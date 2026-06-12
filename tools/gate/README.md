# Phase-1 acceptance gate tooling

`raw_capture.py <phase> <seconds>` — binds UDP 5005 (stop the sensing-server first)
and records raw ADR-018 CSI I/Q frames to `/tmp/tn-iq-<phase>.jsonl`.

Protocol: capture `empty`, `waving` (hand on a TX↔RX line), `walking` (cross the
room). Analyze with per-frame RMS normalization (kills per-frame AGC scaling, which
otherwise dominates), valid-bin selection (top-40 of the HT-LTF block by mean
amplitude — drops DC/guard junk), then:

- **Presence** = L2 distance between the window's mean profile and the empty
  baseline profile, compared to the empty self-distance (two halves of the empty
  capture).
- **Motion** = median L2 distance between consecutive 4 s window profiles.

## Results 2026-06-12 (gate run #1, TX@100Hz HT20-MCS0, 2 RX)

| metric | node 2 | node 3 | gate |
|---|---|---|---|
| steady yield, no host traffic | 38–40 pps | 38–40 pps | ✅ |
| presence: empty vs waving-near-link | **3.6×** noise | 1.5× (far from its link) | ✅ |
| presence: empty vs walking | 2.8× | **9.1×** noise | ✅ |
| motion: windowed profile rate (walk) | 2.22× | 2.58× | ⚠️ below 3× |

Verdict: **presence observable passes decisively; motion is borderline** with known
levers untouched: node 3's link RSSI is -70 (noise floor 2.6× worse than node 2 at
-53) → placement/orientation; per-frame normalization MUST be in any feature
pipeline; frame-level variance metrics are quantization-dominated and useless —
windowed profile dynamics are the right observable family.
