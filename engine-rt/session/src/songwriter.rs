//! Songs the engine writes, in five styles of rock: a form (intro, verses, choruses, a solo or a
//! bridge, an ending), a key and a tempo, riffs and chord progressions a guitarist would play in
//! that style, and the drums and the bass that go with them. The guitar comes twice: as it is
//! played (the studio's strokes, every length, mute and stroke as meant) and as a chart with the
//! converter's difficulty levels (the chords' roots on the bar first, every note at the top).
//! Riffs are hand-written patterns the dice fill in; nothing is taken from any song.

use opensmith_dsp::synth::Pcg32;
use opensmith_dsp::AmpModel;
use opensmith_game::Chart;
use serde_json::{json, Value};

use crate::studio::{BassNote, Hit, Piece, Rhythm, Stroke, Tone};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Style {
    Rock,
    Punk,
    Blues,
    Metal,
    Ballad,
}

impl Style {
    pub const ALL: [Style; 5] = [Style::Rock, Style::Punk, Style::Blues, Style::Metal, Style::Ballad];

    pub fn name(self) -> &'static str {
        match self {
            Style::Rock => "rock",
            Style::Punk => "punk",
            Style::Blues => "blues",
            Style::Metal => "metal",
            Style::Ballad => "ballad",
        }
    }

    pub fn from_name(name: &str) -> Option<Style> {
        Style::ALL.into_iter().find(|s| s.name() == name)
    }
}

/// A song written: its chart, how the guitarist plays it, the band, the guitars' sound, and how
/// long it lasts with the last chord's ring.
pub struct Song {
    pub chart: Chart,
    pub strokes: Vec<Stroke>,
    pub rhythm: Rhythm,
    pub tone: Tone,
    pub seconds: f64,
}

const OPEN: [i32; 6] = [40, 45, 50, 55, 59, 64];
const NAMES: [&str; 12] = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
/// The first bar's downbeat (s).
const LEAD: f64 = 1.0;
/// Every level of the chart, as the converter makes them (see `pipeline-ingest/builder.py`).
const TOP: u32 = 4;

/// `style`, the same song for the same `seed`.
pub fn write(style: Style, seed: u64) -> Song {
    let mut w = Writer::new(seed.wrapping_mul(31).wrapping_add(style as u64));
    let tone = match style {
        Style::Rock => {
            rock(&mut w);
            Tone { amp: AmpModel::Crunch, gain: 0.85 }
        }
        Style::Punk => {
            punk(&mut w);
            Tone { amp: AmpModel::Crunch, gain: 0.95 }
        }
        Style::Blues => {
            blues(&mut w);
            Tone { amp: AmpModel::Crunch, gain: 0.6 }
        }
        Style::Metal => {
            metal(&mut w);
            Tone { amp: AmpModel::Metal, gain: 0.7 }
        }
        Style::Ballad => {
            ballad(&mut w);
            Tone { amp: AmpModel::Clean, gain: 0.45 }
        }
    };
    let title = w.title();
    let end = w.time(w.beat);
    let chart = w.chart(&title, style, seed, end + 2.0);
    Song { chart, strokes: w.strokes, rhythm: w.rhythm, tone, seconds: end + 3.0 }
}

/// How a stroke is played.
#[derive(Clone, Copy, Debug, Default)]
struct How {
    palm: bool,
    accent: bool,
    up: bool,
    hammer: bool,
    pull: bool,
    bend: f64,
    slide: i32,
    vibrato: bool,
}

/// A note or a chord of the chart, in beats.
struct Item {
    beat: f64,
    frets: [i32; 6],
    name: Option<String>,
    beats: f64,
    how: How,
}

/// A part of the form, in beats.
struct Section {
    kind: &'static str,
    phrase: char,
    start: f64,
    end: f64,
}

/// The drummer's feel for a bar.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Groove {
    /// Kick on 1 and 3 (and the "and" of 3 every other bar), snare on 2 and 4.
    Rock,
    /// The kick on the guitar's hits.
    Drive,
    /// Kick on 1, the "and" of 2 and 3: punk's push.
    Punk,
    /// The rock beat with triplet hats.
    Shuffle,
    /// Kicks in sixteenths under the beat.
    Double,
    /// The snare on 3 only: half time.
    Half,
    /// Kick on 1 and the "and" of 3, snare on 2 and 4, softly.
    Ballad,
    /// Kick on 1, the snare's rim on 2 and 4, very softly.
    Soft,
}

/// The bass player's line for a bar, on the chord's root.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Line {
    Eighths,
    Halves,
    /// Root, third, fifth, sixth, seventh and back: the boogie.
    Walking,
    Whole,
}

struct Writer {
    rng: Pcg32,
    bpm: f64,
    swing: bool,
    /// Where the next bar starts (beats).
    beat: f64,
    strokes: Vec<Stroke>,
    items: Vec<Item>,
    rhythm: Rhythm,
    /// (beat, root pitch class): what the bass follows.
    harmony: Vec<(f64, i32)>,
    /// Beats where the guitar strikes a chord or a root: where the kick goes in a driving groove.
    hits: Vec<f64>,
    sections: Vec<Section>,
}

impl Writer {
    fn new(seed: u64) -> Writer {
        Writer { rng: Pcg32::new(seed), bpm: 120.0, swing: false, beat: 0.0, strokes: Vec::new(), items: Vec::new(), rhythm: Rhythm::default(), harmony: Vec::new(), hits: Vec::new(), sections: Vec::new() }
    }

    fn pick<T: Copy>(&mut self, items: &[T]) -> T {
        items[(self.rng.next_u32() as usize) % items.len()]
    }

    fn chance(&mut self, p: f32) -> bool {
        self.rng.uniform() < p
    }

    fn spb(&self) -> f64 {
        60.0 / self.bpm
    }

    /// Seconds at `beat`; swung eighths land two thirds into the beat.
    fn time(&self, beat: f64) -> f64 {
        let whole = beat.floor();
        let mut part = beat - whole;
        if self.swing && (part - 0.5).abs() < 1e-6 {
            part = 2.0 / 3.0;
        }
        LEAD + (whole + part) * self.spb()
    }

