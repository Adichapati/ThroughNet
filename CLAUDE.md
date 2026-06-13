# wifi-densepose — Claude Code project guide

## Project: wifi-densepose

WiFi-based human pose estimation using Channel State Information (CSI).
Dual codebase: Python v1 (`v1/`) and Rust port (`v2/`).

### Key Rust Crates
| Crate | Description |
|-------|-------------|
| `wifi-densepose-core` | Core types, traits, error types, CSI frame primitives |
| `wifi-densepose-signal` | SOTA signal processing + RuvSense multistatic sensing (16 modules) |
| `wifi-densepose-nn` | Neural network inference (ONNX, PyTorch, Candle backends) |
| `wifi-densepose-train` | Training pipeline with ruvector integration + ruview_metrics |
| `wifi-densepose-mat` | Mass Casualty Assessment Tool — disaster survivor detection |
| `wifi-densepose-hardware` | ESP32 aggregator, TDM protocol, channel hopping firmware |
| `wifi-densepose-ruvector` | RuVector v2.0.4 integration + cross-viewpoint fusion (5 modules) |
| `wifi-densepose-wasm` | WebAssembly bindings for browser deployment |
| `wifi-densepose-cli` | CLI tool (`wifi-densepose` binary) |
| `wifi-densepose-sensing-server` | Lightweight Axum server for WiFi sensing UI |
| `wifi-densepose-wifiscan` | Multi-BSSID WiFi scanning (ADR-022) |
| `wifi-densepose-vitals` | ESP32 CSI-grade vital sign extraction (ADR-021) |
| `nvsim` | Deterministic NV-diamond magnetometer pipeline simulator (ADR-089) — standalone leaf, WASM-ready |
| `vendor/rvcsi` (submodule) | **rvCSI** — edge RF sensing runtime (ADR-095/096): 9 crates (`rvcsi-core`/`-dsp`/`-events`/`-adapter-file`/`-adapter-nexmon`/`-ruvector`/`-runtime`/`-node`/`-cli`). Vendored under `vendor/rvcsi`. Not a `v2/` workspace member — depend on the published crates (or the submodule's `crates/rvcsi-*` paths). Normalized `CsiFrame`/`CsiWindow`/`CsiEvent` schema, validate-before-FFI, reusable DSP, typed confidence-scored events, the napi-c Nexmon shim (real nexmon_csi `.pcap` from a Raspberry Pi 5 / 4 / 3B+ — BCM43455c0), the napi-rs SDK, the `rvcsi` CLI. |
| `ruview-swarm` | Drone swarm control system (ADR-148) — hierarchical-mesh topology, Raft consensus, MARL, CSI sensing payload, MAVLink/PX4 compat |

### RuvSense Modules (`signal/src/ruvsense/`)
| Module | Purpose |
|--------|---------|
| `multiband.rs` | Multi-band CSI frame fusion, cross-channel coherence |
| `phase_align.rs` | Iterative LO phase offset estimation, circular mean |
| `multistatic.rs` | Attention-weighted fusion, geometric diversity |
| `coherence.rs` | Z-score coherence scoring, DriftProfile |
| `coherence_gate.rs` | Accept/PredictOnly/Reject/Recalibrate gate decisions |
| `pose_tracker.rs` | 17-keypoint Kalman tracker with AETHER re-ID embeddings |
| `field_model.rs` | SVD room eigenstructure, perturbation extraction |
| `tomography.rs` | RF tomography, ISTA L1 solver, voxel grid |
| `longitudinal.rs` | Welford stats, biomechanics drift detection |
| `intention.rs` | Pre-movement lead signals (200-500ms) |
| `cross_room.rs` | Environment fingerprinting, transition graph |
| `gesture.rs` | DTW template matching gesture classifier |
| `adversarial.rs` | Physically impossible signal detection, multi-link consistency |
| `cir.rs` | ADR-134 CSI→CIR via ISTA L1 sparse recovery (NeumannSolver warm-start) |
| `calibration.rs` | ADR-135 empty-room baseline (Welford amplitude + von Mises phase, drift trigger) |

### Cross-Viewpoint Fusion (`ruvector/src/viewpoint/`)
| Module | Purpose |
|--------|---------|
| `attention.rs` | CrossViewpointAttention, GeometricBias, softmax with G_bias |
| `geometry.rs` | GeometricDiversityIndex, Cramer-Rao bounds, Fisher Information |
| `coherence.rs` | Phase phasor coherence, hysteresis gate |
| `fusion.rs` | MultistaticArray aggregate root, domain events |

### RuVector v2.0.4 Integration (ADR-016 complete, ADR-017 proposed)
All 5 ruvector crates integrated in workspace:
- `ruvector-mincut` → `metrics.rs` (DynamicPersonMatcher) + `subcarrier_selection.rs`
- `ruvector-attn-mincut` → `model.rs` (apply_antenna_attention) + `spectrogram.rs`
- `ruvector-temporal-tensor` → `dataset.rs` (CompressedCsiBuffer) + `breathing.rs`
- `ruvector-solver` → `subcarrier.rs` (sparse interpolation 114→56) + `triangulation.rs`
- `ruvector-attention` → `model.rs` (apply_spatial_attention) + `bvp.rs`

### Architecture Decisions
ADRs live in `docs/adr/`. Key ones:
- ADR-014: SOTA signal processing (Accepted)
- ADR-015: MM-Fi + Wi-Pose training datasets (Accepted)
- ADR-016: RuVector training pipeline integration (Accepted — complete)
- ADR-017: RuVector signal + MAT integration (Proposed)
- ADR-024: Contrastive CSI embedding / AETHER (Accepted)
- ADR-027: Cross-environment domain generalization / MERIDIAN (Accepted)
- ADR-028: ESP32 capability audit + witness verification (Accepted)
- ADR-029: RuvSense multistatic sensing mode (Proposed)
- ADR-030: RuvSense persistent field model (Proposed)
- ADR-031: RuView sensing-first RF mode (Proposed)
- ADR-032: Multistatic mesh security hardening (Proposed)
- ADR-148: Drone swarm control system / `ruview-swarm` (In Progress)

### Supported Hardware

| Device | Port | Chip | Role | Cost |
|--------|------|------|------|------|
| ESP32-S3 (8MB flash) | COM9 (was COM7) | Xtensa dual-core | WiFi CSI sensing node | ~$9 |
| ESP32-S3 SuperMini (4MB) | — | Xtensa dual-core | WiFi CSI (compact) | ~$6 |
| ESP32-C6 + Seeed MR60BHA2 | COM12 (was COM4) | RISC-V + 60 GHz FMCW | mmWave HR/BR/presence + WiFi CSI | ~$15 |
| HLK-LD2410 | — | 24 GHz FMCW | Presence + distance | ~$3 |

**Not supported:** ESP32 (original), ESP32-C3 — single-core, can't run CSI DSP pipeline.

### Build & Test Commands (this repo)
```bash
# Rust — full workspace tests (~2 min)
cd v2
cargo test --workspace --no-default-features

# Rust — single crate check (no GPU needed)
cargo check -p wifi-densepose-train --no-default-features

# Python — deterministic proof verification (SHA-256)
python archive/v1/data/proof/verify.py

# Python — test suite
cd archive/v1 && python -m pytest tests/ -x -q
```

### ESP32 Firmware Build (Windows — Python subprocess required)
```bash
# Build 8MB firmware (real WiFi CSI mode, no mocks)
# See CLAUDE.local.md for the full Python subprocess command
# Key: must strip MSYSTEM env vars for ESP-IDF v5.4 on Git Bash

# Build 4MB firmware
cp sdkconfig.defaults.4mb sdkconfig.defaults
# then same build process

# Flash to COM7
# [python, idf_py, '-p', 'COM7', 'flash']

# Provision WiFi
python firmware/esp32-csi-node/provision.py --port COM7 \
  --ssid "YourWiFi" --password "secret" --target-ip 192.168.1.20

# Monitor serial
python -m serial.tools.miniterm COM7 115200
```

### Firmware Release Process
1. Build 8MB from `sdkconfig.defaults.template` (no mock)
2. Build 4MB from `sdkconfig.defaults.4mb` (no mock)
3. Save 6 binaries: `esp32-csi-node.bin`, `bootloader.bin`, `partition-table.bin`, `ota_data_initial.bin`, `esp32-csi-node-4mb.bin`, `partition-table-4mb.bin`
4. Tag: `git tag v0.X.Y-esp32 && git push origin v0.X.Y-esp32`
5. Release: `gh release create v0.X.Y-esp32 <binaries> --title "..." --notes-file ...`
6. Verify on real hardware (COM7) before publishing
7. **CRITICAL:** Always test with real WiFi CSI, not mock mode — mock missed the Kconfig threshold bug

### Crate Publishing Order
Crates must be published in dependency order:
1. `wifi-densepose-core` (no internal deps)
2. `wifi-densepose-vitals` (no internal deps)
3. `wifi-densepose-wifiscan` (no internal deps)
4. `wifi-densepose-hardware` (no internal deps)
5. `wifi-densepose-signal` (depends on core)
6. `wifi-densepose-nn` (no internal deps, workspace only)
7. `wifi-densepose-ruvector` (no internal deps, workspace only)
8. `wifi-densepose-train` (depends on signal, nn)
9. `wifi-densepose-mat` (depends on core, signal, nn)
10. `wifi-densepose-wasm` (depends on mat)
11. `wifi-densepose-sensing-server` (depends on wifiscan)
12. `wifi-densepose-cli` (depends on mat)

### Validation & Witness Verification (ADR-028)

**After any significant code change, run the full validation:**

```bash
# 1. Rust tests — must pass, 0 failed
cd v2
cargo test --workspace --no-default-features

# 2. Python proof — must print VERDICT: PASS
cd ..
python archive/v1/data/proof/verify.py

# 3. Generate witness bundle (includes both above + firmware hashes)
bash scripts/generate-witness-bundle.sh

# 4. Self-verify the bundle — must be 7/7 PASS
cd dist/witness-bundle-ADR028-*/
bash VERIFY.sh
```

**If the Python proof hash changes** (e.g., numpy/scipy version update):
```bash
# Regenerate the expected hash, then verify it passes
python archive/v1/data/proof/verify.py --generate-hash
python archive/v1/data/proof/verify.py
```

**Witness bundle contents** (`dist/witness-bundle-ADR028-<sha>.tar.gz`):
- `WITNESS-LOG-028.md` — 33-row attestation matrix with evidence per capability
- `ADR-028-esp32-capability-audit.md` — Full audit findings
- `proof/verify.py` + `expected_features.sha256` — Deterministic pipeline proof
- `test-results/rust-workspace-tests.log` — Full cargo test output
- `firmware-manifest/source-hashes.txt` — SHA-256 of all 7 ESP32 firmware files
- `crate-manifest/versions.txt` — All crates with versions
- `VERIFY.sh` — One-command self-verification for recipients

**Key proof artifacts:**
- `archive/v1/data/proof/verify.py` — Trust Kill Switch: feeds reference signal through production pipeline, hashes output
- `archive/v1/data/proof/expected_features.sha256` — Published expected hash
- `archive/v1/data/proof/sample_csi_data.json` — 1,000 synthetic CSI frames (seed=42)
- `docs/WITNESS-LOG-028.md` — 11-step reproducible verification procedure
- `docs/adr/ADR-028-esp32-capability-audit.md` — Complete audit record

### ThroughNet (active product track)
Camera-free presence / motion / breathing from controlled bistatic TX/RX links. See
`ROADMAP.md` for phases and acceptance gates, and `tools/gate/` for the Phase-1 gate
and the Phase-2 validation harness (`validate.py`).

### Branch
Default branch: `main`.

---

## Behavioral Rules

- Do what has been asked; nothing more, nothing less
- NEVER create files unless they're absolutely necessary for achieving your goal
- ALWAYS prefer editing an existing file to creating a new one
- NEVER proactively create documentation files (*.md) or README files unless explicitly requested
- NEVER save working files, text/mds, or tests to the root folder
- ALWAYS read a file before editing it
- NEVER commit secrets, credentials, or .env files
- Commit or push only when asked

## File Organization

- NEVER save to root folder — use the directories below
- `docs/adr/` — Architecture Decision Records
- `docs/ddd/` — Domain-Driven Design models
- `v2/crates/` — Rust workspace crates
- `v2/crates/wifi-densepose-signal/src/ruvsense/` — RuvSense multistatic modules
- `v2/crates/wifi-densepose-ruvector/src/viewpoint/` — Cross-viewpoint fusion
- `v2/crates/wifi-densepose-hardware/src/esp32/` — ESP32 TDM protocol
- `firmware/esp32-csi-node/main/` — ESP32 C firmware (channel hopping, NVS config, TDM)
- `archive/v1/src/` — Python source (core, hardware, services, api)
- `archive/v1/data/proof/` — Deterministic CSI proof bundles
- `tools/gate/` — ThroughNet Phase-1 gate + Phase-2 validation tooling

## Project Architecture

- Follow Domain-Driven Design with bounded contexts
- Keep files under 500 lines
- Use typed interfaces for all public APIs
- Prefer TDD London School (mock-first) for new code
- Use event sourcing for state changes
- Ensure input validation at system boundaries

## Pre-Merge Checklist

Before merging any PR, verify each item applies and is addressed:

1. **Rust tests pass** — `cargo test --workspace --no-default-features` (0 failed)
2. **Python proof passes** — `python archive/v1/data/proof/verify.py` (VERDICT: PASS)
3. **README.md** — Update platform tables, crate descriptions, hardware tables, feature summaries if scope changed
4. **CLAUDE.md** — Update crate table, ADR list, module tables if scope changed
5. **CHANGELOG.md** — Add entry under `[Unreleased]` with what was added/fixed/changed
6. **User guide** (`docs/user-guide.md`) — Update if new data sources, CLI flags, or setup steps were added
7. **ADR index** — Update ADR count in README docs table if a new ADR was created
8. **Witness bundle** — Regenerate if tests or proof hash changed: `bash scripts/generate-witness-bundle.sh`
9. **Docker Hub image** — Only rebuild if Dockerfile, dependencies, or runtime behavior changed
10. **Crate publishing** — Only needed if a crate is published to crates.io and its public API changed
11. **`.gitignore`** — Add any new build artifacts or binaries
12. **Security audit** — Run security review for new modules touching hardware/network boundaries

## Security Rules

- NEVER hardcode API keys, secrets, or credentials in source files
- NEVER commit .env files or any file containing secrets
- Always validate user input at system boundaries
- Always sanitize file paths to prevent directory traversal
