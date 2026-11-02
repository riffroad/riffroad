//! Recorded notes for the virtual guitar, cut out of takes of single notes played one by one
//! (each string at each fret, plain, palm-muted, with vibrato, as pinch or natural harmonics):
//! real attacks, timbres, decays and noises, from as many guitars as there are takes.

use std::collections::HashMap;
use std::io::Cursor;
use std::path::Path;

use lewton::inside_ogg::OggStreamReader;
use opensmith_dsp::guitar::{Kind, Samples};
use serde::Deserialize;

use crate::take::{Take, TakeError};

/// Longest recording kept per note (s).
const LONGEST: f64 = 4.0;

/// Where each note stands in the built-in notes' stream.
#[derive(Deserialize)]
struct NotesIndex {
    players: Vec<String>,
    /// (player, "plain" | "palmmute", string, fret, first sample, samples).
    notes: Vec<(usize, String, usize, i32, usize, usize)>,
}

#[derive(Default)]
pub struct SampleBank {
    notes: HashMap<(usize, i32, Kind), Vec<Vec<f32>>>,
}

impl SampleBank {
    /// The notes of the takes in `dir` (folders holding a take) whose name says how they were
    /// played: `singlenotes`, `palmmute`, `vibrato`, `pinchharmonics`, `harmonics`. Each note of
    /// their chart is cut from its attack to its end (or the next note), and scaled to the same
    /// peak: the guitarist's dynamics come on top.
    pub fn from_takes(dir: &Path) -> Result<SampleBank, TakeError> {
        let mut bank = SampleBank::default();
        let mut folders: Vec<_> = std::fs::read_dir(dir)
            .map_err(|e| TakeError::Io(dir.display().to_string(), e))?
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.join("take.json").is_file())
            .collect();
        folders.sort();
        for folder in folders {
            let name = folder.file_name().unwrap_or_default().to_string_lossy().to_lowercase();
            let kind = if name.contains("singlenotes") {
                Kind::Plain
            } else if name.contains("palmmute") {
                Kind::PalmMute
            } else if name.contains("vibrato") {
                Kind::Vibrato
            } else if name.contains("pinch") {
                Kind::Pinch
            } else if name.contains("harmonics") {
                Kind::Harmonic
            } else {
                continue;
            };
            let take = Take::load(&folder)?;
            let sr = take.sample_rate as f64;
            let mut notes = take.chart.notes.clone();
            notes.sort_by(|a, b| a.time.total_cmp(&b.time));
            for (k, n) in notes.iter().enumerate() {
                let next = notes.get(k + 1).map_or(f64::INFINITY, |m| m.time);
                let from = ((n.time - 0.003) * sr).max(0.0) as usize;
                let to = (((n.time + n.sustain + 0.15).min(next - 0.01).min(n.time + LONGEST)) * sr) as usize;
                let Some(cut) = take.guitar.get(from..to.min(take.guitar.len())) else { continue };
                let peak = cut.iter().fold(0.0f32, |m, v| m.max(v.abs()));
                if cut.len() < (0.1 * sr) as usize || peak < 1e-4 {
                    continue;
                }
                let note: Vec<f32> = cut.iter().map(|v| v * 0.5 / peak).collect();
                bank.notes.entry((n.string as usize, n.fret as i32, kind)).or_default().push(note);
            }
        }
        Ok(bank)
    }

    /// The notes the engine records its songs on, one bank per player: every string at frets 0
    /// to 15, plain and palm-muted, cut on their attacks, tuned, at one loudness
    /// (`assets/guitar-notes.*`, made by `models/guitar-notes/build.py` from Guitar-TECHS,
    /// CC BY 4.0). At 48 kHz.
    pub fn players() -> Result<Vec<SampleBank>, lewton::VorbisError> {
        let index: NotesIndex = serde_json::from_str(include_str!("../assets/guitar-notes.json")).expect("the notes' index is valid");
        let mut ogg = OggStreamReader::new(Cursor::new(&include_bytes!("../assets/guitar-notes.ogg")[..]))?;
        let mut stream: Vec<f32> = Vec::new();
        while let Some(packet) = ogg.read_dec_packet_itl()? {
            stream.extend(packet.iter().map(|&s| f32::from(s) / 32768.0));
        }
        let mut banks: Vec<SampleBank> = index.players.iter().map(|_| SampleBank::default()).collect();
        for (player, kind, string, fret, at, len) in index.notes {
            let kind = if kind == "palmmute" { Kind::PalmMute } else { Kind::Plain };
            let Some(note) = stream.get(at..at + len) else { continue };
            banks[player].notes.entry((string, fret, kind)).or_default().push(note.to_vec());
        }
        Ok(banks)
    }

    /// Recordings held, all kinds together.
    pub fn len(&self) -> usize {
        self.notes.values().map(Vec::len).sum()
    }

    pub fn is_empty(&self) -> bool {
        self.notes.is_empty()
    }
}

impl Samples for SampleBank {
    fn note(&self, string: usize, fret: i32, kind: Kind, choice: u32) -> Option<&[f32]> {
        // A technique without a recording at that fret falls back to the plain note there.
        let found = self.notes.get(&(string, fret, kind)).or_else(|| self.notes.get(&(string, fret, Kind::Plain)).filter(|_| kind != Kind::Harmonic))?;
        found.get(choice as usize % found.len()).map(Vec::as_slice)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use opensmith_dsp::{TunerAnalyzer, TunerConfig};

    #[test]
    fn the_built_in_notes_are_two_players_every_string_at_frets_0_to_15_in_tune() {
        let players = SampleBank::players().expect("the notes decode");
        assert_eq!(players.len(), 2);
        let open = [40, 45, 50, 55, 59, 64];
        // A fretted note beats more than an open string: less clarity asked than when tuning.
        let mut tuner = TunerAnalyzer::new(TunerConfig { min_clarity: 0.5, ..TunerConfig::default() });
        for (p, bank) in players.iter().enumerate() {
            assert_eq!(bank.len(), 6 * 16 * 2, "player {p}: plain and palm-muted, all of them");
            for (s, open) in open.iter().enumerate() {
                for f in 0..=15 {
                    assert!(bank.note(s, f, Kind::PalmMute, 0).is_some_and(|n| n.len() > 4800), "player {p} string {s} fret {f} palm-muted");
                    let plain = bank.note(s, f, Kind::Plain, 0).expect("plain");
                    // Read where the string rings clearly, past the pick's attack.
                    let reading = [4800, 9600, 19200].iter().find_map(|&at| tuner.analyze(&plain[at..at + 8192]));
                    let Some(reading) = reading else { panic!("player {p} string {s} fret {f} rings clearly") };
                    let cents = 100.0 * (reading.midi - (open + f) as f64);
                    assert!(cents.abs() < 10.0, "player {p} string {s} fret {f}: {cents:+.1} cents");
                }
            }
        }
    }
}
