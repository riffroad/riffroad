//! The player's account and saves online: sign-in by e-mail with Firebase Auth (its REST API),
//! the sign-in kept in the system's keychain between launches, and the saves sent to and
//! fetched from the OpenSmith server. Everything goes through here, not through the page: the
//! token never reaches the interface.

#[cfg(test)]
use std::sync::Mutex as StdMutex;
use std::time::{Duration, Instant};

use opensmith_cloud::{ACCOUNT_PATH, Conflict, Push, Save, Saved, is_slot, save_path};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::Mutex;

/// Riffroad's Firebase project (`studio-998403342-4f8d5`): its public key (an identifier, not a
/// secret, limited to sign-in and token refresh) and its server (`cloud/deploy.sh`). Either one
/// empty hides the account.
const FIREBASE_KEY: &str = "AIzaSyAx3pCQVTLhUjm87E2k8eaPxkfex5FsNWs";
const SERVER: &str = "https://opensmith-api-ju6xor62bq-ew.a.run.app";

/// Where the cloud is (overridden by `OPENSMITH_FIREBASE_KEY`, `OPENSMITH_CLOUD_URL` and
/// `FIREBASE_AUTH_EMULATOR_HOST`, for development and tests).
#[derive(Debug, Clone)]
pub struct Config {
    pub key: String,
    pub server: String,
    pub auth_emulator: Option<String>,
}

impl Config {
    pub fn from_env() -> Option<Self> {
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        let key = var("OPENSMITH_FIREBASE_KEY").unwrap_or_else(|| FIREBASE_KEY.into());
        let server = var("OPENSMITH_CLOUD_URL").unwrap_or_else(|| SERVER.into());
        (!key.is_empty() && !server.is_empty()).then(|| Self { key, server: server.trim_end_matches('/').into(), auth_emulator: var("FIREBASE_AUTH_EMULATOR_HOST") })
    }

    fn identity(&self, method: &str) -> String {
        match &self.auth_emulator {
            Some(host) => format!("http://{host}/identitytoolkit.googleapis.com/v1/accounts:{method}?key={}", self.key),
            None => format!("https://identitytoolkit.googleapis.com/v1/accounts:{method}?key={}", self.key),
        }
    }

    fn refresh_url(&self) -> String {
        match &self.auth_emulator {
            Some(host) => format!("http://{host}/securetoken.googleapis.com/v1/token?key={}", self.key),
            None => format!("https://securetoken.googleapis.com/v1/token?key={}", self.key),
        }
    }
}

/// What is kept between launches: who is signed in, and the token that signs in again.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Kept {
    pub uid: String,
    pub email: String,
    pub refresh_token: String,
}

/// Where the sign-in is kept: the system's keychain, or memory (tests).
pub trait Keep: Send + Sync {
    fn load(&self) -> Option<Kept>;
    fn store(&self, kept: &Kept);
    fn clear(&self);
}

pub struct Keychain;

impl Keychain {
    fn entry() -> Option<keyring::Entry> {
        keyring::Entry::new("OpenSmith", "account").ok()
    }
}

impl Keep for Keychain {
    fn load(&self) -> Option<Kept> {
        serde_json::from_str(&Self::entry()?.get_password().ok()?).ok()
    }

    fn store(&self, kept: &Kept) {
        if let (Some(entry), Ok(text)) = (Self::entry(), serde_json::to_string(kept))
            && let Err(e) = entry.set_password(&text)
        {
            eprintln!("compte : trousseau indisponible ({e})");
        }
    }

    fn clear(&self) {
        if let Some(entry) = Self::entry() {
            let _ = entry.delete_credential();
        }
    }
}

/// The sign-in kept in memory only (tests).
#[cfg(test)]
#[derive(Default)]
pub struct Memory(StdMutex<Option<Kept>>);

/// A keep shared (tests: the same keychain across two launches).
impl<T: Keep + ?Sized> Keep for std::sync::Arc<T> {
    fn load(&self) -> Option<Kept> {
        (**self).load()
    }

    fn store(&self, kept: &Kept) {
        (**self).store(kept)
    }

    fn clear(&self) {
        (**self).clear()
    }
}

#[cfg(test)]
impl Keep for Memory {
    fn load(&self) -> Option<Kept> {
        self.0.lock().unwrap().clone()
    }

    fn store(&self, kept: &Kept) {
        *self.0.lock().unwrap() = Some(kept.clone());
    }

    fn clear(&self) {
        *self.0.lock().unwrap() = None;
    }
}