    /// The guitarist strikes `frets` at `beat` for `beats`.
    fn strike(&mut self, beat: f64, beats: f64, frets: [i32; 6], name: Option<String>, how: How) {
        let time = self.time(beat);
        let length = (self.time(beat + beats) - time - 0.015).max(0.05);
        self.strokes.push(Stroke {
            time,
            length,
            frets,
            up: how.up,
            palm: how.palm,
            accent: how.accent,
            legato: how.hammer || how.pull,
            bend: how.bend,
            slide: how.slide,
            vibrato: how.vibrato,
        });
        self.items.push(Item { beat, frets, name, beats, how });
    }

    fn chord_at(&mut self, beat: f64, root: i32) {
        if self.harmony.last().is_none_or(|h| h.1 != root) {
            self.harmony.push((beat, root));
        }
    }

    fn root_at(&self, beat: f64) -> Option<i32> {
        self.harmony.iter().rev().find(|h| h.0 <= beat + 1e-6).map(|h| h.1)
    }

    /// Plays `pattern` from `beat`, a character per `step` beats: `P` a chord struck, `p` the
    /// chord palm-muted, `r` the key's root palm-muted, `R` the key's root ringing, `D` and `U`
    /// a strum down and up, `a` the chord's next string ringing (an arpeggio), `b` and `s` the
    /// boogie's fifth and sixth, `n` the next of `line`'s notes, `-` holding on, `.` a rest.
    /// Each of `P p D U a b s` takes its chord from `degrees`, one per stroke or one per bar.
    #[allow(clippy::too_many_arguments)]
    fn pattern(&mut self, beat: f64, step: f64, pattern: &str, key: &Key, degrees: &[i32], per_bar: bool, line: &[(usize, i32)]) {
        let chars: Vec<char> = pattern.chars().collect();
        let (mut d, mut n, mut arp) = (0usize, 0usize, 0usize);
        let mut degree = degrees.first().copied().unwrap_or(0);
        for (k, &c) in chars.iter().enumerate() {
            let at = beat + k as f64 * step;
            let held = 1 + chars[k + 1..].iter().take_while(|&&x| x == '-').count();
            let beats = held as f64 * step;
            let on_beat = (at - at.round()).abs() < 1e-6;
            if per_bar {
                let bar = ((at - beat) / 4.0).floor() as usize;
                degree = degrees[bar.min(degrees.len() - 1)];
            } else if "PpDUbs".contains(c) {
                degree = degrees[d.min(degrees.len() - 1)];
                d += 1;
            }
            let root = (key.tonic + degree).rem_euclid(12);
            match c {
                'P' | 'p' => {
                    let (frets, name) = key.chord(root, degree);
                    self.strike(at, beats, frets, Some(name), How { palm: c == 'p', accent: on_beat, ..How::default() });
                    self.chord_at(at, root);
                    self.hits.push(at);
                }
                'r' | 'R' => {
                    let (s, f) = key.root;
                    self.strike(at, beats, single(s, f), None, How { palm: c == 'r', accent: on_beat, ..How::default() });
                    self.chord_at(at, key.tonic);
                    self.hits.push(at);
                }
                'D' | 'U' => {
                    let (frets, name) = key.chord(root, degree);
                    let frets = if c == 'U' { upstroke(frets) } else { frets };
                    self.strike(at, beats, frets, Some(name), How { up: c == 'U', accent: on_beat && c == 'D', ..How::default() });
                    self.chord_at(at, root);
                }
                'a' => {
                    let (frets, _) = key.chord(root, degree);
                    let strings: Vec<usize> = (0..6).filter(|&s| frets[s] >= 0).collect();
                    let order = [0usize, 2, 3, 4, 3, 2, 3, 4];
                    let s = strings[order[arp % 8].min(strings.len() - 1)];
                    // Rings to the end of the bar.
                    let bar_end = beat + ((at - beat) / 4.0).floor() * 4.0 + 4.0;
                    self.strike(at, bar_end - at, single(s, frets[s]), None, How { accent: arp % 8 == 0, ..How::default() });
                    self.chord_at(at, root);
                    arp += 1;
                }
                'b' | 's' => {
                    let frets = key.boogie(root, c == 's');
                    let name = format!("{}{}", NAMES[root as usize], if c == 's' { "6" } else { "5" });
                    self.strike(at, beats, frets, Some(name), How { palm: true, accent: on_beat, ..How::default() });
                    self.chord_at(at, root);
                    self.hits.push(at);
                }
                'n' => {
                    if let Some(&(s, f)) = line.get(n % line.len().max(1)) {
                        self.strike(at, beats, single(s, f), None, How { accent: on_beat, ..How::default() });
                    }
                    n += 1;
                }
                _ => {}
            }
        }
    }

