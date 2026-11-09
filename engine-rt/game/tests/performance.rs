use opensmith_game::{Chart, Game, GameConfig, Judgement, Status};
use opensmith_game::chart::Techniques;

fn game(techniques: Techniques, sustain: f64) -> Game {
    let mut c = Chart::from_json(include_str!("fixtures/demo_rock.json")).unwrap();
    c.chords.clear(); c.notes.truncate(1);
    c.notes[0].time = 1.0; c.notes[0].string = 2; c.notes[0].fret = 5;
    c.notes[0].sustain = sustain; c.notes[0].levels = [0, 4]; c.notes[0].techniques = Some(techniques);
    let mut g = Game::new(c, GameConfig { dynamic_difficulty: false, ..GameConfig::default() });
    g.activate_all(); g
}

fn play(t: Techniques, sustain: f64, pitch: impl Fn(f64) -> Option<f64>, level: impl Fn(f64) -> f32) -> Game {
    let mut g = game(t, sustain);
    assert!(g.on_note(1.0, 55).is_none(), "an attack is not proof of a performance");
    assert!(!g.attack_available(1.0), "reserve the attack before final scoring");
    for k in 1..=120 {
        let at = k as f64 * 0.01;
        if let Some(p) = pitch(at) { g.observe_pitch(1.0 + at, p); }
        g.observe_level(1.0 + at, level(at));
        g.advance(1.0 + at);
    }
    g.advance(100.0); g
}
fn hit(g: &Game) -> bool { g.expected()[0].status == Status::Hit }

#[test]
fn sustain_requires_audible_correct_pitch_throughout_the_note() {
    assert!(hit(&play(Techniques::default(), 0.6, |_| Some(55.0), |_| -20.0)));
    assert!(!hit(&play(Techniques::default(), 0.6, |t| (t < 0.1).then_some(55.0), |_| -90.0)));
    assert!(!hit(&play(Techniques::default(), 0.6, |t| Some(if t < 0.1 { 55.0 } else { 67.0 }), |_| -20.0)));
}

#[test]
fn bends_need_the_requested_amount_and_a_trajectory() {
    let bend = Techniques { bend: Some(2.0), ..Default::default() };
    for amount in [0.0, 1.0, 2.0, 14.0] {
        let g = play(bend.clone(), 0.6, |t| Some(55.0 + amount * (t / 0.4).min(1.0)), |_| -20.0);
        assert_eq!(hit(&g), amount == 2.0, "bend {amount}");
    }
    assert!(!hit(&play(bend, 0.6, |t| Some(if t < 0.2 { 55.0 } else { 57.0 }), |_| -20.0)), "jumping straight to another note is not bending");
}

#[test]
fn slides_are_checked_in_both_directions() {
    for (fret, shift) in [(9, 4.0), (0, -5.0)] {
        let slide = Techniques { slide_to: Some(fret), ..Default::default() };
        assert!(hit(&play(slide.clone(), 0.6, |t| Some(55.0 + shift * (t / 0.45).min(1.0)), |_| -20.0)));
        assert!(!hit(&play(slide, 0.6, |_| Some(55.0), |_| -20.0)));
    }
}

#[test]
fn vibrato_requires_repeated_pitch_modulation_not_a_straight_note() {
    let vib = Techniques { vibrato: Some(true), ..Default::default() };
    assert!(hit(&play(vib.clone(), 0.6, |t| Some(55.0 + 0.22 * (std::f64::consts::TAU * 5.0 * t).sin()), |_| -20.0)));
    assert!(!hit(&play(vib, 0.6, |_| Some(55.0), |_| -20.0)));
}

#[test]
fn palm_mute_requires_a_pitched_attack_with_fast_damping() {
    let pm = Techniques { palm_mute: Some(true), ..Default::default() };
    assert!(hit(&play(pm.clone(), 0.0, |t| (t < 0.14).then_some(55.0), |t| -15.0 - 160.0 * t as f32)));
    assert!(!hit(&play(pm.clone(), 0.0, |_| Some(55.0), |_| -20.0)), "an open ringing note is not muted");
    assert!(!hit(&play(pm, 0.0, |_| None, |t| -15.0 - 200.0 * t as f32)), "a dead click is not palm mute");
}

#[test]
fn reserved_attacks_and_evidence_are_cleared_on_restart() {
    let mut g = game(Techniques::default(), 0.6);
    g.on_note(1.0, 55); g.restart_at(0.0);
    assert!(g.attack_available(1.0));
    assert!(g.on_note(1.0, 55).is_none());
    let events = g.advance(100.0);
    assert!(!events.iter().any(|e| matches!(e, Judgement::Hit { .. })), "old evidence must not validate a new attempt");
}

#[test]
fn small_bends_still_require_pitch_motion() {
    for amount in [0.25, 0.5, 1.0] {
        let bend = Techniques { bend: Some(amount), ..Default::default() };
        assert!(hit(&play(bend.clone(), 0.6, |t| Some(55.0 + amount as f64 * (t / 0.4).min(1.0)), |_| -20.0)));
        assert!(!hit(&play(bend, 0.6, |_| Some(55.0), |_| -20.0)), "straight note for a {amount}-semitone bend");
    }
}

#[test]
fn a_failed_waiting_attempt_can_be_replayed_without_missing_future_notes() {
    let mut g = game(Techniques::default(), 0.6);
    g.on_note(1.0, 55);
    assert!(g.finish_waiting(0, 1.0).is_none());
    assert!(g.attack_available(1.0));
    assert_eq!(g.score().misses, 0);
    g.on_note(1.0, 55);
    for k in 2..=60 { g.observe_pitch(1.0 + k as f64 * 0.01, 55.0); }
    assert!(matches!(g.finish_waiting(0, 1.0), Some(Judgement::Hit { error: 0.0, .. })));
    assert_eq!((g.score().hits, g.score().misses), (1, 0));
}