struct Session {
    kept: Kept,
    id_token: String,
    /// When the ID token stops being valid (a minute early).
    until: Instant,
}

/// A refusal, as a short code the interface words.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloudError {
    /// No project to talk to.
    Unavailable,
    SignedOut,
    /// Firebase's reason: `email-exists`, `invalid-credentials`, `weak-password`,
    /// `invalid-email`, `too-many-attempts`, `auth-failed`.
    Auth(&'static str),
    TooLarge,
    TooManyRequests,
    Network,
    Server(u16),
}

impl CloudError {
    pub fn code(&self) -> String {
        match self {
            Self::Unavailable => "unavailable".into(),
            Self::SignedOut => "signed-out".into(),
            Self::Auth(code) => (*code).into(),
            Self::TooLarge => "too-large".into(),
            Self::TooManyRequests => "too-many-requests".into(),
            Self::Network => "network".into(),
            Self::Server(status) => format!("server-{status}"),
        }
    }
}

fn auth_error(message: &str) -> CloudError {
    let reason = message.split([' ', ':']).next().unwrap_or("");
    CloudError::Auth(match reason {
        "EMAIL_EXISTS" => "email-exists",
        "INVALID_LOGIN_CREDENTIALS" | "EMAIL_NOT_FOUND" | "INVALID_PASSWORD" | "USER_DISABLED" => "invalid-credentials",
        "WEAK_PASSWORD" | "MISSING_PASSWORD" => "weak-password",
        "INVALID_EMAIL" | "MISSING_EMAIL" => "invalid-email",
        "TOO_MANY_ATTEMPTS_TRY_LATER" => "too-many-attempts",
        _ => "auth-failed",
    })
}

/// Who is signed in, for the interface.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// Whether there is an online service at all.
    pub available: bool,
    pub email: Option<String>,
}

/// What became of a save sent.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Pushed {
    Saved(Saved),
    /// Another Mac saved since: the player chooses.
    Conflict(Conflict),
}

pub struct Cloud {
    http: reqwest::Client,
    config: Option<Config>,
    keep: Box<dyn Keep>,
    session: Mutex<Option<Session>>,
}

impl Cloud {
    pub fn new(config: Option<Config>, keep: Box<dyn Keep>) -> Self {
        let http = reqwest::Client::builder().timeout(Duration::from_secs(15)).build().expect("http client");
        Self { http, config, keep, session: Mutex::new(None) }
    }

    fn config(&self) -> Result<&Config, CloudError> {
        self.config.as_ref().ok_or(CloudError::Unavailable)
    }

    pub async fn status(&self) -> Status {
        let email = match self.session.lock().await.as_ref() {
            Some(s) => Some(s.kept.email.clone()),
            None => self.keep.load().map(|k| k.email),
        };
        Status { available: self.config.is_some(), email: email.filter(|_| self.config.is_some()) }
    }

    /// Signed in (`create`: a new account) with an e-mail and a password.
    pub async fn sign_in(&self, email: &str, password: &str, create: bool) -> Result<Status, CloudError> {
        let config = self.config()?;
        let reply = self
            .http
            .post(config.identity(if create { "signUp" } else { "signInWithPassword" }))
            .json(&json!({ "email": email.trim(), "password": password, "returnSecureToken": true }))
            .send()
            .await
            .map_err(|_| CloudError::Network)?;
        let ok = reply.status().is_success();
        let body: Value = reply.json().await.map_err(|_| CloudError::Network)?;
        if !ok {
            return Err(auth_error(body["error"]["message"].as_str().unwrap_or("")));
        }
        let field = |k: &str| body[k].as_str().unwrap_or_default().to_string();
        let kept = Kept { uid: field("localId"), email: field("email"), refresh_token: field("refreshToken") };
        let seconds = field("expiresIn").parse().unwrap_or(3600u64);
        self.keep.store(&kept);
        *self.session.lock().await = Some(Session { kept, id_token: field("idToken"), until: Instant::now() + Duration::from_secs(seconds.saturating_sub(60)) });
        Ok(self.status().await)
    }

    pub async fn sign_out(&self) {
        *self.session.lock().await = None;
        self.keep.clear();
    }

    /// An e-mail to choose a new password.
    pub async fn reset_password(&self, email: &str) -> Result<(), CloudError> {
        let config = self.config()?;
        let reply = self
            .http
            .post(config.identity("sendOobCode"))
            .json(&json!({ "requestType": "PASSWORD_RESET", "email": email.trim() }))
            .send()
            .await
            .map_err(|_| CloudError::Network)?;
        if reply.status().is_success() {
            return Ok(());
        }
        let body: Value = reply.json().await.unwrap_or(Value::Null);
        Err(auth_error(body["error"]["message"].as_str().unwrap_or("")))
    }

