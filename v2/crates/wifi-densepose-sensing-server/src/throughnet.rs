//! ThroughNet Phase-2 detector — presence + motion from controlled TX/RX links.
//!
//! Implements exactly the observable family validated by the Phase-1 gate
//! (tools/gate/, run #2 2026-06-12: presence 8.5–58.9×, motion 5.2–6.1×):
//!
//! 1. Per-frame **RMS normalization** of the HT-LTF amplitude block — the ESP32
//!    auto-scales every CSI frame (AGC), so raw amplitudes are garbage-dominated.
//! 2. **Valid-bin selection**: top `N_BINS` of the HT-LTF block by mean amplitude
//!    (drops DC/guard/null junk). Frames are `L-LTF[0:64] + HT-LTF[64:128]`.
//! 3. **Windowed mean profiles** (~4 s, 50% overlap).
//! 4. **Presence** = L2 distance from the current window profile to the frozen
//!    empty-room baseline, in units of the baseline's own self-noise.
//! 5. **Motion** = ~1–6 Hz spectral energy (per-bin cascaded high-pass+low-pass IIR →
//!    windowed power) of the top-bin amplitudes, normalized by the empty-room floor and
//!    fused (OR) across links. Walking churns the channel with sustained Doppler in
//!    this band; breathing (~0.25 Hz), its harmonics, and slow sway fall below the
//!    high-pass edge, and the static link perturbation is DC. Raw-capture validation
//!    (2026-06-13, incl. heavy-breathing still on the link) plus a live run: fused
//!    still ≤ 2.5× floor, walking ≥ 3.5× → 100% at a 3.0× threshold (presence FP 0%,
//!    detection 100%, latency 0 s). The earlier window-rate metrics (~85%) and a
//!    too-broad single bandpass (leaked breathing) are in git history.
//! 6. **Debounce**: `present()`/`moving()` commit a new boolean state only after
//!    `DEBOUNCE_WINDOWS` consecutive windows disagree with the committed value, so
//!    a lone transient window (walk-in, weight-shift on a hot link) can't flip the
//!    fused state. Phase-2 live validation flagged exactly this — the raw scores
//!    were correct but the bare-threshold state machine blipped on single windows.
//!
//! Baselines are captured per node via `BaselineCapture` (room must be empty).

use std::collections::VecDeque;
use std::time::Instant;

/// Frames per analysis window (~4 s at the ~37 fps beacon-fed rate).
const WIN_FRAMES: usize = 150;
/// Number of valid bins kept from the HT-LTF block.
const N_BINS: usize = 40;
/// HT-LTF block location within the beacon CSI frame.
const HT_LTF_START: usize = 64;
const HT_LTF_LEN: usize = 64;
/// Presence threshold in self-noise units (gate run #2 margins comfortably clear it).
const PRESENCE_THRESH: f64 = 3.0;
/// Motion = ~1–6 Hz spectral energy of the per-frame top-bin amplitudes, normalized by
/// the empty-room floor, fused (OR) across links. Walking churns the channel with
/// sustained Doppler in this band; a still person's breathing (~0.25 Hz), its low
/// harmonics, and slow sway fall below the high-pass edge, and the static link
/// perturbation is DC. A live run exposed that a broad single-biquad band leaked
/// breathing on the link a subject stood on (still read 4–9×); the cascaded high-pass
/// fixes it. Tuned on the 2026-06-13 raw captures incl. a heavy-breathing still, then a
/// live run: FUSED still ≤ 1.7× the floor offline / ≤ 2.5× live (n2 catching slight
/// postural sway), walking ≥ 3.5× → 3.0× sits in the gap with ~0.5× margin each side.
/// Live confirmation: motion still-vs-walking 93% at 2.5×, 100% at 3.0×; FP 0%.
const MOTION_BAND_THRESH: f64 = 3.0;
/// Motion-band filter: a cascade of a 2nd-order Butterworth high-pass (rejects
/// breathing/sway) and low-pass (rejects fast noise) at `NOMINAL_FPS`. The metric is
/// normalized by the empty floor, so the small live fps variation (~36–38) cancels.
const NOMINAL_FPS: f64 = 37.0;
const MOTION_BAND_HP: f64 = 1.0;
const MOTION_BAND_LP: f64 = 6.0;
const BUTTER_Q: f64 = std::f64::consts::FRAC_1_SQRT_2;
/// Consecutive disagreeing windows required to flip a committed present/moving
/// state. At the ~2 s window cadence (WIN_FRAMES/2 frames @ ~37 fps) this debounces
/// single-window transients over ~4 s — well inside the <10 s latency budget.
const DEBOUNCE_WINDOWS: u32 = 2;
/// Floor for self-noise to avoid divide-by-near-zero on unnaturally quiet links.
const NOISE_FLOOR: f64 = 1e-6;

