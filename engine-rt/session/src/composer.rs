//! Practice material invented on the spot: random but guitar-like pieces (strummed open, barre
//! and power chords, arpeggios, palm-muted riffs, scale lines with hammer-ons, pull-offs,
//! slides, bends, vibrato and harmonics), as charts the virtual guitarist can play. Nothing is
//! taken from any song: what it trains or measures is free of anyone's rights.

use opensmith_dsp::synth::Pcg32;
use opensmith_game::Chart;
use serde_json::{json, Value};

/// Chord shapes, low E string first (-1: not played).
const OPEN: [[i32; 6]; 8] = [
    [0, 2, 2, 1, 0, 0],    // E
    [-1, 0, 2, 2, 2, 0],   // A
    [-1, -1, 0, 2, 3, 2],  // D
    [3, 2, 0, 0, 0, 3],    // G
    [-1, 3, 2, 0, 1, 0],   // C
    [-1, 0, 2, 2, 1, 0],   // Am
    [0, 2, 2, 0, 0, 0],    // Em
    [-1, -1, 0, 2, 3, 1],  // Dm
];

/// Movable shapes, relative to the barre fret.
const BARRE: [[i32; 6]; 6] = [
    [0, 2, 2, 1, 0, 0],    // E shape, major
    [0, 2, 2, 0, 0, 0],    // E shape, minor
    [-1, 0, 2, 2, 2, 0],   // A shape, major
    [-1, 0, 2, 2, 1, 0],   // A shape, minor
    [0, 2, 2, -1, -1, -1], // power chord on the low E
    [-1, 0, 2, 2, -1, -1], // power chord on the A
];

/// Scales as semitones from the root.
const SCALES: [&[i32]; 4] = [&[0, 3, 5, 7, 10], &[0, 2, 4, 7, 9], &[0, 2, 3, 5, 7, 8, 10], &[0, 2, 4, 5, 7, 9, 11]];

const OPEN_STRINGS: [i32; 6] = [40, 45, 50, 55, 59, 64];

struct Piece {
    rng: Pcg32,
    notes: Vec<Value>,
    chords: Vec<Value>,
    templates: Vec<Vec<i32>>,
}

impl Piece {
    fn chance(&mut self, p: f32) -> bool {
        self.rng.uniform() < p
    }

    fn pick<T: Copy>(&mut self, items: &[T]) -> T {
        items[(self.rng.next_u32() as usize) % items.len()]
    }

    fn template(&mut self, frets: &[i32]) -> usize {
        match self.templates.iter().position(|t| t == frets) {
            Some(k) => k,
            None => {
                self.templates.push(frets.to_vec());
                self.templates.len() - 1
            }
        }
    }

    fn note(&mut self, time: f64, string: usize, fret: i32, sustain: f64, techniques: Value) {
        let mut n = json!({ "time": time, "string": string, "fret": fret, "sustain": sustain, "levels": [0, 0] });
        if techniques.as_object().is_some_and(|o| !o.is_empty()) {
            n["techniques"] = techniques;
        }
        self.notes.push(n);
    }

    fn chord(&mut self, time: f64, frets: &[i32], sustain: f64, up: bool, techniques: Value) {
        let template = self.template(frets);
        let mut c = json!({ "time": time, "template": template, "sustain": sustain, "levels": [0, 0] });
        if up {
            c["strum"] = json!("up");
        }
        if techniques.as_object().is_some_and(|o| !o.is_empty()) {
            c["techniques"] = techniques;
        }
        self.chords.push(c);
    }

    /// A chord shape: open, or a barre or power chord at a random fret.
    fn shape(&mut self) -> Vec<i32> {
        if self.chance(0.35) {
            return self.pick(&OPEN).to_vec();
        }
        let shape = self.pick(&BARRE);
        let fret = 1 + (self.rng.next_u32() % 11) as i32;
        shape.iter().map(|&f| if f < 0 { -1 } else { f + fret }).collect()
    }

