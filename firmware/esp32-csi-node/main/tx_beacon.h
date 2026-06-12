/**
 * @file tx_beacon.h
 * @brief ThroughNet Phase 1 — fixed-rate OFDM beacon illuminator (role=tx).
 *
 * Broadcasts small ESP-NOW frames at a fixed rate so radio-silent RX nodes
 * (role=rx, MAC-filtered to this node) receive a constant-rate CSI stream.
 * This replaces ambient-traffic sniffing with controlled bistatic
 * illumination (ROADMAP.md §3).
 *
 * CRITICAL: ESP-NOW's default PHY rate is 1 Mbps DSSS (802.11b), whose
 * preamble has no OFDM training fields — receivers get NO CSI from such
 * frames. This module forces an OFDM rate (HT20 MCS0) so every beacon
 * carries L-LTF + HT-LTF and triggers the RX CSI engine.
 */

#ifndef TX_BEACON_H
#define TX_BEACON_H

#include <stdint.h>
#include "esp_err.h"

/**
 * Start the beacon illuminator.
 *
 * Must be called after WiFi STA is connected (ESP-NOW rides the STA
 * interface and inherits its channel). Forces WIFI_PS_NONE for steady
 * timing.
 *
 * @param hz       Beacon rate in Hz (1..200).
 * @param node_id  This node's ID, embedded in the beacon payload.
 */
esp_err_t tx_beacon_init(uint16_t hz, uint8_t node_id);

/** Total beacons sent since boot. */
uint32_t tx_beacon_tx_count(void);

/** Beacons that failed to send. */
uint32_t tx_beacon_tx_fail(void);

#endif /* TX_BEACON_H */