/// Normalize one CSI amplitude frame: HT-LTF block, per-frame RMS normalization.
/// Returns `None` when the frame is too short (not a beacon-style 128-sc frame).
fn normalize(amplitudes: &[f64]) -> Option<Vec<f64>> {
    if amplitudes.len() < HT_LTF_START + HT_LTF_LEN {
        return None;
    }
    let block = &amplitudes[HT_LTF_START..HT_LTF_START + HT_LTF_LEN];
    let rms = (block.iter().map(|a| a * a).sum::<f64>() / block.len() as f64).sqrt();
    if rms <= 0.0 {
        return None;
    }
    Some(block.iter().map(|a| a / rms).collect())
}

fn l2(a: &[f64], b: &[f64]) -> f64 {
    a.iter()
        .zip(b.iter())
        .map(|(x, y)| (x - y) * (x - y))
        .sum::<f64>()
        .sqrt()
}

/// Advance a debounced binary state by one window observation.
///
/// The first observation commits immediately (unknown → known). Thereafter a flip
/// requires `DEBOUNCE_WINDOWS` consecutive windows disagreeing with the committed
/// value; any window that agrees resets the streak, so an isolated transient window
/// can never change state.
fn commit_state(committed: &mut Option<bool>, streak: &mut u32, raw: bool) {
    match *committed {
        None => {
            *committed = Some(raw);
            *streak = 0;
        }
        Some(c) if c == raw => *streak = 0,
        Some(_) => {
            *streak += 1;
            if *streak >= DEBOUNCE_WINDOWS {
                *committed = Some(raw);
                *streak = 0;
            }
        }
    }
}

/// Motion decision for one window: a node reads "moving" only when a person is present
/// AND the motion-band power (normalized by the empty floor) clears the threshold.
/// Gating on presence keeps the empty-room band-noise floor (≈1×) from ever reading as
/// motion in an unoccupied room.
fn is_moving(present: bool, motion_band: f64) -> bool {
    present && motion_band >= MOTION_BAND_THRESH
}

/// RBJ 2nd-order Butterworth biquad (high-pass / low-pass), cascaded to form the motion
/// band with steeper skirts than a single bandpass — the broad bandpass leaked breathing.
#[derive(Debug, Clone, Copy)]
struct Biquad {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
}

impl Biquad {
    fn highpass(fs: f64, fc: f64, q: f64) -> Self {
        let w0 = 2.0 * std::f64::consts::PI * fc / fs;
        let (cos, sin) = (w0.cos(), w0.sin());
        let alpha = sin / (2.0 * q);
        let a0 = 1.0 + alpha;
        Self {
            b0: (1.0 + cos) / 2.0 / a0,
            b1: -(1.0 + cos) / a0,
            b2: (1.0 + cos) / 2.0 / a0,
            a1: -2.0 * cos / a0,
            a2: (1.0 - alpha) / a0,
        }
    }

    fn lowpass(fs: f64, fc: f64, q: f64) -> Self {
        let w0 = 2.0 * std::f64::consts::PI * fc / fs;
        let (cos, sin) = (w0.cos(), w0.sin());
        let alpha = sin / (2.0 * q);
        let a0 = 1.0 + alpha;
        Self {
            b0: (1.0 - cos) / 2.0 / a0,
            b1: (1.0 - cos) / a0,
            b2: (1.0 - cos) / 2.0 / a0,
            a1: -2.0 * cos / a0,
            a2: (1.0 - alpha) / a0,
        }
    }
}