    /// Strummed chords: four shapes, quarters or eighths, sometimes palm-muted or muted.
    fn strum(&mut self, t0: f64, beat: f64, bars: usize) -> f64 {
        let progression: Vec<Vec<i32>> = (0..4).map(|_| self.shape()).collect();
        let eighths = self.chance(0.6);
        let palm = self.chance(0.25);
        let step = if eighths { beat / 2.0 } else { beat };
        let mut t = t0;
        for bar in 0..bars {
            let frets = progression[bar % 4].clone();
            let per_bar = if eighths { 8 } else { 4 };
            for k in 0..per_bar {
                if self.chance(0.12) {
                    t += step;
                    continue; // a rest
                }
                let tech = if self.chance(0.05) { json!({ "mute": true }) } else if palm { json!({ "palmMute": true }) } else { json!({}) };
                let up = eighths && k % 2 == 1;
                self.chord(t, &frets, step * 0.9, up, tech);
                t += step;
            }
        }
        t
    }

    /// Arpeggios: a shape's strings one after the other, ringing.
    fn arpeggio(&mut self, t0: f64, beat: f64, bars: usize) -> f64 {
        let mut t = t0;
        let step = beat / 2.0;
        for _ in 0..bars {
            let frets = self.shape();
            let strings: Vec<usize> = (0..6).filter(|&s| frets[s] >= 0).collect();
            for k in 0..8 {
                let s = strings[if k < strings.len() { k } else { strings.len() - 1 - (k - strings.len()) % strings.len() }];
                self.note(t, s, frets[s], beat * 1.5, json!({}));
                t += step;
            }
        }
        t
    }

    /// A line in a scale, in one position, with the techniques of lead playing.
    fn line(&mut self, t0: f64, beat: f64, bars: usize) -> f64 {
        let scale = self.pick(&SCALES);
        let root = 40 + (self.rng.next_u32() % 12) as i32;
        let position = (self.rng.next_u32() % 13) as i32;
        // The scale's notes playable in the position, as (string, fret).
        let mut places: Vec<(usize, i32)> = Vec::new();
        for (s, open) in OPEN_STRINGS.iter().enumerate() {
            for f in position..=position + 4 {
                let pc = (open + f - root).rem_euclid(12);
                if scale.contains(&pc) {
                    places.push((s, f));
                }
            }
        }
        if places.is_empty() {
            return t0;
        }
        let sixteenths = self.chance(0.4);
        let step = if sixteenths { beat / 4.0 } else { beat / 2.0 };
        let mut t = t0;
        let mut at = (self.rng.next_u32() as usize) % places.len();
        let end = t0 + bars as f64 * 4.0 * beat;
        while t < end {
            let jump = (self.rng.next_u32() % 5) as i64 - 2;
            let next = (at as i64 + jump).clamp(0, places.len() as i64 - 1) as usize;
            let (s, f) = places[next];
            let (ps, pf) = places[at];
            let long = self.chance(0.15);
            let sustain = if long { beat * 1.5 } else { step * 0.9 };
            let mut tech = json!({});
            if s == ps && f != pf && (f - pf).abs() <= 3 && self.chance(0.35) {
                tech[if f > pf { "hammerOn" } else { "pullOff" }] = json!(true);
            } else if long && s >= 2 && self.chance(0.4) {
                tech["bend"] = json!(if self.chance(0.6) { 2.0 } else { 1.0 });
            } else if long && self.chance(0.3) {
                tech["vibrato"] = json!(true);
            } else if self.chance(0.06) {
                let to = (f + if self.chance(0.5) { 2 } else { -2 }).clamp(1, 20);
                tech["slideTo"] = json!(to);
            } else if s <= 2 && self.chance(0.2) {
                tech["palmMute"] = json!(true);
            }
            self.note(t, s, f, sustain, tech);
            at = next;
            t += if long { beat * 2.0 } else { step };
        }
        t
    }

    /// A riff: palm-muted low notes and power-chord stabs.
    fn riff(&mut self, t0: f64, beat: f64, bars: usize) -> f64 {
        let base = (self.rng.next_u32() % 8) as i32;
        let string = if self.chance(0.7) { 0 } else { 1 };
        let step = beat / 2.0;
        let mut t = t0;
        for _ in 0..bars * 8 {
            if self.chance(0.25) {
                let f = base + self.pick(&[0, 3, 5, 7]);
                let frets: Vec<i32> = (0..6).map(|s| if s == string { f } else if s == string + 1 || s == string + 2 { f + 2 } else { -1 }).collect();
                self.chord(t, &frets, step * 0.9, false, json!({}));
            } else if self.chance(0.08) {
                self.note(t, string, base, step * 0.5, json!({ "mute": true }));
            } else {
                self.note(t, string, base, step * 0.8, json!({ "palmMute": true }));
            }
            t += step;
        }
        t
    }

