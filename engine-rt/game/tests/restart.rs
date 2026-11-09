//! Seeking and retrying: judging restarts from a song time, the phrase levels learnt are kept.

use opensmith_game::{Chart, Game, GameConfig, Status, Target};

fn chart() -> Chart {
    Chart::load(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/demo_rock.json")).unwrap()
}

/// A flawless player: every note and chord exactly on time, until song time `until`.
fn play_perfectly(game: &mut Game, from: f64, until: f64) {
    let mut t = from;
    while t < until {
        t += 0.005;
        let due: Vec<(usize, f64, Target)> = game
            .expected()
            .iter()
            .enumerate()
            .filter(|(_, e)| e.status == Status::Pending && e.time <= t)
            .map(|(i, e)| (i, e.time, e.target.clone()))
            .collect();
        for (index, time, target) in due {
            match target {
                Target::Note { midi, .. } => drop(game.on_note(time, midi)),
                Target::Chord { .. } => drop(game.on_chord(index, true, Some(time))),
            }
        }
        game.autoplay(t);
        game.advance(t);
    }
}

#[test]
fn expected_notes_point_back_to_their_chart_events() {
    let chart = chart();
    let mut game = Game::new(chart.clone(), GameConfig { start_level: 4, ..GameConfig::default() });
    game.activate_all();
    for e in game.expected() {
        match &e.target {
            Target::Note { string, fret, .. } => {
                let n = &chart.notes[e.event];
                assert_eq!((n.time, n.string, n.fret), (e.time, *string, *fret));
            }
            Target::Chord { template, .. } => {
                let c = &chart.chords[e.event];
                assert_eq!((c.time, c.template), (e.time, *template));
            }
        }
    }
}

#[test]
fn restarting_skips_what_came_before_and_keeps_the_levels() {
    let chart = chart();
    let b = chart.phrases.iter().position(|p| p.name == "B").unwrap();
    let mut game = Game::new(chart.clone(), GameConfig::default());
    play_perfectly(&mut game, -1.0, chart.phrases[b].end + 0.5);
    let (level_a, level_b) = (game.level("A"), game.level("B"));
    assert_eq!((level_a, level_b), (1, 1), "one clean pass of A and B");
    assert!(game.score().hits > 0);

    let t = chart.phrases[b].start + 1.0;
    game.restart_at(t);
    assert!(game.expected().is_empty());
    assert_eq!(game.score().hits, 0);
    play_perfectly(&mut game, t, chart.meta.duration + 1.0);
    assert!(game.expected().iter().all(|e| e.time >= t));
    assert!(game.expected().iter().all(|e| e.status == Status::Hit));
    assert_eq!(game.iteration_level(b), Some(level_b), "the restarted phrase plays at the level learnt");
    assert_eq!(game.level("A"), level_a + 1, "and the next A climbs from there");
}
