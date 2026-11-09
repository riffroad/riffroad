//! Note sequences through the streaming tracker: re-picked lines, repeated notes, legato
//! (hammer-on / pull-off / slide) and bends.

mod common;

use common::*;
use opensmith_dsp::{note, Algorithm, NoteTracker, PitchConfig, TrackerConfig, TrackerEvent};

/// Renders `(midi, start_s, dur_s)` notes; each is cut by a 4 ms fade at its end, as when the
/// next note is fretted or the pick lands on the string again.
fn sequence(notes: &[(i32, f32, f32)], kind: Kind, seed: u64) -> (Vec<f32>, Vec<(usize, i32)>) {
    let fade = (0.004 * SR) as usize;
    let mut out = Vec::new();
    let mut truth = Vec::new();
    for (k, &(midi, start, dur)) in notes.iter().enumerate() {
        let at = (start * SR) as usize;
        let len = (dur * SR) as usize;
        let mut s = common::render(kind, midi_freq(midi), dur + 0.01, 0.35, seed + k as u64);
        s.truncate(len + fade);
        for (i, v) in s[len..].iter_mut().enumerate() {
            *v *= 1.0 - i as f32 / fade as f32;
        }
        opensmith_dsp::synth::mix_into(&mut out, &s, at, 1.0);
        truth.push((at, midi));
    }
    out.extend(std::iter::repeat_n(0.0, (0.2 * SR) as usize));
    (out, truth)
}

/// Exact note sequence; attack timestamps within 1 ms (2 ms when the note has to emerge from
/// the previous note's tail); confirmation within physics + settle + the agreement buffers.
fn check_sequence(cfg: TrackerConfig, signal: &[f32], truth: &[(usize, i32)], label: &str) {
    let ons = note_ons(&run_tracker(&mut NoteTracker::new(cfg), signal));
    let got: Vec<i32> = ons.iter().map(|o| o.midi).collect();
    let want: Vec<i32> = truth.iter().map(|t| t.1).collect();
    assert_eq!(got, want, "{label}: note sequence");
    let mpm = opensmith_dsp::Mpm::new(cfg.pitch);
    for (k, (on, &(at, midi))) in ons.iter().zip(truth).enumerate() {
        let timing = on.onset as i64 - at as i64;
        let tolerance = if k == 0 { 48 } else { 96 };
        assert!((0..=tolerance).contains(&timing), "{label} {}: attack off by {timing} samples", note::note_name(midi));
        let physics = opensmith_dsp::PitchDetector::min_window_for(&mpm, midi_freq(midi)) as u64;
        // A note that interrupts another one waits `settle_ms` before its pitch window opens.
        let settle = if k > 0 { (cfg.settle_ms * 1e-3 * SR) as u64 } else { 0 };
        assert!(
            on.sample - at as u64 <= physics + settle + (cfg.confirm.max(1) + 1) as u64 * BLOCK as u64,
            "{label} {}: confirmed after {:.2} ms",
            note::note_name(midi),
            ms(on.sample - at as u64)
        );
    }
}

#[test]
fn chromatic_run_sixteenths_at_120_bpm() {
    let notes: Vec<(i32, f32, f32)> = (40..=64).enumerate().map(|(k, m)| (m, 0.05 + k as f32 * 0.125, 0.125)).collect();
    for kind in [Kind::Pluck, Kind::Ks] {
        let (signal, truth) = sequence(&notes, kind, 1);
        check_sequence(TrackerConfig::default(), &signal, &truth, kind.label());
    }
}

#[test]
fn repeated_notes_are_separate_hits() {
    // E3 E3 E3 E3 G3 E3 D3 C3 B2 — eighths at 140 BPM, the repeated E3s re-picked.
    let midis = [52, 52, 52, 52, 55, 52, 50, 48, 47];
    let notes: Vec<(i32, f32, f32)> = midis.iter().enumerate().map(|(k, &m)| (m, 0.05 + k as f32 * 0.214, 0.214)).collect();
    for kind in [Kind::Pluck, Kind::Ks] {
        let (signal, truth) = sequence(&notes, kind, 7);
        check_sequence(TrackerConfig::default(), &signal, &truth, kind.label());
    }
}

#[test]
fn alternate_picking_sixteenths_at_160_bpm_across_strings() {
    // A minor pentatonic box, 94 ms per note, mixing strings and octaves.
    let midis = [57, 60, 62, 64, 67, 69, 72, 69, 67, 64, 62, 60, 57, 55, 52, 50, 48, 45];
    let notes: Vec<(i32, f32, f32)> = midis.iter().enumerate().map(|(k, &m)| (m, 0.05 + k as f32 * 0.094, 0.094)).collect();
    for kind in [Kind::Pluck, Kind::Ks] {
        let (signal, truth) = sequence(&notes, kind, 21);
        check_sequence(TrackerConfig::default(), &signal, &truth, kind.label());
    }
}

