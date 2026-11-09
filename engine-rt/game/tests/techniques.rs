//! What is judged when a note has no pitch to check (dead notes, muted strums, pinch
//! harmonics), what a natural harmonic sounds, and a guitar a little out of tune.

use opensmith_game::{Chart, Game, GameConfig, Judgement, MissReason, Status};

/// E standard, one note or chord per second from 1 s: `notes` and `chords` as JSON objects
/// without their time (given in order).
fn game(notes: &[&str], chords: &[&str]) -> Game {
    game_every(1.0, notes, chords)
}

/// Same, one every `step` seconds.
fn game_every(step: f64, notes: &[&str], chords: &[&str]) -> Game {
    let at = |k: usize| 1.0 + step * k as f64;
    let notes: Vec<String> = notes.iter().enumerate().map(|(k, n)| format!(r#"{{"time":{},{n},"sustain":0.0,"levels":[0,0]}}"#, at(k))).collect();
    let first_chord = notes.len();
    let chords: Vec<String> =
        chords.iter().enumerate().map(|(k, c)| format!(r#"{{"time":{},"template":0,"sustain":0.0,"levels":[0,0]{c}}}"#, at(first_chord + k))).collect();
    let json = format!(
        r#"{{"format":"opensmith-chart","version":1,
        "meta":{{"title":"T","artist":"A","album":null,"year":null,"duration":20.0,"source":{{"kind":"audio","file":"x"}},"generator":"test"}},
        "audio":{{"backing":null,"guitar":null,"mix":null,"offset":0.0}},
        "arrangement":{{"name":"Rhythm","type":"rhythm","tuning":{{"name":"E Standard","strings":[40,45,50,55,59,64]}},"capo":0,"maxDifficulty":0}},
        "tempo":{{"bpm":120.0,"timeSignature":[4,4]}},
        "beats":[{{"time":0.0,"bar":1}}],"sections":[],
        "phrases":[{{"name":"A","start":0.0,"end":20.0,"maxDifficulty":0}}],
        "chordTemplates":[{{"name":"E5","frets":[0,2,2,-1,-1,-1],"fingers":[0,1,1,-1,-1,-1]}}],
        "notes":[{}],"chords":[{}],"anchors":[],"handShapes":[]}}"#,
        notes.join(","),
        chords.join(",")
    );
    let mut g = Game::new(Chart::from_json(&json).unwrap(), GameConfig { dynamic_difficulty: false, ..GameConfig::default() });
    g.activate_all();
    g
}

fn hits(js: impl IntoIterator<Item = Judgement>) -> usize {
    js.into_iter().filter(|j| matches!(j, Judgement::Hit { .. })).count()
}

#[test]
fn a_dead_note_is_played_by_its_attack_whatever_the_pitch() {
    let dead = r#""string":0,"fret":5,"techniques":{"mute":true}"#;
    let mut g = game(&[dead, dead], &[]);
    assert!(g.expected().iter().all(|e| e.attack_only));
    assert_eq!(hits(g.on_note(1.01, 70)), 1, "a pitch the tracker made up from the noise");
    assert_eq!(hits(g.on_strum(1.98)), 1, "an attack without a pitch");
    assert_eq!(g.score().extras, 0);
}

#[test]
fn a_natural_harmonic_is_judged_at_the_pitch_it_sounds() {
    // Low E: the 7th-fret node sounds B3 (E2 + 19), the 5th-fret node E4 (+24).
    let at = |fret: u8| format!(r#""string":0,"fret":{fret},"techniques":{{"harmonic":true}}"#);
    let (seven, five) = (at(7), at(5));
    let mut g = game(&[&seven, &five], &[]);
    assert_eq!(hits(g.on_note(1.0, 59)), 1);
    assert_eq!(hits(g.on_note(2.0, 45)), 0, "the fretted A2 is not the harmonic");
    let misses: Vec<Judgement> = g.advance(5.0);
    assert!(misses.contains(&Judgement::Miss { index: 1, time: 2.0, reason: MissReason::Pitch { semitones: -19 } }), "{misses:?}");
}

#[test]
fn a_pinch_harmonic_is_judged_on_its_attack() {
    let mut g = game(&[r#""string":2,"fret":5,"techniques":{"pinchHarmonic":true}"#], &[]);
    assert_eq!(hits(g.on_note(1.02, 91)), 1);
}

#[test]
fn a_muted_strum_is_not_sent_to_the_chord_verifier() {
    let mut g = game(&[], &[r#","techniques":{"mute":true}"#, ""]);
    let ready: Vec<usize> = g.chords_ready(10.0, 0.09).into_iter().map(|c| c.0).collect();
    assert_eq!(ready, [1], "only the chord that sounds");
    assert_eq!(hits(g.on_strum(0.97)), 1, "a strum plays the muted one");
    assert_eq!(g.expected()[0].status, Status::Hit);
}

#[test]
fn a_muted_strum_missed_says_why() {
    let mut g = game(&[], &[r#","techniques":{"mute":true}"#, r#","techniques":{"mute":true}"#]);
    g.on_strum(0.75);
    let js = g.advance(10.0);
    let reasons: Vec<MissReason> = js.iter().filter_map(|j| if let Judgement::Miss { reason, .. } = j { Some(*reason) } else { None }).collect();
    assert_eq!(reasons.len(), 2);
    assert!(matches!(reasons[0], MissReason::Timing { error } if (error + 0.25).abs() < 1e-9), "{reasons:?}");
    assert_eq!(reasons[1], MissReason::Unplayed);
}

#[test]
fn a_guitar_going_out_of_tune_is_still_judged_right() {
    // G2 twelve times, the guitar sinking from 30 to 65 cents flat: each reading alone would be
    // F#2 past the half; the drift learnt from the notes hit keeps them G2.
    let g2 = r#""string":0,"fret":3"#;
    let mut g = game(&[g2; 12], &[]);
    let played = (0..12).map(|k| g.on_pitch(k as f64 + 1.0, 43.0 - 0.30 - 0.035 * k as f64)).filter(|j| matches!(j, Some(Judgement::Hit { .. }))).count();
    assert_eq!(played, 12);
    // A wrong note stays wrong: a full semitone off is no drift.
    let mut g = game(&[g2], &[]);
    assert_eq!(hits(g.on_pitch(1.0, 44.05)), 0);
}

#[test]
fn wrong_notes_and_octaves_are_refused() {
    let g2 = r#""string":0,"fret":3"#;
    for shift in -24..=24 {
        let mut g = game(&[g2], &[]);
        assert_eq!(hits(g.on_note(1.0, 43 + shift)), usize::from(shift == 0), "pitch shifted {shift} semitones");
        g.advance(3.0);
        assert_eq!(g.score().misses, u32::from(shift != 0));
    }
    // G2 then G3, 80 ms apart: G3 heard right after G2 plays G3, not the nearer G2.
    let g3 = r#""string":0,"fret":15"#;
    let mut g = game_every(0.08, &[g2, g3], &[]);
    assert!(matches!(g.on_note(1.03, 55), Some(Judgement::Hit { index: 1, .. })));
}

#[test]
fn the_same_attack_cannot_be_scored_again_by_another_detector() {
    let e3 = r#""string":2,"fret":2"#;
    let mut g = game_every(0.08, &[e3, e3], &[]);
    assert_eq!(hits(g.on_note(1.0, 52)), 1);
    assert_eq!(hits(g.on_note(1.0, 52)), 0, "a repeated pitch report is still the same attack");
    assert_eq!(hits(g.on_note_heard(1, true, Some(1.0))), 0, "the neural detector cannot reuse the tracker's attack");
    g.advance(3.0);
    assert_eq!((g.score().hits, g.score().misses), (1, 1));

    let mut g = game_every(0.08, &[e3, e3], &[]);
    assert_eq!(hits(g.on_note_heard(0, true, Some(1.0))), 1);
    assert_eq!(hits(g.on_note(1.0, 52)), 0, "the tracker cannot reuse the neural detector's attack either");
    assert_eq!(hits(g.on_note(1.08, 52)), 1, "a real second attack still counts");
}

#[test]
fn attack_claims_allow_for_latency_and_are_cleared_on_restart() {
    let e3 = r#""string":2,"fret":2"#;
    let mut g = game_every(0.08, &[e3, e3], &[]);
    g.set_input_offset(0.05);
    assert_eq!(hits(g.on_note(1.05, 52)), 1);
    assert_eq!(hits(g.on_note_heard(1, true, Some(1.051))), 0, "detectors may date the same compensated attack slightly differently");
    g.restart_at(0.0);
    assert_eq!(hits(g.on_note(1.05, 52)), 1, "a retry starts a new performance");
}

#[test]
fn a_strum_may_brush_the_open_strings_next_to_its_chord() {
    let json = r#"{"format":"opensmith-chart","version":1,
        "meta":{"title":"T","artist":"A","album":null,"year":null,"duration":4.0,"source":{"kind":"audio","file":"x"},"generator":"test"},
        "audio":{"backing":null,"guitar":null,"mix":null,"offset":0.0},
        "arrangement":{"name":"Lead","type":"lead","tuning":{"name":"E Standard","strings":[40,45,50,55,59,64]},"capo":0,"maxDifficulty":0},
        "tempo":{"bpm":120.0,"timeSignature":[4,4]},"beats":[{"time":0.0,"bar":1}],"sections":[],
        "phrases":[{"name":"A","start":0.0,"end":4.0,"maxDifficulty":0}],
        "chordTemplates":[
          {"name":"A5","frets":[-1,0,2,2,-1,-1],"fingers":[-1,0,1,2,-1,-1]},
          {"name":"E","frets":[0,2,2,1,0,0],"fingers":[0,2,3,1,0,0]},
          {"name":"D","frets":[-1,-1,0,2,3,2],"fingers":[-1,-1,0,1,3,2]}],
        "notes":[],"chords":[],"anchors":[],"handShapes":[]}"#;
    let chart = opensmith_game::Chart::from_json(json).unwrap();
    // The low E below, the B above; nothing outside a six-string chord; only the A next to D's.
    assert_eq!(chart.brushable(0), vec![40, 59]);
    assert!(chart.brushable(1).is_empty());
    assert_eq!(chart.brushable(2), vec![45]);
}

#[test]
fn the_strings_of_one_strum_cannot_score_another_chord() {
    let mut g = game_every(0.08, &[], &["", ""]);
    assert_eq!(hits(g.on_chord(0, true, Some(1.0))), 1);
    assert_eq!(hits(g.on_chord(1, true, Some(1.025))), 0, "a later string in the same strum");
    assert_eq!(hits(g.on_chord(1, true, Some(1.08))), 1, "a new strum still counts");
}