/// Per-bin biquad delay memory.
#[derive(Debug, Clone, Copy, Default)]
struct BiquadState {
    x1: f64,
    x2: f64,
    y1: f64,
    y2: f64,
}

impl BiquadState {
    fn step(&mut self, bq: &Biquad, x: f64) -> f64 {
        let y =
            bq.b0 * x + bq.b1 * self.x1 + bq.b2 * self.x2 - bq.a1 * self.y1 - bq.a2 * self.y2;
        self.x2 = self.x1;
        self.x1 = x;
        self.y2 = self.y1;
        self.y1 = y;
        y
    }
}

/// Median windowed motion-band power over an empty-room capture — the floor that live
/// motion-band power is normalized against. Runs the biquad from rest over `frames`
/// (the startup transient lands in the first window; the median is robust to it).
fn motion_band_floor(frames: &[Vec<f64>], bins: &[usize]) -> f64 {
    let hp = Biquad::highpass(NOMINAL_FPS, MOTION_BAND_HP, BUTTER_Q);
    let lp = Biquad::lowpass(NOMINAL_FPS, MOTION_BAND_LP, BUTTER_Q);
    let mut hs = vec![BiquadState::default(); bins.len()];
    let mut ls = vec![BiquadState::default(); bins.len()];
    let per_frame: Vec<f64> = frames
        .iter()
        .map(|f| {
            let mut s = 0.0;
            for (i, &k) in bins.iter().enumerate() {
                let y = ls[i].step(&lp, hs[i].step(&hp, f[k]));
                s += y * y;
            }
            s
        })
        .collect();
    let nbins = bins.len().max(1) as f64;
    let mut powers = Vec::new();
    let mut t0 = 0;
    while t0 + WIN_FRAMES <= per_frame.len() {
        let sum: f64 = per_frame[t0..t0 + WIN_FRAMES].iter().sum();
        powers.push(sum / (WIN_FRAMES as f64 * nbins));
        t0 += WIN_FRAMES / 2;
    }
    powers.sort_by(|a, b| a.partial_cmp(b).unwrap());
    if powers.is_empty() {
        NOISE_FLOOR
    } else {
        powers[powers.len() / 2].max(NOISE_FLOOR)
    }
}

/// Frozen empty-room reference for one node/link.
#[derive(Debug, Clone)]
pub struct LinkBaseline {
    /// Mean profile over the baseline capture (valid bins only).
    profile: Vec<f64>,
    /// Bin indices (into the HT-LTF block) selected during baseline capture.
    bins: Vec<usize>,
    /// Median window-profile distance to `profile` during the (empty) capture.
    self_noise: f64,
    /// Median windowed motion-band power during the (empty) capture — the floor that
    /// live motion-band power is normalized against.
    empty_band_floor: f64,
    pub captured_at: Instant,
    pub n_windows: usize,
}

/// Rolling per-node detector state.
#[derive(Debug)]
pub struct LinkDetector {
    /// Normalized frames awaiting windowing (bounded ring).
    frames: VecDeque<Vec<f64>>,
    frames_since_window: usize,
    /// Motion-band cascade coefficients (high-pass + low-pass, computed once).
    band_hp: Biquad,
    band_lp: Biquad,
    /// Per-bin motion-band filter state (hp, lp), sized to the baseline's bin set.
    band_filters: Vec<(BiquadState, BiquadState)>,
    /// Per-frame motion-band energy (Σ filtered² over bins), rolling over a window.
    band_ring: VecDeque<f64>,
    band_ring_sum: f64,
    pub baseline: Option<LinkBaseline>,
    /// Latest presence score, in self-noise units; `None` until enough data.
    pub presence_score: Option<f64>,
    /// Latest motion-band power normalized by the empty floor (still-vs-moving score).
    pub motion_score: Option<f64>,
    pub last_update: Option<Instant>,
    /// Debounced present state — committed only after `DEBOUNCE_WINDOWS` agreeing
    /// windows; `None` until the first scored window.
    present_state: Option<bool>,
    present_streak: u32,
    /// Debounced moving state (same debounce as `present_state`).
    moving_state: Option<bool>,
    moving_streak: u32,
}

