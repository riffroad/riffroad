//! The player's account and saves online: sign-in by e-mail with Firebase Auth (its REST API),
//! the sign-in kept in the system's keychain between launches, and the saves sent to and
//! fetched from the OpenSmith server. Everything goes through here, not through the page: the
//! token never reaches the interface.

#[cfg(test)]
use std::sync::Mutex as StdMutex;
use std::time::{Duration, Instant};

use opensmith_cloud::{ACCOUNT_PATH, Board, Card, Conflict, Event, Friends, Profile, Push, Rival, Save, Saved, Score, Version, history_path, is_slot, save_path};
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
    /// Google's picture of the player and their name there (signed in with Google).
    #[serde(default)]
    pub photo: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
}

/// Where the sign-in is kept: a file of the app's own, or memory (tests).
pub trait Keep: Send + Sync {
    fn load(&self) -> Option<Kept>;
    fn store(&self, kept: &Kept);
    fn clear(&self);
}

/// The sign-in in a file only the player can read (`account.json` in the app's data folder),
/// not the keychain: macOS ties a keychain item to the exact build of an app without an Apple
/// team, and asked for the player's password after every update. What it holds signs into a
/// game account, nothing more.
pub struct FileKeep {
    path: std::path::PathBuf,
}

impl FileKeep {
    pub fn new(path: std::path::PathBuf) -> Self {
        Self { path }
    }

    /// `account.json` in the app's data folder (`~/Library/Application Support/<identifier>`).
    pub fn in_app_data(identifier: &str) -> Self {
        Self::new(dirs::data_dir().unwrap_or_else(std::env::temp_dir).join(identifier).join("account.json"))
    }

    /// The text written whole or not at all, readable by its owner only.
    fn write(&self, text: &str) -> std::io::Result<()> {
        use std::io::Write as _;
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let mut file = options.open(&tmp)?;
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        std::fs::rename(&tmp, &self.path)
    }
}

impl Keep for FileKeep {
    fn load(&self) -> Option<Kept> {
        serde_json::from_str(&std::fs::read_to_string(&self.path).ok()?).ok()
    }

    fn store(&self, kept: &Kept) {
        let written = serde_json::to_string(kept).map_err(std::io::Error::other).and_then(|text| self.write(&text));
        if let Err(e) = written {
            eprintln!("compte : connexion non gardée ({e})");
        }
    }

    fn clear(&self) {
        let _ = std::fs::remove_file(&self.path);
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
    /// Whether the e-mail is confirmed, once asked (`check`).
    verified: Option<bool>,
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
    /// The server writes only for a confirmed e-mail.
    Unverified,
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
            Self::Unverified => "unverified".into(),
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
    /// Whether the e-mail is confirmed; None until asked.
    pub verified: Option<bool>,
    /// The player's picture and name (from Google), for the account button.
    pub photo: Option<String>,
    pub name: Option<String>,
    /// Whether signing in with Google is offered.
    pub google: bool,
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
        let (kept, verified) = match self.session.lock().await.as_ref() {
            Some(s) => (Some(s.kept.clone()), s.verified),
            None => (self.keep.load(), None),
        };
        let available = self.config.is_some();
        let kept = kept.filter(|_| available);
        Status {
            available,
            email: kept.as_ref().map(|k| k.email.clone()),
            verified: verified.filter(|_| available),
            photo: kept.as_ref().and_then(|k| k.photo.clone()),
            name: kept.and_then(|k| k.name),
            google: available && crate::google::available(),
        }
    }

