//! The server that keeps each player's saves online (see `opensmith_cloud` for the routes).

pub mod auth;
pub mod events;
pub mod limit;
pub mod store;

use std::sync::Arc;

use axum::extract::rejection::JsonRejection;
use axum::extract::{DefaultBodyLimit, FromRef, FromRequestParts, Path, State};
use axum::http::StatusCode;
use axum::http::request::Parts;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, put};
use axum::{Json, Router};
use opensmith_cloud::{AddFriend, ApiError, Board, Card, Conflict, Entry, Friends, clean_code, valid_card, MAX_SAVE_BYTES, MAX_SCORE, MAX_TRACE, Profile, Push, REQUESTS_PER_MINUTE, Save, Saved, Score, TOP, challenge_of, is_slot, valid_name, week_of, week_start};

use auth::{AuthError, Verifier, Who};
use limit::Limiter;
use store::{Store, Written};

/// Where the server runs: the Firebase project, and the emulators when testing.
#[derive(Debug, Clone)]
pub struct Config {
    pub project: String,
    /// `host:port` of the Firestore emulator.
    pub firestore_emulator: Option<String>,
    /// Tokens come from the Auth emulator (unsigned).
    pub auth_emulator: bool,
}

impl Config {
    /// From the environment: `OPENSMITH_PROJECT` (or `GCLOUD_PROJECT`, set by the emulators),
    /// `FIRESTORE_EMULATOR_HOST`, `FIREBASE_AUTH_EMULATOR_HOST`.
    pub fn from_env() -> Option<Self> {
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        Some(Self {
            project: var("OPENSMITH_PROJECT").or_else(|| var("GCLOUD_PROJECT"))?,
            firestore_emulator: var("FIRESTORE_EMULATOR_HOST"),
            auth_emulator: var("FIREBASE_AUTH_EMULATOR_HOST").is_some(),
        })
    }
}

#[derive(Clone)]
pub struct AppState {
    verifier: Arc<Verifier>,
    store: Arc<Store>,
    limiter: Arc<Limiter>,
}

impl AppState {
    pub fn new(config: &Config) -> Self {
        let http = reqwest::Client::builder().timeout(std::time::Duration::from_secs(10)).build().expect("http client");
        Self {
            verifier: Arc::new(Verifier::new(config.project.clone(), config.auth_emulator, http.clone())),
            store: Arc::new(Store::new(&config.project, config.firestore_emulator.clone(), http)),
            limiter: Arc::new(Limiter::new(REQUESTS_PER_MINUTE)),
        }
    }
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/v1/saves/{slot}", get(pull).put(push))
        .route("/v1/saves/{slot}/history", get(history))
        .route("/v1/saves/{slot}/history/{version}", get(old))
        .route("/v1/profile", get(get_profile).put(put_profile))
        .route("/v1/challenge", get(get_board).post(post_score))
        .route("/v1/challenge/rival", get(get_rival))
        .route("/v1/events", get(|| async { Json(events::around(now())) }))
        .route("/v1/friends", get(get_friends).post(add_friend))
        .route("/v1/friends/{code}", delete(remove_friend))
        .route("/v1/card", put(put_card))
        .route("/v1/account", delete(delete_account))
        // The save, its envelope around it.
        .layer(DefaultBodyLimit::max(MAX_SAVE_BYTES + 16 * 1024))
        .with_state(state)
}

fn refuse(status: StatusCode, error: &str) -> Response {
    (status, Json(ApiError { error: error.into() })).into_response()
}

/// The player asking: a valid token, and requests left this minute.
struct Player(String);

/// A player whose e-mail is confirmed: only they write (an account made up in bulk cannot).
struct Verified(String);

impl<S> FromRequestParts<S> for Verified
where
    AppState: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let who = who(parts, state).await.map_err(|e| *e)?;
        if !who.verified {
            return Err(refuse(StatusCode::FORBIDDEN, "email not verified"));
        }
        Ok(Verified(who.uid))
    }
}

impl<S> FromRequestParts<S> for Player
where
    AppState: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        Ok(Player(who(parts, state).await.map_err(|e| *e)?.uid))
    }
}

/// The token's player, if valid and with requests left this minute.
async fn who<S>(parts: &Parts, state: &S) -> Result<Who, Box<Response>>
where
    AppState: FromRef<S>,
{
    let state = AppState::from_ref(state);
    let token = parts
        .headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");
    let who = state.verifier.who(token).await.map_err(|e| {
        Box::new(match e {
            AuthError::Keys => refuse(StatusCode::SERVICE_UNAVAILABLE, "sign-in check unavailable"),
            AuthError::Missing => refuse(StatusCode::UNAUTHORIZED, "missing token"),
            AuthError::Invalid(why) => {
                tracing::info!(why, "token refused");
                refuse(StatusCode::UNAUTHORIZED, "invalid token")
            }
        })
    })?;
    if !state.limiter.allow(&who.uid) {
        return Err(Box::new(([(axum::http::header::RETRY_AFTER, "60")], refuse(StatusCode::TOO_MANY_REQUESTS, "too many requests")).into_response()));
    }
    Ok(who)
}