#[test]
fn yin_tracker_follows_the_same_lines() {
    let cfg = TrackerConfig { algorithm: Algorithm::Yin, ..TrackerConfig::default() };
    let midis = [40, 45, 50, 55, 59, 64, 52, 52, 57, 60, 62, 64, 67, 69, 72];
    let notes: Vec<(i32, f32, f32)> = midis.iter().enumerate().map(|(k, &m)| (m, 0.05 + k as f32 * 0.15, 0.15)).collect();
    let (signal, truth) = sequence(&notes, Kind::Pluck, 3);
    let ons = note_ons(&run_tracker(&mut NoteTracker::new(cfg), &signal));
    assert_eq!(ons.iter().map(|o| o.midi).collect::<Vec<_>>(), truth.iter().map(|t| t.1).collect::<Vec<_>>());
    for (on, &(at, midi)) in ons.iter().zip(&truth) {
        // YIN needs two periods in its window (MPM: 1.25), plus the settle delay after a note.
        let bound = 2.0 * (SR / midi_freq(midi) + 3.0)
            + PitchConfig::default().min_overlap_samples as f32
            + cfg.settle_ms * 1e-3 * SR;
        assert!(((on.sample - at as u64) as f32) <= bound + (cfg.confirm.max(1) + 1) as f32 * BLOCK as f32, "YIN {midi}");
    }
}

/// Phase-continuous additive tone following `freq(t)`, no new attack: legato technique.
fn glide(freq: impl Fn(f32) -> f32, secs: f32) -> Vec<f32> {
    let n = (secs * SR) as usize;
    let mut phases = [0f64; 8];
    (0..n)
        .map(|i| {
            let t = i as f32 / SR;
            let f = freq(t) as f64;
            let env = (-t / 1.5).exp() * 0.35;
            let mut v = 0.0;
            for (h, ph) in phases.iter_mut().enumerate() {
                let hf = (h + 1) as f64;
                *ph += std::f64::consts::TAU * f * hf / SR as f64;
                v += ph.sin() / hf;
            }
            (v * env as f64 * 0.5) as f32
        })
        .collect()
}

fn with_lead(x: Vec<f32>) -> Vec<f32> {
    let mut s = vec![0.0; 2400];
    s.extend(x);
    s
}

#[test]
fn hammer_on_and_pull_off_are_legato_notes() {
    // G3 → hammer A3 at 300 ms → pull-off to G3 at 600 ms.
    let signal = with_lead(glide(|t| if (0.3..0.6).contains(&t) { 220.0 } else { 196.0 }, 0.9));
    let ons = note_ons(&run_tracker(&mut NoteTracker::new(TrackerConfig::default()), &signal));
    let got: Vec<(i32, bool)> = ons.iter().map(|o| (o.midi, o.legato)).collect();
    assert_eq!(got, vec![(55, false), (57, true), (55, true)]);
    for (on, change_s) in ons.iter().skip(1).zip([0.3f32, 0.6]) {
        let at = 2400 + (change_s * SR) as u64;
        assert!(on.sample > at && on.sample - at < (0.03 * SR) as u64, "legato change reported {:.1} ms late", ms(on.sample - at));
    }
}

#[test]
fn slide_walks_up_through_the_frets() {
    // A3 held 200 ms, slide to C4 over 80 ms, C4 held.
    let f = |t: f32| {
        let m = if t < 0.2 { 57.0 } else if t < 0.28 { 57.0 + 3.0 * (t - 0.2) / 0.08 } else { 60.0 };
        note::midi_to_freq(m, 440.0)
    };
    let ons = note_ons(&run_tracker(&mut NoteTracker::new(TrackerConfig::default()), &with_lead(glide(f, 0.6))));
    let midis: Vec<i32> = ons.iter().map(|o| o.midi).collect();
    assert_eq!(midis.first(), Some(&57));
    assert_eq!(midis.last(), Some(&60));
    assert!(midis.windows(2).all(|w| w[1] > w[0]), "slide must be monotonic: {midis:?}");
    assert!(ons.iter().skip(1).all(|o| o.legato));
}

#[test]
fn bend_is_tracked_as_continuous_pitch() {
    // G3 bent a whole step (to A3) over 200 ms, held, released.
    let f = |t: f32| {
        let m = if t < 0.15 { 55.0 } else if t < 0.35 { 55.0 + 2.0 * (t - 0.15) / 0.2 } else { 57.0 };
        note::midi_to_freq(m, 440.0)
    };
    let events = run_tracker(&mut NoteTracker::new(TrackerConfig::default()), &with_lead(glide(f, 0.6)));
    let first = note_ons(&events)[0];
    assert_eq!((first.midi, first.legato), (55, false));
    let pitches: Vec<(u64, f32)> = events
        .iter()
        .filter_map(|e| match *e {
            TrackerEvent::Pitch { sample, midi_f, .. } => Some((sample, midi_f)),
            _ => None,
        })
        .collect();
    let at = |s: f32| 2400 + (s * SR) as u64;
    let before: Vec<f32> = pitches.iter().filter(|p| p.0 > at(0.05) && p.0 < at(0.15)).map(|p| p.1).collect();
    let after: Vec<f32> = pitches.iter().filter(|p| p.0 > at(0.40)).map(|p| p.1).collect();
    assert!(before.iter().all(|m| (m - 55.0).abs() < 0.1), "before bend: {before:?}");
    assert!(!after.is_empty() && after.iter().all(|m| (m - 57.0).abs() < 0.1), "after bend");
    // The bend itself is reported continuously (no gap longer than 3 buffers).
    let during: Vec<u64> = pitches.iter().filter(|p| p.0 > at(0.15) && p.0 < at(0.35)).map(|p| p.0).collect();
    assert!(during.windows(2).all(|w| w[1] - w[0] <= 3 * BLOCK as u64));
}
