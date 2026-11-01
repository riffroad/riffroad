//! What the app and the server say to each other: a player's saves kept online, one per slot,
//! each with a version so that two Macs never overwrite each other's progress without asking.
//!
//! `GET /v1/saves/{slot}` → [`Save`] (404: nothing saved yet).
//! `PUT /v1/saves/{slot}` with [`Push`] → [`Saved`], or 409 with [`Conflict`] when the save
//! online moved on since `base_version` (another Mac saved in between).
//! `GET /v1/saves/{slot}/history` → the [`Version`]s kept before the current one, newest first
//! ([`HISTORY`] at most); `GET /v1/saves/{slot}/history/{version}` → that [`Save`] (to put back
//! with a `PUT` over the current version).
//! `GET /v1/profile` → [`Profile`]; `PUT /v1/profile` with [`Profile`] → it, the name checked
//! ([`valid_name`]; 400 `bad name`).
//! `GET /v1/challenge` → this week's [`Board`]; `POST /v1/challenge` with [`Score`] → the board
//! with it (the player's best of the week kept; 409 `name needed` without a name, 400 `not this
//! week's challenge`).
//! `GET /v1/challenge/rival` → the [`Rival`] to beat: the run just above the player's best of
//! the week (the best one before a first run; null when first).
//! `GET /v1/friends` → [`Friends`] (the player's code made on first ask); `POST /v1/friends`
//! with [`AddFriend`] → them (404 `no such code`, 400 `that is you`, 409 `too many friends`);
//! `DELETE /v1/friends/{code}` → them. `PUT /v1/card` with [`Card`] → 204 (400 `bad card`).
//! `GET /v1/events` (no token) → the [`Event`]s on now or within two weeks.
//! `DELETE /v1/account` → 204, every save gone (the app then deletes the sign-in itself).
//! Every route but `/health` wants `Authorization: Bearer <Firebase ID token>`; a `PUT` wants
//! the account's e-mail confirmed (403 `email not verified` until then).

use serde::{Deserialize, Serialize};

/// What can be kept online: the career, and the progress (scores, lessons). Settings stay on
/// each Mac (latency, audio input and the guitar's tuning belong to the machine).
pub const SLOTS: &[&str] = &["career", "progress"];

/// The biggest save accepted, its JSON text in bytes.
pub const MAX_SAVE_BYTES: usize = 512 * 1024;

/// Requests a player may make in a minute.
pub const REQUESTS_PER_MINUTE: u32 = 30;

pub fn is_slot(slot: &str) -> bool {
    SLOTS.contains(&slot)
}

pub fn save_path(slot: &str) -> String {
    format!("/v1/saves/{slot}")
}

pub fn history_path(slot: &str) -> String {
    format!("/v1/saves/{slot}/history")
}

/// Saves kept before the current one, per slot: a wrong choice on a conflict can be taken back.
pub const HISTORY: u64 = 5;

pub const ACCOUNT_PATH: &str = "/v1/account";

/// A save as kept online.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Save {
    /// 1 for the first save, one more each time.
    pub version: u64,
    /// When it was written (RFC 3339).
    pub updated_at: String,
    pub data: serde_json::Value,
}

/// A save sent: written only if the one online is still `base_version` (0: none yet).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Push {
    pub base_version: u64,
    pub data: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Saved {
    pub version: u64,
    pub updated_at: String,
}

/// The save online moved on: its version and date, for the player to choose.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    pub version: u64,
    pub updated_at: String,
}

/// A save kept in the history: its version and when it was written.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    pub version: u64,
    pub updated_at: String,
}

/// What other players see of someone: a name chosen for the boards (never the e-mail).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub name: Option<String>,
}

/// A name for the boards: 2 to 20 letters, digits, spaces, `-`, `_`, `.` or `'`, trimmed.
pub fn valid_name(name: &str) -> bool {
    let n = name.trim();
    (2..=20).contains(&n.chars().count()) && n.chars().all(|c| c.is_alphanumeric() || " -_.'".contains(c)) && n == name
}