fn unavailable(e: store::StoreError) -> Response {
    tracing::error!(error = e.0, "store");
    refuse(StatusCode::BAD_GATEWAY, "storage unavailable")
}

async fn pull(State(state): State<AppState>, Player(uid): Player, Path(slot): Path<String>) -> Response {
    if !is_slot(&slot) {
        return refuse(StatusCode::NOT_FOUND, "unknown slot");
    }
    match state.store.get(&uid, &slot).await {
        Ok(Some(s)) => {
            let data = serde_json::from_str(&s.text).unwrap_or(serde_json::Value::Null);
            Json(Save { version: s.version, updated_at: s.updated_at, data }).into_response()
        }
        Ok(None) => refuse(StatusCode::NOT_FOUND, "no save"),
        Err(e) => unavailable(e),
    }
}

async fn push(State(state): State<AppState>, Verified(uid): Verified, Path(slot): Path<String>, body: Result<Json<Push>, JsonRejection>) -> Response {
    if !is_slot(&slot) {
        return refuse(StatusCode::NOT_FOUND, "unknown slot");
    }
    let Json(push) = match body {
        Ok(b) => b,
        Err(JsonRejection::BytesRejection(_)) => return refuse(StatusCode::PAYLOAD_TOO_LARGE, "save too large"),
        Err(e) => return refuse(StatusCode::BAD_REQUEST, &e.body_text()),
    };
    let text = push.data.to_string();
    if text.len() > MAX_SAVE_BYTES {
        return refuse(StatusCode::PAYLOAD_TOO_LARGE, "save too large");
    }
    match state.store.put(&uid, &slot, push.base_version, &text).await {
        Ok(Written::Saved { version, updated_at }) => Json(Saved { version, updated_at }).into_response(),
        Ok(Written::Conflict { version, updated_at }) => (StatusCode::CONFLICT, Json(Conflict { version, updated_at })).into_response(),
        Err(e) => unavailable(e),
    }
}

async fn history(State(state): State<AppState>, Player(uid): Player, Path(slot): Path<String>) -> Response {
    if !is_slot(&slot) {
        return refuse(StatusCode::NOT_FOUND, "unknown slot");
    }
    match state.store.history(&uid, &slot).await {
        Ok(versions) => Json(versions).into_response(),
        Err(e) => unavailable(e),
    }
}

async fn old(State(state): State<AppState>, Player(uid): Player, Path((slot, version)): Path<(String, u64)>) -> Response {
    if !is_slot(&slot) {
        return refuse(StatusCode::NOT_FOUND, "unknown slot");
    }
    match state.store.old(&uid, &slot, version).await {
        Ok(Some(s)) => {
            let data = serde_json::from_str(&s.text).unwrap_or(serde_json::Value::Null);
            Json(Save { version: s.version, updated_at: s.updated_at, data }).into_response()
        }
        Ok(None) => refuse(StatusCode::NOT_FOUND, "no such version"),
        Err(e) => unavailable(e),
    }
}

async fn get_profile(State(state): State<AppState>, Player(uid): Player) -> Response {
    match state.store.profile(&uid).await {
        Ok(p) => Json(p).into_response(),
        Err(e) => unavailable(e),
    }
}

async fn put_profile(State(state): State<AppState>, Verified(uid): Verified, body: Result<Json<Profile>, JsonRejection>) -> Response {
    let Ok(Json(Profile { name: Some(name) })) = body else { return refuse(StatusCode::BAD_REQUEST, "bad name") };
    if !valid_name(&name) {
        return refuse(StatusCode::BAD_REQUEST, "bad name");
    }
    match state.store.set_name(&uid, &name, this_week()).await {
        Ok(()) => Json(Profile { name: Some(name) }).into_response(),
        Err(e) => unavailable(e),
    }
}

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64)
}

fn this_week() -> i64 {
    week_of(now())
}

/// This week's board, as `uid` sees it.
async fn board(state: &AppState, uid: &str) -> Result<Board, store::StoreError> {
    let week = this_week();
    let top = state.store.top(week, TOP).await?;
    let mut entries: Vec<Entry> = Vec::with_capacity(top.len());
    for (i, (who, name, score, accuracy)) in top.into_iter().enumerate() {
        // Equal scores share a rank.
        let rank = match entries.last() {
            Some(prev) if prev.score == score => prev.rank,
            _ => i as u64 + 1,
        };
        entries.push(Entry { rank, name, score, accuracy, me: who == uid });
    }
    let me = match state.store.best(uid, week).await? {
        Some((score, accuracy)) => {
            let rank = state.store.count(week, Some(score)).await? + 1;
            let name = state.store.profile(uid).await?.name.unwrap_or_default();
            Some(Entry { rank, name, score, accuracy, me: true })
        }
        None => None,
    };
    Ok(Board { challenge: challenge_of(week, events::all()), ends: week_start(week + 1), players: state.store.count(week, None).await?, top: entries, me })
}

