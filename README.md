<div align="center">

# ThroughNet

**Camera-free human sensing from ordinary WiFi.**
Presence, motion, and breathing — from a pair of low-cost **ESP32-S3** boards and the Channel State Information (CSI) of the radio waves between them. No cameras. No wearables. No new wiring.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Rust](https://img.shields.io/badge/rust-stable-orange.svg)
![Hardware](https://img.shields.io/badge/hardware-ESP32--S3-informational.svg)
![Status](https://img.shields.io/badge/sensing-validated_on_hardware-success.svg)

</div>

---

## What it is

A person moving through a room perturbs the WiFi signal around them. ThroughNet turns one ESP32-S3 into a quiet **illuminator** (a fixed-rate beacon) and the others into radio-silent **receivers** that measure how that beacon's CSI changes — then scores the room for **presence**, **motion**, and **breathing rate**, live, in your browser.

It runs as **one self-contained binary**: a Rust server that flashes and provisions the boards over USB, ingests their CSI over the LAN, computes the sensing verdict, and serves its own web UI. Plug in boards, open a browser, follow the setup, and watch the room.

> ThroughNet builds on **RuView / WiFi-DensePose** (MIT, © ruvnet). The full upstream README is preserved as [`UPSTREAM-RUVIEW-README.md`](UPSTREAM-RUVIEW-README.md); attribution and the change list are in [`NOTICE`](NOTICE) and [`CORRECTIONS.md`](CORRECTIONS.md).

## Status

| Capability | State |
|---|---|
| ESP32-S3 CSI capture, end-to-end | ✅ Verified on real, display-less hardware |
| **Presence** detection | ✅ 0% false-positive (empty), 100% detection, <10 s latency — live 3-board fleet |
| **Motion** (still vs. walking) | ✅ 100% on hardware (motion-band energy, breathing-rejecting) |
| **Breathing** rate | ✅ ±0 BPM at a paced 15 BPM run (best-link spectral estimate) |
| Multi-node resilience (add/drop nodes, IP changes) | ✅ mDNS discovery + staleness-aware fusion (R1–R3) |
| **Product app** (single binary, embedded UI, in-app setup) | ✅ Onboarding → live view → fleet management → OTA |
| Learned 17-keypoint pose / skeleton | ❌ Not the focus — no pretrained weights upstream; ThroughNet targets presence + vitals + motion |

Honest scope: this is a working research/product foundation, not a polished consumer device. Numbers above were measured on one 3-board fleet in one room; a second-room validation pass is still pending.

## How it works

ThroughNet uses a **bistatic** link topology — one transmitter, many receivers:

```
        ┌─────────────┐        WiFi CSI         ┌─────────────┐
        │  TX (node)  │  ·······beacon·······>  │  RX (node)  │
        │ illuminator │     a person here       │  receiver   │
        │  ~100 Hz    │   perturbs the signal   │ radio-silent│
        └─────────────┘          │              └──────┬──────┘
                                  │                     │ CSI / UDP :5005
                                ( ʘ )                   ▼
                                  human          ┌──────────────┐
                                                 │ sensing-server│  presence · motion
                                                 │  (one binary) │  breathing · live UI
                                                 └──────┬───────┘
                                                        │ http://localhost:8080
                                                        ▼
                                                   your browser
```

- The **TX illuminator** sends a fixed-rate OFDM beacon and captures no CSI of its own.
- Each **RX** is locked to the TX's MAC (`filter_mac`) and channel, so it measures only the illuminator's signal — quiet, repeatable, and immune to ambient WiFi churn.
- The server fuses every RX link (staleness-gated, N-agnostic), scores presence/motion in the right frequency bands, and extracts breathing from the band the motion detector rejects (0.15–0.5 Hz).

## Hardware

| Device | Role | Notes | ~Cost |
|---|---|---|---|
| **ESP32-S3 DevKitC** (8 MB flash + PSRAM) | TX illuminator + RX nodes | Dual-core; the supported board. **Display-less.** | ~$9 |
| ESP32-S3 SuperMini (4 MB) | RX (compact) | Same chip, smaller | ~$6 |
| Any 2.4 GHz WiFi network | LAN transport | The boards and host share it | — |
| Linux host | Runs the server, flashes boards | USB for setup; LAN for sensing | — |

**Not supported:** the original ESP32 and ESP32-C3 — single-core, can't run the CSI DSP pipeline.

## Quickstart

The whole product is one binary that embeds both the web UI and the board firmware.

```bash
# 1. Build the self-contained binary (embedded UI + ESP32 firmware)
cd v2
cargo build --release --features bundle -p wifi-densepose-sensing-server

# 2. Open the firewall for CSI + mDNS (the #1 gotcha — ufw silently drops these)
sudo ufw allow 5005/udp && sudo ufw allow 5353/udp

# 3. Run it FROM THE REPO ROOT (so in-app flash/provision can find their tools)
cd ..
./v2/target/release/sensing-server --source esp32

# 4. Open the app
xdg-open http://localhost:8080
```

First run drops you into an **onboarding wizard** that does everything from the browser:

1. **Prepare** — a host preflight (serial access, firewall, CSI ingest).
2. **Flash** — writes the bundled firmware to a board over USB.
3. **Connect** — provisions WiFi + role; the first board becomes the **TX illuminator**, the rest **RX** locked to it.
4. **Place** — positions the boards across the room.
5. **Calibrate** — captures an empty-room baseline (this is the switch that arms sensing).

After setup, the home view is a live diorama of the room with presence/breathing overlays. Already set up? It skips straight to the live view (`?view=live` jumps there directly).

> **One-shot launcher:** [`scripts/throughnet-app.sh`](scripts/throughnet-app.sh) builds the UI + binary and opens it app-style in Chromium.

### Fleet management

Beyond first-run, the app gives you full control of the hardware whenever you want:

- **Devices** tab — every board the system knows (provisioned ∪ streaming), with per-board **re-provision**, **re-flash** (armed, with a TX mesh-blackout warning), explicit **role** assignment, and **OTA-over-network** firmware updates for deployed nodes (PSK-authed A/B flash, no USB).
- **Server** tab — runtime status, a live tail of the server's own log, and restart / shutdown controls.

Manual CLI provisioning is still available:

```bash
python firmware/esp32-csi-node/provision.py --port /dev/ttyACM0 --chip esp32s3 \
  --auto --ssid "<SSID>" --password "<PASS>"   # first board = TX, later = RX
```

## Repository layout

```
ThroughNet/
├── v2/crates/            Rust workspace (the active codebase)
├── firmware/esp32-csi-node/   ESP32-S3 C firmware + provision.py
├── app/                  Product web app — Vite + Lit + TypeScript
├── tools/gate/           ThroughNet Phase-1 gate + Phase-2 validation harness
├── docs/adr/             Architecture Decision Records (149)
├── archive/v1/           Python v1 (reference + deterministic proof bundle)
└── ROADMAP.md            Phases, acceptance gates, current status
```

### Key Rust crates

| Crate | Purpose |
|---|---|
| `wifi-densepose-sensing-server` | The product binary — Axum server, CSI ingest, ThroughNet scoring, embedded UI + firmware, in-app setup |
| `wifi-densepose-signal` | SOTA signal processing + RuvSense multistatic sensing |
| `wifi-densepose-core` | Core types, CSI frame primitives, traits |
| `wifi-densepose-vitals` | ESP32 CSI-grade vital-sign extraction |
| `wifi-densepose-hardware` | ESP32 aggregator, TDM protocol, channel hopping |
| `wifi-densepose-ruvector` | RuVector integration + cross-viewpoint fusion |
| `wifi-densepose-nn` / `-train` | Neural inference + training pipeline |
| `wifi-densepose-mat` | Mass Casualty Assessment — disaster survivor detection |
| `wifi-densepose-cli` | CLI tool (`wifi-densepose`) |

(The workspace contains additional crates beyond the ThroughNet track — see [`CLAUDE.md`](CLAUDE.md) for the full map.)

## Build & test

```bash
# Rust workspace tests (no GPU needed)
cd v2 && cargo test --workspace --no-default-features

# Deterministic pipeline proof (SHA-256 trust kill-switch)
python archive/v1/data/proof/verify.py        # expect: VERDICT: PASS

# Phase-2 sensing validation against a running server
python tools/gate/validate.py                 # presence / motion / breathing gates
```

Validation is reproducible end-to-end: the witness bundle (ADR-028) bundles the test logs, firmware hashes, and the deterministic proof into a self-verifying archive (`bash scripts/generate-witness-bundle.sh`).

## Documentation

- [`ROADMAP.md`](ROADMAP.md) — phases, acceptance gates, what's done and what's next
- [`docs/adr/`](docs/adr/) — Architecture Decision Records (the project's design history)
- [`docs/user-guide.md`](docs/user-guide.md) — setup and operation
- [`CORRECTIONS.md`](CORRECTIONS.md) — upstream bugs found and fixed bringing this up on real hardware
- [`CHANGELOG.md`](CHANGELOG.md) — detailed change log
- [`CLAUDE.md`](CLAUDE.md) — full crate / module / ADR map

## License

MIT, inherited from RuView / WiFi-DensePose. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
