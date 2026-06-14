/**
 * @file mdns_resolver.h
 * @brief ThroughNet R1 (ROADMAP Phase R) — resolve the sensing server via mDNS.
 *
 * RX nodes stream CSI to the server over UDP. Historically the target was a
 * static NVS `target_ip`, so a host/router IP change silently killed the stream.
 * This module browses `_throughnet._udp.local` (advertised by the sensing
 * server) and returns the server's current address + port, picking the
 * advertised A-record on this node's own subnet when the host is multi-homed.
 *
 * The caller keeps the NVS `target_ip` as a fallback: if resolution fails we use
 * it, so behavior never regresses below the pre-mDNS firmware.
 */

#ifndef MDNS_RESOLVER_H
#define MDNS_RESOLVER_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

/** Buffer size adequate for any dotted-quad IPv4 string (+NUL), with headroom. */
#define MDNS_RESOLVER_IP_BUF 40

/**
 * Initialize the mDNS responder/querier. Idempotent — safe to call repeatedly.
 * Must run after the WiFi STA netif is up (i.e. after wifi_init_sta()).
 *
 * @return ESP_OK on success (or if already initialized).
 */
esp_err_t mdns_resolver_init(void);

/**
 * One-shot query for the ThroughNet server.
 *
 * Browses `_throughnet._udp` and selects an IPv4 address, preferring one on this
 * node's STA subnet (handles a multi-homed host advertising several A-records);
 * falls back to the first IPv4 otherwise.
 *
 * @param out_ip    Destination for the dotted-quad server IP (NUL-terminated).
 * @param out_len   Size of @p out_ip (use MDNS_RESOLVER_IP_BUF).
 * @param out_port  Destination for the advertised UDP port (from the SRV record).
 * @param timeout_ms mDNS query timeout in milliseconds.
 * @return true if a server was resolved, false otherwise.
 */
bool mdns_resolver_query(char *out_ip, size_t out_len, uint16_t *out_port,
                         uint32_t timeout_ms);

/**
 * Start a background task that periodically re-resolves the server and re-points
 * the UDP stream sender (stream_sender_init_with) if the address or port
 * changed. This is what makes a DHCP/router change recover automatically.
 *
 * Call once, after the initial sender is up. RX-only by placement (the TX role
 * never reaches the streaming path).
 *
 * @param initial_ip   The IP the sender currently targets (change is measured
 *                     against this).
 * @param initial_port The port the sender currently targets.
 * @param interval_ms  Re-resolve cadence in milliseconds (0 → default 30000).
 */
void mdns_resolver_start_watch(const char *initial_ip, uint16_t initial_port,
                               uint32_t interval_ms);

#endif /* MDNS_RESOLVER_H */
