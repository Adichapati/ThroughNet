# ADR-151: ThroughNet Product App — Server-as-Shell architecture + own design system

| Field | Value |
|-------|-------|
| **Status** | Accepted |
| **Date** | 2026-06-14 |
| **Deciders** | Adithya |
| **Codebase target** | `wifi-densepose-sensing-server` (embed UI via `rust-embed`, add localhost setup/serial endpoints) + a new `app/` frontend (Vite + Lit + TypeScript). No new native shell crate. |
| **Relates to** | ROADMAP Phase A (our own app) / Phase R (robustness, complete); ADR-052 (inherited RuView Tauri desktop — **reference for mechanics only**), ADR-053 (inherited UI design system — superseded for ThroughNet), ADR-043 (sensing-server UI API), ADR-115 (Home Assistant — Phase 5) |

---

## 1. Context

ThroughNet's detection stack is proven (Phase 2 complete: presence FP 0%, detection 100%, motion still-vs-walking 100%, breathing ±2 BPM live PASS) and hardened (Phase R complete: mDNS discovery verified live, N-agnostic staleness-aware fusion, scripted resilience gates). The work now pivots from research to **product**: the app a non-expert uses to set up the fleet and read presence / motion / breathing.

The productization direction was set on 2026-06-13: **build our own app from scratch** (our design language, our screens), **not** adopt the inherited RuView Tauri app (`wifi-densepose-desktop`), which is referenced for reusable *mechanics* only. A research spike was required to pick the app stack before building.

### 1.1 What we already have (the spike's inventory)

- **Inherited RuView Tauri desktop crate** (`wifi-densepose-desktop`, ADR-052/054): Tauri v2 with Rust commands for `flash` (espflash subprocess + SHA-256 verify + progress events), `provision` (serial NVS, 115200 baud, checksum), `discovery` (mdns-sd), `ota`, `server`. **Most of its code has historically not worked / cost bug-fixing time** — it is a reading reference for protocol facts, not a dependency.
- **Our own proven mechanics** (validated on the live fleet, the better reference): `firmware/esp32-csi-node/provision.py --auto` (fleet auto-id, NVS provisioning), esptool/espflash flashing from the venv, and the sensing-server's `mdns-sd` advertiser (R1, verified live). We are **not dependent** on the inherited crate for any of this.
- **`dashboard/` tooling pattern** (nvsim app, ROADMAP says adopt): Vite + Lit 3 + TypeScript + Vitest + Playwright + axe (a11y), `@preact/signals-core` for state, a transport abstraction (`WsClient`), component-per-file Lit web components.
- **The sensing-server** already runs as the product backend (`./sensing-server --source esp32`): UDP `0.0.0.0:5005` CSI ingest, HTTP `127.0.0.1:8080`, WS `127.0.0.1:8765`, and the ThroughNet REST surface (`/api/v1/throughnet/status`, `/baseline/start|stop`).

### 1.2 The framing the spike sharpened

The 2026-06-13 framing was "native shell required because browsers can't do serial." The spike refined this: **a native server we already ship can do serial itself and expose flash/provision over HTTP** — so the browser never needs serial access. That collapses the "native shell" requirement into the binary we already produce. The decision below follows from that.

## 2. Decision

**Build the ThroughNet product app as "server-as-shell": the `wifi-densepose-sensing-server` binary serves an embedded, from-scratch web UI (`rust-embed`) and gains a small set of localhost-only setup/serial endpoints; the native server owns USB/serial (flash + provision), the browser is the renderer.** Ship as **one self-contained binary** (server + embedded UI + bundled firmware), launched app-like, with a doctor preflight for the known Linux traps.

The frontend is **our own design system and screens built from scratch** on the `dashboard/` tooling pattern (Vite + Lit + TypeScript + Playwright/axe). The inherited RuView UI is **not** reused. Inherited Rust mechanics are referenced for protocol facts only; the implementation drives our *own* proven tools.

### 2.1 Architecture