/// The songs shipped with the app: the weekly challenge is always one of them, the same for
/// everyone, and never a song someone imported.
pub const SHIPPED: &[&str] = &[
    "Shane Ivers - Hard Sell Hotel/song_chart.json",
    "Shane Ivers - Apple For The Preacher/song_chart.json",
    "Shane Ivers - Wave Rider/song_chart.json",
    "OpenSmith - First Riff/song_chart.json",
    "Shane Ivers - Later Alligator/song_chart.json",
];

/// The Score Attack levels the challenge goes through, a week each.
pub const CHALLENGE_LEVELS: &[&str] = &["medium", "hard", "easy"];

/// The best score taken: well above what a song can give (≈ 1,800 points a note at most).
pub const MAX_SCORE: u64 = 5_000_000;

/// Players shown on a board.
pub const TOP: usize = 20;

/// The week a moment falls in (`unix_seconds`): weeks run from Monday 00:00 UTC, numbered from
/// the one of 5 January 1970.
pub fn week_of(unix_seconds: i64) -> i64 {
    (unix_seconds.div_euclid(86_400) - 4).div_euclid(7)
}

/// When week `week` starts (Unix seconds).
pub fn week_start(week: i64) -> i64 {
    (week * 7 + 4) * 86_400
}

/// The challenge of week `week`: a shipped song, at a Score Attack level; an event of that
/// week may pick another.
pub fn challenge_of(week: i64, events: &[Event]) -> Challenge {
    if let Some(pick) = events.iter().find(|e| e.starts == week_start(week)).and_then(|e| e.challenge.as_ref()) {
        return Challenge { week, song: pick.song.clone(), level: pick.level.clone() };
    }
    let n = SHIPPED.len() as i64;
    Challenge {
        week,
        song: SHIPPED[week.rem_euclid(n) as usize].into(),
        level: CHALLENGE_LEVELS[week.div_euclid(n).rem_euclid(CHALLENGE_LEVELS.len() as i64) as usize].into(),
    }
}

/// A text in each language of the game.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Text {
    pub fr: String,
    pub en: String,
}

/// What a career gig brings during an event, times.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Boost {
    pub fans: f64,
    pub money: f64,
}

/// A challenge picked by hand.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Pick {
    pub song: String,
    pub level: String,
}

/// Something on for a while, for every player: a festival that pays the gigs more, a weekly
/// challenge picked by hand (that event then spans its week exactly). Written in
/// `cloud/server/events.json`, with dates in RFC 3339 (UTC); served in Unix seconds.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Event {
    pub id: String,
    pub starts: i64,
    pub ends: i64,
    pub title: Text,
    pub text: Text,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub career: Option<Boost>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub challenge: Option<Pick>,
}

/// Why an event cannot be: its id, and the reason.
pub fn check_event(e: &Event) -> Result<(), String> {
    let fail = |why: &str| Err(format!("{}: {why}", e.id));
    if e.starts >= e.ends {
        return fail("ends before it starts");
    }
    if [&e.title.fr, &e.title.en, &e.text.fr, &e.text.en].iter().any(|t| t.trim().is_empty()) {
        return fail("a title or a text is empty");
    }
    if let Some(b) = &e.career
        && (!(1.0..=3.0).contains(&b.fans) || !(1.0..=3.0).contains(&b.money))
    {
        return fail("a boost goes from 1 to 3");
    }
    if let Some(p) = &e.challenge {
        if !SHIPPED.contains(&p.song.as_str()) {
            return fail("the challenge is not a shipped song");
        }
        if !["easy", "medium", "hard", "master"].contains(&p.level.as_str()) {
            return fail("unknown level");
        }
        let week = week_of(e.starts);
        if e.starts != week_start(week) || e.ends != week_start(week + 1) {
            return fail("a challenge event spans a week, Monday to Monday");
        }
    }
    Ok(())
}