impl Default for LinkDetector {
    fn default() -> Self {
        Self::new()
    }
}

impl LinkDetector {
    pub fn new() -> Self {
        Self {
            frames: VecDeque::with_capacity(WIN_FRAMES + 8),
            frames_since_window: 0,
            band_hp: Biquad::highpass(NOMINAL_FPS, MOTION_BAND_HP, BUTTER_Q),
            band_lp: Biquad::lowpass(NOMINAL_FPS, MOTION_BAND_LP, BUTTER_Q),
            band_filters: Vec::new(),
            band_ring: VecDeque::with_capacity(WIN_FRAMES + 8),
            band_ring_sum: 0.0,
            baseline: None,
            presence_score: None,
            motion_score: None,
            last_update: None,
            present_state: None,
            present_streak: 0,
            moving_state: None,
            moving_streak: 0,
        }
    }

    /// Feed one raw CSI amplitude frame. Emits a new window profile every
    /// `WIN_FRAMES / 2` frames (50% overlap) and refreshes the scores.
    pub fn push_frame(&mut self, amplitudes: &[f64]) {
        let Some(norm) = normalize(amplitudes) else {
            return;
        };

        // Motion-band filtering runs every frame on the baseline's bins (continuous
        // IIR — no per-window startup transient). Needs the baseline to know the bins.
        if let Some(bins) = self.baseline.as_ref().map(|b| b.bins.clone()) {
            if self.band_filters.len() != bins.len() {
                self.band_filters =
                    vec![(BiquadState::default(), BiquadState::default()); bins.len()];
                self.band_ring.clear();
                self.band_ring_sum = 0.0;
            }
            let (hp, lp) = (self.band_hp, self.band_lp);
            let mut frame_band = 0.0;
            for (i, &k) in bins.iter().enumerate() {
                let (hs, ls) = &mut self.band_filters[i];
                let y = ls.step(&lp, hs.step(&hp, norm[k]));
                frame_band += y * y;
            }
            self.band_ring.push_back(frame_band);
            self.band_ring_sum += frame_band;
            if self.band_ring.len() > WIN_FRAMES {
                self.band_ring_sum -= self.band_ring.pop_front().unwrap_or(0.0);
            }
        }

        self.frames.push_back(norm);
        if self.frames.len() > WIN_FRAMES {
            self.frames.pop_front();
        }
        self.frames_since_window += 1;
        if self.frames.len() < WIN_FRAMES || self.frames_since_window < WIN_FRAMES / 2 {
            return;
        }
        self.frames_since_window = 0;

        let Some(base) = self.baseline.as_ref() else {
            return; // no baseline yet — nothing to score against
        };
        // Presence: distance of the window mean profile from the empty baseline.
        let profile: Vec<f64> = base
            .bins
            .iter()
            .map(|&k| self.frames.iter().map(|f| f[k]).sum::<f64>() / self.frames.len() as f64)
            .collect();
        let presence = l2(&profile, &base.profile) / base.self_noise.max(NOISE_FLOOR);
        let present = presence >= PRESENCE_THRESH;

        // Motion: windowed motion-band power, normalized by the empty-room floor.
        let nbins = base.bins.len().max(1) as f64;
        let band_power = if self.band_ring.is_empty() {
            0.0
        } else {
            self.band_ring_sum / (self.band_ring.len() as f64 * nbins)
        };
        let motion = band_power / base.empty_band_floor.max(NOISE_FLOOR);
        // `base` borrow ends here; safe to mutate `self` below.

        self.presence_score = Some(presence);
        self.motion_score = Some(motion);
        commit_state(&mut self.present_state, &mut self.present_streak, present);
        commit_state(
            &mut self.moving_state,
            &mut self.moving_streak,
            is_moving(present, motion),
        );
        self.last_update = Some(Instant::now());
    }

    /// Debounced presence verdict (`None` until the first scored window). The raw
    /// score remains available via `presence_score` for the API/diagnostics.
    pub fn present(&self) -> Option<bool> {
        self.present_state
    }

    /// Debounced motion verdict (`None` until the first scored window with motion).
    pub fn moving(&self) -> Option<bool> {
        self.moving_state
    }
}

