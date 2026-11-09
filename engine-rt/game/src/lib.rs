//! OpenSmith game core: loads a chart (schema/chart.schema.json), judges what the player plays
//! against it, keeps score and streak, and adapts each phrase's difficulty to the player.
//!
//! It knows nothing about audio: the engine feeds it note attacks from the tracker
//! (`on_note`, `on_strum`) and chord-verifier results (`on_chord`), and moves its clock
//! (`advance`).

pub mod chart;
pub mod game;
mod performance;

pub use chart::{Chart, ChartError};
pub use game::{Expected, Game, GameConfig, Judgement, MissReason, Score, Status, Target};

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    /// Phrases A B A B of 2 s; each has notes appearing at levels 0, 1 and 2.
    fn chart_json() -> String {
        let mut notes = Vec::new();
        let mut phrases = Vec::new();
        for (k, name) in ["A", "B", "A", "B"].iter().enumerate() {
            let t0 = k as f64 * 2.0;
            phrases.push(format!(r#"{{"name":"{name}","start":{t0},"end":{},"maxDifficulty":2}}"#, t0 + 2.0));
            for (j, lvl) in [0, 1, 2, 1].iter().enumerate() {
                let fret = if *name == "A" { 3 + j } else { 5 + j };
                notes.push(format!(
                    r#"{{"time":{},"string":1,"fret":{fret},"sustain":0.0,"levels":[{lvl},2]}}"#,
                    t0 + 0.25 + j as f64 * 0.4
                ));
            }
        }
        format!(
            r#"{{"format":"opensmith-chart","version":1,
            "meta":{{"title":"T","artist":"A","album":null,"year":null,"duration":8.0,"source":{{"kind":"audio","file":"x"}},"generator":"test"}},
            "audio":{{"backing":null,"guitar":null,"mix":null,"offset":0.0}},
            "arrangement":{{"name":"Lead","type":"lead","tuning":{{"name":"E Standard","strings":[40,45,50,55,59,64]}},"capo":0,"maxDifficulty":2}},
            "tempo":{{"bpm":120.0,"timeSignature":[4,4]}},
            "beats":[{{"time":0.0,"bar":1}}],"sections":[],"phrases":[{}],"chordTemplates":[],
            "notes":[{}],"chords":[],"anchors":[],"handShapes":[]}}"#,
            phrases.join(","),
            notes.join(",")
        )
    }

    fn game(cfg: GameConfig) -> Game {
        Game::new(Chart::from_json(&chart_json()).unwrap(), cfg)
    }

    /// Plays every visible note at its time + `delay`, with pitch shifted by `shift`.
    fn play(g: &mut Game, delay: f64, shift: i32) -> Vec<Judgement> {
        let mut out = Vec::new();
        let mut played = 0;
        let mut now = 0.0;
        while now < 10.0 {
            now += 0.01;
            out.extend(g.advance(now));
            let todo: Vec<(f64, i32)> = g.expected()[played..]
                .iter()
                .take_while(|e| e.time + delay <= now)
                .map(|e| match e.target {
                    Target::Note { midi, .. } => (e.time + delay, midi + shift),
                    Target::Chord { .. } => unreachable!(),
                })
                .collect();
            for (t, m) in todo {
                played += 1;
                out.extend(g.on_note(t, m));
            }
        }
        out
    }

    #[test]
    fn perfect_play_hits_everything_and_builds_a_streak() {
        let mut g = game(GameConfig { dynamic_difficulty: false, start_level: 2, ..GameConfig::default() });
        play(&mut g, 0.0, 0);
        let s = g.score();
        assert_eq!((s.hits, s.misses, s.perfects, s.best_streak), (16, 0, 16, 16));
        assert_eq!(s.accuracy(), 1.0);
        assert!(s.points > 16 * 150);
    }

    #[test]
    fn the_autopilot_plays_every_note_on_time() {
        let mut g = game(GameConfig { dynamic_difficulty: false, start_level: 2, input_offset: 0.05, ..GameConfig::default() });
        let mut now = 0.0;
        let mut hits = Vec::new();
        while now < 10.0 {
            now += 0.01;
            hits.extend(g.autoplay(now));
            g.advance(now);
        }
        let s = g.score();
        assert_eq!((s.hits, s.misses, s.perfects), (16, 0, 16));
        assert!(hits.iter().all(|j| matches!(j, Judgement::Hit { error, .. } if *error == 0.0)));
    }

    #[test]
    fn the_difficulty_changes_from_the_next_phrase_in_mid_song() {
        let run = |g: &mut Game, from: f64, to: f64| {
            let mut now = from;
            while now < to {
                now += 0.01;
                g.autoplay(now);
                g.advance(now);
            }
        };
        let levels = |g: &Game| (0..4).map(|k| g.iteration_level(k)).collect::<Vec<_>>();

        // Dynamic from level 0, then every note: the two phrases already shown stay as they were.
        let mut g = game(GameConfig::default());
        run(&mut g, 0.0, 0.5);
        g.set_difficulty(false, 2);
        run(&mut g, 0.5, 10.0);
        assert_eq!(levels(&g), [Some(0), Some(0), Some(2), Some(2)]);
        assert_eq!(g.score().hits, 1 + 1 + 4 + 4);

        // Fixed, then back to dynamic difficulty: each phrase from the level it had learnt.
        let mut g = game(GameConfig { dynamic_difficulty: false, start_level: 2, ..GameConfig::default() });
        g.set_levels(HashMap::from([("A".to_string(), 1)]));
        run(&mut g, 0.0, 0.5);
        g.set_difficulty(true, 0);
        run(&mut g, 0.5, 10.0);
        assert_eq!(levels(&g), [Some(2), Some(2), Some(1), Some(0)]);
    }

    #[test]
    fn timing_windows() {
        let mut g = game(GameConfig { dynamic_difficulty: false, start_level: 2, ..GameConfig::default() });
        let js = play(&mut g, 0.07, 0);
        let s = g.score();
        assert_eq!((s.hits, s.perfects), (16, 0), "70 ms late: good, not perfect");
        assert!(js.iter().all(|j| !matches!(j, Judgement::Hit { error, .. } if (error - 0.07).abs() > 1e-9)));
        let mut late = game(GameConfig { dynamic_difficulty: false, start_level: 2, ..GameConfig::default() });
        play(&mut late, 0.15, 0);
        assert_eq!((late.score().hits, late.score().misses), (0, 16));
        let mut wrong = game(GameConfig { dynamic_difficulty: false, start_level: 2, ..GameConfig::default() });
        play(&mut wrong, 0.0, 1);
        assert_eq!((wrong.score().hits, wrong.score().misses, wrong.score().extras), (0, 16, 16));
    }

    #[test]
    fn input_offset_compensates_latency() {
        let mut g = game(GameConfig { dynamic_difficulty: false, start_level: 2, input_offset: 0.15, ..GameConfig::default() });
        play(&mut g, 0.15, 0);
        assert_eq!(g.score().hits, 16);
    }

    #[test]
    fn dynamic_difficulty_follows_the_player() {
        // Phrases here last 2 s: a short lookahead lets each run decide the next iteration's
        // level (a level is fixed once the phrase is visible).
        let mut g = game(GameConfig { lookahead: 0.5, ..GameConfig::default() });
        let js = play(&mut g, 0.0, 0);
        let done: Vec<(String, u32, u32)> = js
            .iter()
            .filter_map(|j| match j {
                Judgement::PhraseDone { name, level, next_level, .. } => Some((name.clone(), *level, *next_level)),
                _ => None,
            })
            .collect();
        // Perfect runs: A and B start at level 0 and are played at level 1 the second time.
        assert_eq!(done, vec![("A".into(), 0, 1), ("B".into(), 0, 1), ("A".into(), 1, 2), ("B".into(), 1, 2)]);
        assert_eq!(g.iteration_level(2), Some(1));
        assert_eq!(g.score().hits, 1 + 1 + 3 + 3);

        let mut bad = game(GameConfig { start_level: 2, lookahead: 0.5, ..GameConfig::default() });
        play(&mut bad, 0.0, 1);
        assert_eq!((bad.level("A"), bad.level("B")), (0, 0));
    }

    #[test]
    fn invalid_charts_are_rejected() {
        assert!(Chart::from_json(&chart_json().replace("opensmith-chart", "other")).is_err());
        assert!(Chart::from_json("{}").is_err());
    }
}