    /// Natural harmonics on open strings.
    fn harmonics(&mut self, t0: f64, beat: f64, bars: usize) -> f64 {
        let mut t = t0;
        for _ in 0..bars * 2 {
            let s = (self.rng.next_u32() % 6) as usize;
            let f = self.pick(&[12, 12, 7, 5]);
            self.note(t, s, f, beat * 1.8, json!({ "harmonic": true }));
            t += beat * 2.0;
        }
        t
    }
}

/// A piece of about `seconds`, the same for the same `seed`.
pub fn compose(seed: u64, seconds: f64) -> Chart {
    let mut p = Piece { rng: Pcg32::new(seed), notes: Vec::new(), chords: Vec::new(), templates: Vec::new() };
    let bpm = 70.0 + 100.0 * p.rng.uniform() as f64;
    let beat = 60.0 / bpm;
    let mut t = 1.0;
    let mut phrases = Vec::new();
    while t < seconds {
        let bars = 2 + (p.rng.next_u32() % 3) as usize;
        let start = t;
        let r = p.rng.uniform();
        t = if r < 0.3 {
            p.strum(t, beat, bars)
        } else if r < 0.45 {
            p.arpeggio(t, beat, bars)
        } else if r < 0.8 {
            p.line(t, beat, bars)
        } else if r < 0.95 {
            p.riff(t, beat, bars)
        } else {
            p.harmonics(t, beat, bars)
        };
        t = t.max(start + beat);
        phrases.push(json!({ "name": format!("s{}", phrases.len()), "start": start, "end": t, "maxDifficulty": 0 }));
    }
    let duration = t + 2.0;
    let beats: Vec<Value> = (0..(duration / beat) as usize).map(|k| json!({ "time": k as f64 * beat, "bar": if k % 4 == 0 { json!(k / 4 + 1) } else { Value::Null } })).collect();
    let templates: Vec<Value> = p.templates.iter().map(|f| json!({ "name": "", "frets": f, "fingers": f.iter().map(|_| -1).collect::<Vec<_>>() })).collect();
    let doc = json!({
        "format": "opensmith-chart", "version": 1,
        "meta": { "title": format!("Étude {seed}"), "artist": "Riffroad", "album": null, "year": null, "duration": duration, "source": { "kind": "composer", "file": format!("{seed}") }, "generator": "composer" },
        "audio": { "backing": null, "guitar": null, "mix": null, "offset": 0.0 },
        "arrangement": { "name": "Lead", "type": "lead", "tuning": { "name": "E Standard", "strings": OPEN_STRINGS }, "capo": 0, "maxDifficulty": 0 },
        "tempo": { "bpm": bpm, "timeSignature": [4, 4] },
        "beats": beats, "sections": [], "phrases": phrases, "chordTemplates": templates,
        "notes": p.notes, "chords": p.chords, "anchors": [], "handShapes": []
    });
    Chart::from_json(&doc.to_string()).expect("a composed chart is valid")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pieces_are_playable_varied_and_repeatable() {
        let a = compose(1, 60.0);
        assert!(a.meta.duration >= 60.0);
        assert!(a.notes.len() + a.chords.len() > 50, "{} notes, {} chords", a.notes.len(), a.chords.len());
        assert_eq!(compose(1, 60.0).notes.len(), a.notes.len(), "the same seed, the same piece");
        let all: Vec<Chart> = (0..20).map(|k| compose(k, 60.0)).collect();
        let has = |f: &dyn Fn(&opensmith_game::chart::Techniques) -> bool| all.iter().any(|c| c.notes.iter().any(|n| n.techniques.as_ref().is_some_and(f)));
        assert!(all.iter().any(|c| !c.chords.is_empty()));
        assert!(has(&|t| t.hammer_on == Some(true) || t.pull_off == Some(true)));
        assert!(has(&|t| t.bend.is_some()) && has(&|t| t.palm_mute == Some(true)) && has(&|t| t.harmonic == Some(true)));
        for c in &all {
            assert!(c.notes.iter().all(|n| n.string < 6 && n.fret <= 24));
        }
    }
}
