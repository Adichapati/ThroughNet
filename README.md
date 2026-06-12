# ThroughNet

**Through-wall human sensing from ordinary WiFi.** Detect presence, breathing, heart rate, and motion using low-cost **ESP32-S3** Channel State Information (CSI) — no cameras, no wearables.

> ThroughNet is built on **RuView / WiFi-DensePose** (MIT, © ruvnet). The full upstream README is preserved as [`UPSTREAM-RUVIEW-README.md`](UPSTREAM-RUVIEW-README.md); attribution and the list of changes are in [`NOTICE`](NOTICE).

---

## Status — 2026-06-12 (early WIP)

| Capability | State |
|------------|-------|
| ESP32-S3 CSI capture pipeline, end-to-end on 1 node | ✅ Verified working (custom display-off firmware) |
| CSI yield | ⚠️ Low (~5 pps) — tuning in progress (target ~20 Hz) |
| 3-node mesh, sensing-server UI, vitals validation | ⏳ Pending |
| Learned 17-keypoint pose / skeleton | ❌ Not functional upstream (no pretrained weights). ThroughNet focuses on **presence + vitals + motion** first. |

Honest scope: this is a research/hobby foundation, not a finished product. See [`CORRECTIONS.md`](CORRECTIONS.md) for the upstream issues being fixed along the way.

## Hardware

- 3× **ESP32-S3 DevKitC** (8 MB flash + PSRAM, **display-less**). The plain ESP32 / ESP32-C3 won't work (single-core).
- Any 2.4 GHz WiFi network as the RF illuminator (tested on a Google WiFi mesh).
- A Linux host for flashing and running the sensing server.

## Quickstart (the verified path)

The upstream pre-built binaries **do not produce CSI on display-less S3 boards** (they stay MGMT-only → `yield=0pps`; see [`CORRECTIONS.md`](CORRECTIONS.md) #1). ThroughNet builds the firmware with the **display compiled out** so the MGMT+DATA CSI capture engages.

```bash
# 1. Build firmware — display OFF, ESP-IDF v5.4 (NOT v5.2; see CORRECTIONS.md #2)
cd firmware/esp32-csi-node
# sdkconfig.nodisp already present: "# CONFIG_DISPLAY_ENABLE is not set"
docker run --rm -v "$PWD:/project" -w /project espressif/idf:v5.4 bash -c \
  "export SDKCONFIG_DEFAULTS='sdkconfig.defaults;sdkconfig.nodisp'; \
   rm -rf build sdkconfig && idf.py set-target esp32s3 && idf.py build"

# 2. Flash (or use the prebuilt binaries in release_bins/throughnet-s3-nodisp/)
python -m esptool --chip esp32s3 --port /dev/ttyACM0 -b 460800 \
  --before default_reset --after hard_reset write-flash \
  --flash_mode dio --flash_size 8MB --flash_freq 80m \
  0x0 build/bootloader/bootloader.bin \
  0x8000 build/partition_table/partition-table.bin \
  0xf000 build/ota_data_initial.bin \
  0x20000 build/esp32-csi-node.bin

# 3. Provision WiFi + node identity (one node at a time)
python provision.py --port /dev/ttyACM0 --chip esp32s3 \
  --ssid "<YOUR_SSID>" --password "<YOUR_PASS>" --target-ip <YOUR_PC_LAN_IP> \
  --node-id 1 --tdm-slot 0 --tdm-total 3 --edge-tier 2
#   node 2 -> --node-id 2 --tdm-slot 1 ;  node 3 -> --node-id 3 --tdm-slot 2

# 4. Run the sensing server + open the UI
cd ../../v2
cargo run -p wifi-densepose-sensing-server -- --http-port 3000 --source auto
#   then open http://localhost:3000
```

**Prebuilt display-off binaries:** [`firmware/esp32-csi-node/release_bins/throughnet-s3-nodisp/`](firmware/esp32-csi-node/release_bins/throughnet-s3-nodisp/) (ESP32-S3, 8 MB, v0.7.0 source, display compiled out).

**Serial port note (Linux):** the board enumerates as `/dev/ttyACM0` (or `/dev/ttyUSB0`); on Arch you must be in the `uucp` group for access.

## What's different from upstream RuView

ThroughNet keeps the RuView codebase as its foundation but corrects the issues that block a clean build/run on real, display-less hardware. The running list — intended both as ThroughNet's changelog and as upstream fix candidates — lives in [`CORRECTIONS.md`](CORRECTIONS.md).

## License

MIT, inherited from RuView. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
