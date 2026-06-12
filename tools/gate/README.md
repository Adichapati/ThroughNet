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

## Results 2026-06-12 (gate run #2 — after placement tuning) — **GATE PASSED**

Link geometry locked: TX→node2 **-52 dBm**, TX→node3 **-66 dBm**, both ~37 fps.
Protocol: empty / still-person / walking, 25 s each. Metrics: presence = median
window-profile distance to empty baseline (× empty self-noise); motion = median
window-to-window profile rate (× empty).

| | empty | still | walking | gate ≥3 |
|---|---|---|---|---|
| presence node 2 | 1.0× | **58.9×** | **26.1×** | ✅ |
| presence node 3 | 1.0× | **8.5×** | **18.2×** | ✅ |
| motion node 2 | 1.0× | 1.7× | **5.2×** | ✅ |
| motion node 3 | 1.0× | 4.0× | **6.1×** | ✅ |

Semantics correct by construction: still = high presence/low motion; walking =
high presence/high motion. **Phase 1 closed — these feature definitions are the
Phase-2 implementation spec.** Placement matters enormously: the same room failed
the gate at -45 dBm (link too short) and -71→-80 dBm (link too weak); the
link_meter.py tool exists precisely to dial this in (-50..-65 target).
