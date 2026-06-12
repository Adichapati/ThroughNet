/**
 * @file tx_beacon.c
 * @brief ThroughNet Phase 1 — fixed-rate OFDM beacon illuminator (role=tx).
 *
 * See tx_beacon.h for the architecture rationale.
 *
 * Frame layout (20 bytes payload, broadcast MAC FF:FF:FF:FF:FF:FF):
 *   [0..3]   Magic        0x544E4243 ('TNBC' — ThroughNet BeaCon)
 *   [4]      Protocol ver 0x01
 *   [5]      Node ID      sender's node_id
 *   [6..7]   Beacon rate  Hz (LE u16)
 *   [8..11]  Sequence     (LE u32)
 *   [12..19] Epoch µs     esp_timer_get_time() at send (LE u64)
 *
 * RX nodes never parse this payload — they only need the frame's OFDM
 * preamble for CSI. The contents exist for debugging with a sniffer and
 * for future drop-rate accounting on the host.
 */

#include "tx_beacon.h"

#include <string.h>
#include "esp_log.h"
#include "esp_now.h"
#include "esp_wifi.h"
#include "esp_timer.h"
#include "esp_idf_version.h"

static const char *TAG = "tx_beacon";

#define BEACON_MAGIC      0x544E4243u  /* 'TNBC' */
#define BEACON_PROTO_VER  0x01

typedef struct __attribute__((packed)) {
    uint32_t magic;
    uint8_t  proto_ver;
    uint8_t  node_id;
    uint16_t rate_hz;
    uint32_t sequence;
    uint64_t epoch_us;
} tx_beacon_frame_t;