    /// Signed in with an identity provider's token (Google's ID token): Firebase makes the
    /// account the first time, finds it after. An account already made by e-mail and password
    /// for the same address is refused (`account-exists`): sign in with the password instead.
    pub async fn sign_in_idp(&self, id_token: &str) -> Result<Status, CloudError> {
        let config = self.config()?;
        let body = json!({
            "postBody": format!("id_token={}&providerId=google.com", crate::google::encode(id_token)),
            "requestUri": "http://localhost",
            "returnSecureToken": true,
            "returnIdpCredential": true,
        });
        let reply = self.http.post(config.identity("signInWithIdp")).json(&body).send().await.map_err(|_| CloudError::Network)?;
        let ok = reply.status().is_success();
        let body: Value = reply.json().await.map_err(|_| CloudError::Network)?;
        if !ok {
            return Err(auth_error(body["error"]["message"].as_str().unwrap_or("")));
        }
        if body["needConfirmation"].as_bool() == Some(true) {
            return Err(CloudError::Auth("account-exists"));
        }
        let field = |k: &str| body[k].as_str().unwrap_or_default().to_string();
        let text = |k: &str| body[k].as_str().filter(|v| !v.is_empty()).map(String::from);
        let kept = Kept { uid: field("localId"), email: field("email"), refresh_token: field("refreshToken"), photo: text("photoUrl"), name: text("displayName") };
        let seconds = field("expiresIn").parse().unwrap_or(3600u64);
        self.keep.store(&kept);
        let until = Instant::now() + Duration::from_secs(seconds.saturating_sub(60));
        let verified = body["emailVerified"].as_bool();
        *self.session.lock().await = Some(Session { kept, id_token: field("idToken"), until, verified });
        Ok(self.status().await)
    }

    /// Asks Firebase whether the e-mail is confirmed (a link clicked a moment ago counts: the
    /// token is renewed, so the server sees it too).
    pub async fn check(&self) -> Result<Status, CloudError> {
        let token = self.token(true).await?;
        let reply = self.http.post(self.config()?.identity("lookup")).json(&json!({ "idToken": token })).send().await.map_err(|_| CloudError::Network)?;
        if !reply.status().is_success() {
            return Err(CloudError::Server(reply.status().as_u16()));
        }
        let body: Value = reply.json().await.map_err(|_| CloudError::Network)?;
        let verified = body["users"][0]["emailVerified"].as_bool().unwrap_or(false);
        if let Some(s) = self.session.lock().await.as_mut() {
            s.verified = Some(verified);
        }
        Ok(self.status().await)
    }

    /// The e-mail with the link that confirms the address, in `lang` (`fr`, `en`).
    pub async fn send_verification(&self, lang: &str) -> Result<(), CloudError> {
        let token = self.token(false).await?;
        let reply = self
            .http
            .post(self.config()?.identity("sendOobCode"))
            .header("X-Firebase-Locale", lang)
            .json(&json!({ "requestType": "VERIFY_EMAIL", "idToken": token }))
            .send()
            .await
            .map_err(|_| CloudError::Network)?;
        if reply.status().is_success() {
            return Ok(());
        }
        let body: Value = reply.json().await.unwrap_or(Value::Null);
        Err(auth_error(body["error"]["message"].as_str().unwrap_or("")))
    }

    /// Signed in (`create`: a new account, sent the e-mail that confirms it, in `lang`) with an
    /// e-mail and a password.
    pub async fn sign_in(&self, email: &str, password: &str, create: bool, lang: &str) -> Result<Status, CloudError> {
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
        let kept = Kept { uid: field("localId"), email: field("email"), refresh_token: field("refreshToken"), photo: None, name: None };
        let seconds = field("expiresIn").parse().unwrap_or(3600u64);
        self.keep.store(&kept);
        let until = Instant::now() + Duration::from_secs(seconds.saturating_sub(60));
        *self.session.lock().await = Some(Session { kept, id_token: field("idToken"), until, verified: create.then_some(false) });
        if create {
            self.send_verification(lang).await?;
            return Ok(self.status().await);
        }
        self.check().await
    }

    pub async fn sign_out(&self) {
        *self.session.lock().await = None;
        self.keep.clear();
    }

