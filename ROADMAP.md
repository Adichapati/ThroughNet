# ThroughNet Roadmap — from working prototype to shippable product

*Last updated: 2026-06-13. This is a living document.*

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

**Reuse-first rule:** the inherited `wifi-densepose-signal` crate already implements
most of the DSP this phase needs — wire it to the clean TX/RX input instead of
rewriting: `csi_ratio.rs` (conjugate multiplication — cancels CFO/SFO; the proper
phase observable), `subcarrier_selection.rs` (variance-ratio top-K), `hampel.rs`,
`phase_sanitizer.rs`, `hardware_norm.rs`; `wifi-densepose-vitals` for breathing/HR
extraction; the server's `/api/v1/recording/*` API for the validation harness.
Gate run #1 (tools/gate/) proved the feature family: per-frame RMS normalization +
valid-bin selection + **windowed profile dynamics** (presence = profile shift vs
empty baseline, 3.6×–9.1×; motion = window-to-window profile rate).

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
   **Built (2026-06-13): `tools/gate/validate.py`** — drives the live `/throughnet/*`
   API through the phases and auto-scores all four acceptance gates; scoring is
   `--selftest`-verified. Pending: a run on the 3-board fleet to record the real
   accuracy numbers (breathing phase wired once Phase-2 item 4 lands).

Acceptance:
- Presence: <5% false-positive (empty), >95% detection (occupied), <10 s latency.
- Motion: still vs moving discriminated >90% on 5 s windows.
- Breathing: rate within ±2 BPM of a manual count, for a still subject ≤3 m from a link.

### Phase R — Robustness foundation (controlled-link product hardening)
*Goal: the proven detection stack survives real-world change — adding nodes, and the
host/router changing IP — before any product UI is built. Direction set 2026-06-13:
build our own app from scratch (not the inherited RuView Tauri app), mDNS for discovery,
robustness first.*

***STATUS (2026-06-14):** R1 **verified on the live fleet** — both RX boards resolve the
server via mDNS (subnet-correct pick over docker0) and stream; commit `aa27c13`. R2 **done**
— `provision.py --auto` fleet auto-id + N-agnostic, staleness-aware fusion (fixes a phantom-
presence gap from a dropped node); commit `d1a6341`. R3 **gates written + `--selftest`-green**
(`tools/gate/resilience.py`); commit `034fc3d`. **ip-change gate:** every component verified
live (advert with all IPs, both boards resolve `(mDNS)`+`(on-subnet)`, 30 s watch armed,
R2 staleness exclusion unit-tested) — the full continuous live re-point is **accepted +
deferred** to a real deployment / router-DHCP change. *Lesson: on this box wlan0 is
**systemd-networkd + iwd**; a manual `ip addr del` of the DHCP address breaks the default
route/DNS (internet drop) and networkd re-adds it — do NOT manual-swap; use a temporary
networkd static drop-in + `networkctl reconfigure`, or a router-side lease change.*
**add-node live** still needs a 4th board. Phase R code is complete; front advances to
**Phase A** (our own app).*

