//! Plays charts with the virtual guitarist, replays the takes through the engine and says how
//! fairly the game judged, by kind of playing (right notes, chords short of a string, wrong
//! notes, out of time, left out):
//!
//! cargo run --release -p opensmith-session --bin opensmith-simulate -- [--player clean|good|beginner|all] [--level N] [--songs N] [--seed N] <chart or folder>…
//!
//! `--real-notes <folder>` plays the virtual guitarist on notes recorded from real guitars (takes
//! of single notes, see `samples`) instead of synthesised ones.
//!
//! `--takes <folder>` judges real playing instead (takes whose chart is what was played), as
//! played and with mistakes written into the chart.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use opensmith_audio::EngineConfig;
use opensmith_dsp::synth::Pcg32;
use opensmith_game::chart::Note;
use opensmith_game::Chart;
use opensmith_session::guitarist::{perform_with, Played, Player};
use opensmith_session::samples::SampleBank;
use opensmith_session::replay::{replay, Agreement};
use opensmith_session::{Judging, SessionConfig, Take};

/// Real playing whose chart says what was played (`--takes`), altered so that some of it becomes
/// mistakes without touching the sound: a note moved a semitone (a wrong note), a note moved
/// 200 ms (out of time), a note added where nothing was played (left out). The truth of each
/// expected item comes with it.
fn with_mistakes(take: &Take, seed: u64) -> (Chart, Vec<(bool, usize, Played)>) {
    let mut rng = Pcg32::new(seed);
    let mut chart = take.chart.clone();
    let mut truth = Vec::new();
    let times: Vec<f64> = chart.notes.iter().map(|n| n.time).chain(chart.chords.iter().map(|c| c.time)).collect();
    let free = |t: f64| times.iter().all(|&u| (u - t).abs() > 0.6);
    let count = chart.notes.len();
    for i in 0..count {
        let r = rng.uniform();
        let n = &mut chart.notes[i];
        let plain = n.techniques.as_ref().is_none_or(|t| t.harmonic != Some(true) && t.pinch_harmonic != Some(true));
        let played = if r < 0.12 && plain && n.fret >= 1 && n.fret < 24 {
            let up = rng.uniform() < 0.5;
            n.fret = if up { n.fret + 1 } else { n.fret - 1 };
            // The chart now asks for the fret next to the one played.
            Played::Wrong { semitones: if up { -1 } else { 1 } }
        } else if r < 0.22 {
            let shift = if rng.uniform() < 0.5 { -0.2 } else { 0.2 };
            n.time += shift;
            Played::OffTime { error: -shift }
        } else {
            Played::Clean
        };
        truth.push((false, i, played));
    }
    for i in 0..chart.chords.len() {
        truth.push((true, i, Played::Clean));
    }
    // Notes asked for where nothing was played: one in ten, in the gaps.
    let span = take.span();
    let wanted = count / 10;
    let mut tries = 0;
    while chart.notes.len() < count + wanted && tries < 50 * wanted.max(1) {
        tries += 1;
        let t = span.0 + 1.0 + rng.uniform() as f64 * (span.1 - span.0 - 2.0);
        if !free(t) || chart.notes[count..].iter().any(|n| (n.time - t).abs() < 0.6) {
            continue;
        }
        let model = &take.chart.notes[(rng.next_u32() as usize) % count.max(1)];
        chart.notes.push(Note { time: t, string: model.string, fret: model.fret, sustain: 0.3, levels: model.levels, techniques: None });
        truth.push((false, chart.notes.len() - 1, Played::Skipped));
    }
    (chart, truth)
}

/// Takes under `path`: itself, or the folders in it holding one.
fn takes_in(path: &Path) -> Vec<PathBuf> {
    if path.join("take.json").is_file() {
        return vec![path.to_path_buf()];
    }
    let mut found: Vec<PathBuf> = std::fs::read_dir(path)
        .map(|d| d.flatten().map(|e| e.path()).filter(|p| p.join("take.json").is_file()).collect())
        .unwrap_or_default();
    found.sort();
    found
}

/// The real takes judged as played, then with mistakes written into their charts.
fn real(paths: &[PathBuf], each: bool, cfg: SessionConfig) {
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get()).saturating_sub(2).max(1);
    let total = Mutex::new(Agreement::default());
    let next = Mutex::new(0usize);
    std::thread::scope(|scope| {
        for _ in 0..threads {
            scope.spawn(|| loop {
                let k = {
                    let mut n = next.lock().unwrap();
                    *n += 1;
                    *n - 1
                };
                let Some(path) = paths.get(k) else { break };
                let Ok(take) = Take::load(path) else { continue };
                let (chart, truth) = with_mistakes(&take, k as u64 + 1);
                let altered = Take { chart: chart.clone(), guitar: take.guitar.clone(), anchors: take.anchors.clone(), ..take };
                let events = replay(&altered, &EngineConfig::default(), cfg);
                let one = Agreement::of(&truth, &events, &chart);
                if each {
                    let (right, wrong) = one.fairness();
                    println!("  {:>5.1} % compté, {:>5.1} % refusé : {}", 100.0 * right, 100.0 * wrong, path.display());
                }
                total.lock().unwrap().add(&one);
            });
        }
    });
    let total = total.into_inner().unwrap();
    let items: usize = total.rows.iter().map(|r| r.2).sum();
    println!("vrai jeu — {} prises, {items} notes et accords", paths.len());
    println!("{total}");
}

