//! The server that keeps each player's saves online (see `opensmith_cloud` for the routes).

pub mod auth;
pub mod limit;
pub mod store;

use std::sync::Arc;

use axum::extract::rejection::JsonRejection;
use axum::extract::{DefaultBodyLimit, FromRef, FromRequestParts, Path, State};
use axum::http::StatusCode;
use axum::http::request::Parts;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get};
use axum::{Json, Router};
use opensmith_cloud::{ApiError, Conflict, MAX_SAVE_BYTES, Push, REQUESTS_PER_MINUTE, Save, Saved, is_slot};

use auth::{AuthError, Verifier};
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

impl<S> FromRequestParts<S> for Player
where
    AppState: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let state = AppState::from_ref(state);
        let token = parts
            .headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .unwrap_or("");
        let uid = state.verifier.uid(token).await.map_err(|e| match e {
            AuthError::Keys => refuse(StatusCode::SERVICE_UNAVAILABLE, "sign-in check unavailable"),
            AuthError::Missing => refuse(StatusCode::UNAUTHORIZED, "missing token"),
            AuthError::Invalid(why) => {
                tracing::info!(why, "token refused");
                refuse(StatusCode::UNAUTHORIZED, "invalid token")
            }
        })?;
        if !state.limiter.allow(&uid) {
            return Err(([(axum::http::header::RETRY_AFTER, "60")], refuse(StatusCode::TOO_MANY_REQUESTS, "too many requests"))
                .into_response());
        }
        Ok(Player(uid))
    }
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

async fn push(State(state): State<AppState>, Player(uid): Player, Path(slot): Path<String>, body: Result<Json<Push>, JsonRejection>) -> Response {
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

async fn delete_account(State(state): State<AppState>, Player(uid): Player) -> Response {
    match state.store.delete_all(&uid).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => unavailable(e),
    }
}
