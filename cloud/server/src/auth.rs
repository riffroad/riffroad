//! Who is asking: the player's Firebase ID token checked the way Firebase documents it for a
//! third-party JWT library (RS256 signed by one of Google's published keys, for this project,
//! not expired, issued in the past). Against the Auth emulator (tests), tokens are unsigned and
//! only their claims are checked.

use std::collections::HashMap;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use jsonwebtoken::jwk::JwkSet;
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header};
use serde::Deserialize;
use tokio::sync::RwLock;

/// Google's keys for Firebase ID tokens, as JWKs.
const KEYS_URL: &str = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
/// Clock difference allowed with Google's servers.
const LEEWAY: u64 = 60;
/// An unknown key id fetches the keys again at most this often (a forged token cannot make
/// the server hammer Google).
const REFETCH: Duration = Duration::from_secs(60);

#[derive(Debug, PartialEq, Eq)]
pub enum AuthError {
    Missing,
    Invalid(&'static str),
    /// Google's keys could not be fetched.
    Keys,
}

#[derive(Debug, Deserialize)]
struct Claims {
    sub: String,
    aud: String,
    iss: String,
    exp: u64,
    iat: u64,
    #[serde(default)]
    auth_time: u64,
}

struct Keys {
    by_id: HashMap<String, DecodingKey>,
    fetched: Option<Instant>,
    max_age: Duration,
}

pub struct Verifier {
    project: String,
    emulator: bool,
    http: reqwest::Client,
    keys: RwLock<Keys>,
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// A Firebase uid as a path segment: letters, digits, `-` and `_` only.
pub fn valid_uid(uid: &str) -> bool {
    !uid.is_empty() && uid.len() <= 128 && uid.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

impl Verifier {
    pub fn new(project: String, emulator: bool, http: reqwest::Client) -> Self {
        Self { project, emulator, http, keys: RwLock::new(Keys { by_id: HashMap::new(), fetched: None, max_age: Duration::ZERO }) }
    }

    /// The uid of the player whose token this is.
    pub async fn uid(&self, token: &str) -> Result<String, AuthError> {
        if token.is_empty() {
            return Err(AuthError::Missing);
        }
        let claims = if self.emulator { self.unsigned(token)? } else { self.signed(token).await? };
        self.check(&claims)?;
        Ok(claims.sub)
    }

    fn check(&self, c: &Claims) -> Result<(), AuthError> {
        let now = now();
        if c.aud != self.project {
            return Err(AuthError::Invalid("audience"));
        }
        if c.iss != format!("https://securetoken.google.com/{}", self.project) {
            return Err(AuthError::Invalid("issuer"));
        }
        if c.exp + LEEWAY < now {
            return Err(AuthError::Invalid("expired"));
        }
        if c.iat > now + LEEWAY || c.auth_time > now + LEEWAY {
            return Err(AuthError::Invalid("issued in the future"));
        }
        if !valid_uid(&c.sub) {
            return Err(AuthError::Invalid("subject"));
        }
        Ok(())
    }

    async fn signed(&self, token: &str) -> Result<Claims, AuthError> {
        let header = decode_header(token).map_err(|_| AuthError::Invalid("header"))?;
        if header.alg != Algorithm::RS256 {
            return Err(AuthError::Invalid("algorithm"));
        }
        let kid = header.kid.ok_or(AuthError::Invalid("key id"))?;
        let key = self.key(&kid).await?;
        let mut validation = Validation::new(Algorithm::RS256);
        validation.set_audience(&[&self.project]);
        validation.set_issuer(&[format!("https://securetoken.google.com/{}", self.project)]);
        validation.set_required_spec_claims(&["exp", "iat", "sub", "aud", "iss"]);
        validation.leeway = LEEWAY;
        decode::<Claims>(token, &key, &validation).map(|d| d.claims).map_err(|_| AuthError::Invalid("signature or claims"))
    }

    /// The emulator's tokens: `alg: none`, no signature; only accepted in emulator mode.
    fn unsigned(&self, token: &str) -> Result<Claims, AuthError> {
        let payload = token.split('.').nth(1).ok_or(AuthError::Invalid("format"))?;
        let bytes = URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).map_err(|_| AuthError::Invalid("format"))?;
        serde_json::from_slice(&bytes).map_err(|_| AuthError::Invalid("claims"))
    }

    async fn key(&self, kid: &str) -> Result<DecodingKey, AuthError> {
        {
            let keys = self.keys.read().await;
            let fresh = keys.fetched.is_some_and(|t| t.elapsed() < keys.max_age);
            if let Some(k) = keys.by_id.get(kid) {
                if fresh {
                    return Ok(k.clone());
                }
            } else if keys.fetched.is_some_and(|t| t.elapsed() < REFETCH) {
                return Err(AuthError::Invalid("unknown key"));
            }
        }
        let mut keys = self.keys.write().await;
        // Another request may have fetched them meanwhile.
        if !keys.fetched.is_some_and(|t| t.elapsed() < REFETCH) {
            let (by_id, max_age) = self.fetch().await?;
            *keys = Keys { by_id, fetched: Some(Instant::now()), max_age };
        }
        keys.by_id.get(kid).cloned().ok_or(AuthError::Invalid("unknown key"))
    }

    async fn fetch(&self) -> Result<(HashMap<String, DecodingKey>, Duration), AuthError> {
        let res = self.http.get(KEYS_URL).send().await.map_err(|_| AuthError::Keys)?;
        if !res.status().is_success() {
            return Err(AuthError::Keys);
        }
        let max_age = res
            .headers()
            .get(reqwest::header::CACHE_CONTROL)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split(',').find_map(|p| p.trim().strip_prefix("max-age=")?.parse::<u64>().ok()))
            .unwrap_or(3600);
        let set: JwkSet = res.json().await.map_err(|_| AuthError::Keys)?;
        let by_id = set
            .keys
            .iter()
            .filter_map(|jwk| Some((jwk.common.key_id.clone()?, DecodingKey::from_jwk(jwk).ok()?)))
            .collect();
        Ok((by_id, Duration::from_secs(max_age)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn token(claims: serde_json::Value) -> String {
        let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"none","typ":"JWT"}"#);
        format!("{header}.{}.", URL_SAFE_NO_PAD.encode(claims.to_string()))
    }

    fn claims(project: &str, sub: &str, exp: u64) -> serde_json::Value {
        serde_json::json!({ "sub": sub, "aud": project, "iss": format!("https://securetoken.google.com/{project}"), "exp": exp, "iat": now() - 10, "auth_time": now() - 10 })
    }

    #[tokio::test]
    async fn an_unsigned_token_is_refused_outside_the_emulator() {
        let v = Verifier::new("opensmith".into(), false, reqwest::Client::new());
        // `alg: none` is not even a header the JWT library reads.
        assert_eq!(v.uid(&token(claims("opensmith", "abc", now() + 600))).await, Err(AuthError::Invalid("header")));
        assert_eq!(v.uid("").await, Err(AuthError::Missing));
        assert_eq!(v.uid("not-a-token").await, Err(AuthError::Invalid("header")));
    }

    #[tokio::test]
    async fn the_emulator_token_claims_are_still_checked() {
        let v = Verifier::new("demo".into(), true, reqwest::Client::new());
        assert_eq!(v.uid(&token(claims("demo", "abc", now() + 600))).await, Ok("abc".into()));
        assert_eq!(v.uid(&token(claims("other", "abc", now() + 600))).await, Err(AuthError::Invalid("audience")));
        assert_eq!(v.uid(&token(claims("demo", "abc", now() - 600))).await, Err(AuthError::Invalid("expired")));
        assert_eq!(v.uid(&token(claims("demo", "../x", now() + 600))).await, Err(AuthError::Invalid("subject")));
    }
}
