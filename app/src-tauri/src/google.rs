//! Signing in with Google from the desktop app (OAuth 2.0 for installed apps): the system browser
//! opens Google's page, which comes back to a one-off address on this Mac (127.0.0.1, a free
//! port) with a code; the code, with a secret only this attempt knew (PKCE), is traded for
//! Google's ID token, and Firebase signs the player in with it (`Cloud::sign_in_idp`).

use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::cloud::CloudError;

/// The desktop app's OAuth client (Google Cloud → Google Auth Platform → Clients, "Desktop
/// app"). Its "secret" is not one (Google says as much of installed apps; PKCE protects the
/// code), but it stays out of the repository: a build reads it from `RIFFROAD_GOOGLE_CLIENT_SECRET`
/// (docs/macos-release.md). Without it, no Google button.
pub const CLIENT_ID: &str = "804178317836-jdg3a181pbl4f5ekiuev0rdr948tgdvm.apps.googleusercontent.com";
const CLIENT_SECRET: &str = match option_env!("RIFFROAD_GOOGLE_CLIENT_SECRET") {
    Some(s) => s,
    None => "",
};

/// How long Google's page is waited for before giving up (the player closed it).
const WAIT: Duration = Duration::from_secs(180);

pub fn available() -> bool {
    !CLIENT_ID.is_empty() && !CLIENT_SECRET.is_empty()
}

/// `n` random bytes, URL-safe base64.
fn random(n: usize) -> String {
    let mut bytes = vec![0u8; n];
    let filled = std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut bytes)).is_ok();
    if !filled {
        // Not a Unix: the clock and the standard library's own random keys.
        use std::hash::{BuildHasher, Hasher};
        for chunk in bytes.chunks_mut(8) {
            let mut h = std::collections::hash_map::RandomState::new().build_hasher();
            h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos()));
            chunk.copy_from_slice(&h.finish().to_le_bytes()[..chunk.len()]);
        }
    }
    URL_SAFE_NO_PAD.encode(bytes)
}

/// The PKCE pair: the verifier kept here, its SHA-256 sent to Google.
fn pkce() -> (String, String) {
    let verifier = random(48);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

/// `s` percent-encoded for a URL's query (unreserved characters kept).
pub fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok());
                match hex {
                    Some(b) => {
                        out.push(b);
                        i += 3;
                        continue;
                    }
                    None => out.push(b'%'),
                }
            }
            b'+' => out.push(b' '),
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Google's sign-in page, coming back to `redirect`.
pub fn auth_url(redirect: &str, challenge: &str, state: &str, lang: &str) -> String {
    let params = [
        ("client_id", CLIENT_ID),
        ("redirect_uri", redirect),
        ("response_type", "code"),
        ("scope", "openid email profile"),
        ("code_challenge", challenge),
        ("code_challenge_method", "S256"),
        ("state", state),
        ("prompt", "select_account"),
        ("hl", lang),
    ];
    let query: Vec<String> = params.iter().map(|(k, v)| format!("{k}={}", encode(v))).collect();
    format!("https://accounts.google.com/o/oauth2/v2/auth?{}", query.join("&"))
}

/// The code in the request Google's page sent back (`GET /?code=…&state=…`), when its state is
/// this attempt's; else why not (`cancelled` when the player refused).
pub fn code_of(request_line: &str, state: &str) -> Result<String, &'static str> {
    let target = request_line.split_whitespace().nth(1).ok_or("bad request")?;
    let query = target.split_once('?').map_or("", |(_, q)| q);
    let param = |name: &str| query.split('&').find_map(|kv| kv.split_once('=').filter(|(k, _)| *k == name).map(|(_, v)| decode(v)));
    if param("error").is_some() {
        return Err("cancelled");
    }
    if param("state").as_deref() != Some(state) {
        return Err("bad state");
    }
    param("code").filter(|c| !c.is_empty()).ok_or("no code")
}

/// The page left in the browser once it came back.
const DONE: &str = "<!doctype html><meta charset=utf-8><title>Riffroad</title>\
<body style=\"font:16px -apple-system,sans-serif;background:#09090b;color:#f4f4f5;display:grid;place-items:center;height:90vh\">\
<div><h1 style=\"color:#f59e0b\">Riffroad</h1><p>Connecté : tu peux fermer cet onglet et revenir au jeu.</p>\
<p>Signed in: you can close this tab and go back to the game.</p></div>";