```
┌──────────────── one binary: throughnet-server ────────────────┐
│  Axum 127.0.0.1:8080                                           │
│    ├─ embeds the Lit UI (rust-embed)            ──▶ browser    │
│    ├─ /api/v1/throughnet/*  (status, baseline)  ← existing     │
│    ├─ /api/v1/setup/scan|flash|provision|doctor ← NEW, local   │
│    │      ▼ native: espflash (lib) + serial NVS               │
│    │   ESP32 over USB: flash · provision · monitor            │
│    └─ /ws/sensing  (live updates)                             │
│  UDP 0.0.0.0:5005  ◀── CSI ── boards (mDNS-discovered)        │
│  mDNS advertiser: _throughnet._udp.local (R1)                 │
└────────────────────────────────────────────────────────────────┘
   serial lives where the server runs; the browser has no serial
   setup endpoints bind 127.0.0.1 only — never the LAN
```

### 2.2 Key properties

- **One artifact, no new toolchain.** Adds `rust-embed` + a few Axum routes to the binary we already build. CI stays `cargo build` (the "own minimal CI" the ROADMAP wants). No Tauri CLI, no system-webview dev libs, no app-bundle/signing step.
- **No webview ceiling.** The UI runs in the user's real browser (Chromium/Firefox) → latest CSS / WebGL / WebGPU available. None of Tauri-on-Linux's WebKitGTK limitations apply (relevant for a future Phase-5 3D skeleton render).
- **Headless / always-on / multi-client.** The server can run with no display (NUC / Pi / homelab, systemd unit, docker-compose — ROADMAP Phase 4.2) and be viewed from any browser on the LAN, on multiple devices at once.
- **Lower-regret.** The UI (Lit + our design system, talking to the server over fetch/WS) is identical regardless of shell. If a true native window is ever wanted, a Tauri shell points its webview at the same embedded UI + same API — additive, no throwaway.

## 3. The design system (built, not inherited)

We define a **ThroughNet design system** from scratch:

- **Tokens** as CSS custom properties: color (with light/dark themes), type scale, spacing, radius, elevation, motion. Theming via a `data-theme` attribute on `:root`.
- **Components** (Lit, one per file, `tn-*` prefix): presence/motion/breathing cards with honest confidence, node-health rows (per-link pps + RSSI + `stale`), TX/RX topology view, calibration status + one-click recalibrate, event log (entered/left/still/moving), and explicit empty/degraded states. Pose visualization returns only if/when Phase 5 produces a real model.
- **Data**: driven by `GET /api/v1/throughnet/status` (`state`, `breathing_bpm`/`confidence`, per-node `present`/`moving`/`stale`/`presence_score`/`motion_score`/`baseline`/`last_update_ms`) + `/ws/sensing` + baseline start/stop.
- **Tooling**: Vite + Lit + TypeScript; Vitest unit; Playwright + axe for a11y/visual. Adopt the *pattern* from `dashboard/`, build the *screens* ourselves.

Honesty principle (ROADMAP §4.1): the UI shows only what's real — no skeleton/heatmap theatrics driven by heuristics.

## 4. In-app setup & serial

