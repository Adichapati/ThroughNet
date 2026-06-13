//! ThroughNet Phase-2.4 — respiratory rate from the controlled TX/RX links.
//!
//! Breathing lives in **0.15–0.5 Hz** (9–30 BPM) — the band the motion detector
//! deliberately rejects. The hard part on real CSI is that the sub-1 Hz energy is
//! dominated by slow drift/sway at <0.15 Hz, which buries respiration; the offline
//! study (2026-06-13) showed a clean ~0.31 Hz peak on the on-link node only after:
//!
//! 1. **Bandpass 0.15–0.5 Hz** (cascaded high-pass + low-pass) — the 0.15 Hz low edge
//!    is essential, it rejects the drift that otherwise wins.
//! 2. **Select bins by in-band energy** (not amplitude) — the respiration-carrying
//!    bins on the link the subject is near.
//! 3. **DFT spectral peak** over a ~43 s window, searched in the band *interior*
//!    (0.20–0.45 Hz = 12–27 BPM) to dodge low-edge drift/filter-corner artifacts,
//!    parabolic-interpolated for sub-bin resolution → BPM. Confidence = peak
//!    prominence (peak ÷ median). Known limit: a strong slow coherent sway can still
//!    leak near the low edge — the `present_still` gate and the real-data threshold
//!    mitigate it, and the live ±2 BPM run probes it.
//!
//! The caller (a per-node `LinkDetector`) feeds normalized frames and triggers an
//! estimate only when the fused state is `present_still`; the best-confidence link is
//! chosen for the reported rate, and below `CONF_THRESH` it honestly reads "unknown".
//! Rate uses the measured fps (the assumed-vs-actual-rate footgun is what pegged edge
//! HR at ~45 BPM — CHANGELOG #987), with `NOMINAL_FPS` only for the band coefficients.

use std::collections::VecDeque;
use std::f64::consts::PI;

use crate::throughnet::{Biquad, BiquadState, BUTTER_Q, NOMINAL_FPS};

/// Bandpass edges (Hz): 0.15 → reject drift/sway, 0.5 → ceiling (with rolloff margin).
const BREATH_HP: f64 = 0.15;
const BREATH_LP: f64 = 0.5;
/// Peak-search / prominence band (Hz) = 12–27 BPM. The interior of the passband: it
/// excludes the low edge where filter-corner ringing and sub-band drift leakage create
/// spurious peaks (a strong slow sway can still leak there), and covers the full
/// resting-respiration range. On the 2026-06-13 captures: real still peak 0.31 Hz
/// (conf 3.6), empty 0.20 Hz edge (conf 1.4) → cleanly separated by `CONF_THRESH`.
const BREATH_SEARCH_LO: f64 = 0.20;
const BREATH_SEARCH_HI: f64 = 0.45;
/// Analysis window (~43 s at 37 fps) and the minimum data before estimating (~32 s).
const BREATH_WIN_FRAMES: usize = 1600;
const BREATH_MIN_FRAMES: usize = 1200;
/// Number of top in-band-energy bins summed into the spectrum.
const BREATH_KBINS: usize = 6;
/// Frequency grid step for the DFT sweep (Hz). Parabolic interp refines below this.
const FREQ_STEP: f64 = 0.01;
/// Peak prominence (peak ÷ median spectrum) required to report a rate vs "unknown".
const CONF_THRESH: f64 = 2.5;

/// Per-node respiratory-rate estimator. Maintains a rolling buffer of the breathing
/// band-filtered per-bin signal and estimates the dominant rate on demand.
#[derive(Debug)]
pub struct BreathingEstimator {
    hp: Biquad,
    lp: Biquad,
    /// Per-bin (high-pass, low-pass) filter state, sized to the baseline's bin set.
    filters: Vec<(BiquadState, BiquadState)>,
    /// Rolling window of per-bin band-filtered values (one Vec per frame).
    buf: VecDeque<Vec<f64>>,
    /// Latest estimate (`None` = unknown / below confidence).
    pub bpm: Option<f64>,
    pub confidence: f64,
}