/// Waits for Google's page to come back to `listener`: the code it brought.
fn wait_for_code(listener: &TcpListener, state: &str) -> Result<String, CloudError> {
    listener.set_nonblocking(true).map_err(|_| CloudError::Network)?;
    let until = Instant::now() + WAIT;
    while Instant::now() < until {
        let (mut stream, _) = match listener.accept() {
            Ok(s) => s,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(100));
                continue;
            }
            Err(_) => return Err(CloudError::Network),
        };
        let _ = stream.set_nonblocking(false);
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let mut buffer = [0u8; 8192];
        let n = stream.read(&mut buffer).unwrap_or(0);
        let request = String::from_utf8_lossy(&buffer[..n]);
        let line = request.lines().next().unwrap_or("");
        // The browser may ask for its icon first: only the page with a code or an error counts.
        if !line.contains("code=") && !line.contains("error=") {
            let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            continue;
        }
        let _ = stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{DONE}", DONE.len()).as_bytes());
        return code_of(line, state).map_err(|why| if why == "cancelled" { CloudError::Auth("cancelled") } else { CloudError::Auth("auth-failed") });
    }
    Err(CloudError::Auth("cancelled"))
}

fn open(url: &str) -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", "start", ""]);
        c
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let mut command = std::process::Command::new("xdg-open");
    command.arg(url).spawn().map(|_| ())
}

/// The whole browser part: Google's ID token for the player who signed in, in `lang`.
pub async fn id_token(http: &reqwest::Client, lang: &str) -> Result<String, CloudError> {
    if !available() {
        return Err(CloudError::Unavailable);
    }
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|_| CloudError::Network)?;
    let redirect = format!("http://127.0.0.1:{}", listener.local_addr().map_err(|_| CloudError::Network)?.port());
    let (verifier, challenge) = pkce();
    let state = random(16);
    open(&auth_url(&redirect, &challenge, &state, lang)).map_err(|_| CloudError::Network)?;
    let code = tauri::async_runtime::spawn_blocking(move || wait_for_code(&listener, &state)).await.map_err(|_| CloudError::Network)??;
    let reply = http
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("client_id", CLIENT_ID),
            ("client_secret", CLIENT_SECRET),
            ("code", code.as_str()),
            ("code_verifier", verifier.as_str()),
            ("grant_type", "authorization_code"),
            ("redirect_uri", redirect.as_str()),
        ])
        .send()
        .await
        .map_err(|_| CloudError::Network)?;
    let ok = reply.status().is_success();
    let body: Value = reply.json().await.map_err(|_| CloudError::Network)?;
    match body["id_token"].as_str() {
        Some(t) if ok => Ok(t.to_string()),
        _ => Err(CloudError::Auth("auth-failed")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pkce_challenge_is_the_verifiers_hash() {
        let (verifier, challenge) = pkce();
        assert!(verifier.len() >= 43, "RFC 7636: 43 characters at least");
        assert_eq!(challenge, URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes())));
        assert_ne!(pkce().0, verifier);
        // RFC 7636's own example.
        assert_eq!(URL_SAFE_NO_PAD.encode(Sha256::digest(b"dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn reads_the_code_google_sends_back_for_this_attempt_only() {
        assert_eq!(code_of("GET /?state=abc&code=4%2F0Ab-x&scope=email HTTP/1.1", "abc"), Ok("4/0Ab-x".into()));
        assert_eq!(code_of("GET /?state=other&code=4%2F0Ab HTTP/1.1", "abc"), Err("bad state"));
        assert_eq!(code_of("GET /?error=access_denied&state=abc HTTP/1.1", "abc"), Err("cancelled"));
        assert_eq!(code_of("GET /favicon.ico HTTP/1.1", "abc"), Err("bad state"));
    }

    #[test]
    fn the_sign_in_page_asks_for_the_challenge_and_comes_back_here() {
        let url = auth_url("http://127.0.0.1:5123", "CHALLENGE", "STATE", "fr");
        assert!(url.starts_with("https://accounts.google.com/o/oauth2/v2/auth?"));
        assert!(url.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A5123"));
        assert!(url.contains("code_challenge=CHALLENGE&code_challenge_method=S256"));
        assert!(url.contains("scope=openid%20email%20profile"));
        assert_eq!(decode("a%20b%2Fc+d"), "a b/c d");
    }

    #[test]
    fn waits_for_the_page_with_the_code() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let browser = std::thread::spawn(move || {
            for path in ["/favicon.ico", "/?state=s1&code=the-code"] {
                let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
                s.write_all(format!("GET {path} HTTP/1.1\r\nHost: x\r\n\r\n").as_bytes()).unwrap();
                let mut reply = String::new();
                let _ = s.read_to_string(&mut reply);
                if path.contains("code") {
                    assert!(reply.starts_with("HTTP/1.1 200") && reply.contains("Riffroad"));
                }
            }
        });
        assert_eq!(wait_for_code(&listener, "s1"), Ok("the-code".into()));
        browser.join().unwrap();
    }
}
