//! Replays takes (what the guitar played during songs, recorded by the app) through the engine
//! as it is now, and compares with what the live game counted:
//!
//! cargo run --release -p opensmith-session --bin opensmith-replay -- <take or folder of takes>…

use std::path::{Path, PathBuf};

use opensmith_audio::EngineConfig;
use opensmith_session::replay::{replay, Report};
use opensmith_session::{SessionConfig, Take};

/// The takes under `path`: itself, or the folders in it holding one.
fn takes(path: &Path) -> Vec<PathBuf> {
    if path.join("take.json").is_file() {
        return vec![path.to_path_buf()];
    }
    let mut found: Vec<PathBuf> = std::fs::read_dir(path)
        .map(|d| d.flatten().map(|e| e.path()).filter(|p| p.join("take.json").is_file()).collect())
        .unwrap_or_default();
    found.sort();
    found
}

fn main() {
    let paths: Vec<PathBuf> = std::env::args().skip(1).map(PathBuf::from).flat_map(|p| takes(&p)).collect();
    if paths.is_empty() {
        eprintln!("usage : opensmith-replay <prise ou dossier de prises>…");
        std::process::exit(2);
    }
    let (mut live_hits, mut live_judged, mut total) = (0usize, 0usize, Report::default());
    for dir in &paths {
        let take = match Take::load(dir) {
            Ok(t) => t,
            Err(e) => {
                eprintln!("{} : {e}", dir.display());
                continue;
            }
        };
        let r = Report::of(&replay(&take, &EngineConfig::default(), SessionConfig::default()));
        let live = take.score.hits as usize + take.score.misses as usize;
        println!("{} ({:.0} s)", dir.file_name().unwrap_or_default().to_string_lossy(), take.seconds());
        println!("  en direct : {:.0} % ({}/{})", 100.0 * take.score.hits as f64 / live.max(1) as f64, take.score.hits, live);
        println!("  rejoué    : {r}");
        live_hits += take.score.hits as usize;
        live_judged += live;
        for (a, b) in [
            (&mut total.notes, r.notes),
            (&mut total.notes_hit, r.notes_hit),
            (&mut total.chords, r.chords),
            (&mut total.chords_hit, r.chords_hit),
            (&mut total.perfects, r.perfects),
            (&mut total.unplayed, r.unplayed),
            (&mut total.early, r.early),
            (&mut total.late, r.late),
            (&mut total.high, r.high),
            (&mut total.low, r.low),
            (&mut total.wrong_chord, r.wrong_chord),
            (&mut total.technique, r.technique),
        ] {
            *a += b;
        }
        total.extras += r.extras;
        total.mean_error += r.mean_error * r.hits() as f64;
    }
    if paths.len() > 1 {
        total.mean_error /= total.hits().max(1) as f64;
        println!("\n{} prises", paths.len());
        println!("  en direct : {:.0} % ({live_hits}/{live_judged})", 100.0 * live_hits as f64 / live_judged.max(1) as f64);
        println!("  rejoué    : {total}");
    }
}
