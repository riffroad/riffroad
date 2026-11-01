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
        for c in &chart.chords {
            if c.template >= chart.chord_templates.len() {
                return Err(ChartError::Template(c.template));
            }
        }
        let strings = chart.arrangement.tuning.strings.len();
        if let Some(n) = chart.notes.iter().find(|n| n.string as usize >= strings) {
            return Err(ChartError::String(n.string));
        }
        Ok(chart)
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

    /// Pitches of a chord template, low string first.
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