/// Charts under `path`: itself, or the song folders in it (every arrangement).
fn charts(path: &Path, out: &mut Vec<PathBuf>) {
    if path.is_file() {
        out.push(path.to_path_buf());
        return;
    }
    let Ok(dir) = std::fs::read_dir(path) else { return };
    let mut entries: Vec<PathBuf> = dir.flatten().map(|e| e.path()).collect();
    entries.sort();
    for p in entries {
        let name = p.file_name().unwrap_or_default().to_string_lossy().to_string();
        if p.is_dir() && !name.starts_with('.') {
            charts(&p, out);
        } else if name.starts_with("song_chart") && name.ends_with(".json") {
            out.push(p);
        }
    }
}

fn main() {
    let mut args = std::env::args().skip(1);
    let (mut players, mut level, mut songs, mut seed, mut paths) = (vec![Player::good()], u32::MAX, 20usize, 1u64, Vec::new());
    let mut each = false;
    let mut cfg = SessionConfig::default();
    let mut takes: Vec<PathBuf> = Vec::new();
    let mut bank: Option<SampleBank> = None;
    while let Some(a) = args.next() {
        let mut value = || args.next().unwrap_or_default();
        match a.as_str() {
            "--player" => {
                let v = value();
                players = if v == "all" { vec![Player::clean(), Player::good(), Player::beginner()] } else { Player::by_name(&v).into_iter().collect() };
            }
            "--level" => level = value().parse().unwrap_or(u32::MAX),
            "--songs" => songs = value().parse().unwrap_or(20),
            "--seed" => seed = value().parse().unwrap_or(1),
            "--each" => each = true,
            // A preset (strict, normal, lenient) or its values: hit window, chord share, heard, foreign.
            "--judging" => {
                let v = value();
                let numbers: Vec<f64> = v.split(',').filter_map(|x| x.parse().ok()).collect();
                let judging = match numbers[..] {
                    [hit_window, share, heard, foreign] => Some(Judging { hit_window, chord_share: share as f32, heard: heard as f32, foreign: foreign as f32 }),
                    _ => Judging::by_name(&v),
                };
                match judging {
                    Some(j) => {
                        cfg.judging = j;
                        cfg.game.hit_window = j.hit_window;
                    }
                    None => eprintln!("--judging : strict, normal, lenient, ou fenêtre,part,entendue,étrangère"),
                }
            }
            "--takes" => takes.extend(takes_in(Path::new(&value()))),
            "--real-notes" => {
                let dir = value();
                match SampleBank::from_takes(Path::new(&dir)) {
                    Ok(b) => {
                        println!("{} notes enregistrées", b.len());
                        bank = Some(b);
                    }
                    Err(e) => eprintln!("{dir} : {e}"),
                }
            }
            _ => charts(Path::new(&a), &mut paths),
        }
    }
    if !takes.is_empty() {
        real(&takes, each, cfg);
        if paths.is_empty() {
            return;
        }
    }
    if paths.is_empty() || players.is_empty() {
        eprintln!("usage : opensmith-simulate [--player clean|good|beginner|all] [--level N] [--songs N] [--seed N] <partition ou dossier>…");
        std::process::exit(2);
    }
    // An even sample of the charts, the same from one run to the next.
    let step = (paths.len() as f64 / songs as f64).max(1.0);
    let picked: Vec<PathBuf> = (0..songs.min(paths.len())).map(|k| paths[(k as f64 * step) as usize].clone()).collect();
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get()).saturating_sub(2).max(1);
    for player in &players {
        let total = Mutex::new(Agreement::default());
        let next = Mutex::new(0usize);
        std::thread::scope(|scope| {
            for _ in 0..threads {
                scope.spawn(|| loop {
                    let k = {
                        let mut n = next.lock().unwrap();
                        *n += 1;
                        *n - 1
                    };
                    let Some(path) = picked.get(k) else { break };
                    let Ok(chart) = Chart::load(path) else { continue };
                    if chart.arrangement.tuning.strings.len() != 6 {
                        continue;
                    }
                    let samples = bank.as_ref().map(|b| b as &dyn opensmith_dsp::guitar::Samples);
                    let perf = perform_with(&chart, level, player, seed.wrapping_add(k as u64), samples);
                    let events = replay(&perf.take, &EngineConfig::default(), cfg);
                    let one = Agreement::of(&perf.truth, &events, &chart);
                    if each {
                        let (right, wrong) = one.fairness();
                        let n: usize = one.rows.iter().map(|r| r.2).sum();
                        println!("  {:>5.1} % compté, {:>5.1} % refusé, {n:>5} : {}", 100.0 * right, 100.0 * wrong, path.display());
                    }
                    total.lock().unwrap().add(&one);
                });
            }
        });
        let total = total.into_inner().unwrap();
        let items: usize = total.rows.iter().map(|r| r.2).sum();
        println!("joueur {} — {} partitions, {items} notes et accords", player.name, picked.len());
        println!("{total}");
    }
}