impl Default for BreathingEstimator {
    fn default() -> Self {
        Self::new()
    }
}

impl BreathingEstimator {
    pub fn new() -> Self {
        Self {
            hp: Biquad::highpass(NOMINAL_FPS, BREATH_HP, BUTTER_Q),
            lp: Biquad::lowpass(NOMINAL_FPS, BREATH_LP, BUTTER_Q),
            filters: Vec::new(),
            buf: VecDeque::with_capacity(BREATH_WIN_FRAMES + 8),
            bpm: None,
            confidence: 0.0,
        }
    }

    /// Feed one normalized HT-LTF block (caller passes the same `bins` as the detector).
    pub fn push(&mut self, block: &[f64], bins: &[usize]) {
        if self.filters.len() != bins.len() {
            self.filters = vec![(BiquadState::default(), BiquadState::default()); bins.len()];
            self.buf.clear();
        }
        let (hp, lp) = (self.hp, self.lp);
        let row: Vec<f64> = bins
            .iter()
            .enumerate()
            .map(|(i, &k)| {
                let (hs, ls) = &mut self.filters[i];
                ls.step(&lp, hs.step(&hp, block[k]))
            })
            .collect();
        self.buf.push_back(row);
        if self.buf.len() > BREATH_WIN_FRAMES {
            self.buf.pop_front();
        }
    }

    /// Clear the buffer + filter state and mark the rate unknown. Called whenever the
    /// subject isn't `present_still`, so an estimate only ever uses sustained-still data.
    pub fn reset(&mut self) {
        self.buf.clear();
        for (h, l) in self.filters.iter_mut() {
            *h = BiquadState::default();
            *l = BiquadState::default();
        }
        self.bpm = None;
        self.confidence = 0.0;
    }

    /// Estimate the respiratory rate from the buffered window using `fps` (measured).
    pub fn estimate(&mut self, fps: f64) {
        // Skip the filter warm-up (~1/HP seconds) at the head of the buffer.
        let warm = (NOMINAL_FPS / BREATH_HP) as usize;
        if self.buf.len() < BREATH_MIN_FRAMES + warm {
            self.bpm = None;
            self.confidence = 0.0;
            return;
        }
        let nbins = self.buf[0].len();
        let used = self.buf.len() - warm;

        // Per-bin in-band energy → pick the breathing-carrying bins.
        let mut energy = vec![0.0; nbins];
        for row in self.buf.iter().skip(warm) {
            for (k, &v) in row.iter().enumerate() {
                energy[k] += v * v;
            }
        }
        let mut order: Vec<usize> = (0..nbins).collect();
        order.sort_by(|&a, &b| energy[b].partial_cmp(&energy[a]).unwrap());
        let top = &order[..BREATH_KBINS.min(nbins)];

        // DFT power across the breathing band, summed over the top bins.
        let mut freqs = Vec::new();
        let mut powers = Vec::new();
        let mut f = BREATH_SEARCH_LO;
        while f <= BREATH_SEARCH_HI + 1e-9 {
            let p: f64 = top
                .iter()
                .map(|&k| dft_power(&self.buf, k, warm, used, fps, f))
                .sum();
            freqs.push(f);
            powers.push(p);
            f += FREQ_STEP;
        }

        let pk = (0..powers.len())
            .max_by(|&a, &b| powers[a].partial_cmp(&powers[b]).unwrap())
            .unwrap();
        // Parabolic interpolation around the peak for sub-bin frequency.
        let f_peak = if pk > 0 && pk + 1 < powers.len() {
            let (a, b, c) = (powers[pk - 1], powers[pk], powers[pk + 1]);
            let denom = a - 2.0 * b + c;
            let delta = if denom.abs() > 1e-18 { 0.5 * (a - c) / denom } else { 0.0 };
            freqs[pk] + delta * FREQ_STEP
        } else {
            freqs[pk]
        };

        let mut sorted = powers.clone();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let median = sorted[sorted.len() / 2].max(1e-18);
        self.confidence = powers[pk] / median;
        self.bpm = (self.confidence >= CONF_THRESH).then_some(f_peak * 60.0);
    }
}