    /// An e-mail to choose a new password, in `lang` (`fr`, `en`).
    pub async fn reset_password(&self, email: &str, lang: &str) -> Result<(), CloudError> {
        let config = self.config()?;
        let reply = self
            .http
            .post(config.identity("sendOobCode"))
            .header("X-Firebase-Locale", lang)
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
            *session = Some(Session { kept, id_token: String::new(), until: Instant::now(), verified: None });
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
                403 => Err(CloudError::Unverified),
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

    /// The saves kept before the current one in `slot`, newest first.
    pub async fn history(&self, slot: &str) -> Result<Vec<Version>, CloudError> {
        if !is_slot(slot) {
            return Err(CloudError::Server(404));
        }
        let reply = self.send(|http, server| http.get(format!("{server}{}", history_path(slot)))).await?;
        match reply.status().as_u16() {
            200 => reply.json().await.map_err(|_| CloudError::Network),
            s => Err(CloudError::Server(s)),
        }
    }

    /// Version `version` of `slot` put back as its save (the one it replaces joins the history):
    /// the save now online.
    pub async fn restore(&self, slot: &str, version: u64) -> Result<Save, CloudError> {
        if !is_slot(slot) {
            return Err(CloudError::Server(404));
        }
        let reply = self.send(|http, server| http.get(format!("{server}{}/{version}", history_path(slot)))).await?;
        let old: Save = match reply.status().as_u16() {
            200 => reply.json().await.map_err(|_| CloudError::Network)?,
            s => return Err(CloudError::Server(s)),
        };
        let current = self.pull(slot).await?.map_or(0, |s| s.version);
        match self.push(slot, old.data.clone(), current).await? {
            Pushed::Saved(s) => Ok(Save { version: s.version, updated_at: s.updated_at, data: old.data }),
            // Another Mac saved in between: asked again, on the newer save.
            Pushed::Conflict(_) => Err(CloudError::Server(409)),
        }
    }

    /// A call to the server: its answer as `T`, or why not.
    async fn call<T: serde::de::DeserializeOwned>(&self, method: reqwest::Method, path: &str, body: Option<&Value>) -> Result<T, CloudError> {
        let reply = self
            .send(|http, server| {
                let r = http.request(method.clone(), format!("{server}{path}"));
                match body {
                    Some(b) => r.json(b),
                    None => r,
                }
            })
            .await?;
        match reply.status().as_u16() {
            200 => reply.json().await.map_err(|_| CloudError::Network),
            s => Err(CloudError::Server(s)),
        }
    }

    /// The events on now or soon (no account needed).
    pub async fn events(&self) -> Result<Vec<Event>, CloudError> {
        let reply = self.http.get(format!("{}/v1/events", self.config()?.server)).send().await.map_err(|_| CloudError::Network)?;
        match reply.status().as_u16() {
            200 => reply.json().await.map_err(|_| CloudError::Network),
            s => Err(CloudError::Server(s)),
        }
    }

    /// The name the boards show (none yet: None).
    pub async fn profile(&self) -> Result<Profile, CloudError> {
        self.call(reqwest::Method::GET, "/v1/profile", None).await
    }

    /// A name chosen for the boards (400: not a name the boards take).
    pub async fn set_name(&self, name: &str) -> Result<Profile, CloudError> {
        self.call(reqwest::Method::PUT, "/v1/profile", Some(&json!({ "name": name.trim() }))).await
    }

    /// This week's challenge and its board.
    pub async fn board(&self) -> Result<Board, CloudError> {
        self.call(reqwest::Method::GET, "/v1/challenge", None).await
    }

    /// The player's friend code and card, and their friends, best week first.
    pub async fn friends(&self) -> Result<Friends, CloudError> {
        self.call(reqwest::Method::GET, "/v1/friends", None).await
    }

    /// A friend followed by their code (404: no such code; 400: one's own).
    pub async fn add_friend(&self, code: &str) -> Result<Friends, CloudError> {
        self.call(reqwest::Method::POST, "/v1/friends", Some(&json!({ "code": code }))).await
    }

    pub async fn remove_friend(&self, code: &str) -> Result<Friends, CloudError> {
        let code: String = code.chars().filter(char::is_ascii_alphanumeric).collect();
        self.call(reqwest::Method::DELETE, &format!("/v1/friends/{code}"), None).await
    }

    /// The player's card, as friends see it.
    pub async fn set_card(&self, card: &Card) -> Result<(), CloudError> {
        let body = serde_json::to_value(card).map_err(|_| CloudError::Network)?;
        let reply = self.send(|http, server| http.put(format!("{server}/v1/card")).json(&body)).await?;
        if reply.status().is_success() { Ok(()) } else { Err(CloudError::Server(reply.status().as_u16())) }
    }

    /// The run to race on this week's challenge (none when first).
    pub async fn rival(&self) -> Result<Option<Rival>, CloudError> {
        self.call(reqwest::Method::GET, "/v1/challenge/rival", None).await
    }

    /// A run of the challenge sent: the board with it (409: a name is needed first).
    pub async fn submit(&self, run: &Score) -> Result<Board, CloudError> {
        let body = serde_json::to_value(run).map_err(|_| CloudError::Network)?;
        self.call(reqwest::Method::POST, "/v1/challenge", Some(&body)).await
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
    fn keeps_the_sign_in_in_a_file_only_its_owner_reads() {
        let dir = std::env::temp_dir().join(format!("riffroad-keep-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let keep = FileKeep::new(dir.join("app").join("account.json"));
        assert_eq!(keep.load(), None);
        let kept = Kept { uid: "u1".into(), email: "a@b.c".into(), refresh_token: "r1".into(), photo: Some("https://x/p.png".into()), name: None };
        keep.store(&kept);
        assert_eq!(keep.load(), Some(kept.clone()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.join("app").join("account.json")).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "readable by its owner only");
        }
        keep.store(&Kept { refresh_token: "r2".into(), ..kept });
        assert_eq!(keep.load().map(|k| k.refresh_token), Some("r2".into()));
        keep.clear();
        assert_eq!(keep.load(), None);
        let _ = std::fs::remove_dir_all(dir);
    }

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
        assert_eq!(cloud.status().await, Status { available: false, email: None, verified: None, photo: None, name: None, google: false });
        assert_eq!(cloud.pull("career").await, Err(CloudError::Unavailable));
        assert_eq!(cloud.sign_in("a@b.c", "secret-123", true, "fr").await, Err(CloudError::Unavailable));
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
        assert_eq!(mac_a.status().await.email, None);
        assert_eq!(mac_a.sign_in(&email, "123", true, "fr").await, Err(CloudError::Auth("weak-password")));
        let created = mac_a.sign_in(&email, "secret-123", true, "fr").await.unwrap();
        assert_eq!((created.email.as_deref(), created.verified), (Some(email.as_str()), Some(false)));
        assert_eq!(mac_a.sign_in(&email, "secret-123", true, "fr").await, Err(CloudError::Auth("email-exists")));
        assert_eq!(mac_a.pull("career").await, Ok(None));
        // Nothing goes up before the e-mail is confirmed.
        assert_eq!(mac_a.push("career", json!({ "act": 1 }), 0).await, Err(CloudError::Unverified));
        confirm(&email).await;
        assert_eq!(mac_a.check().await.unwrap().verified, Some(true));
        let Pushed::Saved(first) = mac_a.push("career", json!({ "act": 1 }), 0).await.unwrap() else { panic!("not saved") };
        assert_eq!(first.version, 1);

        let mac_b = Cloud::new(Some(config.clone()), Box::new(Memory::default()));
        assert_eq!(mac_b.sign_in(&email, "wrong-password", false, "en").await, Err(CloudError::Auth("invalid-credentials")));
        assert_eq!(mac_b.sign_in(&email, "secret-123", false, "en").await.unwrap().verified, Some(true));
        let online = mac_b.pull("career").await.unwrap().unwrap();
        assert_eq!((online.version, online.data), (1, json!({ "act": 1 })));
        assert!(matches!(mac_b.push("career", json!({ "act": 2 }), 1).await, Ok(Pushed::Saved(Saved { version: 2, .. }))));
        // Mac A, still on version 1, is told instead of overwriting.
        assert!(matches!(mac_a.push("career", json!({ "act": 9 }), 1).await, Ok(Pushed::Conflict(Conflict { version: 2, .. }))));

        // The save Mac A was told about is not lost: it can be put back.
        let kept = mac_a.history("career").await.unwrap();
        assert_eq!(kept.iter().map(|v| v.version).collect::<Vec<_>>(), [1]);
        let back = mac_a.restore("career", 1).await.unwrap();
        assert_eq!((back.version, back.data), (3, json!({ "act": 1 })));
        assert!(matches!(mac_b.push("career", json!({ "act": 2 }), 3).await, Ok(Pushed::Saved(Saved { version: 4, .. }))));

        // The events, signed in or not.
        assert!(Cloud::new(Some(config.clone()), Box::new(Memory::default())).events().await.is_ok());

        // A name, then a run of this week's challenge: on the board.
        assert_eq!(mac_a.profile().await.unwrap().name, None);
        assert_eq!(mac_a.set_name("x").await, Err(CloudError::Server(400)));
        let week = mac_a.board().await.unwrap().challenge;
        let run = Score { week: week.week, song: week.song.clone(), level: week.level.clone(), score: 4_999_000, accuracy: 0.97, trace: vec![0, 2_000_000, 4_999_000] };
        assert_eq!(mac_a.submit(&run).await, Err(CloudError::Server(409)));
        assert_eq!(mac_a.set_name("Mac A").await.unwrap().name.as_deref(), Some("Mac A"));
        let board = mac_a.submit(&run).await.unwrap();
        assert_eq!(board.me.map(|e| (e.name, e.score)), Some(("Mac A".to_string(), 4_999_000)));
        // A card, and a friend code to give.
        let card = Card { band: "Les A".into(), act: 1, fans: 120, week: week.week, week_fans: 30 };
        mac_a.set_card(&card).await.unwrap();
        let mine = mac_a.friends().await.unwrap();
        assert_eq!((mine.code.len(), mine.me), (6, Some(card)));
        assert_eq!(mac_a.add_friend(&mine.code).await, Err(CloudError::Server(400)));

        // The same player on Mac B leads that board: no run above theirs to race.
        assert_eq!(mac_b.rival().await.unwrap(), None);

        // Mac A launched again: signed in from the keychain, a new token from the kept one.
        let relaunched = Cloud::new(Some(config.clone()), Box::new(keychain.clone()));
        assert_eq!(relaunched.status().await.email.as_deref(), Some(email.as_str()));
        assert_eq!(relaunched.pull("career").await.unwrap().unwrap().data, json!({ "act": 2 }));

        relaunched.delete_account().await.unwrap();
        assert_eq!(relaunched.status().await.email, None);
        assert_eq!(keychain.load(), None);
        assert_eq!(mac_b.sign_in(&email, "secret-123", false, "en").await, Err(CloudError::Auth("invalid-credentials")));
    }

    /// Signing in with Google, against the Auth emulator (which takes a made-up ID token): the
    /// account made the first time with the picture and name, found again after; its e-mail is
    /// Google's, already confirmed, so saves go up at once.
    #[tokio::test]
    async fn signs_in_with_google() {
        let Some(server) = opensmith_cloud_server::Config::from_env().filter(|c| c.firestore_emulator.is_some() && c.auth_emulator) else {
            eprintln!("skipped: run under `firebase emulators:exec` (see two_macs_share_a_career's comment)");
            return;
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let app = opensmith_cloud_server::router(opensmith_cloud_server::AppState::new(&server));
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let config = Config { key: "demo".into(), server: url, auth_emulator: std::env::var("FIREBASE_AUTH_EMULATOR_HOST").ok() };
        let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let token = json!({ "sub": format!("g{n}"), "email": format!("g{n}@gmail.com"), "email_verified": true, "name": "Zoé G", "picture": "https://example.com/zoe.png" }).to_string();
        let keychain = Arc::new(Memory::default());
        let mac = Cloud::new(Some(config.clone()), Box::new(keychain.clone()));
        let status = mac.sign_in_idp(&token).await.unwrap();
        assert_eq!((status.photo.as_deref(), status.name.as_deref(), status.verified), (Some("https://example.com/zoe.png"), Some("Zoé G"), Some(true)));
        assert!(matches!(mac.push("career", json!({ "act": 1 }), 0).await, Ok(Pushed::Saved(_))));
        // Launched again: the picture is kept with the sign-in.
        let again = Cloud::new(Some(config), Box::new(keychain));
        assert_eq!(again.status().await.photo.as_deref(), Some("https://example.com/zoe.png"));
    }

    /// The link of the e-mail clicked (the Auth emulator's own admin call).
    async fn confirm(email: &str) {
        let host = std::env::var("FIREBASE_AUTH_EMULATOR_HOST").unwrap();
        let project = std::env::var("GCLOUD_PROJECT").unwrap();
        let http = reqwest::Client::new();
        let found: Value = http
            .post(format!("http://{host}/identitytoolkit.googleapis.com/v1/projects/{project}/accounts:lookup"))
            .bearer_auth("owner")
            .json(&json!({ "email": [email] }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        http.post(format!("http://{host}/identitytoolkit.googleapis.com/v1/projects/{project}/accounts:update"))
            .bearer_auth("owner")
            .json(&json!({ "localId": found["users"][0]["localId"], "emailVerified": true }))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
    }
}