*Phase R follow-up (small, found 2026-06-14 — **DONE 2026-06-14**): the `throughnet` node map
was never evicted (only `node_states` was), so over a long run it accumulated bogus node ids
from occasional malformed/stray UDP (a fresh server is clean — only nodes 2/3). The R2 staleness
fix already kept these out of fusion; the `node_states` 60 s eviction is now **mirrored onto the
`throughnet` map** (keyed on last frame arrival via `LinkDetector::last_frame_time()`, not
`last_update` — the latter stays `None` for a node streaming pre-baseline and would mis-evict a
live node), so they also drop from `/throughnet/status` (keeps the app's node list clean). Unit-
tested (`last_frame_time_tracks_arrival_without_baseline`).*

**R1 — mDNS service discovery (router/IP-change resilience).** Boards push CSI to a static
NVS `target_ip`; when the host IP changes (DHCP / new router) streaming silently dies — the
exact fragility live bring-up hit. Fix: the server advertises, boards resolve at runtime,
the static `target_ip` stays as fallback so we never regress.
- *Server:* add `mdns-sd`, register `_throughnet._udp.local` with the host LAN IP + UDP port
  (5005), re-announce on IP change. The advertiser sits beside the existing `0.0.0.0:5005`
  receiver.
- *Firmware:* add the `espressif/mdns` managed component; after WiFi connect, resolve
  `_throughnet._udp.local` → feed `stream_sender_init_with(ip,port)` (`stream_sender.c:61`,
  called from `main.c:269`); a periodic re-resolve re-inits the sender on IP change; fall
  back to NVS `target_ip` if mDNS yields nothing within a timeout. Log the winning path.
- *Scope boundary (document honestly):* mDNS removes IP-tracking fragility on a given LAN.
  A genuinely new SSID/password still needs WiFi re-provision — the app's setup flow makes
  that a 30-second job; mDNS cannot solve it.

**R2 — multi-node hardening (adding nodes must not break it).** Validated topology is 1 TX
illuminator + N radio-silent RX, so adding an RX needs no reconfiguration of existing nodes
(no inter-node TDM), and the server already keys nodes in a dynamic map. Work: auto-assign
the next-free `node_id` + role=RX + the TX's `filter_mac` at provision time (id collisions
are the one real risk); verify baseline / OR-fusion / best-link breathing / eviction carry
no hidden 2-/3-node assumptions for N≥3.

**R3 — prove the robustness (acceptance).** Two scripted checks in `tools/gate/`:
- *IP-change survival*: with presence live, force the host IP to change (renew DHCP / restart
  router); assert streaming auto-recovers within N s via mDNS re-resolve.
- *Add-a-node*: provision + power a new RX; assert it appears in `/throughnet/status` as a new
  node and joins fusion without disturbing existing nodes.

Acceptance: both gates pass on the real KANAYAM mesh; the Phase-2 + breathing gates re-run
green with the new discovery path (no detection regression).

### Phase 3 — "Plug in and go" setup tool
*Superseded 2026-06-13: setup is baked into the app (Phase 4 / Phase A), not a standalone
CLI — but the mechanics below (auto-detect, flash, provision, doctor, calibrate, run) remain
the requirements; they live inside the app's onboarding flow.*
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

