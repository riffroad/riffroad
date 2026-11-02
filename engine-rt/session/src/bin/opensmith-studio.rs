//! Records in the engine's studio, to listen to: a song the engine writes (rock, punk, blues,
//! metal, ballad), or a chart from elsewhere with a plain rock beat and a bass on its beats and
//! lowest notes. Writes backing.wav, guitar.wav, mix.wav (and the written song's chart).
//!
//! cargo run --release -p opensmith-session --bin opensmith-studio -- <style> <seed> <folder>
//! cargo run --release -p opensmith-session --bin opensmith-studio -- <song_chart.json> <folder> [amp] [gain] [seed] [drums|bass]
//!
//! `drums` or `bass` keeps only that part of the backing, to measure it alone.

use std::path::{Path, PathBuf};

use opensmith_dsp::guitar::Samples;
use opensmith_dsp::AmpModel;
use opensmith_game::Chart;
use opensmith_session::samples::SampleBank;
use opensmith_session::songwriter::{write as write_song, Style};
use opensmith_session::studio::{record, strokes_of, BassNote, Hit, Piece, Rhythm, Tone, SAMPLE_RATE};

/// Kick on 1 and 3 (and the "and" of 3 every other bar), snare on 2 and 4, hats on the eighths,
/// a crash every four bars; the bass in eighths on the lowest note sounding, an octave down.
fn rhythm(chart: &Chart) -> Rhythm {
    let mut r = Rhythm::default();
    let lowest: Vec<(f64, i32)> = chart
        .notes
        .iter()
        .map(|n| (n.time, chart.arrangement.tuning.strings[n.string as usize] + n.fret as i32))
        .chain(chart.chords.iter().map(|c| {
            let frets = &chart.chord_templates[c.template].frets;
            let low = frets.iter().enumerate().filter(|(_, f)| **f >= 0).map(|(s, f)| chart.arrangement.tuning.strings[s] + *f).min().unwrap_or(40);
            (c.time, low)
        }))
        .collect();
    let bars: Vec<f64> = chart.beats.iter().filter(|b| b.bar.is_some()).map(|b| b.time).collect();
    for (k, w) in bars.windows(2).enumerate() {
        let (t, beat) = (w[0], (w[1] - w[0]) / 4.0);
        let hit = |time: f64, piece: Piece, velocity: f32| Hit { time, piece, velocity };
        r.drums.extend([hit(t, Piece::Kick, 1.0), hit(t + 2.0 * beat, Piece::Kick, 0.95), hit(t + beat, Piece::Snare, 0.95), hit(t + 3.0 * beat, Piece::Snare, 1.0)]);
        if k % 2 == 1 {
            r.drums.push(hit(t + 2.5 * beat, Piece::Kick, 0.8));
        }
        if k % 4 == 0 {
            r.drums.push(hit(t, Piece::Crash, 0.9));
        }
        for e in 0..8 {
            if e > 0 || k % 4 != 0 {
                r.drums.push(hit(t + e as f64 * beat / 2.0, Piece::Hat, if e % 2 == 0 { 0.75 } else { 0.5 }));
            }
            let at = t + e as f64 * beat / 2.0;
            if let Some(&(_, low)) = lowest.iter().filter(|(time, _)| *time <= at + 0.01).max_by(|a, b| a.0.total_cmp(&b.0)) {
                r.bass.push(BassNote { time: at, midi: low - 12, length: 0.47 * beat, velocity: if e % 2 == 0 { 1.0 } else { 0.85 } });
            }
        }
    }
    r
}

fn write(path: &Path, samples: &[f32]) {
    let spec = hound::WavSpec { channels: 2, sample_rate: SAMPLE_RATE, bits_per_sample: 32, sample_format: hound::SampleFormat::Float };
    let mut w = hound::WavWriter::create(path, spec).expect("writable");
    samples.iter().for_each(|&s| w.write_sample(s).expect("written"));
    w.finalize().expect("finished");
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 2 {
        eprintln!("usage : opensmith-studio <style> <graine> <dossier> | <song_chart.json> <dossier> [ampli] [gain] [graine] [drums|bass]");
        std::process::exit(2);
    }
    let started = std::time::Instant::now();
    let players = SampleBank::players().expect("recorded notes");
    eprintln!("notes enregistrées décodées en {:.1} s", started.elapsed().as_secs_f64());
    let banks: [Option<&dyn Samples>; 2] = [Some(&players[0]), Some(&players[1])];
    let started = std::time::Instant::now();
    let (rec, out) = if let Some(style) = Style::from_name(&args[0]) {
        let seed = args[1].parse().expect("seed");
        let out = PathBuf::from(args.get(2).expect("folder"));
        let song = write_song(style, seed);
        eprintln!("« {} » : {} bpm, {:.0} s", song.chart.meta.title, song.chart.tempo.bpm, song.seconds);
        std::fs::create_dir_all(&out).expect("folder");
        std::fs::write(out.join("song_chart.json"), serde_json::to_string_pretty(&song.chart).expect("json")).expect("chart");
        (record(&song.strokes, &song.rhythm, song.tone, banks, song.seconds, seed), out)
    } else {
        let chart = Chart::load(Path::new(&args[0])).expect("chart");
        let out = PathBuf::from(&args[1]);
        let amp = args.get(2).and_then(|a| AmpModel::from_name(a)).unwrap_or(AmpModel::Crunch);
        let gain = args.get(3).and_then(|g| g.parse().ok()).unwrap_or(0.85);
        let seed = args.get(4).and_then(|s| s.parse().ok()).unwrap_or(1);
        let mut parts = rhythm(&chart);
        match args.get(5).map(String::as_str) {
            Some("drums") => parts.bass.clear(),
            Some("bass") => parts.drums.clear(),
            _ => {}
        }
        (record(&strokes_of(&chart), &parts, Tone { amp, gain }, banks, chart.meta.duration + 2.0, seed), out)
    };
    eprintln!("enregistré en {:.1} s", started.elapsed().as_secs_f64());
    std::fs::create_dir_all(&out).expect("folder");
    write(&out.join("backing.wav"), &rec.backing);
    write(&out.join("guitar.wav"), &rec.guitar);
    let mix: Vec<f32> = rec.backing.iter().zip(&rec.guitar).map(|(b, g)| b + g).collect();
    write(&out.join("mix.wav"), &mix);
}
