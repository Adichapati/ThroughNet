//! ThroughNet R1 (ROADMAP Phase R) — mDNS service advertiser.
//!
//! Advertises the CSI ingestion endpoint as `_throughnet._udp.local.` so ESP32
//! nodes resolve the server by name instead of a hardcoded IP. This removes the
//! "host/router IP changed → streaming silently dies" fragility that live
//! bring-up hit (the boards stream to a static NVS `target_ip`).
//!
//! Division of responsibility:
//! - Server (here): advertise. `enable_addr_auto()` lets the mdns-sd daemon
//!   track interface address changes and re-announce automatically, so a new
//!   DHCP lease is published with no action on our part.
//! - Firmware (resolver): browse this service, pick the advertised A-record on
//!   its own subnet (a multi-homed host advertises several), and point its UDP
//!   sender there. The static NVS `target_ip` stays as a firmware-side fallback
//!   so the system never regresses below its pre-mDNS behavior.

use mdns_sd::{ServiceDaemon, ServiceInfo};
use std::collections::HashMap;
use tracing::{info, warn};

/// Service type the firmware resolver browses for. Firmware queries the
/// PTR `_throughnet._udp` (the `.local.` suffix is implicit there).
const SERVICE_TYPE: &str = "_throughnet._udp.local.";
/// RFC 6762 hostname carried by the A-record (must end in `.local.`).
const HOSTNAME: &str = "throughnet-server.local.";
/// Instance label shown in the advertisement.
const INSTANCE: &str = "throughnet-server";

/// Live mDNS registration. Holding this keeps the advertisement up; dropping it
/// (and with it the daemon) unregisters the service. Bound for the server's
/// lifetime in `main`, so the advert stays live as long as the server runs.
pub struct MdnsAdvertiser {
    _daemon: ServiceDaemon,
}

/// Start advertising the CSI ingestion service on `udp_port`.
///
/// Non-fatal by design: on any failure (no multicast route, 5353/udp filtered,
/// avahi conflict) we log a warning and return `None`. The firmware then falls
/// back to its NVS `target_ip`, so the server behaves exactly as it did before
/// mDNS existed.
pub fn start(udp_port: u16) -> Option<MdnsAdvertiser> {
    let daemon = match ServiceDaemon::new() {
        Ok(d) => d,
        Err(e) => {
            warn!(
                "mDNS advertiser: ServiceDaemon init failed ({e}); \
                 nodes fall back to their NVS target_ip"
            );
            return None;
        }
    };

    // TXT records are advisory — the SRV record already carries the port and the
    // A-record carries the address. `proto` lets future nodes reject a mismatched
    // server, `role` documents intent in a service browser.
    let mut props: HashMap<String, String> = HashMap::new();
    props.insert("proto".to_string(), "throughnet/1".to_string());
    props.insert("role".to_string(), "csi-ingest".to_string());

    // Empty IP set + `enable_addr_auto`: the daemon fills in (and keeps current)
    // every local interface address, re-announcing on IP change. This is the
    // mechanism that makes a DHCP/router change a non-event for the fleet.
    let info = match ServiceInfo::new(SERVICE_TYPE, INSTANCE, HOSTNAME, "", udp_port, Some(props)) {
        Ok(i) => i.enable_addr_auto(),
        Err(e) => {
            warn!(
                "mDNS advertiser: ServiceInfo build failed ({e}); \
                 nodes fall back to their NVS target_ip"
            );
            return None;
        }
    };

    let fullname = info.get_fullname().to_string();
    if let Err(e) = daemon.register(info) {
        warn!(
            "mDNS advertiser: register failed ({e}); \
             nodes fall back to their NVS target_ip"
        );
        return None;
    }

    info!(
        "mDNS advertiser: {fullname} → UDP :{udp_port} \
         (auto-address; re-announces on host IP change)"
    );
    Some(MdnsAdvertiser { _daemon: daemon })
}
