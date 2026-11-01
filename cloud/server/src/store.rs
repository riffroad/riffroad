//! The saves, in Firestore (its REST API: a few calls, no client library): one document per
//! player and slot, `users/{uid}/saves/{slot}`, holding the save's JSON text and its version.
//! A save is written only if the document is still the one read (its update time as a
//! precondition), so two Macs saving at once never overwrite each other.

use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::Mutex;

use opensmith_cloud::SLOTS;

/// The service account's token on Cloud Run.
const METADATA_TOKEN: &str = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

#[derive(Debug)]
pub struct StoreError(pub String);

/// A save as stored.
#[derive(Debug, Clone, PartialEq)]
pub struct Stored {
    pub version: u64,
    pub updated_at: String,
    pub text: String,
}

#[derive(Debug, PartialEq)]
pub enum Written {
    Saved { version: u64, updated_at: String },
    /// The save online is not `base_version` any more: its version and date.
    Conflict { version: u64, updated_at: String },
}

pub struct Store {
    http: reqwest::Client,
    /// `https://firestore.googleapis.com/v1`, or the emulator's.
    base: String,
    database: String,
    emulator: bool,
    token: Mutex<Option<(String, Instant)>>,
}

#[derive(Deserialize)]
struct Document {
    #[serde(default)]
    fields: Value,
    #[serde(rename = "updateTime")]
    update_time: String,
}

#[derive(Deserialize)]
struct MetadataToken {
    access_token: String,
    expires_in: u64,
}

impl Store {
    /// `emulator`: the Firestore emulator's `host:port`, or None for the real one.
    pub fn new(project: &str, emulator: Option<String>, http: reqwest::Client) -> Self {
        let base = match &emulator {
            Some(host) => format!("http://{host}/v1"),
            None => "https://firestore.googleapis.com/v1".into(),
        };
        Self { http, base, database: format!("projects/{project}/databases/(default)"), emulator: emulator.is_some(), token: Mutex::new(None) }
    }

    fn name(&self, uid: &str, slot: &str) -> String {
        format!("{}/documents/users/{uid}/saves/{slot}", self.database)
    }

    async fn bearer(&self) -> Result<String, StoreError> {
        if self.emulator {
            return Ok("owner".into());
        }
        let mut cached = self.token.lock().await;
        if let Some((token, until)) = cached.as_ref() {
            if Instant::now() < *until {
                return Ok(token.clone());
            }
        }
        let t: MetadataToken = self
            .http
            .get(METADATA_TOKEN)
            .header("Metadata-Flavor", "Google")
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|e| StoreError(format!("metadata token: {e}")))?
            .json()
            .await
            .map_err(|e| StoreError(format!("metadata token: {e}")))?;
        let until = Instant::now() + Duration::from_secs(t.expires_in.saturating_sub(60));
        *cached = Some((t.access_token.clone(), until));
        Ok(t.access_token)
    }

    pub async fn get(&self, uid: &str, slot: &str) -> Result<Option<Stored>, StoreError> {
        let res = self
            .http
            .get(format!("{}/{}", self.base, self.name(uid, slot)))
            .bearer_auth(self.bearer().await?)
            .send()
            .await
            .map_err(|e| StoreError(format!("get: {e}")))?;
        if res.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        let res = res.error_for_status().map_err(|e| StoreError(format!("get: {e}")))?;
        let doc: Document = res.json().await.map_err(|e| StoreError(format!("get: {e}")))?;
        let version = doc.fields["version"]["integerValue"].as_str().and_then(|v| v.parse().ok()).unwrap_or(0);
        let text = doc.fields["data"]["stringValue"].as_str().unwrap_or("null").to_string();
        Ok(Some(Stored { version, updated_at: doc.update_time, text }))
    }

    /// `text` written as the next version, if the save online is still `base_version` (or there
    /// is none yet: an account emptied from another Mac takes any save).
    pub async fn put(&self, uid: &str, slot: &str, base_version: u64, text: &str) -> Result<Written, StoreError> {
        let current = self.get(uid, slot).await?;
        let (version, precondition) = match &current {
            Some(c) if c.version != base_version => return Ok(Written::Conflict { version: c.version, updated_at: c.updated_at.clone() }),
            Some(c) => (c.version + 1, json!({ "updateTime": c.updated_at })),
            None => (1, json!({ "exists": false })),
        };
        let body = json!({
            "writes": [{
                "update": {
                    "name": self.name(uid, slot),
                    "fields": { "version": { "integerValue": version.to_string() }, "data": { "stringValue": text } },
                },
                "currentDocument": precondition,
            }],
        });
        let res = self
            .http
            .post(format!("{}/{}/documents:commit", self.base, self.database))
            .bearer_auth(self.bearer().await?)
            .json(&body)
            .send()
            .await
            .map_err(|e| StoreError(format!("commit: {e}")))?;
        let status = res.status();
        let reply: Value = res.json().await.unwrap_or(Value::Null);
        if status.is_success() {
            let updated_at = reply["writeResults"][0]["updateTime"].as_str().unwrap_or_default().to_string();
            return Ok(Written::Saved { version, updated_at });
        }
        // Another save got in between the read and the write.
        let lost = matches!(reply["error"]["status"].as_str(), Some("FAILED_PRECONDITION" | "ALREADY_EXISTS" | "ABORTED" | "NOT_FOUND"));
        if lost {
            if let Some(now) = self.get(uid, slot).await? {
                return Ok(Written::Conflict { version: now.version, updated_at: now.updated_at });
            }
        }
        Err(StoreError(format!("commit: {status} {}", reply["error"]["message"])))
    }

    /// Every save of the player gone.
    pub async fn delete_all(&self, uid: &str) -> Result<(), StoreError> {
        let token = self.bearer().await?;
        for slot in SLOTS {
            let res = self
                .http
                .delete(format!("{}/{}", self.base, self.name(uid, slot)))
                .bearer_auth(&token)
                .send()
                .await
                .map_err(|e| StoreError(format!("delete: {e}")))?;
            if !res.status().is_success() && res.status() != reqwest::StatusCode::NOT_FOUND {
                return Err(StoreError(format!("delete {slot}: {}", res.status())));
            }
        }
        Ok(())
    }
}
