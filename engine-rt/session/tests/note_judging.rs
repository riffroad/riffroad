//! Real recorded guitar notes through the whole audio/session/game path, without devices.
//! Negative controls matter as much as recognising the notes that were requested.

use std::sync::OnceLock;

use opensmith_audio::EngineConfig;
use opensmith_game::chart::{Note, Phrase};
use opensmith_game::{Chart, GameConfig};
use opensmith_session::guitarist::{perform_with, Player};
use opensmith_session::replay::replay;
use opensmith_session::samples::SampleBank;
use opensmith_session::{Judging, SessionConfig, Take, UiEvent};

fn banks() -> &'static [SampleBank] {
    static BANKS: OnceLock<Vec<SampleBank>> = OnceLock::new();
    BANKS.get_or_init(|| SampleBank::players().expect("the shipped recordings decode"))
}

fn chart(midis: &[i32], step: f64) -> Chart {
    let mut chart = Chart::load(concat!(env!("CARGO_MANIFEST_DIR"), "/../game/tests/fixtures/demo_rock.json")).unwrap();
    let duration = 3.0 + midis.len() as f64 * step;
    chart.meta.duration = duration;
    chart.meta.source.kind = "guitarpro".into();
    chart.audio.offset = 0.0;
    chart.arrangement.max_difficulty = 0;
    chart.phrases = vec![Phrase { name: "test".into(), start: 0.0, end: duration, max_difficulty: 0 }];
    chart.chords.clear();
    chart.notes = midis
        .iter()
        .enumerate()
        .map(|(k, &midi)| {
            let strings = &chart.arrangement.tuning.strings;
            let string = strings.iter().rposition(|&open| open <= midi).unwrap();
            Note {
                time: 1.0 + k as f64 * step,
                string: string as u8,
                fret: (midi - strings[string]) as u8,
                sustain: step.min(0.25),
                levels: [0, 0],
                techniques: None,
            }
        })
        .collect();
    chart
}

fn performance(chart: &Chart, bank: &SampleBank) -> Take {
    let mut player = Player::clean();
    player.bias = 0.0;
    player.spread = 0.0;
    player.let_ring = 0.0;
    player.detune = 0.0;
    perform_with(chart, 0, &player, 1, Some(bank)).take
}

fn judged(take: &Take, judging: Judging) -> Vec<usize> {
    judged_with(take, judging, &EngineConfig::default())
}

fn judged_with(take: &Take, judging: Judging, engine: &EngineConfig) -> Vec<usize> {
    let cfg = SessionConfig {
        judging,
        game: GameConfig { hit_window: judging.hit_window, dynamic_difficulty: false, ..GameConfig::default() },
        ..SessionConfig::default()
    };
    replay(take, engine, cfg)
        .into_iter()
        .filter_map(|e| if let UiEvent::Hit { index, .. } = e { Some(index) } else { None })
        .collect()
}

#[test]
fn recorded_wrong_notes_and_octaves_do_not_play_the_expected_e() {
    let played = chart(&(40..=64).collect::<Vec<_>>(), 1.0);
    for (player, bank) in banks().iter().enumerate() {
        let mut take = performance(&played, bank);
        // E3 is requested each time. The recordings play E2 through E4, including both wrong
        // octaves and the F3 whose attack briefly fools the fast tracker into reporting E3.
        take.chart = chart(&[52; 25], 1.0);
        for judging in [Judging::NORMAL, Judging::STRICT, Judging::LENIENT] {
            assert_eq!(judged(&take, judging), [12], "recorded guitar {player}, {judging:?}: only the E3 may count");
        }
    }
}

#[test]
fn recorded_right_notes_still_count() {
    let played = chart(&(40..=64).collect::<Vec<_>>(), 0.25);
    for (player, bank) in banks().iter().enumerate() {
        let take = performance(&played, bank);
        assert_eq!(judged(&take, Judging::NORMAL), (0..25).collect::<Vec<_>>(), "recorded guitar {player}");
    }
}