    /// The drums of the bar starting at `beat`.
    fn drums(&mut self, beat: f64, groove: Groove, ride: bool, crash: bool, fill: bool) {
        let soft = match groove {
            Groove::Soft => 0.45,
            Groove::Ballad => 0.75,
            _ => 1.0,
        };
        let fill_from = if fill { 3.0 } else { 4.0 };
        let mut hits: Vec<(f64, Piece, f32)> = Vec::new();
        // The cymbal: eighths on the hats (accents on the beat) or the ride.
        let cymbal = if ride { Piece::Ride } else { Piece::Hat };
        for e in 0..8 {
            let at = e as f64 * 0.5;
            if at >= fill_from || (crash && e == 0) {
                continue;
            }
            let v = match groove {
                Groove::Punk => 0.7,
                Groove::Double if e % 2 == 1 => continue,
                _ if e % 2 == 0 => 0.75,
                _ => 0.5,
            };
            let open = !ride && groove == Groove::Rock && e == 7 && self.chance(0.3);
            hits.push((at, if open { Piece::OpenHat } else { cymbal }, v * soft));
        }
        let mut kicks: Vec<f64> = match groove {
            Groove::Rock | Groove::Shuffle => vec![0.0, 2.0],
            Groove::Drive => {
                let mut k: Vec<f64> = self.hits.iter().map(|h| h - beat).filter(|h| (0.0..4.0).contains(h) && (h - 1.0).abs() > 1e-6 && (h - 3.0).abs() > 1e-6).collect();
                k.push(0.0);
                k
            }
            Groove::Punk => vec![0.0, 1.5, 2.0],
            Groove::Double => (0..16).map(|k| k as f64 * 0.25).collect(),
            Groove::Half => vec![0.0, 2.5],
            Groove::Ballad => vec![0.0, 2.5],
            Groove::Soft => vec![0.0],
        };
        if groove == Groove::Rock && (beat / 4.0).round() as usize % 2 == 1 {
            kicks.push(2.5);
        }
        kicks.sort_by(|a, b| a.total_cmp(b));
        kicks.dedup_by(|a, b| (*a - *b).abs() < 1e-6);
        for k in kicks.into_iter().filter(|k| *k < fill_from) {
            let v = if groove == Groove::Double { 0.7 } else if k.fract() == 0.0 { 1.0 } else { 0.85 };
            hits.push((k, Piece::Kick, v * soft));
        }
        let snares: &[f64] = if groove == Groove::Half { &[2.0] } else { &[1.0, 3.0] };
        for &s in snares.iter().filter(|s| **s < fill_from) {
            hits.push((s, Piece::Snare, soft));
        }
        if crash {
            hits.push((0.0, Piece::Crash, 0.9 * soft.max(0.7)));
        }
        if fill {
            let fills: [&[(f64, Piece)]; 3] = [
                &[(3.0, Piece::Snare), (3.25, Piece::Snare), (3.5, Piece::LowTom), (3.75, Piece::FloorTom)],
                &[(3.0, Piece::HighTom), (3.25, Piece::HighTom), (3.5, Piece::LowTom), (3.75, Piece::FloorTom)],
                &[(3.0, Piece::Snare), (3.25, Piece::Snare), (3.5, Piece::Snare), (3.75, Piece::Snare)],
            ];
            let f = self.pick(&fills);
            for (k, &(at, piece)) in f.iter().enumerate() {
                hits.push((at, piece, (0.6 + 0.12 * k as f32) * soft.max(0.6)));
            }
            hits.push((3.0, Piece::Kick, 0.8 * soft));
        }
        for (at, piece, v) in hits {
            let time = self.time(beat + at) + 0.003 * self.rng.gauss() as f64;
            let velocity = (v * self.rng.range(0.9, 1.0)).min(1.0);
            self.rhythm.drums.push(Hit { time, piece, velocity });
        }
    }

    /// The bass of the bar starting at `beat`.
    fn bass(&mut self, beat: f64, line: Line) {
        let steps: Vec<(f64, f64, i32, f32)> = match line {
            Line::Eighths => (0..8).map(|e| (e as f64 * 0.5, 0.45, 0, if e % 2 == 0 { 1.0 } else { 0.85 })).collect(),
            Line::Halves => vec![(0.0, 1.9, 0, 1.0), (2.0, 1.9, if self.chance(0.5) { 7 } else { 0 }, 0.9)],
            Line::Walking => [0, 4, 7, 9, 10, 9, 7, 4].iter().enumerate().map(|(e, &d)| (e as f64 * 0.5, 0.45, d, if e % 2 == 0 { 1.0 } else { 0.85 })).collect(),
            Line::Whole => vec![(0.0, 3.8, 0, 1.0)],
        };
        for (at, beats, interval, velocity) in steps {
            let Some(root) = self.root_at(beat + at) else { continue };
            let time = self.time(beat + at);
            let length = self.time(beat + at + beats) - time;
            let midi = 28 + (root - 4).rem_euclid(12) + interval;
            self.rhythm.bass.push(BassNote { time, midi, length, velocity });
        }
    }

    /// A part of the form: `bars` bars from here, the guitar played by `guitar` (given the start
    /// beat), the drums and the bass bar by bar.
    fn section(&mut self, kind: &'static str, phrase: char, bars: usize, band: Band, guitar: impl FnOnce(&mut Writer, f64)) {
        let start = self.beat;
        guitar(self, start);
        for b in 0..bars {
            let at = start + 4.0 * b as f64;
            if b >= band.from {
                let crash = b == band.from || (band.crash_every > 0 && b % band.crash_every == 0);
                self.drums(at, band.groove, band.ride, crash, b + 1 == bars && band.fill);
                if let Some(line) = band.line {
                    self.bass(at, line);
                }
            }
        }
        self.beat = start + 4.0 * bars as f64;
        self.sections.push(Section { kind, phrase, start, end: self.beat });
    }

    /// The last chord, ringing, the band hitting it with the guitar.
    fn ending(&mut self, key: &Key, degree: i32) {
        let at = self.beat;
        let root = (key.tonic + degree).rem_euclid(12);
        let (frets, name) = key.chord(root, degree);
        self.strike(at, 6.0, frets, Some(name), How { accent: true, vibrato: false, ..How::default() });
        self.chord_at(at, root);
        let time = self.time(at);
        self.rhythm.drums.extend([Hit { time, piece: Piece::Crash, velocity: 1.0 }, Hit { time, piece: Piece::Kick, velocity: 1.0 }]);
        let length = self.time(at + 6.0) - time;
        self.rhythm.bass.push(BassNote { time, midi: 28 + (root - 4).rem_euclid(12), length, velocity: 1.0 });
        self.beat = at + 8.0;
        self.sections.push(Section { kind: "outro", phrase: 'Z', start: at, end: self.beat });
    }

    /// A short title, two words.
    fn title(&mut self) -> String {
        const FIRST: [&str; 20] = [
            "Midnight", "Electric", "Rusty", "Neon", "Wild", "Burning", "Silver", "Lonely", "Heavy", "Broken", "Golden", "Restless", "Crimson", "Rolling", "Hollow", "Velvet", "Iron", "Dusty", "Northern", "Highway",
        ];
        const SECOND: [&str; 20] = [
            "Engine", "Thunder", "Riders", "Desert", "Heart", "Machine", "River", "Signal", "Avenue", "Storm", "Garage", "Echo", "Horizon", "Fever", "Lights", "Road", "Train", "Motel", "Static", "Comet",
        ];
        format!("{} {}", self.pick(&FIRST), self.pick(&SECOND))
    }

