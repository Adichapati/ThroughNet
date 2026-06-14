/**
 * @file mdns_resolver.c
 * @brief ThroughNet R1 (ROADMAP Phase R) — resolve the sensing server via mDNS.
 *
 * See mdns_resolver.h for the contract. The server advertises
 * `_throughnet._udp.local` with `enable_addr_auto`, re-announcing on IP change;
 * here we browse it, pick the best IPv4, and (via the watch task) keep the UDP
 * sender pointed at it as the host's address changes.
 */

#include "mdns_resolver.h"

#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "esp_log.h"
#include "esp_netif.h"
#include "mdns.h"

#include "stream_sender.h"

static const char *TAG = "mdns_resolver";

/* PTR query target — the `.local.` domain is implicit for mdns_query_ptr(). */
#define SERVICE_NAME   "_throughnet"
#define SERVICE_PROTO  "_udp"
#define MAX_RESULTS    4

static bool s_inited = false;

/* Watch-task state (single instance; one server target per node). */
static char     s_cur_ip[MDNS_RESOLVER_IP_BUF];
static uint16_t s_cur_port;
static uint32_t s_interval_ms;

esp_err_t mdns_resolver_init(void)
{
    if (s_inited) {
        return ESP_OK;
    }
    esp_err_t err = mdns_init();
    if (err == ESP_OK) {
        s_inited = true;
    } else {
        ESP_LOGW(TAG, "mdns_init failed: %s", esp_err_to_name(err));
    }
    return err;
}

bool mdns_resolver_query(char *out_ip, size_t out_len, uint16_t *out_port,
                         uint32_t timeout_ms)
{
    if (out_ip == NULL || out_len == 0 || out_port == NULL) {
        return false;
    }

    /* This node's STA subnet, used to prefer a server A-record we can actually
     * route to when the host advertises several (e.g. WiFi + docker bridge). */
    esp_netif_ip_info_t local;
    bool have_local = false;
    esp_netif_t *sta = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
    if (sta != NULL && esp_netif_get_ip_info(sta, &local) == ESP_OK) {
        have_local = (local.ip.addr != 0);
    }

    mdns_result_t *results = NULL;
    esp_err_t err = mdns_query_ptr(SERVICE_NAME, SERVICE_PROTO, timeout_ms,
                                   MAX_RESULTS, &results);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "mdns_query_ptr failed: %s", esp_err_to_name(err));
        return false;
    }
    if (results == NULL) {
        return false; /* no responder answered within the timeout */
    }

    uint32_t chosen_addr = 0;     /* network byte order; 0 = none yet */
    bool     chosen_on_subnet = false;
    uint16_t chosen_port = 0;

    for (mdns_result_t *r = results; r != NULL; r = r->next) {
        for (mdns_ip_addr_t *a = r->addr; a != NULL; a = a->next) {
            if (a->addr.type != ESP_IPADDR_TYPE_V4) {
                continue;
            }
            uint32_t cand = a->addr.u_addr.ip4.addr;
            bool on_subnet = have_local &&
                ((cand & local.netmask.addr) ==
                 (local.ip.addr & local.netmask.addr));

            /* Take the first IPv4 we see; upgrade to a subnet match if one
             * appears (a routable address beats an unroutable one). */
            if (chosen_addr == 0 || (on_subnet && !chosen_on_subnet)) {
                chosen_addr = cand;
                chosen_on_subnet = on_subnet;
                chosen_port = r->port;
            }
        }
    }

    mdns_query_results_free(results);

    if (chosen_addr == 0) {
        return false;
    }

    esp_ip4_addr_t ip4 = { .addr = chosen_addr };
    esp_ip4addr_ntoa(&ip4, out_ip, (int)out_len);
    *out_port = chosen_port;
    ESP_LOGI(TAG, "resolved server %s:%u (%s)", out_ip, chosen_port,
             chosen_on_subnet ? "on-subnet" : "first-ipv4");
    return true;
}

static void mdns_watch_task(void *arg)
{
    (void)arg;
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(s_interval_ms));

        char     ip[MDNS_RESOLVER_IP_BUF];
        uint16_t port = 0;
        if (!mdns_resolver_query(ip, sizeof(ip), &port, 3000)) {
            continue; /* keep the current target; nothing answered */
        }
        if (strcmp(ip, s_cur_ip) == 0 && port == s_cur_port) {
            continue; /* unchanged */
        }

        ESP_LOGW(TAG, "server moved %s:%u -> %s:%u — re-pointing UDP sender",
                 s_cur_ip, s_cur_port, ip, port);
        if (stream_sender_init_with(ip, port) == 0) {
            strncpy(s_cur_ip, ip, sizeof(s_cur_ip) - 1);
            s_cur_ip[sizeof(s_cur_ip) - 1] = '\0';
            s_cur_port = port;
        } else {
            ESP_LOGE(TAG, "re-init of UDP sender to %s:%u failed; keeping %s:%u",
                     ip, port, s_cur_ip, s_cur_port);
        }
    }
}

void mdns_resolver_start_watch(const char *initial_ip, uint16_t initial_port,
                               uint32_t interval_ms)
{
    strncpy(s_cur_ip, initial_ip ? initial_ip : "", sizeof(s_cur_ip) - 1);
    s_cur_ip[sizeof(s_cur_ip) - 1] = '\0';
    s_cur_port = initial_port;
    s_interval_ms = interval_ms ? interval_ms : 30000;

    if (xTaskCreate(mdns_watch_task, "mdns_watch", 4096, NULL, 4, NULL) != pdPASS) {
        ESP_LOGW(TAG, "failed to start mDNS watch task (server IP changes won't auto-recover)");
    } else {
        ESP_LOGI(TAG, "mDNS watch started (every %lu ms)", (unsigned long)s_interval_ms);
    }
}
