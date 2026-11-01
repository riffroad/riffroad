//! The server against the Firebase emulators (real Auth tokens, a real Firestore), in `cloud/`:
//! `firebase emulators:exec --project demo-opensmith --only auth,firestore 'cargo test'`.
//! Without the emulators these tests say so and pass.

use std::sync::atomic::{AtomicU64, Ordering};

use opensmith_cloud::{Conflict, MAX_SAVE_BYTES, REQUESTS_PER_MINUTE, Save, Saved, save_path};
use opensmith_cloud_server::{AppState, Config, router};
use reqwest::StatusCode;
use serde_json::{Value, json};

struct Env {
    base: String,
    auth: String,
    http: reqwest::Client,
}

async fn start() -> Option<Env> {
    let config = Config::from_env()?;
    if config.firestore_emulator.is_none() || !config.auth_emulator {
        return None;
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = router(AppState::new(&config));
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Some(Env { base: format!("http://{addr}"), auth: std::env::var("FIREBASE_AUTH_EMULATOR_HOST").unwrap(), http: reqwest::Client::new() })
}

macro_rules! env_or_skip {
    () => {
        match start().await {
            Some(env) => env,
            None => {
                eprintln!("skipped: run under `firebase emulators:exec` (see the file's header)");
                return;
            }
        }
    };
}

fn unique() -> u64 {
    static N: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos() as u64;
    nanos ^ N.fetch_add(1, Ordering::Relaxed)
}

impl Env {
    /// A new player signed up on the Auth emulator: their ID token.
    async fn player(&self) -> String {
        let reply: Value = self
            .http
            .post(format!("http://{}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo", self.auth))
            .json(&json!({ "email": format!("p{}@example.com", unique()), "password": "secret-123", "returnSecureToken": true }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        reply["idToken"].as_str().expect("an ID token").to_string()
    }

    async fn get(&self, token: &str, slot: &str) -> reqwest::Response {
        self.http.get(format!("{}{}", self.base, save_path(slot))).bearer_auth(token).send().await.unwrap()
    }

    async fn put(&self, token: &str, slot: &str, base_version: u64, data: Value) -> reqwest::Response {
        self.http
            .put(format!("{}{}", self.base, save_path(slot)))
            .bearer_auth(token)
            .json(&json!({ "baseVersion": base_version, "data": data }))
            .send()
            .await
            .unwrap()
    }
}

#[tokio::test]
async fn keeps_a_save_and_never_overwrites_a_newer_one() {
    let env = env_or_skip!();
    let me = env.player().await;
    assert_eq!(env.http.get(format!("{}/v1/saves/career", env.base)).send().await.unwrap().status(), StatusCode::UNAUTHORIZED);
    assert_eq!(env.get(&me, "career").await.status(), StatusCode::NOT_FOUND);

    let first: Saved = env.put(&me, "career", 0, json!({ "act": 1 })).await.json().await.unwrap();
    assert_eq!(first.version, 1);
    let save: Save = env.get(&me, "career").await.json().await.unwrap();
    assert_eq!((save.version, save.data), (1, json!({ "act": 1 })));

    // Another Mac that never synced: refused, told what is online.
    let other = env.put(&me, "career", 0, json!({ "act": 9 })).await;
    assert_eq!(other.status(), StatusCode::CONFLICT);
    let conflict: Conflict = other.json().await.unwrap();
    assert_eq!(conflict.version, 1);

    let second: Saved = env.put(&me, "career", 1, json!({ "act": 2 })).await.json().await.unwrap();
    assert_eq!(second.version, 2);
    let save: Save = env.get(&me, "career").await.json().await.unwrap();
    assert_eq!(save.data, json!({ "act": 2 }));

    // Someone else sees nothing of it.
    let stranger = env.player().await;
    assert_eq!(env.get(&stranger, "career").await.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn two_macs_saving_at_once_one_wins_the_other_is_told() {
    let env = env_or_skip!();
    let me = env.player().await;
    env.put(&me, "progress", 0, json!({ "songs": 1 })).await;
    let (a, b) = tokio::join!(env.put(&me, "progress", 1, json!({ "mac": "a" })), env.put(&me, "progress", 1, json!({ "mac": "b" })));
    let mut statuses = [a.status(), b.status()];
    statuses.sort();
    assert_eq!(statuses, [StatusCode::OK, StatusCode::CONFLICT]);
    let save: Save = env.get(&me, "progress").await.json().await.unwrap();
    assert_eq!(save.version, 2);
}

#[tokio::test]
async fn refuses_unknown_slots_and_oversized_saves() {
    let env = env_or_skip!();
    let me = env.player().await;
    assert_eq!(env.get(&me, "settings").await.status(), StatusCode::NOT_FOUND);
    assert_eq!(env.put(&me, "settings", 0, json!({})).await.status(), StatusCode::NOT_FOUND);
    let huge = "x".repeat(MAX_SAVE_BYTES);
    assert_eq!(env.put(&me, "career", 0, json!({ "notes": huge })).await.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(env.get(&me, "career").await.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn deletes_every_save_with_the_account() {
    let env = env_or_skip!();
    let me = env.player().await;
    env.put(&me, "career", 0, json!({ "act": 3 })).await;
    env.put(&me, "progress", 0, json!({ "songs": 12 })).await;
    let gone = env.http.delete(format!("{}/v1/account", env.base)).bearer_auth(&me).send().await.unwrap();
    assert_eq!(gone.status(), StatusCode::NO_CONTENT);
    assert_eq!(env.get(&me, "career").await.status(), StatusCode::NOT_FOUND);
    assert_eq!(env.get(&me, "progress").await.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn limits_the_requests_of_each_player() {
    let env = env_or_skip!();
    let me = env.player().await;
    for _ in 0..REQUESTS_PER_MINUTE {
        assert_eq!(env.get(&me, "career").await.status(), StatusCode::NOT_FOUND);
    }
    let refused = env.get(&me, "career").await;
    assert_eq!(refused.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(refused.headers()["retry-after"], "60");
    let other = env.player().await;
    assert_eq!(env.get(&other, "career").await.status(), StatusCode::NOT_FOUND);
}
