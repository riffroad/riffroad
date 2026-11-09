//! The whole game loop on a chart made by `pipeline-ingest` from an MP3: a simulated guitarist
//! plays what the highway shows, the Step 1 detection (note tracker + chord verifier, fed in
//! 64-sample buffers) listens, and the game judges.

use opensmith_dsp::synth::{mix_into, Pcg32, Pluck};
use opensmith_dsp::{ChordConfig, ChordVerifier, NoteTracker, TrackerConfig, TrackerEvent};
use opensmith_game::{Chart, Game, GameConfig, Judgement, Status, Target};

const SR: f32 = 48_000.0;
const BLOCK: usize = 64;
/// Audio the chord verifier looks at after a strum.
const CHORD_WINDOW: f64 = 0.09;

fn chart() -> Chart {
    Chart::load(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/demo_rock.json")).expect("fixture chart")
}

fn midi_hz(m: i32) -> f32 {
    440.0 * 2f32.powf((m - 69) as f32 / 12.0)
}

/// Renders a performance of `targets` (time, target): each note or strum lasts until the next
/// one (the player moves on), pitches shifted by `shift`, everything played `delay` late.
fn perform(targets: &[(f64, Target)], duration: f64, shift: i32, delay: f64) -> Vec<f32> {
    let mut rng = Pcg32::new(7);
    let mut out = vec![0.0f32; ((duration + 1.0) * SR as f64) as usize];
    for (k, (time, target)) in targets.iter().enumerate() {
        let next = targets.get(k + 1).map_or(time + 1.0, |t| t.0);
        let length = (next - time).clamp(0.08, 1.0) as f32;
        let at = ((time + delay) * SR as f64) as usize;
        let pitches = match target {
            Target::Note { midi, .. } => vec![*midi],
            Target::Chord { midis, .. } => midis.clone(),
        };
        for (j, m) in pitches.iter().enumerate() {
            let mut p = Pluck::new(midi_hz(m + shift));
            p.secs = length;
            p.amp = if pitches.len() > 1 { 0.22 } else { 0.4 };
            p.pluck_pos = rng.range(0.12, 0.3);
            let mut sound = p.render(SR, &mut rng);
            let fade = (0.004 * SR) as usize;
            let n = sound.len();
            for (i, v) in sound[n.saturating_sub(fade)..].iter_mut().enumerate() {
                *v *= 1.0 - i as f32 / fade as f32;
            }
            mix_into(&mut out, &sound, at + j * (0.008 * SR) as usize, 1.0);
        }
    }
    out
}

/// Runs the detection over `audio` like the engine would and lets the game judge it.
fn play(game: &mut Game, audio: &[f32]) -> Vec<Judgement> {
    let mut tracker = NoteTracker::new(TrackerConfig::default());
    let mut verifier = ChordVerifier::new(ChordConfig::default());
    let mut judgements = Vec::new();
    let mut attacks: Vec<f64> = Vec::new();
    for (k, block) in audio.chunks(BLOCK).enumerate() {
        let now = ((k + 1) * BLOCK) as f64 / SR as f64;
        tracker.process(block, |e| match e {
            TrackerEvent::Onset { sample } => attacks.push(sample as f64 / SR as f64),
            TrackerEvent::NoteOn { onset_sample, midi, .. } => judgements.extend(game.on_note(onset_sample as f64 / SR as f64, midi)),
            TrackerEvent::Pitch { sample, midi_f, .. } => game.observe_pitch(sample as f64 / SR as f64, midi_f as f64),
            _ => {}
        });
        for (index, time, pitches) in game.chords_ready(now, CHORD_WINDOW) {
            let a = (time * SR as f64) as usize;
            let b = (((time + CHORD_WINDOW) * SR as f64) as usize).min(audio.len());
            let accepted = verifier.verify(&audio[a..b], &pitches, 440.0).accepted;
            let attack = attacks
                .iter()
                .copied()
                .filter(|t| (t - time).abs() < 0.1)
                .min_by(|x, y| (x - time).abs().total_cmp(&(y - time).abs()));
            judgements.extend(game.on_chord(index, accepted, attack));
        }
        let db = 10.0 * (block.iter().map(|v| v * v).sum::<f32>() / block.len() as f32).max(1e-12).log10();
        game.observe_level(now, db);
        judgements.extend(game.advance(now));
    }
    judgements.extend(game.advance(audio.len() as f64 / SR as f64 + 1.0));
    judgements
}

/// What the highway shows at a fixed `level`, in time order.
fn targets_at(chart: &Chart, level: u32) -> Vec<(f64, Target)> {
    let mut preview = Game::new(chart.clone(), GameConfig { dynamic_difficulty: false, start_level: level, ..GameConfig::default() });
    preview.activate_all();
    let mut t: Vec<(f64, Target)> = preview.expected().iter().map(|e| (e.time, e.target.clone())).collect();
    t.sort_by(|a, b| a.0.total_cmp(&b.0));
    t
}

#[test]
fn a_good_player_is_recognised_at_every_level() {
    let chart = chart();
    println!("\n{} — {} ({} phrases, levels 0..={})", chart.meta.artist, chart.meta.title, chart.phrases.len(), chart.arrangement.max_difficulty);
    for level in 0..=chart.arrangement.max_difficulty {
        let targets = targets_at(&chart, level);
        let audio = perform(&targets, chart.meta.duration, 0, 0.0);
        let mut game = Game::new(chart.clone(), GameConfig { dynamic_difficulty: false, start_level: level, ..GameConfig::default() });
        let js = play(&mut game, &audio);
        let s = game.score();
        let chords = targets.iter().filter(|t| matches!(t.1, Target::Chord { .. })).count();
        let worst = js
            .iter()
            .filter_map(|j| match j {
                Judgement::Hit { error, .. } => Some(error.abs() * 1000.0),
                _ => None,
            })
            .fold(0f64, f64::max);
        println!(
            "level {level}: {} targets ({chords} chords) → {} hits, {} misses, accuracy {:.1}%, best streak {}, {} perfect, worst timing {:.1} ms",
            targets.len(),
            s.hits,
            s.misses,
            100.0 * s.accuracy(),
            s.best_streak,
            s.perfects,
            worst
        );
        assert_eq!(s.hits + s.misses, targets.len() as u32);
        assert!(s.accuracy() >= 0.95, "level {level}: accuracy {:.3}", s.accuracy());
        assert!(worst <= 50.0, "timing error {worst} ms");
    }
}

#[test]
fn wrong_notes_and_late_playing_are_not_rewarded() {
    let chart = chart();
    let level = chart.arrangement.max_difficulty;
    let targets = targets_at(&chart, level);
    for (label, shift, delay) in [("a semitone sharp", 1, 0.0), ("250 ms late", 0, 0.25)] {
        let audio = perform(&targets, chart.meta.duration, shift, delay);
        let mut game = Game::new(chart.clone(), GameConfig { dynamic_difficulty: false, start_level: level, ..GameConfig::default() });
        play(&mut game, &audio);
        let s = game.score();
        println!("{label}: accuracy {:.1}%", 100.0 * s.accuracy());
        assert!(s.accuracy() <= 0.1, "{label}: accuracy {:.3}", s.accuracy());
    }
}

#[test]
fn dynamic_difficulty_climbs_for_a_good_player() {
    let chart = chart();
    // A symbolic perfect player run through a probe game gives the level of every iteration:
    // that is what the highway shows, so that is what the simulated guitarist plays.
    let mut probe = Game::new(chart.clone(), GameConfig::default());
    let mut now = 0.0;
    while now <= chart.meta.duration + 1.0 {
        probe.autoplay(now);
        probe.advance(now);
        let due: Vec<(usize, f64, Target)> = probe
            .expected()
            .iter()
            .enumerate()
            .filter(|(_, e)| e.status == Status::Pending && e.time <= now)
            .map(|(i, e)| (i, e.time, e.target.clone()))
            .collect();
        for (index, t, target) in due {
            match target {
                Target::Note { midi, .. } => {
                    probe.on_note(t, midi);
                }
                Target::Chord { .. } => {
                    probe.on_chord(index, true, Some(t));
                }
            }
        }
        now += 0.005;
    }
    let mut shown = Vec::new();
    let mut targets: Vec<(f64, Target)> = Vec::new();
    for (k, phrase) in chart.phrases.iter().enumerate() {
        let level = probe.iteration_level(k).expect("every phrase was shown");
        if phrase.name != "rest" {
            shown.push((phrase.name.clone(), level));
        }
        targets.extend(targets_at(&chart, level).into_iter().filter(|(t, _)| phrase.start <= *t && *t < phrase.end));
    }

    let mut game = Game::new(chart.clone(), GameConfig::default());
    let js = play(&mut game, &perform(&targets, chart.meta.duration, 0, 0.0));
    let done: Vec<(String, u32, u32, f64)> = js
        .iter()
        .filter_map(|j| match j {
            Judgement::PhraseDone { name, level, next_level, accuracy, .. } => Some((name.clone(), *level, *next_level, *accuracy)),
            _ => None,
        })
        .collect();
    println!("phrase runs (name, level, next level, accuracy): {done:?}");
    let played: Vec<(String, u32)> = done.iter().map(|d| (d.0.clone(), d.1)).collect();
    assert_eq!(played, shown, "the game judged each phrase at the level the player saw");
    assert!(done.iter().all(|d| d.3 >= 0.85), "every run good enough to level up");
    let second_a = done.iter().filter(|d| d.0 == "A").nth(1).expect("phrase A twice");
    assert_eq!(second_a.1, 1, "A comes back one level up");
}
