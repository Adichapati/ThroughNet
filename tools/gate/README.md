# ThroughNet gate & validation tooling

## Phase-2 validation harness — `validate.py`

The tool that turns "it looked right when I watched it" into measured numbers.
Drives the running sensing-server's ThroughNet REST API through scripted
ground-truth phases (baseline → empty → enter+still → moving → exit), records the
fused state + per-node scores each poll, and scores the run against the Phase-2
acceptance gates (ROADMAP §4):

| metric | gate |
|---|---|
| presence false-positive (empty room) | < 5 % |
| presence detection (occupied, settled) | > 95 % |
| presence latency (enter → first detect) | < 10 s |
| motion still-vs-moving discrimination (5 s windows) | > 90 % |

Reuses only the existing endpoints (`POST /api/v1/throughnet/baseline/start|stop`,
`GET /api/v1/throughnet/status`) — **no server changes**. Start the sensing-server
first (it owns UDP 5005); the harness talks to its HTTP API (default `:8080`).

```bash
python tools/gate/validate.py                 # full interactive run (one person)
python tools/gate/validate.py --quick         # shorter phases for a smoke run
python tools/gate/validate.py --check         # just ping the server, print state
python tools/gate/validate.py --selftest      # verify the scorers (no hardware)
python tools/gate/validate.py --out run.json  # also dump samples + scores to JSON
```

The scoring is pure functions verified by `--selftest` (clean run passes all four
gates; injected faults — 14 s latency, 40 empty-room blips, inverted motion, empty
input — each trip the right gate). A `SETTLE_S=10 s` post-phase allowance keeps the
debounce/posture transient out of the steady-state metrics; latency is measured on
the transient itself. Exit cleanly with code 0 (PASS) / 1 (FAIL).

## Phase-2 acceptance validation — live on the 3-board fleet (2026-06-13)

First end-to-end run of the harness against real hardware (driven phase-by-phase).

**Run 1 — absolute motion metric:**

| gate | result | |
|---|---|---|
| presence false-positive (empty) | **0.0%** | ✅ |
| presence detection (occupied) | **100%** | ✅ |
| presence latency (enter→detect) | **0.0 s** | ✅ |
| motion still-vs-moving (5 s win) | **50%** | ❌ |

Diagnosis: standing still **on node 3's link line** gave presence 196× (huge but
*stable* perturbation). The motion metric — absolute window-to-window change ÷
empty-rate — scales with the perturbation it sits on, so breathing/sway there read
motion 50× (> walking's 6×). No threshold separates that. **Presence is
production-ready; motion was conflating a still subject's position with movement.**

**Fix — relative motion** (`motion ÷ presence`, the fractional change): still ≈
0.19–0.30 vs walking ≈ 0.46–1.21 (median across runs). Implemented in `throughnet.rs`
(`MOTION_REL_THRESH`, gated on presence).

**Run 2 — relative motion:** the still-on-link case is fixed — standing still on
n3's line now reads `present_still` **44/45** (was `present_moving` 39/44). Presence
gates still pass. But still/walking discrimination only reaches **~80–88%** (run 2
scored 71% at the initial 0.5 threshold; retuned to 0.35), because walking's
*relative* motion dips when the subject pauses/turns — it's run-dependent and below
the 90% gate.

**Run 3 — motion-band energy (the fix that clears the gate).** Replaced the
window-rate observable with **~1–6 Hz spectral energy** (per-bin cascaded
high-pass + low-pass IIR → windowed power), normalized by the empty-room floor and
fused (OR) across links. Walking = sustained Doppler in-band; breathing (~0.25 Hz),
its harmonics, and slow sway fall below the high-pass edge. Developed offline against
raw captures (`raw_capture.py`), including a deliberately heavy-breathing still on the
link line — the case a first (too-broad, single-bandpass) attempt leaked (still read
4–9× live). The cascaded high-pass at 1 Hz rejects it:

| | fused still (×floor) | fused walking (×floor) |
|---|---|---|
| empty/still | med 2.16, **max 2.54** | — |
| walking | — | med 7.89, **min 3.52** |

Clean gap → threshold **3.0×**. Live confirmation:

| gate | result | |
|---|---|---|
| presence false-positive (empty) | **0.0%** | ✅ |
| presence detection (occupied) | **100%** | ✅ |
| presence latency (enter→detect) | **0.0 s** | ✅ |
| motion still-vs-moving (5 s win) | **93% @2.5×, 100% @3.0×** | ✅ |

**Status: PHASE 2 COMPLETE — all four acceptance gates pass on real hardware**,
including a still subject breathing on a link line (the hardest case). Detector:
`throughnet.rs` (`MOTION_BAND_THRESH`, `Biquad` cascade). Next: breathing extraction
(Phase 2.4), then the Phase-3 setup CLI.

## Phase-1 acceptance gate tooling

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
