//! ASTM F3411 Remote ID broadcast (Basic ID + Location/Vector message).

use crate::types::DroneState;
use serde::{Deserialize, Serialize};

/// Remote ID broadcast state for one drone.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteIdBroadcast {
    pub uas_id: [u8; 20],        // 20-byte UAS ID (ANSI/CTA-2063-A)
    pub operator_lat: f64,
    pub operator_lon: f64,
    pub drone_lat: f64,
    pub drone_lon: f64,
    pub altitude_msl_m: f32,
    pub speed_ms: f32,
    pub heading_deg: f32,
    pub timestamp_ms: u64,
    pub emergency_status: bool,
}

impl RemoteIdBroadcast {
    pub fn new(uas_id: [u8; 20]) -> Self {
        Self {
            uas_id,
            operator_lat: 0.0,
            operator_lon: 0.0,
            drone_lat: 0.0,
            drone_lon: 0.0,
            altitude_msl_m: 0.0,
            speed_ms: 0.0,
            heading_deg: 0.0,
            timestamp_ms: 0,
            emergency_status: false,
        }
    }

    /// Update from a drone state and operator position.
    pub fn update(&mut self, state: &DroneState, operator_pos: (f64, f64)) {
        // Convert NED position to approximate lat/lon (placeholder — real impl uses WGS84).
        // We store the NED metres as placeholder values here.
        self.drone_lat = state.position.x;   // placeholder: x ≈ north offset
        self.drone_lon = state.position.y;   // placeholder: y ≈ east offset
        self.altitude_msl_m = state.altitude_agl_m as f32;
        self.speed_ms = state.velocity.magnitude() as f32;
        self.heading_deg = state.heading_rad.to_degrees() as f32;
        self.timestamp_ms = state.timestamp_ms;
        self.operator_lat = operator_pos.0;
        self.operator_lon = operator_pos.1;
    }

    /// Encode a 25-byte ASTM F3411 Basic ID message (serial number, multirotor).
    pub fn encode_basic_id(&self) -> [u8; 25] {
        remoteid::BasicId {
            protocol_version: remoteid::PROTOCOL_VERSION,
            id_type: remoteid::IdType::SerialNumber,
            ua_type: remoteid::UaType::HelicopterOrMultirotor,
            uas_id: self.uas_id,
        }
        .encode()
        .expect("Basic ID fields are in range")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encode_basic_id_length() {
        let rid = RemoteIdBroadcast::new([0x41u8; 20]);
        let buf = rid.encode_basic_id();
        assert_eq!(buf.len(), 25);
        let decoded = remoteid::BasicId::decode(&buf).unwrap();
        assert_eq!(decoded.id_type, remoteid::IdType::SerialNumber);
        assert_eq!(decoded.ua_type, remoteid::UaType::HelicopterOrMultirotor);
        assert_eq!(decoded.protocol_version, remoteid::PROTOCOL_VERSION);
    }

    #[test]
    fn test_uas_id_in_encoded_buffer() {
        let mut id = [0u8; 20];
        id[0] = 0xFF;
        let rid = RemoteIdBroadcast::new(id);
        let buf = rid.encode_basic_id();
        assert_eq!(buf[2], 0xFF);
    }
}
