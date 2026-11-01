//! The server against the Firebase emulators (real Auth tokens, a real Firestore), in `cloud/`:
//! `firebase emulators:exec --project demo-opensmith --only auth,firestore 'cargo test'`.
//! Without the emulators these tests say so and pass.

use std::sync::atomic::{AtomicU64, Ordering};

use opensmith_cloud::{Board, Conflict, HISTORY, MAX_SAVE_BYTES, Profile, REQUESTS_PER_MINUTE, Save, Saved, Version, challenge_of, history_path, save_path, week_of};
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
    async fn identity(&self, method: &str, body: Value) -> Value {
        let url = format!("http://{}/identitytoolkit.googleapis.com/v1/accounts:{method}?key=demo", self.auth);
        self.http.post(url).json(&body).send().await.unwrap().json().await.unwrap()
    }

    /// A new player signed up on the Auth emulator, e-mail not confirmed yet: their ID token.
    async fn newcomer(&self) -> String {
        let reply = self.identity("signUp", json!({ "email": format!("p{}@example.com", unique()), "password": "secret-123", "returnSecureToken": true })).await;
        reply["idToken"].as_str().expect("an ID token").to_string()
    }

    /// A new player whose e-mail is confirmed: their ID token, which says so.
    async fn player(&self) -> String {
        let email = format!("p{}@example.com", unique());
        let up = self.identity("signUp", json!({ "email": email, "password": "secret-123", "returnSecureToken": true })).await;
        let project = std::env::var("GCLOUD_PROJECT").unwrap();
        self.http
            .post(format!("http://{}/identitytoolkit.googleapis.com/v1/projects/{project}/accounts:update", self.auth))
            .bearer_auth("owner")
            .json(&json!({ "localId": up["localId"], "emailVerified": true }))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
        let back = self.identity("signInWithPassword", json!({ "email": email, "password": "secret-123", "returnSecureToken": true })).await;
        back["idToken"].as_str().expect("an ID token").to_string()
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
async fn keeps_the_last_saves_replaced_to_go_back_to() {
    let env = env_or_skip!();
    let me = env.player().await;
    for v in 0..7 {
        assert_eq!(env.put(&me, "career", v, json!({ "week": v + 1 })).await.status(), StatusCode::OK);
    }
    let history: Vec<Version> = env.http.get(format!("{}{}", env.base, history_path("career"))).bearer_auth(&me).send().await.unwrap().json().await.unwrap();
    // The current save is 7; the five before it are kept, newest first.
    assert_eq!(history.iter().map(|v| v.version).collect::<Vec<_>>(), (2..=6).rev().collect::<Vec<u64>>());
    assert_eq!(history.len() as u64, HISTORY);
    assert!(history.iter().all(|v| !v.updated_at.is_empty()));
    let old = |version: u64| env.http.get(format!("{}{}/{version}", env.base, history_path("career"))).bearer_auth(&me).send();
    let third: Save = old(3).await.unwrap().json().await.unwrap();
    assert_eq!((third.version, &third.data), (3, &json!({ "week": 3 })));
    assert_eq!(old(1).await.unwrap().status(), StatusCode::NOT_FOUND);

    // Going back: version 3 written over the current one, which joins the history.
    let back: Saved = env.put(&me, "career", 7, third.data.clone()).await.json().await.unwrap();
    assert_eq!(back.version, 8);
    let save: Save = env.get(&me, "career").await.json().await.unwrap();
    assert_eq!(save.data, json!({ "week": 3 }));
    let seventh: Save = old(7).await.unwrap().json().await.unwrap();
    assert_eq!(seventh.data, json!({ "week": 7 }));

    // Someone else's history is out of reach.
    let stranger = env.player().await;
    let theirs: Vec<Version> = env.http.get(format!("{}{}", env.base, history_path("career"))).bearer_auth(&stranger).send().await.unwrap().json().await.unwrap();
    assert!(theirs.is_empty());
}

#[tokio::test]
async fn writes_only_once_the_email_is_confirmed() {
    let env = env_or_skip!();
    let newcomer = env.newcomer().await;
    let refused = env.put(&newcomer, "career", 0, json!({ "act": 1 })).await;
    assert_eq!(refused.status(), StatusCode::FORBIDDEN);
    assert_eq!(refused.json::<Value>().await.unwrap()["error"], "email not verified");
    // Reading is fine: there is simply nothing yet.
    assert_eq!(env.get(&newcomer, "career").await.status(), StatusCode::NOT_FOUND);
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
    env.put(&me, "career", 1, json!({ "act": 4 })).await;
    env.put(&me, "progress", 0, json!({ "songs": 12 })).await;
    let gone = env.http.delete(format!("{}/v1/account", env.base)).bearer_auth(&me).send().await.unwrap();
    assert_eq!(gone.status(), StatusCode::NO_CONTENT);
    assert_eq!(env.get(&me, "career").await.status(), StatusCode::NOT_FOUND);
    assert_eq!(env.get(&me, "progress").await.status(), StatusCode::NOT_FOUND);
    let history: Vec<Version> = env.http.get(format!("{}{}", env.base, history_path("career"))).bearer_auth(&me).send().await.unwrap().json().await.unwrap();
    assert!(history.is_empty(), "the history goes with the account");
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

impl Env {
    async fn send(&self, token: &str, method: reqwest::Method, path: &str, body: Option<Value>) -> reqwest::Response {
        let mut r = self.http.request(method, format!("{}{path}", self.base)).bearer_auth(token);
        if let Some(b) = body {
            r = r.json(&b);
        }
        r.send().await.unwrap()
    }

    /// A run of this week's challenge, as the app sends it.
    async fn run(&self, token: &str, score: u64) -> reqwest::Response {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
        let c = challenge_of(week_of(now), opensmith_cloud_server::events::all());
        let body = json!({ "week": c.week, "song": c.song, "level": c.level, "score": score, "accuracy": 0.9, "trace": [0, score / 2, score] });
        self.send(token, reqwest::Method::POST, "/v1/challenge", Some(body)).await
    }
}

#[tokio::test]
async fn a_player_picks_a_name_for_the_boards() {
    let env = env_or_skip!();
    let me = env.player().await;
    let p: Profile = env.send(&me, reqwest::Method::GET, "/v1/profile", None).await.json().await.unwrap();
    assert_eq!(p.name, None);
    let bad = env.send(&me, reqwest::Method::PUT, "/v1/profile", Some(json!({ "name": "<script>" }))).await;
    assert_eq!(bad.status(), StatusCode::BAD_REQUEST);
    let newcomer = env.newcomer().await;
    assert_eq!(env.send(&newcomer, reqwest::Method::PUT, "/v1/profile", Some(json!({ "name": "Nouveau" }))).await.status(), StatusCode::FORBIDDEN);
    assert_eq!(env.send(&me, reqwest::Method::PUT, "/v1/profile", Some(json!({ "name": "Julien" }))).await.status(), StatusCode::OK);
    let p: Profile = env.send(&me, reqwest::Method::GET, "/v1/profile", None).await.json().await.unwrap();
    assert_eq!(p.name.as_deref(), Some("Julien"));
}

#[tokio::test]
async fn the_weekly_challenge_keeps_each_players_best_and_ranks_them() {
    let env = env_or_skip!();
    let (a, b) = (env.player().await, env.player().await);
    let board: Board = env.send(&a, reqwest::Method::GET, "/v1/challenge", None).await.json().await.unwrap();
    assert_eq!(board.me, None);
    assert!(board.ends > 0);

    // No name, no place on the board.
    assert_eq!(env.run(&a, 1000).await.status(), StatusCode::CONFLICT);
    let tag = unique() % 100_000;
    let (name_a, name_b) = (format!("A{tag}"), format!("B{tag}"));
    env.send(&a, reqwest::Method::PUT, "/v1/profile", Some(json!({ "name": name_a }))).await;
    env.send(&b, reqwest::Method::PUT, "/v1/profile", Some(json!({ "name": name_b }))).await;
    // Scores far above the other tests' runs: these two lead the board.
    let base = 4_000_000 + tag * 10;
    let mine: Board = env.run(&a, base + 5).await.json().await.unwrap();
    assert_eq!(mine.me.as_ref().map(|e| (e.score, e.me)), Some((base + 5, true)));
    env.run(&b, base + 7).await;
    // A worse run keeps the best one.
    let after: Board = env.run(&a, base + 1).await.json().await.unwrap();
    let me = after.me.unwrap();
    assert_eq!(me.score, base + 5);
    let order: Vec<&str> = after.top.iter().filter(|e| e.name == name_a || e.name == name_b).map(|e| e.name.as_str()).collect();
    assert_eq!(order, [name_b.as_str(), name_a.as_str()]);
    let b_entry = after.top.iter().find(|e| e.name == name_b).unwrap();
    assert_eq!((me.rank, b_entry.me), (b_entry.rank + 1, false));

    // The run to race: B for A (just above), none for B among these two.
    let rival: Option<opensmith_cloud::Rival> = env.send(&a, reqwest::Method::GET, "/v1/challenge/rival", None).await.json().await.unwrap();
    let rival = rival.unwrap();
    assert_eq!((rival.name.as_str(), rival.score, rival.trace.clone()), (name_b.as_str(), base + 7, vec![0, (base + 7) / 2, base + 7]));

    // Another week's or another song's run is refused; so is a made-up score.
    let wrong = json!({ "week": 1, "song": "x", "level": "easy", "score": 10, "accuracy": 0.5 });
    assert_eq!(env.send(&a, reqwest::Method::POST, "/v1/challenge", Some(wrong)).await.status(), StatusCode::BAD_REQUEST);
    assert_eq!(env.run(&a, 999_999_999).await.status(), StatusCode::BAD_REQUEST);

    // Gone with the account.
    env.send(&b, reqwest::Method::DELETE, "/v1/account", None).await;
    let left: Board = env.send(&a, reqwest::Method::GET, "/v1/challenge", None).await.json().await.unwrap();
    assert!(!left.top.iter().any(|e| e.name == name_b));
}

#[tokio::test]
async fn tells_anyone_the_events_on() {
    let env = env_or_skip!();
    let reply = env.http.get(format!("{}/v1/events", env.base)).send().await.unwrap();
    assert_eq!(reply.status(), StatusCode::OK);
    let events: Vec<opensmith_cloud::Event> = reply.json().await.unwrap();
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
    assert!(events.iter().all(|e| e.ends > now));
}

impl Env {
    async fn friends(&self, token: &str) -> opensmith_cloud::Friends {
        self.send(token, reqwest::Method::GET, "/v1/friends", None).await.json().await.unwrap()
    }
}

#[tokio::test]
async fn friends_follow_each_others_bands_best_week_first() {
    use opensmith_cloud::Friends;
    let env = env_or_skip!();
    let (a, b, c) = (env.player().await, env.player().await, env.player().await);
    let mine = env.friends(&a).await;
    assert_eq!((mine.code.len(), mine.friends.len()), (6, 0));
    assert_eq!(env.friends(&a).await.code, mine.code, "a code is made once");
    let (code_b, code_c) = (env.friends(&b).await.code, env.friends(&c).await.code);

    assert_eq!(env.send(&a, reqwest::Method::POST, "/v1/friends", Some(json!({ "code": &mine.code }))).await.status(), StatusCode::BAD_REQUEST);
    assert_eq!(env.send(&a, reqwest::Method::POST, "/v1/friends", Some(json!({ "code": "ZZZZZZ" }))).await.status(), StatusCode::NOT_FOUND);
    assert_eq!(env.send(&env.newcomer().await, reqwest::Method::POST, "/v1/friends", Some(json!({ "code": &code_b }))).await.status(), StatusCode::FORBIDDEN);
    let with_b: Friends = env.send(&a, reqwest::Method::POST, "/v1/friends", Some(json!({ "code": code_b.to_lowercase() }))).await.json().await.unwrap();
    assert_eq!(with_b.friends.iter().map(|f| (f.code.as_str(), f.card.is_none())).collect::<Vec<_>>(), [(code_b.as_str(), true)]);

    // Their cards: B won 40 fans this week, C 90.
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
    let card = |band: &str, week_fans: u64| json!({ "band": band, "act": 2, "fans": 500, "week": week_of(now), "weekFans": week_fans });
    assert_eq!(env.send(&b, reqwest::Method::PUT, "/v1/card", Some(card("Les B", 40))).await.status(), StatusCode::NO_CONTENT);
    assert_eq!(env.send(&c, reqwest::Method::PUT, "/v1/card", Some(card("Les C", 90))).await.status(), StatusCode::NO_CONTENT);
    assert_eq!(env.send(&c, reqwest::Method::PUT, "/v1/card", Some(json!({ "band": "x", "act": 1, "fans": 1, "week": 1, "weekFans": 9 }))).await.status(), StatusCode::BAD_REQUEST);
    let both: Friends = env.send(&a, reqwest::Method::POST, "/v1/friends", Some(json!({ "code": &code_c }))).await.json().await.unwrap();
    let bands: Vec<String> = both.friends.iter().map(|f| f.card.as_ref().unwrap().band.clone()).collect();
    assert_eq!(bands, ["Les C", "Les B"]);

    let left: Friends = env.send(&a, reqwest::Method::DELETE, &format!("/v1/friends/{code_b}"), None).await.json().await.unwrap();
    assert_eq!(left.friends.len(), 1);
    // A friend who deletes their account leaves the list, and their code is free again.
    env.send(&c, reqwest::Method::DELETE, "/v1/account", None).await;
    assert!(env.friends(&a).await.friends.is_empty());
    assert_eq!(env.send(&a, reqwest::Method::POST, "/v1/friends", Some(json!({ "code": &code_c }))).await.status(), StatusCode::NOT_FOUND);
}