/// `YYYY-MM-DDTHH:MM:SSZ` as Unix seconds.
pub fn parse_utc(text: &str) -> Option<i64> {
    let b = text.as_bytes();
    if b.len() != 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' || b[19] != b'Z' {
        return None;
    }
    let n = |r: std::ops::Range<usize>| text.get(r)?.parse::<i64>().ok();
    let (y, m, d, hh, mm, ss) = (n(0..4)?, n(5..7)?, n(8..10)?, n(11..13)?, n(14..16)?, n(17..19)?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) || hh > 23 || mm > 59 || ss > 59 {
        return None;
    }
    // Days from the civil date (Howard Hinnant's algorithm).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some((era * 146_097 + doe - 719_468) * 86_400 + hh * 3600 + mm * 60 + ss)
}

/// A week's challenge: the song (its library id) and the level.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Challenge {
    pub week: i64,
    pub song: String,
    pub level: String,
}

/// A run of the challenge sent: for that week, song and level.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Score {
    pub week: i64,
    pub song: String,
    pub level: String,
    pub score: u64,
    /// 0 to 1.
    pub accuracy: f64,
    /// The points reached at each second of the song (before the level's bonus), for others
    /// to race as a ghost; [`MAX_TRACE`] seconds at most.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub trace: Vec<u64>,
}

/// The longest trace kept: half an hour of song.
pub const MAX_TRACE: usize = 1800;

/// A run to race: whose, its score, its trace.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rival {
    pub name: String,
    pub score: u64,
    pub trace: Vec<u64>,
}

/// A player's place on a board.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub rank: u64,
    pub name: String,
    pub score: u64,
    pub accuracy: f64,
    /// The player asking.
    pub me: bool,
}

/// This week's challenge, its best players, and the player's own place (none before a run).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Board {
    pub challenge: Challenge,
    /// When it ends (Unix seconds).
    pub ends: i64,
    pub players: u64,
    pub top: Vec<Entry>,
    pub me: Option<Entry>,
}

/// What friends see of a player's career: the band, how far it got, its fans, and those won
/// in week `week` (the battle of the bands).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    pub band: String,
    pub act: u32,
    pub fans: u64,
    pub week: i64,
    pub week_fans: u64,
}

pub fn valid_card(c: &Card) -> bool {
    c.band.chars().count() <= 40 && c.act <= 10 && c.fans <= 1_000_000_000 && c.week_fans <= c.fans
}

/// A friend: their code, their name for the boards, their card (none until they play).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Friend {
    pub code: String,
    pub name: Option<String>,
    pub card: Option<Card>,
}

/// The player's code (to give), their own card, and their friends, the best week first.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Friends {
    pub code: String,
    pub me: Option<Card>,
    pub friends: Vec<Friend>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AddFriend {
    pub code: String,
}

/// Friends a player may follow.
pub const MAX_FRIENDS: usize = 50;

/// Letters of a code: no 0/O, 1/I/L, said aloud without a doubt.
const CODE_LETTERS: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/// A player's friend code, 6 letters; `attempt` gives another when one is taken.
pub fn code_of(uid: &str, attempt: u32) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in uid.bytes().chain(attempt.to_le_bytes()) {
        h = (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3);
    }
    (0..6)
        .map(|_| {
            let c = CODE_LETTERS[(h % CODE_LETTERS.len() as u64) as usize] as char;
            h /= CODE_LETTERS.len() as u64;
            c
        })
        .collect()
}

/// A code as typed: trimmed, upper case; None if it cannot be one.
pub fn clean_code(typed: &str) -> Option<String> {
    let c = typed.trim().to_ascii_uppercase();
    (c.len() == 6 && c.bytes().all(|b| CODE_LETTERS.contains(&b))).then_some(c)
}