/// Accumulates normalized frames during an empty-room baseline capture,
/// then freezes a `LinkBaseline`.
#[derive(Debug, Default)]
pub struct BaselineCapture {
    frames: Vec<Vec<f64>>,
}

impl BaselineCapture {
    pub fn push_frame(&mut self, amplitudes: &[f64]) {
        if let Some(norm) = normalize(amplitudes) {
            self.frames.push(norm);
        }
    }

    pub fn frame_count(&self) -> usize {
        self.frames.len()
    }

    /// Freeze the capture into a baseline. Needs at least 2 windows of frames.
    pub fn finalize(&self) -> Result<LinkBaseline, String> {
        if self.frames.len() < WIN_FRAMES * 2 {
            return Err(format!(
                "need at least {} frames, got {} — keep the room empty longer",
                WIN_FRAMES * 2,
                self.frames.len()
            ));
        }
        let nsc = HT_LTF_LEN;
        // Valid bins: top-N by mean normalized amplitude over the whole capture.
        let mean_amp: Vec<f64> = (0..nsc)
            .map(|k| self.frames.iter().map(|f| f[k]).sum::<f64>() / self.frames.len() as f64)
            .collect();
        let mut order: Vec<usize> = (0..nsc).collect();
        order.sort_by(|&a, &b| mean_amp[b].partial_cmp(&mean_amp[a]).unwrap());
        let bins: Vec<usize> = order.into_iter().take(N_BINS).collect();

        // Window profiles over the capture (50% overlap).
        let mut profiles: Vec<Vec<f64>> = Vec::new();
        let mut t0 = 0;
        while t0 + WIN_FRAMES <= self.frames.len() {
            let chunk = &self.frames[t0..t0 + WIN_FRAMES];
            profiles.push(
                bins.iter()
                    .map(|&k| chunk.iter().map(|f| f[k]).sum::<f64>() / chunk.len() as f64)
                    .collect(),
            );
            t0 += WIN_FRAMES / 2;
        }
        let mean_profile: Vec<f64> = (0..bins.len())
            .map(|i| profiles.iter().map(|p| p[i]).sum::<f64>() / profiles.len() as f64)
            .collect();

        let mut dists: Vec<f64> = profiles.iter().map(|p| l2(p, &mean_profile)).collect();
        dists.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let self_noise = dists[dists.len() / 2].max(NOISE_FLOOR);

        // Empty-room motion-band floor: run the same bandpass over the capture.
        let empty_band_floor = motion_band_floor(&self.frames, &bins);

        Ok(LinkBaseline {
            profile: mean_profile,
            bins,
            self_noise,
            empty_band_floor,
            captured_at: Instant::now(),
            n_windows: profiles.len(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn synth_frame(seed: u64, perturb: f64) -> Vec<f64> {
        // 128-sc frame; HT-LTF block gets a stable shape + per-bin pseudo-noise
        // (sine of large argument ≈ uniform in [-1,1], deterministic).
        let mut v = vec![0.0; 128];
        for k in 0..64 {
            let shape = 10.0 + 5.0 * ((k as f64) * 0.3).sin();
            let noise = ((seed as f64) * 7919.0 + (k as f64) * 104729.0).sin() * 0.1;
            v[64 + k] = shape + noise + perturb * ((k as f64) * 0.7).cos();
        }
        v
    }

    #[test]
    fn baseline_then_detect_perturbation() {
        let mut cap = BaselineCapture::default();
        for s in 0..400 {
            cap.push_frame(&synth_frame(s, 0.0));
        }
        let base = cap.finalize().expect("baseline");
        let mut det = LinkDetector::new();
        det.baseline = Some(base);
        // empty continuation → low presence
        for s in 400..700 {
            det.push_frame(&synth_frame(s, 0.0));
        }
        let empty_presence = det.presence_score.expect("scored");
        // perturbed channel → high presence
        for s in 700..1000 {
            det.push_frame(&synth_frame(s, 2.0));
        }
        let perturbed_presence = det.presence_score.expect("scored");
        assert!(perturbed_presence > empty_presence * 3.0,
            "perturbed {perturbed_presence} should be >3x empty {empty_presence}");
        // After sustained perturbation (~4 windows) the debounced verdict commits true.
        assert_eq!(det.present(), Some(true),
            "sustained perturbation should commit present=true through the debounce");
    }

    #[test]
    fn short_frames_ignored() {
        let mut det = LinkDetector::new();
        det.push_frame(&[1.0; 32]); // too short — must not panic or count
        assert!(det.presence_score.is_none());
    }

    #[test]
    fn motion_band_decision() {
        // Anchored to the 2026-06-13 live run (fused, incl. heavy-breathing still):
        // still ≤ 2.5× floor, walking ≥ 3.5×, threshold 3.0×.
        assert!(!is_moving(true, 1.0), "at the empty floor → still");
        assert!(!is_moving(true, 2.5), "breathing-still + slight sway max → still");
        assert!(is_moving(true, 3.5), "lowest walking window → moving");
        assert!(is_moving(true, 12.0), "median walking → moving");
        assert!(!is_moving(false, 9.0), "not present → never moving");
    }

    #[test]
    fn motion_band_separates_dc_from_oscillation() {
        // Empty baseline (band noise floor only).
        let mut cap = BaselineCapture::default();
        for s in 0..600 {
            cap.push_frame(&synth_frame(s, 0.0));
        }
        let base = cap.finalize().expect("baseline");

        // Still: a large but CONSTANT perturbation (DC offset — no 0.5–5 Hz energy).
        let mut det = LinkDetector::new();
        det.baseline = Some(base.clone());
        for s in 600..1200 {
            det.push_frame(&synth_frame(s, 4.0));
        }
        assert_eq!(det.present(), Some(true), "constant perturbation → present");
        assert_eq!(det.moving(), Some(false), "a DC perturbation has no motion-band energy");

        // Walking: same mean perturbation + a 2 Hz oscillation (inside the band).
        let mut det = LinkDetector::new();
        det.baseline = Some(base);
        for s in 600..1200 {
            let t = (s - 600) as f64 / NOMINAL_FPS;
            let p = 4.0 + 2.0 * (2.0 * std::f64::consts::PI * 2.0 * t).sin();
            det.push_frame(&synth_frame(s, p));
        }
        assert_eq!(det.present(), Some(true), "still present while moving");
        assert_eq!(det.moving(), Some(true), "a 2 Hz oscillation IS motion-band energy");
    }

    #[test]
    fn debounce_first_observation_commits_immediately() {
        // Going from unknown → known must not wait for the debounce streak.
        let mut state: Option<bool> = None;
        let mut streak = 0u32;
        commit_state(&mut state, &mut streak, true);
        assert_eq!(state, Some(true));
    }

    #[test]
    fn debounce_single_transient_window_does_not_flip() {
        // Committed=false. A lone disagreeing window (the walk-in / weight-shift
        // transient the Phase-2 validation flagged) must NOT flip the state.
        let mut state = Some(false);
        let mut streak = 0u32;
        commit_state(&mut state, &mut streak, true); // transient window
        assert_eq!(state, Some(false), "single window must not flip");
        commit_state(&mut state, &mut streak, false); // back to baseline → streak resets
        assert_eq!(state, Some(false));
        // An isolated true every other window also never flips (streak keeps resetting).
        commit_state(&mut state, &mut streak, true);
        commit_state(&mut state, &mut streak, false);
        commit_state(&mut state, &mut streak, true);
        assert_eq!(state, Some(false), "oscillating windows must not flip");
    }

    #[test]
    fn debounce_two_consecutive_windows_flip() {
        // DEBOUNCE_WINDOWS=2 consecutive disagreeing windows commit the new state.
        let mut state = Some(false);
        let mut streak = 0u32;
        for _ in 0..DEBOUNCE_WINDOWS {
            commit_state(&mut state, &mut streak, true);
        }
        assert_eq!(state, Some(true), "two consecutive windows must flip");
        // ...and flips back the same way.
        for _ in 0..DEBOUNCE_WINDOWS {
            commit_state(&mut state, &mut streak, false);
        }
        assert_eq!(state, Some(false));
    }
}