    /// The chart: the strokes as a game reads them, with difficulty levels, phrases and
    /// sections, chord shapes, where the hand sits.
    fn chart(&self, title: &str, style: Style, seed: u64, duration: f64) -> Chart {
        let spb = self.spb();
        let mut templates: Vec<([i32; 6], String)> = Vec::new();
        let mut notes: Vec<Value> = Vec::new();
        let mut chords: Vec<Value> = Vec::new();
        let mut shapes: Vec<Value> = Vec::new();
        let mut items: Vec<&Item> = self.items.iter().collect();
        items.sort_by(|a, b| a.beat.total_cmp(&b.beat));
        // Each phrase starts with something to play at the easiest level.
        let mut first_in: Vec<bool> = vec![false; items.len()];
        for s in &self.sections {
            if let Some(k) = items.iter().position(|i| i.beat >= s.start - 1e-6 && i.beat < s.end - 1e-6) {
                first_in[k] = true;
            }
        }
        for (k, it) in items.iter().enumerate() {
            let time = self.time(it.beat);
            let level = if first_in[k] { 0 } else { metric(it.beat) };
            let sustain = if it.beats >= 1.5 || (it.how.vibrato || it.how.bend > 0.0) && it.beats >= 1.0 { (it.beats - 0.5) * spb } else { 0.0 };
            let mut tech = serde_json::Map::new();
            let mut flag = |key: &str, on: bool| {
                if on {
                    tech.insert(key.into(), json!(true));
                }
            };
            flag("palmMute", it.how.palm);
            flag("hammerOn", it.how.hammer);
            flag("pullOff", it.how.pull);
            flag("vibrato", it.how.vibrato);
            flag("accent", it.how.accent && it.name.is_some());
            if it.how.bend > 0.0 {
                tech.insert("bend".into(), json!(it.how.bend));
            }
            let sounding: Vec<(usize, i32)> = (0..6).filter(|&s| it.frets[s] >= 0).map(|s| (s, it.frets[s])).collect();
            if let (Some(name), true) = (&it.name, sounding.len() > 1) {
                let template = match templates.iter().position(|t| t.0 == it.frets) {
                    Some(t) => t,
                    None => {
                        templates.push((it.frets, name.clone()));
                        templates.len() - 1
                    }
                };
                // The easy levels play the chord's root alone.
                let from = if level <= 1 {
                    let (s, f) = sounding[0];
                    notes.push(json!({ "time": time, "string": s, "fret": f, "sustain": sustain, "levels": [level, 1] }));
                    2
                } else {
                    level
                };
                let mut c = json!({ "time": time, "template": template, "sustain": sustain, "levels": [from, TOP] });
                if it.how.up {
                    c["strum"] = json!("up");
                }
                if !tech.is_empty() {
                    c["techniques"] = Value::Object(tech);
                }
                chords.push(c);
                shapes.push(json!({ "template": template, "start": time, "end": time + it.beats * spb * 0.9 }));
            } else if let Some(&(s, f)) = sounding.first() {
                if it.how.slide != 0 {
                    tech.insert("slideTo".into(), json!(f + it.how.slide));
                }
                let mut n = json!({ "time": time, "string": s, "fret": f, "sustain": sustain, "levels": [level, TOP] });
                if !tech.is_empty() {
                    n["techniques"] = Value::Object(tech);
                }
                notes.push(n);
            }
        }
        // The hand: its index finger moves a beat ahead of a note out of its reach.
        let mut anchors: Vec<Value> = vec![json!({ "time": 0.0, "fret": 1, "width": 4 })];
        let mut hand = 1;
        for it in &items {
            let fretted: Vec<i32> = it.frets.iter().copied().filter(|&f| f > 0).collect();
            let (Some(&lo), Some(&hi)) = (fretted.iter().min(), fretted.iter().max()) else { continue };
            if lo < hand || hi > hand + 3 {
                hand = lo.max(1);
                anchors.push(json!({ "time": (self.time(it.beat) - spb).max(0.0), "fret": hand, "width": 4 }));
            }
        }
        let total = (self.beat.ceil() as usize).max(4) + 8;
        let beats: Vec<Value> = (0..total).take_while(|&k| self.time(k as f64) <= duration).map(|k| if k % 4 == 0 { json!({ "time": self.time(k as f64), "bar": k / 4 + 1 }) } else { json!({ "time": self.time(k as f64) }) }).collect();
        let phrases: Vec<Value> = self.sections.iter().map(|s| json!({ "name": s.phrase.to_string(), "start": self.time(s.start), "end": self.time(s.end), "maxDifficulty": TOP })).collect();
        let sections: Vec<Value> = self.sections.iter().map(|s| json!({ "name": s.kind, "start": self.time(s.start), "end": self.time(s.end) })).collect();
        let templates: Vec<Value> = templates.iter().map(|(f, n)| json!({ "name": n, "frets": f, "fingers": fingers(f) })).collect();
        let doc = json!({
            "format": "opensmith-chart", "version": 1,
            "meta": { "title": title, "artist": "Riffroad", "album": null, "year": null, "duration": duration, "source": { "kind": "generated", "file": format!("{}-{seed}", style.name()) }, "generator": "songwriter" },
            "audio": { "backing": null, "guitar": null, "mix": null, "offset": 0.0 },
            "arrangement": { "name": "Lead", "type": "lead", "tuning": { "name": "E Standard", "strings": OPEN }, "capo": 0, "maxDifficulty": TOP },
            "tempo": { "bpm": self.bpm, "timeSignature": [4, 4] },
            "beats": beats, "sections": sections, "phrases": phrases, "chordTemplates": templates,
            "notes": notes, "chords": chords, "anchors": anchors, "handShapes": shapes
        });
        Chart::from_json(&doc.to_string()).expect("a written chart is valid")
    }
}

/// When the band plays in a section, and how.
#[derive(Clone, Copy)]
struct Band {
    /// The bar it comes in (the guitar alone before).
    from: usize,
    groove: Groove,
    ride: bool,
    /// A crash every this many bars (0: on its first bar only).
    crash_every: usize,
    /// A fill on the last bar.
    fill: bool,
    line: Option<Line>,
}

impl Band {
    fn new(groove: Groove, line: Line) -> Band {
        Band { from: 0, groove, ride: false, crash_every: 0, fill: true, line: Some(line) }
    }
}

/// Difficulty level of a stroke on `beat`, as the converter places them: the bar's first beat,
/// its middle, the other beats, the eighths, the rest.
fn metric(beat: f64) -> u32 {
    let in_bar = beat.rem_euclid(4.0);
    let near = |x: f64| (in_bar - x).abs() < 1e-6;
    if near(0.0) {
        0
    } else if near(2.0) {
        1
    } else if (in_bar - in_bar.round()).abs() < 1e-6 {
        2
    } else if ((in_bar * 2.0) - (in_bar * 2.0).round()).abs() < 1e-6 {
        3
    } else {
        4
    }
}

