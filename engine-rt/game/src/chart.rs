//! Chart model: the JSON produced by `pipeline-ingest` (schema/chart.schema.json).

use std::path::Path;

use serde::{Deserialize, Serialize};

#[derive(Debug, thiserror::Error)]
pub enum ChartError {
    #[error("cannot read chart: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid chart JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("not a Riffroad chart (format {format:?}, version {version})")]
    Format { format: String, version: u32 },
    #[error("chord template {0} does not exist")]
    Template(usize),
    #[error("string {0} does not exist in the tuning")]
    String(u8),
    #[error("invalid chart: {0}")]
    Invalid(String),
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Chart {
    pub format: String,
    pub version: u32,
    pub meta: Meta,
    pub audio: Audio,
    pub arrangement: Arrangement,
    pub tempo: Tempo,
    pub beats: Vec<Beat>,
    pub sections: Vec<Span>,
    pub phrases: Vec<Phrase>,
    pub chord_templates: Vec<ChordTemplate>,
    pub notes: Vec<Note>,
    pub chords: Vec<Chord>,
    pub anchors: Vec<Anchor>,
    pub hand_shapes: Vec<HandShape>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Meta {
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    pub year: Option<i32>,
    pub duration: f64,
    pub source: Source,
    pub generator: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Source {
    pub kind: String,
    pub file: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Audio {
    pub backing: Option<String>,
    pub guitar: Option<String>,
    pub mix: Option<String>,
    pub offset: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Arrangement {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub tuning: Tuning,
    pub capo: u8,
    pub max_difficulty: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Tuning {
    pub name: String,
    pub strings: Vec<i32>,
    /// The recording's pitch against A440, in cents: the guitar is tuned this much up.
    #[serde(default)]
    pub cents: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tempo {
    pub bpm: f64,
    pub time_signature: [u32; 2],
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Beat {
    pub time: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bar: Option<u32>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Span {
    pub name: String,
    pub start: f64,
    pub end: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Phrase {
    pub name: String,
    pub start: f64,
    pub end: f64,
    pub max_difficulty: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ChordTemplate {
    pub name: String,
    pub frets: Vec<i32>,
    pub fingers: Vec<i32>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Techniques {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hammer_on: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pull_off: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slide_to: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bend: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vibrato: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub palm_mute: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mute: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub harmonic: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinch_harmonic: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tremolo: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accent: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tap: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link_next: Option<bool>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Note {
    pub time: f64,
    pub string: u8,
    pub fret: u8,
    pub sustain: f64,
    pub levels: [u32; 2],
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub techniques: Option<Techniques>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Chord {
    pub time: f64,
    pub template: usize,
    pub sustain: f64,
    pub levels: [u32; 2],
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub strum: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub techniques: Option<Techniques>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Anchor {
    pub time: f64,
    pub fret: u8,
    pub width: u8,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HandShape {
    pub template: usize,
    pub start: f64,
    pub end: f64,
}

/// Songs further than this many semitones from the guitar's tuning are not transposed: the
/// audio would suffer.
pub const MAX_TRANSPOSE: i32 = 5;

impl Chart {
    pub fn from_json(text: &str) -> Result<Chart, ChartError> {
        let chart: Chart = serde_json::from_str(text)?;
        if chart.format != "opensmith-chart" || chart.version != 1 {
            return Err(ChartError::Format { format: chart.format, version: chart.version });
        }
        chart.validate()?;
        Ok(chart)
    }

    /// Validate before either the renderer or the judge indexes chart data. Never reorder
    /// events: indices are shared by the renderer, judge and saved performances.
    pub fn validate(&self) -> Result<(), ChartError> {
        let chart = self;
        let invalid = |why: &str| ChartError::Invalid(why.into());
        let strings = chart.arrangement.tuning.strings.len();
        if !(4..=6).contains(&strings) {
            return Err(invalid("only arrangements with 4 to 6 strings are supported"));
        }
        if chart.arrangement.tuning.strings.iter().any(|m| !(0..=127).contains(m)) {
            return Err(invalid("open-string pitches must be MIDI notes (0..127)"));
        }
        let duration = chart.meta.duration;
        if !duration.is_finite() || duration <= 0.0 || !chart.audio.offset.is_finite() || !chart.arrangement.tuning.cents.is_finite() {
            return Err(invalid("duration must be positive and audio/tuning offsets finite"));
        }
        if !chart.tempo.bpm.is_finite() || chart.tempo.bpm <= 0.0 || chart.tempo.time_signature.contains(&0) {
            return Err(invalid("invalid tempo or time signature"));
        }
        let time = |t: f64| t.is_finite() && t >= 0.0 && t <= duration + 1e-6;
        let ordered = |times: Vec<f64>| times.iter().all(|&t| time(t)) && times.windows(2).all(|w| w[0] <= w[1]);
        for times in [chart.notes.iter().map(|n| n.time).collect(), chart.chords.iter().map(|c| c.time).collect(),
            chart.beats.iter().map(|b| b.time).collect(), chart.anchors.iter().map(|a| a.time).collect()] {
            if !ordered(times) { return Err(invalid("events must be in time order within the song")); }
        }
        let span = |start: f64, end: f64| time(start) && time(end) && start < end;
        if chart.phrases.iter().any(|p| !span(p.start, p.end) || p.max_difficulty > chart.arrangement.max_difficulty)
            || chart.phrases.windows(2).any(|w| w[0].end > w[1].start + 1e-6) {
            return Err(invalid("phrases must be nonempty, ordered and nonoverlapping"));
        }
        if chart.sections.iter().any(|s| !span(s.start, s.end)) || chart.sections.windows(2).any(|w| w[0].start > w[1].start) {
            return Err(invalid("invalid sections"));
        }
        for c in &chart.chord_templates {
            if c.frets.len() != strings || c.fingers.len() != strings || !c.frets.iter().any(|&f| f >= 0)
                || c.frets.iter().any(|&f| !(-1..=36).contains(&f)) || c.fingers.iter().any(|&f| !(-1..=4).contains(&f)) {
                return Err(invalid("chord frets/fingers must match the tuning and contain playable positions"));
            }
        }
        for template in chart.chords.iter().map(|c| c.template).chain(chart.hand_shapes.iter().map(|h| h.template)) {
            if template >= chart.chord_templates.len() { return Err(ChartError::Template(template)); }
        }
        if chart.hand_shapes.iter().any(|h| !span(h.start, h.end)) || chart.anchors.iter().any(|a| a.width == 0 || a.fret > 36) {
            return Err(invalid("invalid hand shape or anchor"));
        }
        if let Some(n) = chart.notes.iter().find(|n| n.string as usize >= strings) {
            return Err(ChartError::String(n.string));
        }
        for (t, sustain, levels) in chart.notes.iter().map(|n| (n.time, n.sustain, n.levels))
            .chain(chart.chords.iter().map(|c| (c.time, c.sustain, c.levels))) {
            if !sustain.is_finite() || sustain < 0.0 || levels[0] > levels[1] || levels[1] > chart.arrangement.max_difficulty
                || !chart.phrases.iter().any(|p| p.start <= t && t < p.end) {
                return Err(invalid("invalid sustain, difficulty or event outside a phrase"));
            }
        }
        if chart.notes.iter().any(|n| n.fret > 36 || n.techniques.as_ref().is_some_and(|t|
            t.slide_to.is_some_and(|f| f > 36) || t.bend.is_some_and(|b| !b.is_finite() || !(0.0..=12.0).contains(&b)))) {
            return Err(invalid("invalid fret or technique"));
        }
        Ok(())
    }

    pub fn load(path: impl AsRef<Path>) -> Result<Chart, ChartError> {
        Chart::from_json(&std::fs::read_to_string(path)?)
    }

    /// MIDI pitch of a fretted position (frets are absolute; the capo fret plays the "open" note).
    pub fn pitch(&self, string: u8, fret: u8) -> i32 {
        self.arrangement.tuning.strings[string as usize] + fret as i32
    }

    /// Plays the chart on a guitar tuned `strings` (called `name`) instead of retuning it: when
    /// the chart's tuning is that one moved by the same number of semitones on every string (at
    /// most `MAX_TRANSPOSE`), or the recording is off A440, the chart takes the guitar's tuning
    /// (same frets) and the song's audio is to be transposed by the semitones returned. `None`:
    /// nothing to change, or not possible (another string layout, another string count).
    pub fn retune_to(&mut self, strings: &[i32], name: &str) -> Option<f64> {
        let tuning = &mut self.arrangement.tuning;
        if strings.len() != tuning.strings.len() {
            return None;
        }
        let k = tuning.strings[0] - strings[0];
        if tuning.strings.iter().zip(strings).any(|(a, b)| a - b != k) || k.abs() > MAX_TRANSPOSE {
            return None;
        }
        let shift = -(k as f64 + tuning.cents / 100.0);
        if shift.abs() < 0.05 {
            return None;
        }
        tuning.strings = strings.to_vec();
        tuning.name = name.to_string();
        tuning.cents = 0.0;
        Some(shift)
    }

    /// Open strings a strum of chord `template` may brush on its way (MIDI): the string just
    /// below its lowest and just above its highest, when the chord leaves them unplayed.
    pub fn brushable(&self, template: usize) -> Vec<i32> {
        let frets = &self.chord_templates[template].frets;
        let strings = &self.arrangement.tuning.strings;
        let played: Vec<usize> = frets.iter().enumerate().filter(|(_, f)| **f >= 0).map(|(s, _)| s).collect();
        let (Some(&lo), Some(&hi)) = (played.first(), played.last()) else { return Vec::new() };
        [lo.checked_sub(1), Some(hi + 1)]
            .into_iter()
            .flatten()
            .filter(|&s| s < strings.len() && frets.get(s).is_none_or(|f| *f < 0))
            .map(|s| strings[s])
            .collect()
    }

    /// Made by the machine from a recording (an MP3), not written by a person: its chords have
    /// the right root far more often than the right third.
    pub fn transcribed(&self) -> bool {
        self.meta.source.kind == "audio"
    }

    /// Pitch classes of the thirds that chord `template` leaves free in a transcribed chart: both,
    /// for a chord on a root (its bass) and its fifth — the recognition takes minor for major
    /// more than anything else, and the player strums what the song plays. None otherwise.
    pub fn free_thirds(&self, template: usize) -> Vec<i32> {
        let pitches = self.chord_pitches(template);
        let (true, Some(bass)) = (self.transcribed(), pitches.iter().min()) else { return Vec::new() };
        let root = bass.rem_euclid(12);
        if !pitches.iter().any(|m| m.rem_euclid(12) == (root + 7) % 12) {
            return Vec::new();
        }
        vec![(root + 3) % 12, (root + 4) % 12]
    }

    /// What a strum of chord `template` must sound, and what else it may sound (MIDI): its notes
    /// but the free thirds (`free_thirds`), which it may sound anywhere, as the open strings next
    /// to it (`brushable`).
    pub fn judged(&self, template: usize) -> (Vec<i32>, Vec<i32>) {
        let thirds = self.free_thirds(template);
        let free = |m: &i32| thirds.contains(&m.rem_euclid(12));
        let mut allowed = self.brushable(template);
        allowed.extend((0..128).filter(free));
        (self.chord_pitches(template).into_iter().filter(|m| !free(m)).collect(), allowed)
    }

    /// Pitches of a chord template, low string first.
    pub fn chord_pitches(&self, template: usize) -> Vec<i32> {
        self.chord_templates[template]
            .frets
            .iter()
            .enumerate()
            .filter(|(_, f)| **f >= 0)
            .map(|(s, f)| self.arrangement.tuning.strings[s] + f)
            .collect()
    }

    /// Index of the phrase iteration containing `time`.
    pub fn phrase_at(&self, time: f64) -> Option<usize> {
        self.phrases.iter().position(|p| p.start <= time && time < p.end)
    }
}