static const uint8_t s_broadcast_mac[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

static esp_timer_handle_t s_beacon_timer = NULL;
static uint32_t s_tx_count = 0;
static uint32_t s_tx_fail  = 0;
static uint32_t s_sequence = 0;
static uint16_t s_rate_hz  = 100;
static uint8_t  s_node_id  = 0;

#if ESP_IDF_VERSION_MAJOR >= 6
static void on_send(const esp_now_send_info_t *tx_info, esp_now_send_status_t status)
{
    (void)tx_info;
    if (status != ESP_NOW_SEND_SUCCESS) s_tx_fail++;
}
#else
static void on_send(const uint8_t *mac, esp_now_send_status_t status)
{
    (void)mac;
    if (status != ESP_NOW_SEND_SUCCESS) s_tx_fail++;
}
#endif

static void beacon_timer_cb(void *arg)
{
    (void)arg;
    tx_beacon_frame_t f = {
        .magic     = BEACON_MAGIC,
        .proto_ver = BEACON_PROTO_VER,
        .node_id   = s_node_id,
        .rate_hz   = s_rate_hz,
        .sequence  = s_sequence++,
        .epoch_us  = (uint64_t)esp_timer_get_time(),
    };
    esp_err_t r = esp_now_send(s_broadcast_mac, (const uint8_t *)&f, sizeof(f));
    s_tx_count++;
    if (r != ESP_OK) s_tx_fail++;

    /* Diag log every ~5 s regardless of rate. */
    uint32_t every = (uint32_t)s_rate_hz * 5U;
    if (every == 0) every = 1;
    if ((s_tx_count % every) == 1) {
        ESP_LOGI(TAG, "beacon tx#%lu fail=%lu rate=%uHz",
                 (unsigned long)s_tx_count, (unsigned long)s_tx_fail,
                 (unsigned)s_rate_hz);
    }
}

esp_err_t tx_beacon_init(uint16_t hz, uint8_t node_id)
{
    if (hz < 1 || hz > 200) {
        ESP_LOGW(TAG, "beacon_hz=%u out of range, clamping to 100", (unsigned)hz);
        hz = 100;
    }
    s_rate_hz = hz;
    s_node_id = node_id;

    /* Steady beacon timing needs the modem awake (STA default is MIN_MODEM). */
    esp_err_t ps = esp_wifi_set_ps(WIFI_PS_NONE);
    if (ps != ESP_OK) {
        ESP_LOGW(TAG, "esp_wifi_set_ps(WIFI_PS_NONE) failed: %s — beacon jitter likely",
                 esp_err_to_name(ps));
    }

    esp_err_t r = esp_now_init();
    if (r != ESP_OK && r != ESP_ERR_ESPNOW_EXIST) {
        ESP_LOGE(TAG, "esp_now_init failed: %s", esp_err_to_name(r));
        return r;
    }
    esp_now_register_send_cb(on_send);

    esp_now_peer_info_t peer = {0};
    memcpy(peer.peer_addr, s_broadcast_mac, 6);
    peer.channel = 0;       /* current STA channel */
    peer.ifidx   = WIFI_IF_STA;
    peer.encrypt = false;
    r = esp_now_add_peer(&peer);
    if (r != ESP_OK && r != ESP_ERR_ESPNOW_EXIST) {
        ESP_LOGE(TAG, "esp_now_add_peer(broadcast) failed: %s", esp_err_to_name(r));
        return r;
    }

    /* CRITICAL: force an OFDM PHY rate. ESP-NOW defaults to 1 Mbps DSSS,
     * whose 802.11b preamble carries no L-LTF/HT-LTF — receivers get ZERO
     * CSI from such frames (this is why the upstream 10 Hz sync beacons
     * never fed the CSI engine). HT20 MCS0 carries both L-LTF and HT-LTF. */
#if ESP_IDF_VERSION >= ESP_IDF_VERSION_VAL(5, 3, 0)
    esp_now_rate_config_t rate_cfg = {
        .phymode = WIFI_PHY_MODE_HT20,
        .rate    = WIFI_PHY_RATE_MCS0_LGI,
        .ersu    = false,
        .dcm     = false,
    };
    r = esp_now_set_peer_rate_config(s_broadcast_mac, &rate_cfg);
    if (r != ESP_OK) {
        ESP_LOGE(TAG, "esp_now_set_peer_rate_config(HT20 MCS0) failed: %s — "
                 "beacons will be DSSS and produce NO CSI at receivers!",
                 esp_err_to_name(r));
    } else {
        ESP_LOGI(TAG, "beacon PHY rate locked: HT20 MCS0 (OFDM, CSI-capable)");
    }
#else
    r = esp_wifi_config_espnow_rate(WIFI_IF_STA, WIFI_PHY_RATE_MCS0_LGI);
    if (r != ESP_OK) {
        ESP_LOGE(TAG, "esp_wifi_config_espnow_rate(MCS0) failed: %s — "
                 "beacons will be DSSS and produce NO CSI at receivers!",
                 esp_err_to_name(r));
    } else {
        ESP_LOGI(TAG, "beacon PHY rate locked: MCS0 (OFDM, CSI-capable)");
    }
#endif

    /* esp_timer for sub-10ms periods — FreeRTOS timers tick at 100 Hz. */
    esp_timer_create_args_t targs = {
        .callback        = beacon_timer_cb,
        .arg             = NULL,
        .dispatch_method = ESP_TIMER_TASK,
        .name            = "tx_beacon",
    };
    r = esp_timer_create(&targs, &s_beacon_timer);
    if (r != ESP_OK) {
        ESP_LOGE(TAG, "esp_timer_create failed: %s", esp_err_to_name(r));
        return r;
    }
    uint64_t period_us = 1000000ULL / (uint64_t)s_rate_hz;
    r = esp_timer_start_periodic(s_beacon_timer, period_us);
    if (r != ESP_OK) {
        ESP_LOGE(TAG, "esp_timer_start_periodic failed: %s", esp_err_to_name(r));
        esp_timer_delete(s_beacon_timer);
        s_beacon_timer = NULL;
        return r;
    }

    uint8_t pri = 0;
    wifi_second_chan_t sec;
    esp_wifi_get_channel(&pri, &sec);
    ESP_LOGI(TAG, "TX beacon active: %u Hz on channel %u (HT20 MCS0, payload %u B)",
             (unsigned)s_rate_hz, (unsigned)pri, (unsigned)sizeof(tx_beacon_frame_t));
    return ESP_OK;
}

uint32_t tx_beacon_tx_count(void) { return s_tx_count; }
uint32_t tx_beacon_tx_fail(void)  { return s_tx_fail; }