### Phase 4 — Product app & packaging (a.k.a. Phase A — our own app)
*Goal: it looks and feels like a product, not a research repo.*
*Stack **DECIDED 2026-06-14 — ADR-151: server-as-shell.** The research spike found that a
native server we already ship can do serial itself and expose flash/provision over HTTP, so
the browser never needs serial — collapsing the "native shell" requirement into the
sensing-server binary. The product is **one self-contained binary**: the sensing-server serves
an embedded from-scratch Lit UI (`rust-embed`) + localhost-only `/api/v1/setup/*` endpoints
(native `espflash` flash + `--auto` provision; the server owns USB, the browser renders),
launched app-like (Chromium `--app=` / `.desktop`), with a doctor preflight for the known Linux
traps. Chosen over Tauri v2 / Electron / web+helper for: no new toolchain (CI stays
`cargo build`), no system-webview dep (cleaner Linux install — no WebKitGTK runtime), no webview
ceiling (real browser → latest CSS/WebGL/WebGPU), headless/always-on/multi-client capability, and
it stays reusable as the inside of a Tauri wrap if a true native window is ever wanted. Honest
limit accepted: serial flashing only on the machine running the server (run the one binary where
the boards are). Build our own screens/design system; reference the inherited RuView app
(`wifi-densepose-desktop`, ADR-052) for protocol facts only (NVS format), and drive our **own**
proven tools (`provision.py --auto`, `espflash`, the server's `mdns-sd`), never its UI/non-working code.
**Milestones A1–A4 in ADR-151 §7.***

1. **Full UI overhaul — the inherited `ui/` is demo-ware and gets replaced, not
   patched.** The Observatory's skeleton/heatmap theatrics are decoration driven by
   heuristics; the product UI shows only what's real. New app: presence / motion /
   breathing cards with confidence, node health (per-link pps + link RSSI), TX/RX
   topology view, calibration status & one-click recalibrate, event log
   (entered/left/still/moving), honest empty/degraded states. Stack: adopt the
   tooling pattern already proven in the inherited `dashboard/` (Vite + Lit +
   TypeScript + Playwright/axe tests) but build our screens from scratch, driven by
   `/ws/sensing` + the Phase-2 endpoints. Pose visualization returns only if/when
   Phase 5's pose track produces a real model.
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
- **Pose / limb-movement track** (upgraded from "out of scope" — assets exist):
  research models that predict limb/arm movement from CSI are real, and the inherited
  tree ships its own: `ruvnet/wifi-densepose-mmfi-pose` on HuggingFace (17-keypoint),
  the `cog-pose-estimation` crate to run it, the full `wifi-densepose-train` pipeline,
  and ADR-079's camera-supervised fine-tune design. **Honest caveat:** those weights
  are trained on MM-Fi research hardware (multi-antenna NICs, 114 subcarriers, high
  rate) — a large domain gap from a single-antenna ESP32 at ~40 fps. Path: (a) coarse
  limb/gesture classes from our own labeled recordings first, (b) full skeleton only
  via camera-assisted fine-tuning on our hardware (ADR-079). Do not block the core
  product on this.
- **Heart rate**: borderline on this hardware; attempt only with the controlled-link
  SNR, market as experimental.
- **Zones / rough localization**: TDM-rotate the TX role (each board takes turns
  transmitting) → up to 6 directed links → per-link presence = zone information.
- **Home Assistant integration**: MQTT publisher exists upstream; wire it to our
  *reliable* presence/motion/breathing only.
- **Multi-person**: explicitly out of scope until single-person is solid.

## 4b. Repo hygiene & CI policy
- The 22 inherited RuView GitHub workflows + dependabot config were **removed**
  (2026-06-12) — they ran on every push to this independent repo, failed, and
  spammed notifications (one was even cron-scheduled).
- ThroughNet gets its **own minimal CI** in Phase 3/4: firmware Docker build +
  size gate, sensing-server `cargo build` + tests, gate-tool lint. Nothing more
  until the product surface stabilizes.

## 4c. Inherited-asset inventory (audited 2026-06-12)
| Asset | Where | Use in ThroughNet |
|---|---|---|
| CSI-ratio (CFO/SFO cancel) | `v2/.../signal/src/csi_ratio.rs` | Phase 2 phase observable |
| Subcarrier top-K (variance ratio) | `.../subcarrier_selection.rs` | Phase 2 (replaces gate-tool hand-roll) |
| Hampel, phase sanitizer, hardware norm | `signal/src/` | Phase 2 preprocessing |
| Breathing / heart-rate extractors | `v2/crates/wifi-densepose-vitals` | Phase 2 vitals |
| Recording API | sensing-server `/api/v1/recording/*` | Phase 2 validation harness |
| MQTT + Home Assistant publisher | server `--mqtt-*`, `homecore-*`, ADR-115 | Phase 5 HA |
| Training pipeline (losses/eval/domain) | `v2/crates/wifi-densepose-train` | Phase 5 learned detectors |
| Pose model + runner + fine-tune design | HF `mmfi-pose`, `cog-pose-estimation`, ADR-079 | Phase 5 pose track |
| Vite+Lit+TS+Playwright tooling pattern | `dashboard/` (nvsim app) | Phase 4 UI rebuild template |
| Field-model calibration (we fixed it) | `sensing-server` + `ruvsense/field_model` | Phase 2 occupancy |

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
***PHASE 2 COMPLETE** (2026-06-13) — all four acceptance gates pass on real hardware:
presence FP 0%, detection 100%, latency 0 s, motion still-vs-walking 100% — including
the hardest case (a still subject breathing on a link line). Detection layer is locked.

**DIRECTION (set 2026-06-13):** with detection proven, the work pivots from research to
product. Build our **own** app from scratch (our design; the inherited RuView Tauri app is
reference-only) and **harden first** — mDNS discovery + multi-node robustness — before any
UI. See **Phase R** above. Current front:*
1. **Phase 2.4 — breathing — VALIDATED ON HARDWARE (2026-06-13).** `breathing.rs`:
   0.15–0.5 Hz bandpass → in-band bin selection → DFT spectral peak (interior
   0.20–0.45 Hz, parabolic-interpolated) → BPM, prominence confidence, measured-rate,
   gated on `present_still`, best-link, on `/throughnet/status`. Offline: still subject
   18.5 BPM/conf 3.6, empty → unknown. Live ±2 BPM run (paced 15 BPM metronome, 110 s
   poll, fresh empty-room baseline, 3-node mesh): estimate **15.0 BPM, error 0.0,
   conf 4.5 → PASS** — 24 post-lock `present_still` readings (range 13.8–16.7), locked
   to 15.0–15.7 with confidence rising to ~10 over a sustained 30 s window, 0 moving/
   absent misfires. Best-link picker correctly leaned on the stronger receiver (node 2);
   the weaker link rarely cleared the confidence floor — a geometry note, not a detector
   fault. `validate.py --breathing [--breathing-truth N]` is the canonical harness.
2. **Phase R — robustness foundation — CODE COMPLETE (2026-06-14).** R1 mDNS discovery
   (verified live), R2 multi-node auto-id + staleness-aware fusion, R3 scripted resilience
   gates (`--selftest`-green). Only the two R3 *live* runs (IP-flip, add-a-4th-board) remain,
   operator-in-the-loop. Full detail + status in **Phase R** above.
3. **Phase A — our own app (CURRENT).** Research spike + stack **DECIDED (ADR-151:
   server-as-shell)** 2026-06-14 — one self-contained sensing-server binary serving an
   embedded from-scratch Lit UI + localhost `/api/v1/setup/*` (native `espflash` flash +
   `--auto` provision), app-like launch, doctor preflight. **A1 in progress** — `app/`
   scaffolded (Vite + Lit + TS); the "Living Blueprint / Paper-craft" design system
   (tokens + chrome kit) and the `tn-live-view` diorama (three.js presence/motion/breathing,
   ported from the approved `app/prototypes/live-view.html`) are landed, mock-driven via a
   control panel that stands in for `/throughnet/status` (now also surfaces per-node `stale`)
   + `/ws/sensing`. Remaining A1: wire the real transport + the product cards (node health,
   calibration status, event log, honest empty/degraded states), Linux first.
   Then A2 embed (`rust-embed`), A3 in-app setup, A4 single-binary packaging (ADR-151 §7).
   Replaces the CLI-first framing of Phase 3.
4. **Second-room validation (R5)** — re-run `validate.py` in another room before
   calling the numbers "accuracy"; confirm the empty-floor normalization generalizes.

*Done 2026-06-13: state-machine debounce, validation harness (`validate.py`), the
motion observable across three iterations — absolute (failed on still-on-link) →
relative `motion÷presence` (fixed that, ~85%) → **1–6 Hz motion-band energy** (cascaded
HP+LP, empty-floor-normalized, OR-fused; rejects breathing/sway; 100% on hardware) — and
the **live breathing ±2 BPM validation** (paced 15 BPM → 15.0 BPM, error 0.0, PASS) on the
3-board fleet. Live bring-up also surfaced and fixed a `parse_esp32_frame` header-offset
bug (rssi/noise/sequence misaligned vs the firmware layout; rssi decoded to 0 for every
frame) and documented the host firewall step (open inbound UDP 5005 — ufw was eating CSI).*
