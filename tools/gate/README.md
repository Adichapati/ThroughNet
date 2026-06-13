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

## Results 2026-06-12 (Phase-2 live validation — server-side detector) — **PASSED**

Same locked geometry, whole fleet BSSID-locked (CORRECTIONS #12). Detector =
`throughnet.rs` in the sensing-server, fed live on UDP 5005 (540-560
frames/node per 15 s window, every window, no workarounds). Protocol: 60 s
empty-room baseline via `POST /api/v1/throughnet/baseline/start|stop`
(2185/2216 frames, 28 windows per node), then live cues polled from
`GET /api/v1/throughnet/status` every 4 s:

| cue | fused state | presence (n2 / n3) | motion (n2 / n3) |
|---|---|---|---|
| empty | `absent` (3/3 polls) | 0.9-1.2× / 1.0-1.2× | 0.9-1.2× / 0.9-1.3× |
| still | `present_still` (2/4)* | 39-42× / 45-48× | 1.6-2.3× / 1.0-1.3× |
| walking | `present_moving` (4/4) | 27-56× / 6.7-8.4× | **18.9-27.5×** / 1.7-6.0× |

\* the two `present_moving` polls during "still" were the walk-in transient
(first poll) and a weight-shift on the hot -52 dBm link (last poll). The raw
scores are correct; the state machine needed **debounce** (require ~2
consecutive windows to flip state). **Done 2026-06-13** — `commit_state` in
`throughnet.rs` now commits a present/moving flip only after `DEBOUNCE_WINDOWS`
(=2) consecutive disagreeing windows (~4 s at the ~2 s window cadence, inside the
<10 s latency budget); raw scores stay exposed on `/throughnet/status` for
diagnostics. A lone transient window can no longer flip the fused state. The
validation harness remains the next Phase-2 item. Per-link geometry is visible as
designed: the walking path crossed node 2's link line, so n2 carried the motion
signal while n3 stayed near baseline.
