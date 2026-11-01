//! The saves, in Firestore (its REST API: a few calls, no client library): one document per
//! player and slot, `users/{uid}/saves/{slot}`, holding the save's JSON text and its version.
//! A save is written only if the document is still the one read (its update time as a
//! precondition), so two Macs saving at once never overwrite each other. The one it replaces goes,
//! in the same write, to `…/{slot}/history/{version}` (the last `HISTORY` kept).

use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::Mutex;

use opensmith_cloud::{Card, Friend, HISTORY, MAX_FRIENDS, Profile, Rival, SLOTS, Score, Version, code_of};

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

    /// An old version: its number padded, so that names sort as versions do.
    fn old_name(&self, uid: &str, slot: &str, version: u64) -> String {
        format!("{}/history/{version:010}", self.name(uid, slot))
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

    async fn document(&self, name: &str) -> Result<Option<Document>, StoreError> {
        let res = self
            .http
            .get(format!("{}/{name}", self.base))
            .bearer_auth(self.bearer().await?)
            .send()
            .await
            .map_err(|e| StoreError(format!("get: {e}")))?;
        if res.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        let res = res.error_for_status().map_err(|e| StoreError(format!("get: {e}")))?;
        res.json().await.map(Some).map_err(|e| StoreError(format!("get: {e}")))
    }

    pub async fn get(&self, uid: &str, slot: &str) -> Result<Option<Stored>, StoreError> {
        Ok(self.document(&self.name(uid, slot)).await?.map(|doc| Stored {
            version: version_of(&doc.fields),
            text: doc.fields["data"]["stringValue"].as_str().unwrap_or("null").to_string(),
            updated_at: doc.update_time,
        }))
    }

    /// The versions kept before the current one, newest first.
    pub async fn history(&self, uid: &str, slot: &str) -> Result<Vec<Version>, StoreError> {
        let docs = self.list(&format!("{}/history", self.name(uid, slot)), &["version", "savedAt"]).await?;
        let mut out: Vec<Version> = docs
            .iter()
            .map(|d| Version { version: version_of(&d["fields"]), updated_at: d["fields"]["savedAt"]["stringValue"].as_str().unwrap_or_default().into() })
            .collect();
        out.sort_by_key(|v| std::cmp::Reverse(v.version));
        Ok(out)
    }

    /// Version `version` of the save, if it is still kept.
    pub async fn old(&self, uid: &str, slot: &str, version: u64) -> Result<Option<Stored>, StoreError> {
        Ok(self.document(&self.old_name(uid, slot, version)).await?.map(|doc| Stored {
            version: version_of(&doc.fields),
            updated_at: doc.fields["savedAt"]["stringValue"].as_str().unwrap_or_default().into(),
            text: doc.fields["data"]["stringValue"].as_str().unwrap_or("null").to_string(),
        }))
    }

    /// The documents of a collection (`fields` only of each), as Firestore gives them.
    async fn list(&self, collection: &str, fields: &[&str]) -> Result<Vec<Value>, StoreError> {
        let mut query: Vec<(&str, &str)> = fields.iter().map(|f| ("mask.fieldPaths", *f)).collect();
        query.push(("pageSize", "100"));
        let url = reqwest::Url::parse_with_params(&format!("{}/{collection}", self.base), &query).map_err(|e| StoreError(format!("list: {e}")))?;
        let res = self
            .http
            .get(url)
            .bearer_auth(self.bearer().await?)
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|e| StoreError(format!("list: {e}")))?;
        let reply: Value = res.json().await.map_err(|e| StoreError(format!("list: {e}")))?;
        Ok(reply["documents"].as_array().cloned().unwrap_or_default())
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
        let mut writes = vec![json!({
            "update": {
                "name": self.name(uid, slot),
                "fields": { "version": { "integerValue": version.to_string() }, "data": { "stringValue": text } },
            },
            "currentDocument": precondition,
        })];
        // The save replaced goes to the history; the oldest kept goes.
        if let Some(c) = &current {
            writes.push(json!({
                "update": {
                    "name": self.old_name(uid, slot, c.version),
                    "fields": {
                        "version": { "integerValue": c.version.to_string() },
                        "savedAt": { "stringValue": c.updated_at },
                        "data": { "stringValue": c.text },
                    },
                },
            }));
            if c.version > HISTORY {
                writes.push(json!({ "delete": self.old_name(uid, slot, c.version - HISTORY) }));
            }
        }
        let body = json!({ "writes": writes });
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

    /// Writes applied together, all or none: Firestore's reply, or why it refused.
    async fn commit(&self, writes: Vec<Value>) -> Result<Value, StoreError> {
        let res = self
            .http
            .post(format!("{}/{}/documents:commit", self.base, self.database))
            .bearer_auth(self.bearer().await?)
            .json(&json!({ "writes": writes }))
            .send()
            .await
            .map_err(|e| StoreError(format!("commit: {e}")))?;
        let status = res.status();
        let reply: Value = res.json().await.unwrap_or(Value::Null);
        if status.is_success() {
            return Ok(reply);
        }
        if matches!(reply["error"]["status"].as_str(), Some("ALREADY_EXISTS" | "FAILED_PRECONDITION")) {
            return Err(StoreError(PRECONDITION.into()));
        }
        Err(StoreError(format!("commit: {status} {}", reply["error"]["message"])))
    }

    /// The player's friend code, made (and reserved) on first ask.
    pub async fn code(&self, uid: &str) -> Result<String, StoreError> {
        if let Some(code) = self.document(&self.user(uid)).await?.and_then(|d| d.fields["code"]["stringValue"].as_str().map(String::from)) {
            return Ok(code);
        }
        for attempt in 0..8 {
            let code = code_of(uid, attempt);
            let writes = vec![
                json!({ "update": { "name": self.code_doc(&code), "fields": { "uid": { "stringValue": uid } } }, "currentDocument": { "exists": false } }),
                json!({ "update": { "name": self.user(uid), "fields": { "code": { "stringValue": code } } }, "updateMask": { "fieldPaths": ["code"] } }),
            ];
            match self.commit(writes).await {
                Ok(_) => return Ok(code),
                Err(e) if e.0 == PRECONDITION => continue,
                Err(e) => return Err(e),
            }
        }
        Err(StoreError("no free code".into()))
    }

    fn code_doc(&self, code: &str) -> String {
        format!("{}/documents/codes/{code}", self.database)
    }

    /// Whose code `code` is.
    pub async fn uid_of(&self, code: &str) -> Result<Option<String>, StoreError> {
        Ok(self.document(&self.code_doc(code)).await?.and_then(|d| d.fields["uid"]["stringValue"].as_str().map(String::from)))
    }

    /// The friends the player follows (their uids).
    pub async fn friend_uids(&self, uid: &str) -> Result<Vec<String>, StoreError> {
        Ok(self
            .document(&self.user(uid))
            .await?
            .map(|d| d.fields["friends"]["arrayValue"]["values"].as_array().into_iter().flatten().filter_map(|v| v["stringValue"].as_str().map(String::from)).collect())
            .unwrap_or_default())
    }

    /// `friend` followed (false: already MAX_FRIENDS).
    pub async fn follow(&self, uid: &str, friend: &str) -> Result<bool, StoreError> {
        let now = self.friend_uids(uid).await?;
        if now.iter().any(|f| f == friend) {
            return Ok(true);
        }
        if now.len() >= MAX_FRIENDS {
            return Ok(false);
        }
        self.array(uid, "friends", "appendMissingElements", friend).await.map(|()| true)
    }

    pub async fn unfollow(&self, uid: &str, friend: &str) -> Result<(), StoreError> {
        self.array(uid, "friends", "removeAllFromArray", friend).await
    }

    async fn array(&self, uid: &str, field: &str, how: &str, value: &str) -> Result<(), StoreError> {
        let write = json!({ "transform": { "document": self.user(uid), "fieldTransforms": [{ "fieldPath": field, how: { "values": [{ "stringValue": value }] } }] } });
        self.commit(vec![write]).await.map(|_| ())
    }

    pub async fn set_card(&self, uid: &str, card: &Card) -> Result<(), StoreError> {
        let fields = json!({
            "band": { "stringValue": card.band },
            "act": { "integerValue": card.act.to_string() },
            "fans": { "integerValue": card.fans.to_string() },
            "week": { "integerValue": card.week.to_string() },
            "weekFans": { "integerValue": card.week_fans.to_string() },
        });
        let write = json!({ "update": { "name": self.user(uid), "fields": { "card": { "mapValue": { "fields": fields } } } }, "updateMask": { "fieldPaths": ["card"] } });
        self.commit(vec![write]).await.map(|_| ())
    }

    /// The players `uids` as friends see them (those gone are left out), and the card of each.
    pub async fn cards(&self, uids: &[String]) -> Result<Vec<(String, Friend)>, StoreError> {
        if uids.is_empty() {
            return Ok(Vec::new());
        }
        let names: Vec<String> = uids.iter().map(|u| self.user(u)).collect();
        let rows = self.post(&format!("{}/documents:batchGet", self.database), &json!({ "documents": names })).await?;
        Ok(rows
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|r| {
                let d = r.get("found")?;
                let uid = d["name"].as_str()?.rsplit('/').next()?.to_string();
                let f = &d["fields"];
                let friend = Friend { code: f["code"]["stringValue"].as_str().unwrap_or_default().into(), name: f["name"]["stringValue"].as_str().map(String::from), card: card_of(&f["card"]) };
                Some((uid, friend))
            })
            .collect())
    }

    pub async fn own_card(&self, uid: &str) -> Result<Option<Card>, StoreError> {
        Ok(self.document(&self.user(uid)).await?.and_then(|d| card_of(&d.fields["card"])))
    }

    fn user(&self, uid: &str) -> String {
        format!("{}/documents/users/{uid}", self.database)
    }

    fn week(&self, week: i64) -> String {
        format!("{}/documents/challenges/w{week}", self.database)
    }

    pub async fn profile(&self, uid: &str) -> Result<Profile, StoreError> {
        Ok(self.document(&self.user(uid)).await?.map(|d| Profile { name: d.fields["name"]["stringValue"].as_str().map(String::from) }).unwrap_or_default())
    }

    /// The player's name, on their profile and on this week's board if they are on it.
    pub async fn set_name(&self, uid: &str, name: &str, week: i64) -> Result<(), StoreError> {
        self.commit(vec![json!({ "update": { "name": self.user(uid), "fields": { "name": { "stringValue": name } } }, "updateMask": { "fieldPaths": ["name"] } })]).await?;
        let entry = format!("{}/scores/{uid}", self.week(week));
        if self.document(&entry).await?.is_some() {
            self.commit(vec![json!({ "update": { "name": entry, "fields": { "name": { "stringValue": name } } }, "updateMask": { "fieldPaths": ["name"] } })]).await?;
        }
        Ok(())
    }

    /// A run of the week's challenge: kept if it beats the player's best of the week.
    pub async fn submit(&self, uid: &str, name: &str, run: &Score) -> Result<(), StoreError> {
        let entry = format!("{}/scores/{uid}", self.week(run.week));
        let best = self.document(&entry).await?.map_or(0, |d| int_of(&d.fields["score"]));
        if run.score <= best {
            return Ok(());
        }
        self.commit(vec![
            json!({ "update": { "name": entry, "fields": {
                "name": { "stringValue": name },
                "score": { "integerValue": run.score.to_string() },
                "accuracy": { "doubleValue": run.accuracy },
                "trace": { "stringValue": run.trace.iter().map(u64::to_string).collect::<Vec<_>>().join(",") },
            } } }),
            // The weeks the player is on, for the account's deletion.
            json!({ "transform": { "document": self.user(uid), "fieldTransforms": [
                { "fieldPath": "weeks", "appendMissingElements": { "values": [{ "integerValue": run.week.to_string() }] } },
            ] } }),
        ])
        .await
        .map(|_| ())
    }

    /// The week's best runs, best first: (uid, name, score, accuracy).
    pub async fn top(&self, week: i64, n: usize) -> Result<Vec<(String, String, u64, f64)>, StoreError> {
        let query = json!({ "structuredQuery": {
            "from": [{ "collectionId": "scores" }],
            "orderBy": [{ "field": { "fieldPath": "score" }, "direction": "DESCENDING" }],
            "limit": n,
        } });
        let rows = self.post(&format!("{}:runQuery", self.week(week)), &query).await?;
        Ok(rows
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|r| {
                let d = &r["document"];
                let uid = d["name"].as_str()?.rsplit('/').next()?.to_string();
                let f = &d["fields"];
                Some((uid, f["name"]["stringValue"].as_str().unwrap_or("?").to_string(), int_of(&f["score"]), f["accuracy"]["doubleValue"].as_f64().unwrap_or(0.0)))
            })
            .collect())
    }

    /// Runs of the week above `score` (all of them: None).
    pub async fn count(&self, week: i64, above: Option<u64>) -> Result<u64, StoreError> {
        let mut query = json!({ "from": [{ "collectionId": "scores" }] });
        if let Some(score) = above {
            query["where"] = json!({ "fieldFilter": { "field": { "fieldPath": "score" }, "op": "GREATER_THAN", "value": { "integerValue": score.to_string() } } });
        }
        let body = json!({ "structuredAggregationQuery": { "structuredQuery": query, "aggregations": [{ "alias": "n", "count": {} }] } });
        let rows = self.post(&format!("{}:runAggregationQuery", self.week(week)), &body).await?;
        Ok(int_of(&rows[0]["result"]["aggregateFields"]["n"]))
    }

    /// The run to beat: just above the player's best of the week, else the best one.
    pub async fn rival(&self, uid: &str, week: i64) -> Result<Option<Rival>, StoreError> {
        let mine = self.best(uid, week).await?.map(|(score, _)| score);
        let mut query = json!({
            "from": [{ "collectionId": "scores" }],
            "orderBy": [{ "field": { "fieldPath": "score" }, "direction": if mine.is_some() { "ASCENDING" } else { "DESCENDING" } }],
            "limit": 1,
        });
        if let Some(score) = mine {
            query["where"] = json!({ "fieldFilter": { "field": { "fieldPath": "score" }, "op": "GREATER_THAN", "value": { "integerValue": score.to_string() } } });
        }
        let rows = self.post(&format!("{}:runQuery", self.week(week)), &json!({ "structuredQuery": query })).await?;
        let Some(d) = rows.as_array().and_then(|r| r.iter().find_map(|r| r.get("document"))) else { return Ok(None) };
        if d["name"].as_str().is_some_and(|n| n.ends_with(&format!("/{uid}"))) {
            return Ok(None);
        }
        let f = &d["fields"];
        let trace = f["trace"]["stringValue"].as_str().unwrap_or("").split(',').filter_map(|v| v.parse().ok()).collect();
        Ok(Some(Rival { name: f["name"]["stringValue"].as_str().unwrap_or("?").into(), score: int_of(&f["score"]), trace }))
    }

    /// The player's best run of the week: (score, accuracy).
    pub async fn best(&self, uid: &str, week: i64) -> Result<Option<(u64, f64)>, StoreError> {
        Ok(self.document(&format!("{}/scores/{uid}", self.week(week))).await?.map(|d| (int_of(&d.fields["score"]), d.fields["accuracy"]["doubleValue"].as_f64().unwrap_or(0.0))))
    }

    async fn post(&self, path: &str, body: &Value) -> Result<Value, StoreError> {
        let res = self
            .http
            .post(format!("{}/{path}", self.base))
            .bearer_auth(self.bearer().await?)
            .json(body)
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|e| StoreError(format!("query: {e}")))?;
        res.json().await.map_err(|e| StoreError(format!("query: {e}")))
    }

    /// A document gone (already gone is fine).
    pub(crate) async fn delete(&self, name: &str) -> Result<(), StoreError> {
        let res = self
            .http
            .delete(format!("{}/{name}", self.base))
            .bearer_auth(self.bearer().await?)
            .send()
            .await
            .map_err(|e| StoreError(format!("delete: {e}")))?;
        if !res.status().is_success() && res.status() != reqwest::StatusCode::NOT_FOUND {
            return Err(StoreError(format!("delete {name}: {}", res.status())));
        }
        Ok(())
    }

    /// Every save of the player gone, their history with them, their name and their runs.
    pub async fn delete_all(&self, uid: &str) -> Result<(), StoreError> {
        if let Some(user) = self.document(&self.user(uid)).await? {
            if let Some(code) = user.fields["code"]["stringValue"].as_str() {
                self.delete(&self.code_doc(code)).await?;
            }
            for week in user.fields["weeks"]["arrayValue"]["values"].as_array().into_iter().flatten() {
                if let Ok(week) = int_of(week).try_into() {
                    self.delete(&format!("{}/scores/{uid}", self.week(week))).await?;
                }
            }
        }
        self.delete(&self.user(uid)).await?;
        for slot in SLOTS {
            for old in self.list(&format!("{}/history", self.name(uid, slot)), &["version"]).await? {
                if let Some(name) = old["name"].as_str() {
                    self.delete(name).await?;
                }
            }
            self.delete(&self.name(uid, slot)).await?;
        }
        Ok(())
    }
}

fn version_of(fields: &Value) -> u64 {
    int_of(&fields["version"])
}

/// A write refused because the document was not as expected (taken, or changed meanwhile).
const PRECONDITION: &str = "precondition failed";

fn card_of(v: &Value) -> Option<Card> {
    let f = v.get("mapValue")?.get("fields")?;
    Some(Card {
        band: f["band"]["stringValue"].as_str().unwrap_or_default().into(),
        act: int_of(&f["act"]) as u32,
        fans: int_of(&f["fans"]),
        week: int_of(&f["week"]) as i64,
        week_fans: int_of(&f["weekFans"]),
    })
}

/// A Firestore integer (its value is written as text).
fn int_of(value: &Value) -> u64 {
    value["integerValue"].as_str().and_then(|v| v.parse().ok()).unwrap_or(0)
}