fn single(string: usize, fret: i32) -> [i32; 6] {
    let mut f = [-1; 6];
    f[string] = fret;
    f
}

/// An upstroke catches the top of the chord: its four highest strings at most.
fn upstroke(frets: [i32; 6]) -> [i32; 6] {
    let mut out = frets;
    let sounding: Vec<usize> = (0..6).filter(|&s| frets[s] >= 0).collect();
    for &s in sounding.iter().take(sounding.len().saturating_sub(4)) {
        out[s] = -1;
    }
    out
}

/// Fingers for a shape: an open chord's as taught; else the index on the lowest fret, the
/// others a finger a fret up from it, each finger on one string (a power chord: 1, 3, 4).
fn fingers(frets: &[i32; 6]) -> [i32; 6] {
    if let Some(&(_, _, f)) = OPEN_CHORDS.iter().find(|c| &c.1 == frets) {
        return f;
    }
    let lo = frets.iter().copied().filter(|&f| f > 0).min().unwrap_or(1);
    let mut used = [false; 5];
    let mut out = [-1; 6];
    for (s, &f) in frets.iter().enumerate() {
        out[s] = match f {
            f if f < 0 => -1,
            0 => 0,
            f => {
                let mut finger = (f - lo + 1).clamp(1, 4) as usize;
                while used[finger] && finger < 4 {
                    finger += 1;
                }
                used[finger] = true;
                finger as i32
            }
        };
    }
    out
}

/// Open chords by name, low E first, and their fingers.
const OPEN_CHORDS: [(&str, [i32; 6], [i32; 6]); 10] = [
    ("E", [0, 2, 2, 1, 0, 0], [0, 2, 3, 1, 0, 0]),
    ("A", [-1, 0, 2, 2, 2, 0], [-1, 0, 1, 2, 3, 0]),
    ("D", [-1, -1, 0, 2, 3, 2], [-1, -1, 0, 1, 3, 2]),
    ("G", [3, 2, 0, 0, 0, 3], [2, 1, 0, 0, 0, 3]),
    ("C", [-1, 3, 2, 0, 1, 0], [-1, 3, 2, 0, 1, 0]),
    ("Am", [-1, 0, 2, 2, 1, 0], [-1, 0, 2, 3, 1, 0]),
    ("Em", [0, 2, 2, 0, 0, 0], [0, 2, 3, 0, 0, 0]),
    ("Dm", [-1, -1, 0, 2, 3, 1], [-1, -1, 0, 2, 3, 1]),
    ("F", [-1, -1, 3, 2, 1, 1], [-1, -1, 3, 2, 1, 1]),
    ("Bm", [-1, 2, 4, 4, 3, 2], [-1, 1, 3, 4, 2, 1]),
];

/// The song's key and how its chords are voiced.
struct Key {
    tonic: i32,
    /// Power chords (and the key's root) near this fret.
    hand: i32,
    /// Where the key's root is played on its own: (string, fret).
    root: (usize, i32),
    /// Major key with open chords (the ballad), else power chords.
    open: bool,
}

impl Key {
    fn power(tonic: i32, hand: i32) -> Key {
        let (s, f) = power_root(tonic, hand);
        Key { tonic, hand: f, root: (s, f), open: false }
    }

    /// The chord on `root`, `degree` semitones above the key: a power chord, or the key's open
    /// chord there (major on I, IV, V; minor on ii, vi).
    fn chord(&self, root: i32, degree: i32) -> ([i32; 6], String) {
        if self.open {
            let minor = matches!(degree.rem_euclid(12), 2 | 4 | 9 | 11);
            let name = format!("{}{}", NAMES[root as usize], if minor { "m" } else { "" });
            if let Some(&(_, frets, _)) = OPEN_CHORDS.iter().find(|c| c.0 == name) {
                return (frets, name);
            }
        }
        let (s, f) = power_root(root, self.hand);
        let mut frets = [-1; 6];
        frets[s] = f;
        frets[s + 1] = f + 2;
        frets[s + 2] = f + 2;
        (frets, format!("{}5", NAMES[root as usize]))
    }

    /// The boogie's two-string shapes on `root`: the fifth, or the sixth above it.
    fn boogie(&self, root: i32, sixth: bool) -> [i32; 6] {
        let (s, f) = (0..3).map(|s| (s, (root - OPEN[s]).rem_euclid(12))).min_by_key(|&(s, f)| (f, s)).expect("three strings");
        let mut frets = [-1; 6];
        frets[s] = f;
        frets[s + 1] = f + if sixth { 4 } else { 2 };
        frets
    }
}

/// The root of a power chord on `root` near fret `hand`: on the low E or the A string, its
/// shape within the recorded frets.
fn power_root(root: i32, hand: i32) -> (usize, i32) {
    let mut best = (0usize, 0i32, i32::MAX);
    for (s, open) in OPEN.iter().enumerate().take(2) {
        for octave in [0, 12] {
            let f = (root - open).rem_euclid(12) + octave;
            if f > 13 {
                continue;
            }
            let cost = 2 * (f - hand).abs() + s as i32;
            if cost < best.2 {
                best = (s, f, cost);
            }
        }
    }
    (best.0, best.1)
}

/// The minor pentatonic of `tonic` in the box at `fret` (four frets) on `strings`, low to high.
fn pentatonic(tonic: i32, fret: i32, strings: std::ops::Range<usize>) -> Vec<(usize, i32)> {
    let mut out: Vec<(usize, i32)> = Vec::new();
    for s in strings {
        for f in fret..=(fret + 3).min(15) {
            let degree = (OPEN[s] + f - tonic).rem_euclid(12);
            let pitch = OPEN[s] + f;
            if [0, 3, 5, 7, 10].contains(&degree) && !out.iter().any(|&(s2, f2)| OPEN[s2] + f2 == pitch) {
                out.push((s, f));
            }
        }
    }
    out.sort_by_key(|&(s, f)| OPEN[s] + f);
    out
}

/// Where the minor pentatonic's first box sits for `tonic`: its root on the low E string, an
/// octave up when that is open or first fret and the box still fits.
fn box_fret(tonic: i32) -> i32 {
    let f = (tonic - OPEN[0]).rem_euclid(12);
    if f < 3 && f + 12 <= 12 {
        f + 12
    } else {
        f
    }
}

