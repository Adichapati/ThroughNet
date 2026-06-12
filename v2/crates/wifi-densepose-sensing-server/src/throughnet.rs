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
//! 5. **Motion** = L2 distance between consecutive window profiles, in units of
//!    the empty-room window-to-window rate.
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
/// Detection thresholds, in noise units (gate run #2 margins comfortably clear these).
const PRESENCE_THRESH: f64 = 3.0;
const MOTION_THRESH: f64 = 3.0;
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

/// Frozen empty-room reference for one node/link.
#[derive(Debug, Clone)]
pub struct LinkBaseline {
    /// Mean profile over the baseline capture (valid bins only).
    profile: Vec<f64>,
    /// Bin indices (into the HT-LTF block) selected during baseline capture.
    bins: Vec<usize>,
    /// Median window-profile distance to `profile` during the (empty) capture.
    self_noise: f64,
    /// Median window-to-window rate during the (empty) capture.
    empty_rate: f64,
    pub captured_at: Instant,
    pub n_windows: usize,
}

/// Rolling per-node detector state.
#[derive(Debug)]
pub struct LinkDetector {
    /// Normalized frames awaiting windowing (bounded ring).
    frames: VecDeque<Vec<f64>>,
    /// Most recent window profiles (for motion rate; bounded).
    profiles: VecDeque<Vec<f64>>,
    frames_since_window: usize,
    pub baseline: Option<LinkBaseline>,
    /// Latest scores (noise units); `None` until enough data.
    pub presence_score: Option<f64>,
    pub motion_score: Option<f64>,
    pub last_update: Option<Instant>,
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
            profiles: VecDeque::with_capacity(8),
            frames_since_window: 0,
            baseline: None,
            presence_score: None,
            motion_score: None,
            last_update: None,
        }
    }

    /// Feed one raw CSI amplitude frame. Emits a new window profile every
    /// `WIN_FRAMES / 2` frames (50% overlap) and refreshes the scores.
    pub fn push_frame(&mut self, amplitudes: &[f64]) {
        let Some(norm) = normalize(amplitudes) else {
            return;
        };
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
        // Window mean profile over the baseline's bin set.
        let profile: Vec<f64> = base
            .bins
            .iter()
            .map(|&k| self.frames.iter().map(|f| f[k]).sum::<f64>() / self.frames.len() as f64)
            .collect();

        let presence = l2(&profile, &base.profile) / base.self_noise.max(NOISE_FLOOR);
        let motion = self
            .profiles
            .back()
            .map(|prev| l2(&profile, prev) / base.empty_rate.max(NOISE_FLOOR));

        self.profiles.push_back(profile);
        if self.profiles.len() > 4 {
            self.profiles.pop_front();
        }
        self.presence_score = Some(presence);
        if motion.is_some() {
            self.motion_score = motion;
        }
        self.last_update = Some(Instant::now());
    }

    pub fn present(&self) -> Option<bool> {
        self.presence_score.map(|s| s >= PRESENCE_THRESH)
    }

    pub fn moving(&self) -> Option<bool> {
        self.motion_score.map(|s| s >= MOTION_THRESH)
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

        let mut rates: Vec<f64> = profiles.windows(2).map(|w| l2(&w[1], &w[0])).collect();
        rates.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let empty_rate = rates[rates.len() / 2].max(NOISE_FLOOR);

        Ok(LinkBaseline {
            profile: mean_profile,
            bins,
            self_noise,
            empty_rate,
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
    }

    #[test]
    fn short_frames_ignored() {
        let mut det = LinkDetector::new();
        det.push_frame(&[1.0; 32]); // too short — must not panic or count
        assert!(det.presence_score.is_none());
    }
}
