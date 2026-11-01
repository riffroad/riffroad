//! The events (`events.json`, beside this crate): built into the server, so a change is a
//! deployment, and a wrong one fails the tests before it. Dates in RFC 3339, UTC.

use std::sync::OnceLock;

use opensmith_cloud::{Boost, Event, Pick, Text, check_event, parse_utc};
use serde::Deserialize;

const FILE: &str = include_str!("../events.json");
/// How far ahead the app is told of what is coming.
const AHEAD: i64 = 14 * 86_400;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Written {
    id: String,
    starts: String,
    ends: String,
    title: Text,
    text: Text,
    #[serde(default)]
    career: Option<Boost>,
    #[serde(default)]
    challenge: Option<Pick>,
}

/// The events of a file, each one checked.
pub fn parse(text: &str) -> Result<Vec<Event>, String> {
    let written: Vec<Written> = serde_json::from_str(text).map_err(|e| e.to_string())?;
    written
        .into_iter()
        .map(|w| {
            let date = |d: &str| parse_utc(d).ok_or_else(|| format!("{}: {d} is not YYYY-MM-DDTHH:MM:SSZ", w.id));
            let e = Event { starts: date(&w.starts)?, ends: date(&w.ends)?, id: w.id, title: w.title, text: w.text, career: w.career, challenge: w.challenge };
            check_event(&e).map(|()| e)
        })
        .collect()
}

pub fn all() -> &'static [Event] {
    static EVENTS: OnceLock<Vec<Event>> = OnceLock::new();
    EVENTS.get_or_init(|| parse(FILE).expect("events.json"))
}

/// What the app is told at `now`: the events on, and those starting within two weeks.
pub fn around(now: i64) -> Vec<Event> {
    all().iter().filter(|e| e.ends > now && e.starts < now + AHEAD).cloned().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_events_file_is_right() {
        parse(FILE).unwrap();
    }

    #[test]
    fn tells_what_is_on_and_what_comes_soon() {
        let file = r#"[
            { "id": "now", "starts": "2026-11-01T00:00:00Z", "ends": "2026-11-03T00:00:00Z", "title": { "fr": "a", "en": "a" }, "text": { "fr": "b", "en": "b" } },
            { "id": "later", "starts": "2027-01-01T00:00:00Z", "ends": "2027-01-02T00:00:00Z", "title": { "fr": "a", "en": "a" }, "text": { "fr": "b", "en": "b" } }
        ]"#;
        let events = parse(file).unwrap();
        let now = parse_utc("2026-11-02T12:00:00Z").unwrap();
        let shown: Vec<&str> = events.iter().filter(|e| e.ends > now && e.starts < now + AHEAD).map(|e| e.id.as_str()).collect();
        assert_eq!(shown, ["now"]);
        assert!(parse(&file.replace("2026-11-03", "2026-10-03")).is_err(), "an event ending before it starts");
        assert!(parse(&file.replace("\"title\"", "\"titel\"")).is_err(), "an unknown field");
    }
}