/// A melodic line of `count` notes through `notes` (low to high), from the middle, mostly by
/// step, ending on the key's root.
fn line(w: &mut Writer, notes: &[(usize, i32)], tonic: i32, count: usize) -> Vec<(usize, i32)> {
    if notes.is_empty() {
        return Vec::new();
    }
    let mut k = notes.len() / 2;
    let mut out = Vec::new();
    for i in 0..count {
        let step = w.pick(&[-2i32, -1, -1, 1, 1, 2, 0]);
        k = (k as i32 + step).clamp(0, notes.len() as i32 - 1) as usize;
        if i + 1 == count {
            k = nearest_root(notes, tonic, k);
        }
        out.push(notes[k]);
    }
    out
}

fn nearest_root(notes: &[(usize, i32)], tonic: i32, k: usize) -> usize {
    (0..notes.len()).filter(|&j| (OPEN[notes[j].0] + notes[j].1 - tonic).rem_euclid(12) == 0).min_by_key(|&j| (j as i32 - k as i32).abs()).unwrap_or(k)
}

/// A guitar solo of `bars` bars (two-bar phrases, a question then its answer) in the box at the
/// key's pentatonic: runs by step with hammer-ons and pull-offs, each question ending on a bend
/// up to the fifth or the root, each answer on the root, with vibrato.
fn solo(w: &mut Writer, beat: f64, bars: usize, tonic: i32) {
    let notes = pentatonic(tonic, box_fret(tonic), 1..6);
    let firsts = ["nnnn-nn-", "n-nnnnn-", ".nnnn-n-", "nn-nnn-n"];
    let lasts = ["nnn-----", "n-nn----", ".nn-----", "nnnn----"];
    let mut k = notes.len() / 2;
    for p in 0..bars / 2 {
        let question = p % 2 == 0;
        let rhythm: Vec<char> = format!("{}{}", w.pick(&firsts), w.pick(&lasts)).chars().collect();
        let count = rhythm.iter().filter(|&&c| c == 'n').count();
        let mut previous: Option<(usize, i32)> = None;
        let mut n = 0;
        for (i, &c) in rhythm.iter().enumerate() {
            if c != 'n' {
                continue;
            }
            n += 1;
            let at = beat + (2 * p) as f64 * 4.0 + i as f64 * 0.5;
            let held = 1 + rhythm[i + 1..].iter().take_while(|&&x| x == '-').count();
            let beats = held as f64 * 0.5;
            let last = n == count;
            let mut how = How { accent: (at - at.round()).abs() < 1e-6, ..How::default() };
            let degree_of = |j: usize| (OPEN[notes[j].0] + notes[j].1 - tonic).rem_euclid(12);
            let note = if last {
                // A question bends up to the fifth (from the fourth) or to the root (from the
                // seventh), on the G or the B string; an answer lands on the root.
                let target = if question { [5, 10][w.rng.next_u32() as usize % 2] } else { 0 };
                let fits = |j: usize| degree_of(j) == target && (!question || (3..=4).contains(&notes[j].0));
                k = (0..notes.len()).filter(|&j| fits(j)).min_by_key(|&j| (j as i32 - k as i32).abs()).unwrap_or(k);
                if question && degree_of(k) == target {
                    how.bend = 2.0;
                }
                how.vibrato = true;
                notes[k]
            } else {
                let step_by = w.pick(&[-2i32, -1, -1, 1, 1, 1, 2]) * if p == bars / 2 - 1 { -1 } else { 1 };
                k = (k as i32 + step_by).clamp(0, notes.len() as i32 - 1) as usize;
                notes[k]
            };
            if let Some((ps, pf)) = previous {
                // On the same string, a step's distance: hammered on going up, pulled off down.
                if ps == note.0 && beats <= 0.5 && !last {
                    how.hammer = note.1 > pf;
                    how.pull = note.1 < pf;
                }
            }
            w.strike(at, beats, single(note.0, note.1), None, how);
            previous = Some(note);
        }
    }
}

// --- The styles -------------------------------------------------------------------------------

/// Two-bar rock riffs in eighths and the degrees their chords take, in order.
const ROCK_RIFFS: [(&str, &[i32]); 6] = [
    ("P-.PP--.nnnnn-.n", &[0, 3, 5]),
    ("P--.P-P-P--.nnnn", &[0, 3, 5, 0]),
    ("rrrrP-rrrrrrP-P-", &[10, 8, 10]),
    ("P-P-.PP-P--.P---", &[0, 0, 10, 0, 8, 10]),
    ("R-rrP-rrR-rrP-nn", &[3, 5]),
    ("P-----.P--P-P-nn", &[0, 10, 8, 5]),
];
const ROCK_CHORUSES: [[i32; 4]; 6] = [[0, 10, 5, 0], [0, 8, 10, 0], [5, 0, 10, 0], [0, 7, 10, 5], [8, 10, 0, 0], [0, 5, 10, 5]];

fn rock(w: &mut Writer) {
    w.bpm = (96 + w.rng.next_u32() % 33) as f64;
    let key = Key::power(w.pick(&[4, 9, 7, 2]), 0);
    let (riff, degrees) = w.pick(&ROCK_RIFFS);
    let fills = pentatonic(key.tonic, key.hand, 0..4);
    let count = riff.matches('n').count();
    let fill = line(w, &fills, key.tonic, count);
    let chorus = w.pick(&ROCK_CHORUSES);
    let (held, driving) = (w.pick(&["P-------", "P--P--P-", "P--.P-P-"]), w.pick(&["PPPPPPPP", "P-P-P-P-"]));
    let chorus_pattern = format!("{held}{held}{held}{held}{driving}{driving}{driving}{driving}");
    let chorus_degrees: Vec<i32> = chorus.iter().chain(chorus.iter()).copied().collect();
    let play_riff = |w: &mut Writer, at: f64, times: usize| {
        for r in 0..times {
            w.pattern(at + 8.0 * r as f64, 0.5, riff, &key, degrees, false, &fill);
        }
    };
    let verse = Band::new(Groove::Drive, Line::Eighths);
    let refrain = Band { crash_every: 4, ..Band::new(Groove::Rock, Line::Eighths) };
    w.section("intro", 'I', 4, Band { from: 2, ..verse }, |w, at| play_riff(w, at, 2));
    for v in 0..3 {
        if v < 2 {
            w.section("verse", 'A', 8, verse, |w, at| play_riff(w, at, 4));
        } else {
            let tonic = key.tonic;
            w.section("solo", 'C', 8, Band { ride: true, ..refrain }, |w, at| {
                for (b, d) in chorus_degrees.iter().enumerate() {
                    w.chord_at(at + 4.0 * b as f64, (tonic + d).rem_euclid(12));
                }
                solo(w, at, 8, tonic);
            });
        }
        w.section("chorus", 'B', 8, refrain, |w, at| w.pattern(at, 0.5, &chorus_pattern, &key, &chorus_degrees, true, &[]));
    }
    w.ending(&key, 0);
}