/// `|DFT|²` of one bin's buffered series at frequency `f` (Hz), skipping `skip`
/// warm-up frames; `n` is the number of frames actually used.
fn dft_power(buf: &VecDeque<Vec<f64>>, k: usize, skip: usize, n: usize, fps: f64, f: f64) -> f64 {
    let w = -2.0 * PI * f / fps;
    let (mut re, mut im) = (0.0, 0.0);
    for (i, row) in buf.iter().skip(skip).enumerate() {
        let ph = w * i as f64;
        re += row[k] * ph.cos();
        im += row[k] * ph.sin();
    }
    (re * re + im * im) / (n as f64 * n as f64)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a block whose first 8 bins carry a sinusoid at `hz` (+ per-bin phase and
    /// broadband noise); the rest are flat.
    fn breathing_block(s: usize, hz: f64, fps: f64) -> Vec<f64> {
        let t = s as f64 / fps;
        let mut block = vec![1.0_f64; 64];
        for k in 0..8 {
            let phase = 2.0 * PI * hz * t + (k as f64) * 0.3;
            let noise = ((s as f64 * 7919.0 + k as f64 * 104729.0).sin()) * 0.05;
            block[k] = 1.0 + 0.5 * phase.sin() + noise;
        }
        block
    }

    #[test]
    fn detects_synthetic_breathing() {
        let bins: Vec<usize> = (0..8).collect();
        let mut est = BreathingEstimator::new();
        for s in 0..1600 {
            est.push(&breathing_block(s, 0.25, NOMINAL_FPS), &bins); // 0.25 Hz = 15 BPM
        }
        est.estimate(NOMINAL_FPS);
        let bpm = est.bpm.expect("should detect a rate");
        assert!((bpm - 15.0).abs() < 2.0, "estimated {bpm} BPM should be ~15 (±2)");
        assert!(est.confidence >= CONF_THRESH);
    }

    #[test]
    fn measured_rate_changes_bpm() {
        // Same samples, but interpreted at a different fps → proportionally different
        // BPM. Guards the assumed-vs-measured-rate footgun (CHANGELOG #987).
        let bins: Vec<usize> = (0..8).collect();
        let mut est = BreathingEstimator::new();
        for s in 0..1600 {
            est.push(&breathing_block(s, 0.25, NOMINAL_FPS), &bins);
        }
        est.estimate(NOMINAL_FPS);
        let a = est.bpm.unwrap();
        est.estimate(NOMINAL_FPS * 0.9); // pretend 10% slower
        let b = est.bpm.unwrap();
        assert!((b / a - 0.9).abs() < 0.02, "BPM must scale with the measured fps");
    }

    // Note: the "should be unknown" empty/drift case is validated on real CSI captures
    // (empty conf 1.4–2.0 < CONF_THRESH, 2026-06-13), not synthetically — every clean
    // synthetic non-breathing input (constant, pure-sine drift, white noise) is
    // degenerate for a peak/median metric. The None path is covered below.

    #[test]
    fn too_little_data_is_unknown() {
        let bins: Vec<usize> = (0..8).collect();
        let mut est = BreathingEstimator::new();
        for s in 0..300 {
            est.push(&breathing_block(s, 0.25, NOMINAL_FPS), &bins);
        }
        est.estimate(NOMINAL_FPS);
        assert!(est.bpm.is_none(), "under ~32 s of data → unknown");
    }

    #[test]
    fn reset_clears_state() {
        let bins: Vec<usize> = (0..8).collect();
        let mut est = BreathingEstimator::new();
        for s in 0..1600 {
            est.push(&breathing_block(s, 0.25, NOMINAL_FPS), &bins);
        }
        est.estimate(NOMINAL_FPS);
        assert!(est.bpm.is_some());
        est.reset();
        assert!(est.bpm.is_none() && est.buf.is_empty());
    }
}