    /// A valid ID token (`fresh`: a new one even if the last one still looks valid).
    async fn token(&self, fresh: bool) -> Result<String, CloudError> {
        let config = self.config()?;
        let mut session = self.session.lock().await;
        if session.is_none() {
            let kept = self.keep.load().ok_or(CloudError::SignedOut)?;
            *session = Some(Session { kept, id_token: String::new(), until: Instant::now() });
        }
        let s = session.as_mut().expect("session");
        if !fresh && Instant::now() < s.until {
            return Ok(s.id_token.clone());
        }
        let reply = self
            .http
            .post(config.refresh_url())
            .form(&[("grant_type", "refresh_token"), ("refresh_token", s.kept.refresh_token.as_str())])
            .send()
            .await
            .map_err(|_| CloudError::Network)?;
        let ok = reply.status().is_success();
        let status = reply.status();
        let body: Value = reply.json().await.map_err(|_| CloudError::Network)?;
        if !ok {
            if status.is_client_error() {
                // The account is gone, disabled, or its password changed: signed out.
                *session = None;
                self.keep.clear();
                return Err(CloudError::SignedOut);
            }
            return Err(CloudError::Server(status.as_u16()));
        }
        let field = |k: &str| body[k].as_str().unwrap_or_default().to_string();
        s.id_token = field("id_token");
        if let Some(t) = body["refresh_token"].as_str().filter(|t| *t != s.kept.refresh_token) {
            s.kept.refresh_token = t.to_string();
            self.keep.store(&s.kept);
        }
        s.until = Instant::now() + Duration::from_secs(field("expires_in").parse().unwrap_or(3600u64).saturating_sub(60));
        Ok(s.id_token.clone())
    }

    /// A request to the server with the player's token, once more with a fresh one if refused.
    async fn send(&self, build: impl Fn(&reqwest::Client, &str) -> reqwest::RequestBuilder) -> Result<reqwest::Response, CloudError> {
        let server = &self.config()?.server;
        let mut fresh = false;
        loop {
            let token = self.token(fresh).await?;
            let reply = build(&self.http, server).bearer_auth(token).send().await.map_err(|_| CloudError::Network)?;
            if reply.status() == reqwest::StatusCode::UNAUTHORIZED && !fresh {
                fresh = true;
                continue;
            }
            return match reply.status().as_u16() {
                401 => Err(CloudError::SignedOut),
                413 => Err(CloudError::TooLarge),
                429 => Err(CloudError::TooManyRequests),
                _ => Ok(reply),
            };
        }
    }

    /// The save online in `slot`, if any.
    pub async fn pull(&self, slot: &str) -> Result<Option<Save>, CloudError> {
        if !is_slot(slot) {
            return Err(CloudError::Server(404));
        }
        let reply = self.send(|http, server| http.get(format!("{server}{}", save_path(slot)))).await?;
        match reply.status().as_u16() {
            200 => reply.json().await.map(Some).map_err(|_| CloudError::Network),
            404 => Ok(None),
            s => Err(CloudError::Server(s)),
        }
    }

    /// `data` saved in `slot` over version `base_version` (0: the first save).
    pub async fn push(&self, slot: &str, data: Value, base_version: u64) -> Result<Pushed, CloudError> {
        if !is_slot(slot) {
            return Err(CloudError::Server(404));
        }
        let push = Push { base_version, data };
        let reply = self.send(|http, server| http.put(format!("{server}{}", save_path(slot))).json(&push)).await?;
        match reply.status().as_u16() {
            200 => reply.json().await.map(Pushed::Saved).map_err(|_| CloudError::Network),
            409 => reply.json().await.map(Pushed::Conflict).map_err(|_| CloudError::Network),
            s => Err(CloudError::Server(s)),
        }
    }

