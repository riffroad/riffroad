//! What the app and the server say to each other: a player's saves kept online, one per slot,
//! each with a version so that two Macs never overwrite each other's progress without asking.
//!
//! `GET /v1/saves/{slot}` → [`Save`] (404: nothing saved yet).
//! `PUT /v1/saves/{slot}` with [`Push`] → [`Saved`], or 409 with [`Conflict`] when the save
//! online moved on since `base_version` (another Mac saved in between).
//! `DELETE /v1/account` → 204, every save gone (the app then deletes the sign-in itself).
//! Every route but `/health` wants `Authorization: Bearer <Firebase ID token>`.

use serde::{Deserialize, Serialize};

/// What can be kept online: the career, and the progress (scores, lessons). Settings stay on
/// each Mac (latency, audio input and the guitar's tuning belong to the machine).
pub const SLOTS: &[&str] = &["career", "progress"];

/// The biggest save accepted, its JSON text in bytes.
pub const MAX_SAVE_BYTES: usize = 512 * 1024;

/// Requests a player may make in a minute.
pub const REQUESTS_PER_MINUTE: u32 = 30;

pub fn is_slot(slot: &str) -> bool {
    SLOTS.contains(&slot)
}

pub fn save_path(slot: &str) -> String {
    format!("/v1/saves/{slot}")
}

pub const ACCOUNT_PATH: &str = "/v1/account";

/// A save as kept online.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Save {
    /// 1 for the first save, one more each time.
    pub version: u64,
    /// When it was written (RFC 3339).
    pub updated_at: String,
    pub data: serde_json::Value,
}

/// A save sent: written only if the one online is still `base_version` (0: none yet).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Push {
    pub base_version: u64,
    pub data: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Saved {
    pub version: u64,
    pub updated_at: String,
}

/// The save online moved on: its version and date, for the player to choose.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    pub version: u64,
    pub updated_at: String,
}

/// Any refusal: `{"error": "..."}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ApiError {
    pub error: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slots_are_the_known_ones() {
        assert!(is_slot("career"));
        assert!(is_slot("progress"));
        assert!(!is_slot("settings"));
        assert!(!is_slot("../career"));
        assert_eq!(save_path("career"), "/v1/saves/career");
    }

    #[test]
    fn speaks_camel_case() {
        let push = Push { base_version: 3, data: serde_json::json!({"act": 2}) };
        assert_eq!(serde_json::to_string(&push).unwrap(), r#"{"baseVersion":3,"data":{"act":2}}"#);
        let saved: Saved = serde_json::from_str(r#"{"version":4,"updatedAt":"2026-11-01T10:00:00Z"}"#).unwrap();
        assert_eq!(saved.version, 4);
    }
}