/// Any refusal: `{"error": "..."}`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ApiError {
    pub error: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slots_are_the_known_ones() {
        assert!(is_slot("career"));
        assert!(is_slot("progress"));
        assert!(!is_slot("settings"));
        assert!(!is_slot("../career"));
        assert_eq!(save_path("career"), "/v1/saves/career");
    }

    #[test]
    fn a_week_runs_from_monday_and_its_challenge_is_a_shipped_song() {
        // Monday 2 November 2026, 00:00 UTC, and the Sunday before, 23:59.
        let monday = 1_793_577_600;
        // The app works out the same (app/tests/world.test.ts).
        assert_eq!(week_of(monday), 2965);
        assert_eq!(challenge_of(2965, &[]), Challenge { week: 2965, song: SHIPPED[0].into(), level: "easy".into() });
        assert_eq!(week_of(monday), week_of(monday - 60) + 1);
        assert_eq!(week_start(week_of(monday)), monday);
        assert_eq!(week_of(monday + 6 * 86_400 + 86_399), week_of(monday));
        let weeks: Vec<Challenge> = (0..15).map(|w| challenge_of(week_of(monday) + w, &[])).collect();
        assert!(weeks.iter().all(|c| SHIPPED.contains(&c.song.as_str()) && CHALLENGE_LEVELS.contains(&c.level.as_str())));
        // Every song at every level within fifteen weeks.
        let pairs: std::collections::HashSet<_> = weeks.iter().map(|c| (c.song.clone(), c.level.clone())).collect();
        assert_eq!(pairs.len(), SHIPPED.len() * CHALLENGE_LEVELS.len());
    }

    #[test]
    fn reads_utc_dates() {
        assert_eq!(parse_utc("2026-11-02T00:00:00Z"), Some(1_793_577_600));
        assert_eq!(parse_utc("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_utc("2024-02-29T12:30:05Z"), Some(1_709_209_805));
        assert_eq!(parse_utc("2026-11-02 00:00:00"), None);
        assert_eq!(parse_utc("2026-13-02T00:00:00Z"), None);
    }

    #[test]
    fn an_event_can_pick_its_weeks_challenge() {
        let text = Text { fr: "Spécial".into(), en: "Special".into() };
        let week = 2965;
        let mut e = Event { id: "special".into(), starts: week_start(week), ends: week_start(week + 1), title: text.clone(), text, career: None, challenge: Some(Pick { song: SHIPPED[3].into(), level: "master".into() }) };
        assert_eq!(check_event(&e), Ok(()));
        assert_eq!(challenge_of(week, std::slice::from_ref(&e)).level, "master");
        assert_eq!(challenge_of(week + 1, std::slice::from_ref(&e)), challenge_of(week + 1, &[]));
        e.ends -= 3600;
        assert!(check_event(&e).is_err(), "a challenge event spans its week");
        e.ends += 3600;
        e.challenge = Some(Pick { song: "Someone - Imported/song_chart.json".into(), level: "hard".into() });
        assert!(check_event(&e).is_err(), "never an imported song");
    }

    #[test]
    fn friend_codes_are_six_plain_letters() {
        let code = code_of("uid-1", 0);
        assert_eq!(code.len(), 6);
        assert_ne!(code, code_of("uid-1", 1));
        assert_eq!(code, code_of("uid-1", 0));
        assert_eq!(clean_code(&format!(" {} ", code.to_lowercase())), Some(code));
        assert_eq!(clean_code("ABC1O0"), None, "no 1, O or 0");
        assert_eq!(clean_code("ABCDE"), None);
    }

    #[test]
    fn names_are_short_and_plain() {
        assert!(valid_name("Julien"));
        assert!(valid_name("Les Larsen 2"));
        assert!(valid_name("Zoé_D'Arc"));
        assert!(!valid_name("J"));
        assert!(!valid_name(" Julien"));
        assert!(!valid_name("a name far too long for a board"));
        assert!(!valid_name("http://spam"));
        assert!(!valid_name("<b>me</b>"));
    }

    #[test]
    fn speaks_camel_case() {
        let push = Push { base_version: 3, data: serde_json::json!({"act": 2}) };
        assert_eq!(serde_json::to_string(&push).unwrap(), r#"{"baseVersion":3,"data":{"act":2}}"#);
        let saved: Saved = serde_json::from_str(r#"{"version":4,"updatedAt":"2026-11-01T10:00:00Z"}"#).unwrap();
        assert_eq!(saved.version, 4);
    }
}
