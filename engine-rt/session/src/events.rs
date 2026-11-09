use opensmith_game::{Expected, Judgement, MissReason, Score, Target};
use serde::Serialize;

/// What the UI is told, serialised for the TypeScript side (app/src/game/types.ts).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum UiEvent {
    /// Start over (load, seek): forget every expected note.
    Reset,
    /// A phrase iteration became visible at `level`.
    Expected { iteration: usize, level: u32, items: Vec<UiExpected> },
    Hit { index: usize, time: f64, error: f64, perfect: bool },
    Miss { index: usize, time: f64, reason: UiMissReason },
    /// A missed note played after all, `error` seconds late.
    Late { index: usize, error: f64 },
    #[serde(rename_all = "camelCase")]
    Phrase { iteration: usize, name: String, accuracy: f64, level: u32, next_level: u32 },
    Score { score: UiScore },
    /// Loop Trainer: a pass over the loop is over, with its own score.
    Pass { score: UiScore },
    /// A note the guitar played, at the song time of its attack.
    Heard { time: f64, midi: i32, cents: f32 },
    End,
    /// Out of a song (menus, free play): a note the guitar played, for the strings on screen.
    Played { midi: i32, cents: f32 },
    /// Out of a song: an attack without a single pitch (a chord, a muted strum).
    Strum,
    /// Tuner mode: the pitch of the ringing string (fractional MIDI note).
    Pitch { midi: f32, clarity: f32 },
    /// Latency calibration started: clicks at `first + k * period`, the first `count_in` only
    /// announce the beat.
    #[serde(rename_all = "camelCase")]
    CalibrationStart { first: f64, period: f64, count_in: usize, clicks: usize },
    /// A strum matched measured click `index`, `error` seconds after it.
    CalibrationHit { index: usize, error: f64 },
    /// Median strum delay (the latency to compensate) and its spread, from `hits` of `total`.
    Calibrated { offset: f64, spread: f64, hits: usize, total: usize },
    /// A take of what the guitar played was saved to `path` (`seconds` long).
    TakeSaved { path: String, seconds: f64 },
    /// Wait mode: the song stopped on expected note `index` until the guitar plays it.
    Waiting { index: usize },
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct UiExpected {
    /// Position in the game's list, used by judgements.
    pub index: usize,
    /// Index in the chart's notes or chords, by target kind.
    pub event: usize,
    pub time: f64,
    pub sustain: f64,
    pub target: UiTarget,
    pub iteration: usize,
    pub level: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum UiTarget {
    Note { string: u8, fret: u8, midi: i32 },
    Chord { template: usize, midis: Vec<i32> },
}

/// Why a note was missed (opensmith_game::MissReason).
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum UiMissReason {
    Unplayed,
    /// `error` seconds from the note's time, negative when early.
    Timing { error: f64 },
    /// Positive when too high.
    Pitch { semitones: i32 },
    WrongChord,
    Technique,
}

impl From<MissReason> for UiMissReason {
    fn from(r: MissReason) -> Self {
        match r {
            MissReason::Unplayed => UiMissReason::Unplayed,
            MissReason::Timing { error } => UiMissReason::Timing { error },
            MissReason::Pitch { semitones } => UiMissReason::Pitch { semitones },
            MissReason::WrongChord => UiMissReason::WrongChord,
            MissReason::Technique => UiMissReason::Technique,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiScore {
    pub hits: u32,
    pub perfects: u32,
    pub misses: u32,
    pub extras: u32,
    pub streak: u32,
    pub best_streak: u32,
    pub points: u64,
}

impl From<Score> for UiScore {
    fn from(s: Score) -> Self {
        UiScore {
            hits: s.hits,
            perfects: s.perfects,
            misses: s.misses,
            extras: s.extras,
            streak: s.streak,
            best_streak: s.best_streak,
            points: s.points,
        }
    }
}

impl UiExpected {
    pub(crate) fn new(index: usize, e: &Expected, level: u32) -> UiExpected {
        let target = match &e.target {
            Target::Note { string, fret, midi } => UiTarget::Note { string: *string, fret: *fret, midi: *midi },
            Target::Chord { template, midis } => UiTarget::Chord { template: *template, midis: midis.clone() },
        };
        UiExpected { index, event: e.event, time: e.time, sustain: e.sustain, target, iteration: e.iteration, level }
    }
}

impl From<Judgement> for UiEvent {
    fn from(j: Judgement) -> UiEvent {
        match j {
            Judgement::Hit { index, time, error, perfect } => UiEvent::Hit { index, time, error, perfect },
            Judgement::Miss { index, time, reason } => UiEvent::Miss { index, time, reason: reason.into() },
            Judgement::Late { index, error } => UiEvent::Late { index, error },
            Judgement::PhraseDone { iteration, name, accuracy, level, next_level } => {
                UiEvent::Phrase { iteration, name, accuracy, level, next_level }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_serialise_like_the_typescript_side_expects() {
        let e = UiEvent::Phrase { iteration: 2, name: "A".into(), accuracy: 0.9, level: 1, next_level: 2 };
        assert_eq!(
            serde_json::to_string(&e).unwrap(),
            r#"{"type":"phrase","iteration":2,"name":"A","accuracy":0.9,"level":1,"nextLevel":2}"#
        );
        let item = UiExpected {
            index: 0,
            event: 3,
            time: 1.5,
            sustain: 0.0,
            target: UiTarget::Note { string: 1, fret: 2, midi: 47 },
            iteration: 1,
            level: 0,
        };
        let e = UiEvent::Expected { iteration: 1, level: 0, items: vec![item] };
        assert_eq!(
            serde_json::to_string(&e).unwrap(),
            r#"{"type":"expected","iteration":1,"level":0,"items":[{"index":0,"event":3,"time":1.5,"sustain":0.0,"target":{"kind":"note","string":1,"fret":2,"midi":47},"iteration":1,"level":0}]}"#
        );
        let s = UiEvent::Score { score: UiScore { best_streak: 4, ..UiScore::default() } };
        assert!(serde_json::to_string(&s).unwrap().contains(r#""bestStreak":4"#));
        assert_eq!(serde_json::to_string(&UiEvent::Reset).unwrap(), r#"{"type":"reset"}"#);
        let m = UiEvent::Miss { index: 4, time: 2.0, reason: UiMissReason::Pitch { semitones: -1 } };
        assert_eq!(
            serde_json::to_string(&m).unwrap(),
            r#"{"type":"miss","index":4,"time":2.0,"reason":{"kind":"pitch","semitones":-1}}"#
        );
        let m = UiEvent::Miss { index: 4, time: 2.0, reason: UiMissReason::WrongChord };
        assert!(serde_json::to_string(&m).unwrap().contains(r#""reason":{"kind":"wrongChord"}"#));
    }
}