#[test]
fn recorded_neighbouring_frets_and_wrong_octaves_are_refused_across_the_neck() {
    let pairs: Vec<(i32, i32)> = (40..=76)
        .flat_map(|played| [-12, -1, 1, 12].into_iter().map(move |shift| (played, played + shift)))
        .filter(|(_, expected)| (40..=88).contains(expected))
        .collect();
    let played = chart(&pairs.iter().map(|&(p, _)| p).collect::<Vec<_>>(), 0.3);
    let expected = chart(&pairs.iter().map(|&(_, e)| e).collect::<Vec<_>>(), 0.3);
    for (player, bank) in banks().iter().enumerate() {
        let mut take = performance(&played, bank);
        take.chart = expected.clone();
        for judging in [Judging::NORMAL, Judging::STRICT, Judging::LENIENT] {
            let wrong: Vec<_> = judged(&take, judging).into_iter().map(|i| pairs[i]).collect();
            assert!(wrong.is_empty(), "recorded guitar {player}, {judging:?}, (played, expected) accepted: {wrong:?}");
        }
    }
}

#[test]
fn the_fallback_detector_refuses_wrong_notes_and_octave_harmonics_too() {
    let played = chart(&[40, 64, 51, 53, 52], 1.0);
    let mut engine = EngineConfig::default();
    // Keep the real onset detector but suppress primary pitch confirmations: every judgement
    // now has to go through the learned fallback, on the same recorded guitar audio.
    engine.tracker.max_pending_ms = 0.0;
    for (player, bank) in banks().iter().enumerate() {
        let mut take = performance(&played, bank);
        take.chart = chart(&[52; 5], 1.0);
        assert_eq!(judged_with(&take, Judging::NORMAL, &engine), [4], "recorded guitar {player}: only the actual E3 is an E3 attack");
    }
}

#[test]
fn one_recorded_pick_cannot_play_two_notes_in_overlapping_windows() {
    let played = chart(&[52], 1.0);
    for (player, bank) in banks().iter().enumerate() {
        let mut take = performance(&played, bank);
        take.chart = chart(&[52, 52], 0.08);
        let hits = judged(&take, Judging::NORMAL);
        assert_eq!(hits, [0], "recorded guitar {player}: a pick cannot be reused by the fallback detector");
    }
}

#[test]
fn two_recorded_picks_in_overlapping_windows_both_count() {
    let played = chart(&[52, 52], 0.08);
    for (player, bank) in banks().iter().enumerate() {
        let take = performance(&played, bank);
        assert_eq!(judged(&take, Judging::NORMAL), [0, 1], "recorded guitar {player}");
    }
}

#[test]
fn recorded_chords_refuse_changed_bass_third_foreign_notes_and_wrong_octaves() {
    use opensmith_game::chart::{Chord, ChordTemplate};
    let mut expected = chart(&[], 1.0);
    expected.meta.duration = 16.0; expected.phrases[0].end = 16.0;
    expected.chord_templates = vec![ChordTemplate { name: "E".into(), frets: vec![0, 2, 2, 1, 0, 0], fingers: vec![0, 2, 3, 1, 0, 0] }];
    expected.chords = (0..7).map(|k| Chord { time: 1.0 + 2.0 * k as f64, template: 0, sustain: 0.0, levels: [0, 0], strum: None, techniques: None }).collect();
    let variants = [
        vec![0, 2, 2, 1, 0, 0],       // right
        vec![1, 2, 2, 1, 0, 0],       // wrong bass
        vec![0, 2, 2, 0, 0, 0],       // minor third instead of major
        vec![0, 2, 2, 1, 1, 0],       // foreign C instead of B
        vec![12, 14, 14, 13, 12, 12], // wrong octave
        vec![0, 2, 2, 1, 0, -1],      // omitted doubling, same harmony
        vec![-1, 2, 2, 1, 0, 0],      // missing bass
    ];
    let mut played = expected.clone();
    played.chord_templates = variants.iter().enumerate().map(|(k, frets)| ChordTemplate { name: k.to_string(), frets: frets.clone(), fingers: vec![0; 6] }).collect();
    for (k, c) in played.chords.iter_mut().enumerate() { c.template = k; }
    for (player, bank) in banks().iter().enumerate() {
        let mut take = performance(&played, bank); take.chart = expected.clone();
        for judging in [Judging::NORMAL, Judging::STRICT, Judging::LENIENT] {
            let hits = judged(&take, judging);
            assert!(hits.contains(&0), "correct recorded chord, guitar {player}, {judging:?}: {hits:?}");
            assert!(!hits.iter().any(|i| [1, 2, 3, 4, 6].contains(i)), "wrong recorded chord, guitar {player}, {judging:?}: {hits:?}");
            assert!(hits.contains(&5), "an omitted doubling preserves the harmony, guitar {player}, {judging:?}: {hits:?}");
        }
    }
}