- **Flasher in Rust, not Python.** Use the `espflash` crate (library/sidecar) so flashing needs no Python/pip in the shipped product. (Bring-up used the venv's Python esptool; this is the productization step.)
- **Provisioning** reuses our proven `provision.py --auto` logic (fleet auto-id: first board = TX illuminator, later boards = RX locked to the TX MAC, lowest-free `node_id`) — called as a subprocess initially, ported to Rust later. Inherited `provision.rs` is a reading reference for the NVS byte format only, verified against our firmware.
- **Endpoints bind `127.0.0.1`** (the server's existing posture for HTTP/WS). Only UDP CSI ingest is `0.0.0.0`. So the setup/flash surface is **localhost-only by construction** — not reachable from the LAN.
- **Doctor preflight** for the traps we know cold (live bring-up memory): serial-group membership (`uucp`/`dialout` — needed to write `/dev/ttyACM*`), firewall (`ufw` UDP 5005 + 5353), port conflicts, board reachability, CSI rate. Detect and guide the fix.
- **App-like launch**: a `.desktop` entry (or the binary) starts the server and opens the UI via Chromium `--app=http://localhost:8080` (chromeless window) — recovers most of the "real app" feel without a browser tab or a native toolchain.

## 5. Alternatives considered

| Option | Verdict | Why |
|--------|---------|-----|
| **Server-as-shell** (chosen) | **Accepted** | One binary, no toolchain, no webview ceiling, headless/multi-client capable, reuses everything we ship, reusable as a future Tauri inside. Installs cleaner on Linux than a webview app. |
| **Tauri v2 desktop** | Rejected (for now) | Gives a true native window with full design freedom and a Rust backend that fits our codebase — genuinely strong, and better than Electron here. But adds the Tauri toolchain, depends on system **WebKitGTK** libs being present on Linux (a real "won't launch / missing libwebkit2gtk" install-friction point), can't run headless, and the webview lags Chromium on bleeding-edge features. Kept as a **future wrap** option since the UI is reusable. |
| **Electron** | Rejected | Same native-window benefit as Tauri but bundles Chromium + Node (~100–200 MB, high memory) and its native side is Node/JS — a foreign runtime to our all-Rust codebase (we'd still run the Rust server as a sidecar = three runtimes, and rewrite serial/flash in Node). Strictly dominated by Tauri for this project. |
| **Web UI + thin native helper** | Rejected | The "helper that owns serial" is exactly the sensing-server we already ship, so a *separate* helper just adds a second process + a localhost bridge to secure for no gain. Server-as-shell is this option with the helper = the server. |

### 5.1 The honest limitation that was weighed

With server-as-shell, **serial lives wherever the server process runs.** You can flash any board plugged into the machine running the server (the normal "set up on one machine, then the boards go wireless" workflow — fully covered). You **cannot** flash a board plugged into a *different* machine through that machine's browser alone, because the browser has no serial. The mitigation is trivial — ThroughNet is one binary, so to flash on another laptop you run ThroughNet on that laptop. The only scenario genuinely lost is "one central headless server + flash a board on a *remote* laptop through its browser," an unusual setup. (Tauri has local serial per installed machine, but that is functionally "run the product where the boards are" — the same answer.) **Decision:** accepted; the productization requirement that follows is simply a *smooth single-binary install + launch* on the setup machine.

## 6. Consequences

**Positive:** single shippable artifact matching ROADMAP Phase 4.2; no native toolchain / no webview system deps (cleaner Linux install); full latest-browser capabilities for the UI; headless/always-on/multi-client deployments; complete design freedom with zero inherited UI; not bound to the inherited crate's non-working code; reusable substrate for a future native window.

**Negative / honest:** launch is "open a browser to localhost" unless we wrap it in app-mode (mitigated, §4); serial flashing only on the machine running the server (§5.1); Linux serial-permission friction (`uucp`/`dialout`) exists regardless of stack and needs a doctor check; web-only native niceties (no native tray/menu/auto-update — web equivalents only).

**Neutral:** the inherited Tauri crate (`wifi-densepose-desktop`) and ADR-052/053 become reference material; not deleted, not depended on.

## 7. Scope / implementation plan (Phase A milestones)

1. **A1 — UI skeleton + design system.** New `app/` (Vite + Lit + TS), tokens + theming, the live presence/motion/breathing dashboard on `/api/v1/throughnet/status` + `/ws/sensing`, honest empty/degraded states. Vitest + Playwright/axe set up.
2. **A2 — embed + serve.** `rust-embed` the built UI into the sensing-server; serve at `127.0.0.1:8080`; app-mode launcher (`.desktop` + Chromium `--app`).
3. **A3 — in-app setup.** Localhost `/api/v1/setup/{scan,flash,provision,doctor}` endpoints: board/port scan, `espflash`-based flash with progress over WS, `--auto` provision, doctor preflight. Onboarding flow: flash → provision → mDNS-discover → calibrate → live.
4. **A4 — single-binary packaging.** Bundle firmware `.bin`s; one self-contained Linux binary; smooth install (no Python, no system webview deps); systemd unit + docker-compose for always-on.

Each milestone is a discrete, tested unit (per the autonomous project flow). Hardware-gated steps (real flash/provision on a board) are marked as the explicit pending gate, per the no-unproven-layers discipline.

## 8. Open questions

- **Provisioning: subprocess `provision.py` vs. native Rust port** — start with subprocess (proven), port to Rust in A3/A4 to drop the Python dependency from the shipped binary.
- **Cross-platform** — Linux first (decided). Windows/macOS later; the browser UI is already portable, only the serial/doctor layer needs per-OS work.
- **App-mode launch fallback** — if Chromium `--app` is unavailable, open the default browser; revisit a Tauri wrap only if product-feel demands a true native window.