/// Punk progressions, one chord a bar.
const PUNK_PROGRESSIONS: [[i32; 4]; 6] = [[0, 5, 7, 5], [0, 7, 9, 5], [0, 10, 5, 0], [0, 5, 0, 7], [9, 5, 0, 7], [0, 0, 5, 7]];

fn punk(w: &mut Writer) {
    w.bpm = (160 + w.rng.next_u32() % 31) as f64;
    let key = Key::power(w.pick(&[4, 9, 2, 7, 0]), 3);
    let verse: Vec<i32> = w.pick(&PUNK_PROGRESSIONS).repeat(2);
    let mut chorus: Vec<i32> = w.pick(&PUNK_PROGRESSIONS).to_vec();
    if chorus == verse[..4] {
        chorus = vec![5, 7, 0, 0];
    }
    let chorus: Vec<i32> = chorus.repeat(2);
    let muted = "pppppppp".repeat(8);
    let open = "PPPPPPPP".repeat(8);
    let band = Band::new(Groove::Punk, Line::Eighths);
    w.section("intro", 'I', 4, Band { from: 2, ..band }, |w, at| w.pattern(at, 0.5, &"P-P-P-P-".repeat(4), &key, &verse, true, &[]));
    for v in 0..2 {
        w.section("verse", 'A', 8, band, |w, at| w.pattern(at, 0.5, &muted, &key, &verse, true, &[]));
        w.section("chorus", 'B', 8, Band { crash_every: 4, ..band }, |w, at| w.pattern(at, 0.5, &open, &key, &chorus, true, &[]));
        if v == 0 {
            continue;
        }
        let bridge = [5, 7, 5, 7];
        w.section("bridge", 'C', 4, Band::new(Groove::Half, Line::Whole), |w, at| w.pattern(at, 0.5, &"P-------".repeat(4), &key, &bridge, true, &[]));
        w.section("chorus", 'B', 8, Band { crash_every: 4, ..band }, |w, at| w.pattern(at, 0.5, &open, &key, &chorus, true, &[]));
    }
    w.ending(&key, 0);
}

/// The twelve bars of the blues, degrees of the key.
const TWELVE_BARS: [i32; 12] = [0, 0, 0, 0, 5, 5, 0, 0, 7, 5, 0, 7];

fn blues(w: &mut Writer) {
    w.bpm = (80 + w.rng.next_u32() % 26) as f64;
    w.swing = true;
    let tonic = w.pick(&[4, 9]);
    let key = Key { tonic, hand: 0, root: (if tonic == 4 { 0 } else { 1 }, 0), open: false };
    let mut changes = TWELVE_BARS;
    if w.chance(0.5) {
        changes[1] = 5; // the quick change to IV
    }
    let boogie = "bbssbbss".repeat(12);
    let band = Band { crash_every: 0, ..Band::new(Groove::Shuffle, Line::Walking) };
    w.section("intro", 'I', 4, Band { from: 0, ..band }, |w, at| w.pattern(at, 0.5, &"bbssbbss".repeat(4), &key, &changes[8..], true, &[]));
    w.section("verse", 'A', 12, band, |w, at| w.pattern(at, 0.5, &boogie, &key, &changes, true, &[]));
    w.section("verse", 'A', 12, band, |w, at| w.pattern(at, 0.5, &boogie, &key, &changes, true, &[]));
    w.section("solo", 'C', 12, Band { ride: true, ..band }, |w, at| {
        for (b, d) in changes.iter().enumerate() {
            w.chord_at(at + 4.0 * b as f64, (tonic + d).rem_euclid(12));
        }
        solo(w, at, 12, tonic);
    });
    w.section("verse", 'A', 12, band, |w, at| w.pattern(at, 0.5, &boogie, &key, &changes, true, &[]));
    w.ending(&key, 0);
}

/// Metal riffs in sixteenths (two bars) and their chords' degrees: gallops on the open low E.
const METAL_RIFFS: [(&str, &[i32]); 4] = [
    ("r-rrr-rrr-rrP---r-rrr-rrP---P---", &[8, 3, 10]),
    ("r-rrr-rrP-P-r-rrr-rrr-rrP-P-P---", &[1, 0, 3, 1, 0]),
    ("rrrrP---rrrrP---rrrrP---P-P-P-P-", &[3, 1, 0, 1, 3, 5]),
    ("r-r-r-rrP--.P--.r-r-r-rrP-----..", &[10, 8, 5]),
];
const METAL_CHORUSES: [[i32; 4]; 4] = [[0, 8, 10, 0], [0, 3, 10, 8], [0, 5, 3, 1], [8, 10, 0, 0]];

fn metal(w: &mut Writer) {
    w.bpm = (100 + w.rng.next_u32() % 41) as f64;
    let key = Key { tonic: 4, hand: 0, root: (0, 0), open: false };
    let (riff, degrees) = w.pick(&METAL_RIFFS);
    let chorus = w.pick(&METAL_CHORUSES).repeat(2);
    let play_riff = |w: &mut Writer, at: f64, times: usize| {
        for r in 0..times {
            w.pattern(at + 8.0 * r as f64, 0.25, riff, &key, degrees, false, &[]);
        }
    };
    let verse = Band { crash_every: 0, ..Band::new(Groove::Drive, Line::Eighths) };
    let refrain = Band { ride: true, crash_every: 2, ..Band::new(Groove::Double, Line::Halves) };
    w.section("intro", 'I', 4, Band { from: 2, ..verse }, |w, at| play_riff(w, at, 2));
    w.section("verse", 'A', 8, verse, |w, at| play_riff(w, at, 4));
    w.section("chorus", 'B', 8, refrain, |w, at| w.pattern(at, 0.5, &"P-------".repeat(8), &key, &chorus, true, &[]));
    w.section("verse", 'A', 8, verse, |w, at| play_riff(w, at, 4));
    w.section("chorus", 'B', 8, refrain, |w, at| w.pattern(at, 0.5, &"P-------".repeat(8), &key, &chorus, true, &[]));
    let tonic = key.tonic;
    let solo_chords = chorus.clone();
    w.section("solo", 'C', 8, Band { ride: true, ..Band::new(Groove::Rock, Line::Eighths) }, |w, at| {
        for (b, d) in solo_chords.iter().enumerate() {
            w.chord_at(at + 4.0 * b as f64, (tonic + d).rem_euclid(12));
        }
        solo(w, at, 8, tonic);
    });
    w.section("breakdown", 'D', 4, Band::new(Groove::Half, Line::Whole), |w, at| w.pattern(at, 0.25, &"r--r--r-r--r-r--".repeat(4), &key, &[0], false, &[]));
    w.section("chorus", 'B', 8, refrain, |w, at| w.pattern(at, 0.5, &"P-------".repeat(8), &key, &chorus, true, &[]));
    w.ending(&key, 0);
}