#[test]
fn recorded_palm_muted_notes_are_distinguished_from_open_ringing_notes() {
    use opensmith_game::chart::Techniques;
    let mut muted = chart(&[52, 55, 57], 1.0);
    for n in &mut muted.notes { n.sustain = 0.0; n.techniques = Some(Techniques { palm_mute: Some(true), ..Default::default() }); }
    use opensmith_dsp::guitar::{Kind, Samples};
    for (player, bank) in banks().iter().enumerate() {
        for kind in [Kind::PalmMute, Kind::Plain] {
            let mut guitar = vec![0.0; (muted.meta.duration * 48_000.0) as usize];
            for n in &muted.notes {
                let sample = bank.note(n.string as usize, n.fret as i32, kind, 0).unwrap();
                let at = (n.time * 48_000.0) as usize;
                for (dst, src) in guitar[at..].iter_mut().zip(sample.iter().take(48_000)) { *dst += *src; }
            }
            let take = Take { chart: muted.clone(), sample_rate: 48_000, guitar, anchors: vec![(0, 0.0)], input_offset: 0.0,
                levels: vec![Some(0)], score: Default::default() };
            assert_eq!(judged(&take, Judging::NORMAL), if kind == Kind::PalmMute { vec![0, 1, 2] } else { vec![] }, "raw recording {kind:?}, guitar {player}");
        }
    }
}

#[test]
fn the_first_riff_keeps_all_clean_holds_and_refuses_the_reported_wrong_chord() {
    use std::collections::{HashMap, HashSet};
    use opensmith_session::guitarist::Played;
    use opensmith_session::UiTarget;
    let chart = Chart::load(concat!(env!("CARGO_MANIFEST_DIR"), "/../../app/demo/OpenSmith - First Riff/song_chart.json")).unwrap();
    for player in [Player::clean(), Player::good()] {
        let performance = perform_with(&chart, u32::MAX, &player, 1, None);
        let events = replay(&performance.take, &EngineConfig::default(), SessionConfig::default());
        let mut items = HashMap::new(); let mut hits = HashSet::new();
        for event in &events {
            match event {
                UiEvent::Expected { items: announced, .. } => for e in announced {
                    items.insert(e.index, (matches!(e.target, UiTarget::Chord { .. }), e.event));
                },
                UiEvent::Hit { index, .. } => { hits.insert(items[index]); },
                _ => {}
            }
        }
        if player.name == "clean" { assert_eq!(hits.len(), 70, "all clean notes including polyphonic holds count"); }
        else {
            let wrong: Vec<_> = performance.truth.iter().filter(|(chord, _, played)| *chord && matches!(played, Played::Wrong { .. })).collect();
            assert!(!wrong.is_empty(), "exercise the originally accepted wrong chord");
            for &(chord, event, _) in wrong { assert!(!hits.contains(&(chord, event)), "a wrong chord still scored"); }
        }
    }
}
