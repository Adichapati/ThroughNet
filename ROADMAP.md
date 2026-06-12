# ThroughNet Roadmap — from working prototype to shippable product

*Last updated: 2026-06-12. This is a living document.*

## 1. Vision

**Camera-free presence, motion, and breathing sensing that a non-expert can set up in
15 minutes.** A user buys 3× ESP32-S3 boards (~$27), plugs them into a PC one at a
time, runs one command, places the boards, and gets a live dashboard. No cloud, no
cameras, no wearables.

What ships:
- **3 ESP32-S3 boards** running ThroughNet firmware (1 transmitter + 2 receivers)
- **One setup tool** (`throughnet` CLI) that flashes, provisions, verifies, and runs
- **One server + dashboard** showing presence / motion / breathing with honest confidence
- **Docs** that tell the truth about what works and what doesn't

## 2. State of play (what we've proven empirically)

Working today:
- ✅ End-to-end pipeline: ESP32 CSI → UDP → Rust server → WebSocket UI, 3-node mesh
- ✅ Display-off firmware build (fixes upstream's zero-CSI bug — CORRECTIONS.md #1/#2)
- ✅ Empty-room calibration (fixed 3 upstream bugs — CORRECTIONS.md #9)
- ✅ Stable person count with 3-node fusion (no more phantom "3 people")

Broken / unreliable today:
- ❌ **Presence**: reads `true` in an empty room (firmware variance threshold)
- ❌ **Motion**: empty vs. still vs. moving produce overlapping signal ranges
- ❌ **CSI yield** depends on traffic floods we generate, which themselves pollute the signal
- ❌ Boards' own RF chatter (self-ping, ESP-NOW sync) buries the human signal

**Root cause of all four:** uncontrolled illumination. The boards sniff ambient traffic
at unstable rates/gains. The fix is architectural (see §3), not threshold tuning.

## 3. The core pivot: controlled bistatic illumination

Replace "3 independent sniffers of ambient chaos" with **1 TX + 2 RX directed links**:

```
N1 (TX beacon) ──ESP-NOW @ 50–100 Hz──▶ N2 (RX, MAC-filtered to N1)
      └────────────────────────────────▶ N3 (RX, MAC-filtered to N1)
```

Why this fixes the reliability problem:
| Problem today | With TX/RX architecture |
|---|---|
| Variable frame rate (0–50 pps, bursty) | Constant 50–100 Hz → meaningful FFT bins, real bandpass filters |
| Unknown TX source/power/distance per frame | Single known TX → stable amplitude baseline, AGC normalizable |
| All ambient frames mixed together | MAC filter = only the beacon's frames → clean channel measurement |
| Self-ping + mesh chatter pollute CSI | RX nodes go radio-silent (no self-ping, minimal mesh) |
| No geometry | Two known TX→RX paths crossing the room = bistatic radar links |

Key enablers **already in the codebase**: `filter_mac` NVS key (ADR-060), ESP-NOW
stack (c6_espnow module), top-K subcarrier selection, Hampel/phase-sanitization DSP
in `wifi-densepose-signal`, calibration baseline (fixed). The gap is wiring a clean
input into the existing DSP.

## 4. Phases

Each phase has a go/no-go acceptance test. We do not build on top of an unproven layer
— that discipline comes from today's lesson (we almost built presence logic on a
signal that doesn't separate).

### Phase 1 — Signal foundation (TX/RX firmware) ← MAKE-OR-BREAK
*Goal: constant-rate, clean CSI on two directed links.*

Work items:
1. **TX-beacon mode** in firmware: node role `tx` broadcasts ESP-NOW packets at a fixed
   rate (start 50 Hz; NVS-config `beacon_hz`). Disable its CSI capture; it is purely an
   illuminator. (The c6_espnow sync sender is a starting point.)
2. **RX mode**: nodes 2/3 set `filter_mac` = TX node's MAC; **disable self-ping and
   ESP-NOW transmissions** (radio-silent receivers). NVS-config `role` key.
3. Forward per-frame RX timestamps + sequence numbers so the server can detect drops
   and align the two links.
4. Provisioning support: `provision.py --role tx|rx --beacon-mac <MAC>`.

Acceptance test (scripted):
- RX nodes show **≥45 pps sustained for 10 min** with no traffic floods from the PC.
- Empty room amplitude std-dev per subcarrier is **stable** (no AGC jumps) over 10 min.
- **The empty/still/moving test separates**: re-run today's 3-phase protocol; the
  motion-band energy of (moving) must exceed (empty) by a clean margin (≥3× median).
- If separation fails → iterate on rate / placement / antenna orientation / subcarrier
  selection BEFORE writing any detection code. This gate is absolute.

### Phase 2 — Detection pipeline (server-side, on clean input)
*Goal: presence / motion / breathing with measured accuracy.*

1. **Per-link processing**: amplitude normalization (subcarrier ratios cancel AGC),
   Hampel outlier removal, phase sanitization (already in `wifi-densepose-signal`).
2. **Presence** = deviation from empty-room baseline (the calibration we fixed) with
   hysteresis + minimum-hold. Auto-recalibration when "absent" is stable for N minutes.
3. **Motion** = motion-band (0.5–5 Hz) energy on top-K subcarriers, per link; fused
   across the two links (OR for detection, AND for high confidence).
4. **Breathing** = 0.1–0.5 Hz spectral peak when motion is low ("still person"), with
   an explicit SNR-based confidence; report "unknown" honestly below threshold.
5. **Validation harness** (this is what makes it *reliable*): scripted ground-truth
   protocols (empty / enter / still / breathing / moving / exit), recorded to disk
   (recording infra exists), scored automatically: detection rate, false-positive rate,
   latency. Every tuning change re-runs the suite. No more eyeballing.

Acceptance:
- Presence: <5% false-positive (empty), >95% detection (occupied), <10 s latency.
- Motion: still vs moving discriminated >90% on 5 s windows.
- Breathing: rate within ±2 BPM of a manual count, for a still subject ≤3 m from a link.

### Phase 3 — "Plug in and go" setup tool
*Goal: a non-expert goes from boxed boards to live dashboard in 15 minutes.*

1. **`throughnet` CLI** (Python first — esptool/nvs-gen already work in our venv;
   single-binary Rust with espflash later):
   - `throughnet setup` — walks through each board: auto-detect port/chip, flash
     bundled firmware, prompt WiFi creds once, auto-detect PC IP, **auto-assign roles**
     (board 1 = TX, 2/3 = RX with TX's MAC), verify each board joins and streams.
   - `throughnet doctor` — automated checks for every trap we personally hit:
     serial-group membership (uucp/dialout), firewall UDP 5005 (ufw!), port
     conflicts, venv deps, board reachability, CSI rate.
   - `throughnet run` — starts server + opens dashboard.
   - `throughnet calibrate` — guided empty-room baseline ("leave the room, press Enter").
   - `throughnet test` — runs the Phase-2 validation protocol interactively.
2. **Firmware binaries bundled** via GitHub Releases; setup tool downloads/uses local.
3. Placement guide in docs: triangle geometry, chest height, links crossing the
   monitored zone, photos.

Acceptance: a fresh Linux machine + 3 new boards → live dashboard, using only
`pipx install throughnet && throughnet setup`, no manual steps. (Windows/macOS later.)

### Phase 4 — Product app & packaging
*Goal: it looks and feels like a product, not a research repo.*

1. **Clean dashboard** (replace/simplify Observatory): presence / motion / breathing
   cards with confidence, node health (per-link pps, RSSI), calibration status &
   one-click recalibrate, event log (entered/left/still/moving). Honest empty states.
2. **Single deliverable**: one server binary with embedded UI assets (rust-embed), or
   docker-compose for the container crowd; systemd unit for always-on.
3. **Repo slimming**: define the product surface — firmware + sensing-server + UI +
   setup tool + docs. Everything else from upstream (cog catalog, drone swarm, nvsim,
   desktop app, aether-arena, …) moves to `attic/` or is removed. A shippable repo is
   one where every directory earns its place.
4. Docs rewrite: quickstart, placement, troubleshooting (from CORRECTIONS.md), honest
   capability table (what works, conditions, accuracy numbers from Phase-2 harness).

### Phase 5 — Stretch (after the core ships)
- **Learned detectors**: Phase 2's harness produces labeled recordings → train a small
  classifier (logistic regression / tiny CNN on spectrograms) to replace hand
  thresholds; more robust across rooms. This makes upstream's "self-learning" claim real.
- **Heart rate**: borderline on this hardware; attempt only with the controlled-link
  SNR, market as experimental.
- **Zones / rough localization**: TDM-rotate the TX role (each board takes turns
  transmitting) → up to 6 directed links → per-link presence = zone information.
- **Home Assistant integration**: MQTT publisher exists upstream; wire it to our
  *reliable* presence/motion/breathing only.
- **Multi-person**: explicitly out of scope until single-person is solid.

## 5. Honest feasibility tiers
| Capability | Verdict | Basis |
|---|---|---|
| Presence (room-level) | **Achievable, high confidence** | controlled links + baseline deviation is well-proven in literature & products |
| Motion / activity level | **Achievable** | motion-band energy on stable links |
| Breathing rate (still person) | **Achievable with conditions** (distance, stillness) | demonstrated repeatedly on ESP32 CSI with fixed-rate TX |
| Heart rate | **Experimental** — may never be reliable on $9 hardware | tiny signal; needs excellent SNR |
| Pose / skeleton | **Out of scope** | no trained model exists; needs camera-supervised data collection (research project) |
| Multi-person counting | **Stretch** | hard even in research with this hardware |

## 6. Risks
- **R1 — Separation still poor even with TX/RX** (Phase 1 gate fails): iterate
  geometry/rate/subcarrier selection; if fundamentally blocked in this room, test a
  second environment before concluding. This is the project's main technical risk.
- **R2 — AGC/gain wander**: mitigate with subcarrier-ratio normalization.
- **R3 — WiFi coexistence**: 100 Hz ESP-NOW is light; verify it doesn't degrade the
  home network or get throttled.
- **R4 — Scope creep**: the upstream repo is a feature zoo. The product surface (§4.3)
  is the contract; anything outside it waits.
- **R5 — Single-room overfit**: validate in ≥2 rooms before calling numbers "accuracy".

## 7. Immediate next actions
1. Commit + push current state (calibration fix, this roadmap).
2. Phase 1.1: implement `role=tx` beacon mode in firmware (start from c6_espnow sender).
3. Phase 1.2: `role=rx` (MAC filter + radio-silence) + provisioning flags.
4. Re-run the empty/still/moving experiment against the Phase-1 acceptance gate.