/// Ballad progressions (degrees of a major key), one chord a bar.
const BALLAD_PROGRESSIONS: [[i32; 4]; 4] = [[0, 7, 9, 5], [9, 5, 0, 7], [0, 9, 5, 7], [0, 5, 9, 7]];

fn ballad(w: &mut Writer) {
    w.bpm = (66 + w.rng.next_u32() % 15) as f64;
    let tonic = w.pick(&[7, 0, 2]);
    let key = Key { tonic, hand: 0, root: (1, 0), open: true };
    let verse = w.pick(&BALLAD_PROGRESSIONS).repeat(2);
    let mut chorus = w.pick(&BALLAD_PROGRESSIONS).to_vec();
    if chorus == verse[..4] {
        chorus = vec![5, 0, 7, 0];
    }
    let chorus = chorus.repeat(2);
    let arpeggio = "aaaaaaaa".repeat(8);
    let strum = "D-DU-UDU".repeat(8);
    let soft = Band { crash_every: 0, ..Band::new(Groove::Soft, Line::Halves) };
    let full = Band { crash_every: 4, ..Band::new(Groove::Ballad, Line::Halves) };
    w.section("intro", 'I', 2, Band { from: 2, ..soft }, |w, at| w.pattern(at, 0.5, &"aaaaaaaa".repeat(2), &key, &verse, true, &[]));
    for _ in 0..2 {
        w.section("verse", 'A', 8, soft, |w, at| w.pattern(at, 0.5, &arpeggio, &key, &verse, true, &[]));
        w.section("chorus", 'B', 8, full, |w, at| w.pattern(at, 0.5, &strum, &key, &chorus, true, &[]));
    }
    w.ending(&key, 0);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_style_writes_a_playable_song_with_its_form_and_levels() {
        for style in Style::ALL {
            for seed in 0..6 {
                let song = write(style, seed);
                let c = &song.chart;
                let tag = format!("{} {seed}", style.name());
                assert!((60.0..240.0).contains(&song.seconds), "{tag}: {:.0} s", song.seconds);
                assert!(c.sections.iter().any(|s| s.name == "verse") && c.sections.iter().any(|s| s.name == "outro"), "{tag}: a form");
                // Within the recorded frets, one note per string at a time.
                for s in &song.strokes {
                    assert!(s.frets.iter().all(|&f| (-1..=15).contains(&f)), "{tag}: frets {:?}", s.frets);
                }
                for n in &c.notes {
                    assert!(n.fret <= 15 && n.levels[0] <= n.levels[1] && n.levels[1] <= TOP, "{tag}");
                }
                // Each phrase has something at the easiest level, and more at the top.
                for p in &c.phrases {
                    let at = |level: u32| c.notes.iter().map(|n| (n.time, n.levels)).chain(c.chords.iter().map(|c| (c.time, c.levels))).filter(|(t, l)| p.start <= *t && *t < p.end && l[0] <= level && level <= l[1]).count();
                    assert!(at(0) >= 1 && at(TOP) >= at(0), "{tag}: phrase {} has {} easy, {} at the top", p.name, at(0), at(TOP));
                }
                assert!(!song.rhythm.drums.is_empty() && !song.rhythm.bass.is_empty(), "{tag}: a band");
                assert!(song.rhythm.bass.iter().all(|b| (28..=52).contains(&b.midi)), "{tag}: the bass in its range");
            }
        }
    }

    #[test]
    fn the_same_seed_writes_the_same_song_and_others_differ() {
        let a = write(Style::Rock, 7);
        let b = write(Style::Rock, 7);
        assert_eq!(a.strokes, b.strokes);
        assert_eq!(a.chart.meta.title, b.chart.meta.title);
        let titles: std::collections::HashSet<String> = (0..12).map(|s| write(Style::Rock, s).chart.meta.title).collect();
        assert!(titles.len() >= 8, "titles vary: {titles:?}");
        let tempos: std::collections::HashSet<i64> = (0..12).map(|s| write(Style::Punk, s).chart.tempo.bpm as i64).collect();
        assert!(tempos.len() >= 6, "tempos vary");
    }

    #[test]
    fn a_blues_swings_and_a_ballad_plays_open_chords() {
        let blues = write(Style::Blues, 2);
        let spb = 60.0 / blues.chart.tempo.bpm;
        // An off-beat eighth lands two thirds into its beat.
        let off: Vec<f64> = blues.strokes.iter().map(|s| ((s.time - LEAD) / spb).fract()).filter(|f| *f > 0.1 && *f < 0.9).collect();
        assert!(!off.is_empty() && off.iter().all(|f| (f - 2.0 / 3.0).abs() < 0.01 || (f - 0.5).abs() > 0.1), "swung");
        let ballad = write(Style::Ballad, 1);
        let names: Vec<&str> = ballad.chart.chord_templates.iter().map(|t| t.name.as_str()).collect();
        assert!(names.iter().all(|n| OPEN_CHORDS.iter().any(|c| c.0 == *n)), "open chords: {names:?}");
        assert_eq!(fingers(&[0, 2, 2, -1, -1, -1]), [0, 1, 2, -1, -1, -1], "an open power chord");
        assert_eq!(fingers(&[3, 5, 5, -1, -1, -1]), [1, 3, 4, -1, -1, -1], "a power chord: 1, 3, 4");
    }
}
