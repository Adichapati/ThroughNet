# ThroughNet — Upstream Corrections Log

Running list of bugs and doc-gaps found in the upstream **RuView** repo while
bringing it up on real, display-less ESP32-S3 hardware. Each is either fixed or
worked-around in ThroughNet and is a candidate to file upstream. Keep appending.

Legend: 🔴 blocker · 🟡 friction · ✅ fixed in ThroughNet · ⏳ open

---

## 1. 🔴✅ Shipped firmware binaries produce zero CSI on display-less boards

**Symptom:** A display-less ESP32-S3 DevKitC associates to WiFi fine (RSSI
updates) but every tick reads `yield=0pps motion=0.00 presence=0.00` forever —
no sensing ever works from the shipped artifacts.

**Root cause:** `firmware/esp32-csi-node/main/main.c:424` only calls
`csi_collector_enable_data_capture()` (the MGMT→MGMT+**DATA** promiscuous-filter
upgrade, RuView#893) when `has_display == false`. With a MGMT-only filter, DATA
frames are dropped before reaching the CSI engine, so only sparse beacons remain
(DSSS on ch1, no CSI) → yield collapses to 0. Pinging the board does nothing
because those DATA frames are filtered out.

**Both shipped binaries fail differently:**
- `release_bins/esp32-csi-node.bin` (generic, v0.6.7) is a **display build**
  (SH8601 LCD/QSPI driver compiled in); its runtime panel probe false-positives
  on a panel-less board → DATA capture stays off.
- `release_bins/s3-fair-adr110/esp32-csi-node.bin` (v0.6.6) **predates the fixes**
  entirely → boots MGMT-only, no self-ping.

**ThroughNet fix:** build the v0.7.0 source with display compiled out
(`sdkconfig.nodisp` = `# CONFIG_DISPLAY_ENABLE is not set`, layered over the 8 MB
`sdkconfig.defaults`). Then `has_display` is hard-false → MGMT+DATA engages and
CSI flows (boot log shows `CSI filter upgraded to MGMT+DATA (no display)`).
Prebuilt result in `release_bins/throughnet-s3-nodisp/`.

**Upstream action:** republish `release_bins/` from v0.7.0 with clearly-labeled
**display** and **headless** variants, and document which to flash for a bare
DevKitC.

## 2. 🔴✅ README firmware build pins ESP-IDF v5.2, which fails

The build command in `firmware/esp32-csi-node/README.md` (and the top-level
README) uses `espressif/idf:v5.2`. Building the current v0.7.0 source with it
fails at cmake: `Failed to resolve component 'esp_driver_uart'` (that component
only exists in ESP-IDF v5.3+; in v5.2 UART is inside the monolithic `driver`
component).

**Fix:** use `espressif/idf:v5.4` — which is what the repo's own
`.github/workflows/firmware-ci.yml` and QEMU docs already use. The README is
just stale.

## 3. 🟡 Docs are Windows-only for serial

Firmware README + top README only show the Windows flow (`COM7`). No Linux
guidance: the board is `/dev/ttyACM0` or `/dev/ttyUSB0`, and on Arch the user
must be in the **`uucp`** group for serial access.

## 4. 🟡 `esptool` v5.x renamed `write_flash` → `write-flash`

README still uses the old underscore form (works but prints a deprecation
warning on esptool 5.x).

## 5. 🟡 `provision.py` dependency + PEP 668 not documented

`provision.py` needs `esp-idf-nvs-partition-gen` (only mentioned in a docstring
comment, not the quick-start). On Arch, system Python is externally-managed
(PEP 668), so a venv/pipx is required — undocumented.

## 6. 🟡 HuggingFace model format not loadable by the sensing-server

Pre-existing, self-documented in the upstream README: the sensing-server
`--model` flag only parses binary RVF, not the published JSONL container, so the
HF weights can't be loaded live (run without `--model` for now).

## 7. 🟡⏳ Gateway self-ping ineffective on Google WiFi → low CSI yield

The firmware's `csi_start_self_ping` (#521/#954) targets the gateway (.1) for a
50 Hz OFDM CSI floor, but Google WiFi appears to ignore client ICMP, so yield
stays low (~5 pps) and motion/presence read 0. `csi_inject_ndp_frame` is still a
TODO stub (`csi_collector.c:765`). Needs a more robust on-device CSI traffic
source (self-ping a host that replies, NDP injection, channel pinning, or
documenting that ambient channel traffic is required). **Open — yield tuning is
the current focus.**

## 8. 🟡✅ Host firewall (ufw) silently drops the CSI UDP stream (Linux)

Upstream docs only give a *Windows* firewall rule for UDP 5005. On Linux with **ufw**
active, inbound UDP 5005 is dropped and the sensing server receives nothing — while
ping/ICMP still works, so it looks like a board fault. Fix: `sudo ufw allow 5005/udp`.
Upstream action: document the Linux rule alongside the Windows one.

## 9. 🔴✅ Empty-room calibration collected 0 frames (three compounding bugs)

`/api/v1/calibration/*` never worked on the ESP32 path. Fixed in ThroughNet:
- **Chicken-and-egg guard:** `field_bridge::maybe_feed_calibration` only fed when status
  was already `Collecting`, but the only thing that sets `Collecting` is the first feed →
  it never started. Now also feeds while `Uncalibrated`.
- **Feed wired only into the vitals-packet handlers**, which this firmware's packet mix
  never triggers. Added a feed on the **CSI-frame path** (`main.rs`), where data flows.
- **Hardcoded 56 subcarriers** but the ESP32 streams **192** → `feed_calibration` rejected
  every frame (`Dimension mismatch`). `calibration_start` now sizes the field model to the
  live frame width.
- Also lowered `min_calibration_frames` 12_000 → 1_800 (~60 s vs ~6.5 min).

Result: calibration reaches `Fresh` (verified: 1861 frames, eigenvalue-based occupancy).
Caveat: needs traffic on the channel to keep CSI yield up during collection (see #7).