    /// The account deleted: its saves on the server, then the sign-in itself.
    pub async fn delete_account(&self) -> Result<(), CloudError> {
        let reply = self.send(|http, server| http.delete(format!("{server}{ACCOUNT_PATH}"))).await?;
        if !reply.status().is_success() {
            return Err(CloudError::Server(reply.status().as_u16()));
        }
        let token = self.token(false).await?;
        let reply = self
            .http
            .post(self.config()?.identity("delete"))
            .json(&json!({ "idToken": token }))
            .send()
            .await
            .map_err(|_| CloudError::Network)?;
        if !reply.status().is_success() {
            return Err(CloudError::Server(reply.status().as_u16()));
        }
        self.sign_out().await;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn words_firebase_refusals() {
        assert_eq!(auth_error("EMAIL_EXISTS"), CloudError::Auth("email-exists"));
        assert_eq!(auth_error("WEAK_PASSWORD : Password should be at least 6 characters"), CloudError::Auth("weak-password"));
        assert_eq!(auth_error("INVALID_LOGIN_CREDENTIALS"), CloudError::Auth("invalid-credentials"));
        assert_eq!(auth_error("something new"), CloudError::Auth("auth-failed"));
        assert_eq!(CloudError::Server(502).code(), "server-502");
    }

    #[tokio::test]
    async fn without_a_project_the_account_stays_hidden() {
        let cloud = Cloud::new(None, Box::new(Memory::default()));
        assert_eq!(cloud.status().await, Status { available: false, email: None });
        assert_eq!(cloud.pull("career").await, Err(CloudError::Unavailable));
        assert_eq!(cloud.sign_in("a@b.c", "secret-123", true).await, Err(CloudError::Unavailable));
    }

    /// The app against the real server and the Firebase emulators, in `cloud/`:
    /// `firebase emulators:exec --project demo-opensmith --only auth,firestore 'cargo test --manifest-path ../app/src-tauri/Cargo.toml cloud'`.
    #[tokio::test]
    async fn two_macs_share_a_career_and_never_overwrite_each_other() {
        let Some(server) = opensmith_cloud_server::Config::from_env().filter(|c| c.firestore_emulator.is_some() && c.auth_emulator) else {
            eprintln!("skipped: run under `firebase emulators:exec` (see the test's comment)");
            return;
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let app = opensmith_cloud_server::router(opensmith_cloud_server::AppState::new(&server));
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let config = Config { key: "demo".into(), server: url, auth_emulator: std::env::var("FIREBASE_AUTH_EMULATOR_HOST").ok() };
        let email = format!("mac{}@example.com", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos());

        let keychain = Arc::new(Memory::default());
        let mac_a = Cloud::new(Some(config.clone()), Box::new(keychain.clone()));
        assert_eq!(mac_a.status().await, Status { available: true, email: None });
        assert_eq!(mac_a.sign_in(&email, "123", true).await, Err(CloudError::Auth("weak-password")));
        assert_eq!(mac_a.sign_in(&email, "secret-123", true).await.unwrap().email.as_deref(), Some(email.as_str()));
        assert_eq!(mac_a.sign_in(&email, "secret-123", true).await, Err(CloudError::Auth("email-exists")));
        assert_eq!(mac_a.pull("career").await, Ok(None));
        let Pushed::Saved(first) = mac_a.push("career", json!({ "act": 1 }), 0).await.unwrap() else { panic!("not saved") };
        assert_eq!(first.version, 1);

        let mac_b = Cloud::new(Some(config.clone()), Box::new(Memory::default()));
        assert_eq!(mac_b.sign_in(&email, "wrong-password", false).await, Err(CloudError::Auth("invalid-credentials")));
        mac_b.sign_in(&email, "secret-123", false).await.unwrap();
        let online = mac_b.pull("career").await.unwrap().unwrap();
        assert_eq!((online.version, online.data), (1, json!({ "act": 1 })));
        assert!(matches!(mac_b.push("career", json!({ "act": 2 }), 1).await, Ok(Pushed::Saved(Saved { version: 2, .. }))));
        // Mac A, still on version 1, is told instead of overwriting.
        assert!(matches!(mac_a.push("career", json!({ "act": 9 }), 1).await, Ok(Pushed::Conflict(Conflict { version: 2, .. }))));

        // Mac A launched again: signed in from the keychain, a new token from the kept one.
        let relaunched = Cloud::new(Some(config.clone()), Box::new(keychain.clone()));
        assert_eq!(relaunched.status().await.email.as_deref(), Some(email.as_str()));
        assert_eq!(relaunched.pull("career").await.unwrap().unwrap().data, json!({ "act": 2 }));

        relaunched.delete_account().await.unwrap();
        assert_eq!(relaunched.status().await.email, None);
        assert_eq!(keychain.load(), None);
        assert_eq!(mac_b.sign_in(&email, "secret-123", false).await, Err(CloudError::Auth("invalid-credentials")));
    }
}