async fn get_board(State(state): State<AppState>, Player(uid): Player) -> Response {
    match board(&state, &uid).await {
        Ok(b) => Json(b).into_response(),
        Err(e) => unavailable(e),
    }
}

async fn post_score(State(state): State<AppState>, Verified(uid): Verified, body: Result<Json<Score>, JsonRejection>) -> Response {
    let Ok(Json(run)) = body else { return refuse(StatusCode::BAD_REQUEST, "bad score") };
    let challenge = challenge_of(this_week(), events::all());
    if run.week != challenge.week || run.song != challenge.song || run.level != challenge.level {
        return refuse(StatusCode::BAD_REQUEST, "not this week's challenge");
    }
    if run.score > MAX_SCORE || !(0.0..=1.0).contains(&run.accuracy) || run.trace.len() > MAX_TRACE || run.trace.iter().any(|&p| p > MAX_SCORE) {
        return refuse(StatusCode::BAD_REQUEST, "bad score");
    }
    let name = match state.store.profile(&uid).await {
        Ok(Profile { name: Some(name) }) => name,
        Ok(_) => return refuse(StatusCode::CONFLICT, "name needed"),
        Err(e) => return unavailable(e),
    };
    if let Err(e) = state.store.submit(&uid, &name, &run).await {
        return unavailable(e);
    }
    match board(&state, &uid).await {
        Ok(b) => Json(b).into_response(),
        Err(e) => unavailable(e),
    }
}

async fn get_rival(State(state): State<AppState>, Player(uid): Player) -> Response {
    match state.store.rival(&uid, this_week()).await {
        Ok(rival) => Json(rival).into_response(),
        Err(e) => unavailable(e),
    }
}

/// The player's code and card, and their friends, the most fans won this week first.
async fn friends(state: &AppState, uid: &str) -> Result<Friends, store::StoreError> {
    let code = state.store.code(uid).await?;
    let me = state.store.own_card(uid).await?;
    let week = this_week();
    let mut friends: Vec<_> = state.store.cards(&state.store.friend_uids(uid).await?).await?.into_iter().map(|(_, f)| f).collect();
    let this_week_fans = |c: &Option<Card>| c.as_ref().filter(|c| c.week == week).map_or(0, |c| c.week_fans);
    friends.sort_by_key(|f| std::cmp::Reverse(this_week_fans(&f.card)));
    Ok(Friends { code, me, friends })
}

async fn get_friends(State(state): State<AppState>, Player(uid): Player) -> Response {
    match friends(&state, &uid).await {
        Ok(f) => Json(f).into_response(),
        Err(e) => unavailable(e),
    }
}

async fn add_friend(State(state): State<AppState>, Verified(uid): Verified, body: Result<Json<AddFriend>, JsonRejection>) -> Response {
    let Some(code) = body.ok().and_then(|Json(a)| clean_code(&a.code)) else { return refuse(StatusCode::NOT_FOUND, "no such code") };
    let friend = match state.store.uid_of(&code).await {
        Ok(Some(f)) => f,
        Ok(None) => return refuse(StatusCode::NOT_FOUND, "no such code"),
        Err(e) => return unavailable(e),
    };
    if friend == uid {
        return refuse(StatusCode::BAD_REQUEST, "that is you");
    }
    match state.store.follow(&uid, &friend).await {
        Ok(false) => return refuse(StatusCode::CONFLICT, "too many friends"),
        Ok(true) => {}
        Err(e) => return unavailable(e),
    }
    match friends(&state, &uid).await {
        Ok(f) => Json(f).into_response(),
        Err(e) => unavailable(e),
    }
}

async fn remove_friend(State(state): State<AppState>, Player(uid): Player, Path(code): Path<String>) -> Response {
    if let Some(code) = clean_code(&code) {
        match state.store.uid_of(&code).await {
            Ok(Some(friend)) => {
                if let Err(e) = state.store.unfollow(&uid, &friend).await {
                    return unavailable(e);
                }
            }
            Ok(None) => {}
            Err(e) => return unavailable(e),
        }
    }
    match friends(&state, &uid).await {
        Ok(f) => Json(f).into_response(),
        Err(e) => unavailable(e),
    }
}

async fn put_card(State(state): State<AppState>, Verified(uid): Verified, body: Result<Json<Card>, JsonRejection>) -> Response {
    let Ok(Json(card)) = body else { return refuse(StatusCode::BAD_REQUEST, "bad card") };
    if !valid_card(&card) {
        return refuse(StatusCode::BAD_REQUEST, "bad card");
    }
    match state.store.set_card(&uid, &card).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => unavailable(e),
    }
}

async fn delete_account(State(state): State<AppState>, Player(uid): Player) -> Response {
    match state.store.delete_all(&uid).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => unavailable(e),
    }
}
