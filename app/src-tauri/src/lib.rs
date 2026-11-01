//! OpenSmith desktop app: the Tauri shell around the game session (engine-rt/session).
//!
//! The session runs on its own thread with the CoreAudio engine; the web view polls it every
//! frame for the song time and the game events, and renders the note highway.

mod cloud;
mod import;

use std::collections::HashMap;
use std::io::Write;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use import::{Importer, Job, JobState, Origin, Pipeline, Queue, ORIGIN};
use opensmith_audio::{list_devices, Engine, EngineConfig, InputKind};
use opensmith_dsp::{AmpKnobs, AmpModel, ChainParams};
use opensmith_game::Chart;
use opensmith_session::{load_track, load_track_with_stem, metronome, read_excerpt, Command, Devices, EngineBackend, Judging, RiffLoop, SessionConfig, SessionHandle, UiEvent};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, State};

/// Seconds of count-in before the song starts.
const COUNT_IN: f64 = 3.0;
/// The player's progress, in the library folder.
const PROGRESS: &str = "progress.json";
const CAREER: &str = "career.json";

struct App {
    session: SessionHandle,
    library: PathBuf,
    sample_rate: u32,
    charts: Charts,
    /// Previews asked for: one still being read plays only if none was asked for since.
    previews: Arc<AtomicU64>,
}

/// Songs read from their chart, kept while the chart file is unchanged: the library is read
/// again after each import, and a few hundred charts take seconds to parse.
type Charts = Arc<Mutex<HashMap<PathBuf, Parsed>>>;

#[derive(Clone)]
struct Parsed {
    stamp: (SystemTime, u64),
    entry: SongEntry,
    /// The song file's name, as the chart says.
    file: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SongEntry {
    id: String,
    title: String,
    artist: String,
    duration: f64,
    tuning: String,
    arrangement: String,
    /// What it plays: "lead", "rhythm", "combo", "bass".
    arrangement_type: String,
    notes: usize,
    chords: usize,
    /// The song's picture (library path), when it has one.
    cover: Option<String>,
    album: Option<String>,
    year: Option<i32>,
    /// Where the notes come from: "audio" (transcribed), "guitarpro", "synth", a plugin's…
    source: String,
    /// A backing track to play along with.
    has_audio: bool,
    max_difficulty: u32,
    /// Phrase names in order of first appearance (rests aside).
    phrases: Vec<String>,
    phrase_sections: Vec<String>,
    /// Notes and chords played at each level 0..max_difficulty.
    level_notes: Vec<usize>,
    /// The song's other arrangements: the charts beside this one (`song_chart.<part>.json`).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    others: Vec<SongEntry>,
}

#[derive(Serialize)]
struct PollView {
    time: f64,
    playing: bool,
    events: Vec<UiEvent>,
    /// Loudest guitar sample since the last poll (level meter).
    peak: f32,
    /// Playback speed (song seconds per second).
    rate: f64,
}

/// How the player's guitar stays tuned between songs: songs a few semitones away are
/// transposed to it instead of asking for a retune.
#[derive(Deserialize)]
struct GuitarTuning {
    name: String,
    strings: Vec<i32>,
}

/// The player's guitar settings, kept by the app and sent at start and on every change.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InputSettings {
    input_gain_db: f32,
    input_offset_ms: f64,
    /// Linear gains.
    backing_volume: f32,
    monitor_volume: f32,
    /// The song's own guitar, when the import kept it as a stem (MP3 imports, feedpak).
    #[serde(default)]
    stem_volume: f32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioStatus {
    ready: bool,
    error: Option<String>,
    input: Option<String>,
    rocksmith: bool,
    output: Option<String>,
    monitor: bool,
    /// Why the last change of output failed (the previous output still plays).
    switch_error: Option<String>,
    round_trip_ms: Option<f64>,
    library: String,
    /// Song to start right away (`OPENSMITH_AUTOPLAY`, development).
    autoplay: Option<String>,
    /// File to convert right away (`OPENSMITH_IMPORT`, development).
    autoimport: Option<String>,
}

/// A song file of the music folder, and its chart once converted.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MusicFile {
    path: String,
    name: String,
    size: u64,
    song: Option<String>,
    /// Songs made from the file: one, or several for an archive of songs (a plugin's).
    songs: usize,
    /// Guitar Pro tab of the same song next to the file, placed on the recording at conversion.
    tab: Option<String>,
    /// The converted song's chart comes from that tab (as it is now).
    tab_placed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Dropped {
    jobs: Vec<Job>,
    folders: Vec<String>,
    ignored: Vec<String>,
}

/// The library: every `song_chart.json` under its folder, and which song file each came from.
#[derive(Default)]
struct Index {
    songs: Vec<SongEntry>,
    by_source: HashMap<String, Vec<String>>,
    by_name: HashMap<String, Vec<String>>,
}

impl Index {
    /// Charts already read in `charts` are taken from there; the others are read and kept.
    fn of(root: &Path, charts: &Charts) -> Index {
        let mut index = Index::default();
        let mut seen = HashMap::new();
        let mut known = std::mem::take(&mut *charts.lock().unwrap());
        index.scan(root, root, 0, &mut known, &mut seen);
        *charts.lock().unwrap() = seen;
        index
    }

    fn scan(&mut self, root: &Path, dir: &Path, depth: usize, known: &mut HashMap<PathBuf, Parsed>, seen: &mut HashMap<PathBuf, Parsed>) {
        let Ok(entries) = fs::read_dir(dir) else { return };
        let mut paths: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
        paths.sort();
        for path in paths {
            if path.is_dir() {
                if depth < 4 {
                    self.scan(root, &path, depth + 1, known, seen);
                }
                continue;
            }
            if path.file_name().is_none_or(|n| n != "song_chart.json") {
                continue;
            }
            let Some(parsed) = cached(root, &path, known) else { continue };
            let mut entry = parsed.entry.clone();
            for other in paths_beside(&path) {
                if let Some(p) = cached(root, &other, known) {
                    entry.others.push(p.entry.clone());
                    seen.insert(other, p);
                }
            }
            let id = entry.id.clone();
            let origin = fs::read_to_string(path.with_file_name(ORIGIN)).ok().and_then(|t| serde_json::from_str::<Origin>(&t).ok());
            if let Some(o) = origin {
                self.by_source.entry(o.source).or_default().push(id.clone());
            }
            self.by_name.entry(parsed.file.clone()).or_default().push(id);
            self.songs.push(entry);
            seen.insert(path, parsed);
        }
    }

    /// The charts made from `path`: same file, else same file name.
    fn converted(&self, path: &Path) -> &[String] {
        let name = path.file_name().map(|n| n.to_string_lossy()).unwrap_or_default();
        self.by_source.get(path.to_string_lossy().as_ref()).or_else(|| self.by_name.get(name.as_ref())).map_or(&[], Vec::as_slice)
    }
}

/// The chart at `path`, from `known` when it did not change since it was read.
fn cached(root: &Path, path: &Path, known: &mut HashMap<PathBuf, Parsed>) -> Option<Parsed> {
    let stamp = fs::metadata(path).ok().and_then(|m| Some((m.modified().ok()?, m.len())))?;
    match known.remove(path).filter(|p| p.stamp == stamp) {
        Some(p) => Some(p),
        None => parse_entry(root, path, stamp),
    }
}

/// The song's other arrangements beside its `song_chart.json`: `song_chart.<part>.json`, sorted.
fn paths_beside(chart: &Path) -> Vec<PathBuf> {
    let Some(Ok(entries)) = chart.parent().map(fs::read_dir) else { return Vec::new() };
    let mut out: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name().map(|n| n.to_string_lossy()).is_some_and(|n| n.starts_with("song_chart.") && n.ends_with(".json") && n != "song_chart.json")
        })
        .collect();
    out.sort();
    out
}

/// A library song as its chart describes it.
fn parse_entry(root: &Path, path: &Path, stamp: (SystemTime, u64)) -> Option<Parsed> {
    let chart = Chart::from_json(&fs::read_to_string(path).ok()?).ok()?;
    let cover = path.with_file_name("cover.jpg");
    let phrases = phrase_names(&chart);
    let phrase_sections = phrase_sections(&chart, &phrases);
    let level_notes = level_notes(&chart);
    let entry = SongEntry {
        cover: cover.is_file().then(|| library_id(root, &cover)),
        id: library_id(root, path),
        title: chart.meta.title,
        artist: chart.meta.artist,
        duration: chart.meta.duration,
        tuning: chart.arrangement.tuning.name,
        arrangement: chart.arrangement.name,
        arrangement_type: chart.arrangement.kind,
        notes: chart.notes.len(),
        chords: chart.chords.len(),
        album: chart.meta.album.clone(),
        year: chart.meta.year,
        source: chart.meta.source.kind.clone(),
        has_audio: chart.audio.backing.is_some(),
        max_difficulty: chart.arrangement.max_difficulty,
        phrases,
        phrase_sections,
        level_notes,
        others: Vec::new(),
    };
    Some(Parsed { stamp, entry, file: chart.meta.source.file })
}

/// Phrase names in order of first appearance, rests aside.
fn phrase_names(chart: &Chart) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for p in &chart.phrases {
        if !p.name.starts_with("rest") && !names.contains(&p.name) {
            names.push(p.name.clone());
        }
    }
    names
}

/// Notes and chords played at each level 0..max_difficulty.
fn level_notes(chart: &Chart) -> Vec<usize> {
    let top = chart.arrangement.max_difficulty as usize;
    let mut out = vec![0; top + 1];
    let ranges = chart.notes.iter().map(|n| n.levels).chain(chart.chords.iter().map(|c| c.levels));
    for [lo, hi] in ranges {
        for count in out.iter_mut().take((hi as usize).min(top) + 1).skip(lo as usize) {
            *count += 1;
        }
    }
    out
}

/// The part of the song (section name, as written) where each phrase of `names` is first played.
fn phrase_sections(chart: &Chart, names: &[String]) -> Vec<String> {
    names
        .iter()
        .map(|name| {
            let start = chart.phrases.iter().find(|p| &p.name == name).map_or(0.0, |p| p.start);
            chart.sections.iter().find(|s| s.start <= start + 1e-6 && start < s.end - 1e-6).map_or_else(String::new, |s| s.name.clone())
        })
        .collect()
}

fn library_id(root: &Path, path: &Path) -> String {
    path.strip_prefix(root).unwrap_or(path).components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/")
}

/// Song files under `dir` (sub-folders too): audio, feedpaks, and what the pipeline's plugins
/// import.
fn music_files(dir: &Path, depth: usize, importer: &Importer, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for path in entries.flatten().map(|e| e.path()) {
        let hidden = path.file_name().is_some_and(|n| n.to_string_lossy().starts_with('.'));
        if hidden {
            continue;
        }
        if path.is_dir() && import::kind_of(&path).is_none() {
            if depth < 4 {
                music_files(&path, depth + 1, importer, out);
            }
        } else if path.is_dir() {
            out.push(path); // a song packed as a folder (feedpak): its stems are not songs
        } else if matches!(import::kind_of(&path), Some("audio" | "feedpak")) || (import::kind_of(&path).is_none() && importer.accepts(&path)) {
            out.push(path);
        }
    }
}

/// `id` inside the library, never outside it.
fn resolve(root: &Path, id: &str) -> Result<PathBuf, String> {
    let rel = Path::new(id);
    if rel.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err(format!("chemin de morceau invalide : {id}"));
    }
    Ok(root.join(rel))
}

/// Read off the main thread: imports land while a song is played.
#[tauri::command]
async fn cloud_status(cloud: State<'_, cloud::Cloud>) -> Result<cloud::Status, String> {
    Ok(cloud.status().await)
}

#[tauri::command]
async fn cloud_sign_in(cloud: State<'_, cloud::Cloud>, email: String, password: String, create: bool) -> Result<cloud::Status, String> {
    cloud.sign_in(&email, &password, create).await.map_err(|e| e.code())
}

#[tauri::command]
async fn cloud_sign_out(cloud: State<'_, cloud::Cloud>) -> Result<(), String> {
    cloud.sign_out().await;
    Ok(())
}

#[tauri::command]
async fn cloud_reset_password(cloud: State<'_, cloud::Cloud>, email: String) -> Result<(), String> {
    cloud.reset_password(&email).await.map_err(|e| e.code())
}

#[tauri::command]
async fn cloud_pull(cloud: State<'_, cloud::Cloud>, slot: String) -> Result<Option<opensmith_cloud::Save>, String> {
    cloud.pull(&slot).await.map_err(|e| e.code())
}

#[tauri::command]
async fn cloud_push(cloud: State<'_, cloud::Cloud>, slot: String, data: serde_json::Value, base_version: u64) -> Result<cloud::Pushed, String> {
    cloud.push(&slot, data, base_version).await.map_err(|e| e.code())
}

#[tauri::command]
async fn cloud_delete_account(cloud: State<'_, cloud::Cloud>) -> Result<(), String> {
    cloud.delete_account().await.map_err(|e| e.code())
}

#[tauri::command]
async fn library(app: State<'_, App>) -> Result<Vec<SongEntry>, String> {
    let (root, charts) = (app.library.clone(), app.charts.clone());
    let songs = tauri::async_runtime::spawn_blocking(move || Index::of(&root, &charts).songs).await.map_err(|e| e.to_string())?;
    eprintln!("bibliothèque : {} morceau(x) dans {}", songs.len(), app.library.display());
    Ok(songs)
}

/// Files dropped on the window: songs and tabs are queued for conversion, folders returned
/// (the app makes them its music folder).
#[tauri::command]
fn import_paths(importer: State<'_, Importer>, paths: Vec<String>) -> Dropped {
    dropped_paths(&importer, paths)
}

fn dropped_paths(importer: &Importer, paths: Vec<String>) -> Dropped {
    let mut dropped = Dropped { jobs: Vec::new(), folders: Vec::new(), ignored: Vec::new() };
    for p in paths {
        let path = PathBuf::from(&p);
        if path.is_dir() && import::kind_of(&path).is_none() {
            dropped.folders.push(p);
        } else if let Some(job) = importer.add(&path) {
            eprintln!("conversion demandée : {}", path.display());
            dropped.jobs.push(job);
        } else {
            dropped.ignored.push(p);
        }
    }
    dropped
}

/// Places the Guitar Pro tab found next to song file `path` on its converted song.
#[tauri::command]
fn place_tab(app: State<'_, App>, importer: State<'_, Importer>, path: String) -> Result<Job, String> {
    let file = PathBuf::from(&path);
    let tab = import::tab_for(&file).ok_or("aucune tablature de ce morceau dans le dossier")?;
    let id = Index::of(&app.library, &app.charts).converted(&file).first().cloned().ok_or("ce morceau n'est pas encore converti")?;
    let folder = app.library.join(&id).parent().map(Path::to_path_buf).ok_or("dossier du morceau introuvable")?;
    Ok(importer.place_tab(&tab, &folder))
}

#[tauri::command]
fn imports(importer: State<'_, Importer>) -> Queue {
    importer.queue()
}

/// The extensions the pipeline's plugins import, besides audio and Guitar Pro (asked again: a
/// plugin may have been installed since the app started).
#[tauri::command]
async fn import_formats(importer: State<'_, Importer>) -> Result<Vec<String>, String> {
    let importer = importer.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        importer.learn_formats();
        importer.plugin_formats()
    })
    .await
    .map_err(|e| e.to_string())
}

/// Every song file of a folder (sub-folders too) not yet in the library, queued in order.
#[tauri::command]
async fn import_folder(app: State<'_, App>, importer: State<'_, Importer>, path: String) -> Result<Vec<Job>, String> {
    let dir = PathBuf::from(&path);
    if !dir.is_dir() {
        return Err(format!("dossier introuvable : {path}"));
    }
    let (library, charts, importer) = (app.library.clone(), app.charts.clone(), importer.inner().clone());
    let jobs = tauri::async_runtime::spawn_blocking(move || queue_folder(&library, &charts, &importer, &dir)).await.map_err(|e| e.to_string())?;
    eprintln!("dossier importé : {} morceau(x) en file depuis {path}", jobs.len());
    Ok(jobs)
}

fn queue_folder(library: &Path, charts: &Charts, importer: &Importer, dir: &Path) -> Vec<Job> {
    let index = Index::of(library, charts);
    let mut files = Vec::new();
    music_files(dir, 0, importer, &mut files);
    files.sort();
    files.iter().filter(|f| index.converted(f).is_empty()).filter_map(|f| importer.add(f)).collect()
}

#[tauri::command]
fn set_import_paused(importer: State<'_, Importer>, on: bool) {
    importer.set_paused(on);
}

#[tauri::command]
fn cancel_queued_imports(importer: State<'_, Importer>) {
    importer.cancel_queued();
}

#[tauri::command]
fn cancel_import(importer: State<'_, Importer>, id: u32) {
    importer.cancel(id);
}

#[tauri::command]
fn dismiss_import(importer: State<'_, Importer>, id: u32) {
    importer.dismiss(id);
}

/// The song files of a folder of the Mac, with their chart when already converted.
#[tauri::command]
async fn scan_folder(app: State<'_, App>, importer: State<'_, Importer>, path: String) -> Result<Vec<MusicFile>, String> {
    let dir = PathBuf::from(&path);
    if !dir.is_dir() {
        return Err(format!("dossier introuvable : {path}"));
    }
    let (library, charts, importer) = (app.library.clone(), app.charts.clone(), importer.inner().clone());
    tauri::async_runtime::spawn_blocking(move || {
        let index = Index::of(&library, &charts);
        let mut files = Vec::new();
        music_files(&dir, 0, &importer, &mut files);
        files.sort();
        files
            .into_iter()
            .map(|f| {
                let made = index.converted(&f);
                let song = made.first().cloned();
                let tab = import::tab_for(&f);
                let folder = song.as_ref().and_then(|id| library.join(id).parent().map(Path::to_path_buf));
                MusicFile {
                    name: f.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
                    size: fs::metadata(&f).map(|m| m.len()).unwrap_or(0),
                    tab_placed: matches!((&folder, &tab), (Some(d), Some(t)) if import::tab_placed(d, t)),
                    tab: tab.and_then(|t| t.file_name().map(|n| n.to_string_lossy().into_owned())),
                    song,
                    songs: made.len(),
                    path: f.to_string_lossy().into_owned(),
                }
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

/// Loads a song into the session (count-in position, stopped) and returns its chart as written,
/// so the highway indexes the same notes as the game.
#[tauri::command]
async fn load_song(
    app: State<'_, App>,
    id: String,
    start_level: u32,
    levels: HashMap<String, u32>,
    dynamic: Option<bool>,
    guitar: Option<GuitarTuning>,
) -> Result<serde_json::Value, String> {
    let path = resolve(&app.library, &id)?;
    app.session.send(Command::StartLevel(start_level));
    app.session.send(Command::Dynamic(dynamic.unwrap_or(true)));
    let sample_rate = app.sample_rate;
    let (json, chart, track) = tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
        let text = fs::read_to_string(&path).map_err(|e| format!("{} : {e}", path.display()))?;
        let mut chart = Chart::from_json(&text).map_err(|e| e.to_string())?;
        // Played on the guitar as it is tuned: the chart takes its tuning, the audio follows.
        let shift = guitar.as_ref().and_then(|g| chart.retune_to(&g.strings, &g.name));
        let track = match (&chart.audio.backing, &chart.audio.guitar) {
            (Some(name), Some(guitar)) if path.with_file_name(guitar).is_file() => Some(
                load_track_with_stem(&path.with_file_name(name), &path.with_file_name(guitar), sample_rate)
                    .map_err(|e| e.to_string())?,
            ),
            (Some(name), _) => Some(load_track(&path.with_file_name(name), sample_rate).map_err(|e| e.to_string())?),
            (None, _) => None,
        };
        let track = match (track, shift) {
            (Some(t), Some(s)) => Some(t.transposed(s, sample_rate as f64)),
            (t, _) => t,
        };
        let mut json: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        if let Some(s) = shift {
            json["arrangement"]["tuning"] = serde_json::to_value(&chart.arrangement.tuning).map_err(|e| e.to_string())?;
            json["transposed"] = s.into();
            eprintln!("morceau transposé de {s:+.2} demi-tons pour la guitare en {}", chart.arrangement.tuning.name);
        }
        Ok((json, chart, track))
    })
    .await
    .map_err(|e| e.to_string())??;
    eprintln!(
        "morceau chargé : {} ({} notes, {} accords, accompagnement {})",
        chart.meta.title,
        chart.notes.len(),
        chart.chords.len(),
        track.as_ref().map_or("absent".to_string(), |t| format!("{:.1} s", t.frames() as f64 / sample_rate as f64)),
    );
    app.session.send(Command::Load { chart: Box::new(chart), track, start: -COUNT_IN, levels });
    Ok(json)
}

/// A lesson (a chart the app makes): every note from the start, over a metronome on its beats.
#[tauri::command]
fn load_lesson(app: State<'_, App>, json: String) -> Result<serde_json::Value, String> {
    let chart = Chart::from_json(&json).map_err(|e| e.to_string())?;
    let value: serde_json::Value = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    let beats: Vec<(f64, bool)> = chart.beats.iter().map(|b| (b.time, b.bar.is_some())).collect();
    let track = metronome(&beats, chart.meta.duration + 0.5, app.sample_rate);
    app.session.send(Command::StartLevel(chart.arrangement.max_difficulty));
    app.session.send(Command::Dynamic(false));
    eprintln!("leçon chargée : {} ({} notes, {} accords)", chart.meta.title, chart.notes.len(), chart.chords.len());
    app.session.send(Command::Load { chart: Box::new(chart), track: Some(track), start: -COUNT_IN, levels: HashMap::new() });
    Ok(value)
}

/// A sound the app made (interface, crowd), to play later by name: the body holds its mono
/// samples (f32, little-endian), the headers its `name` and `rate` (Hz).
#[tauri::command]
fn add_sound(app: State<'_, App>, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("son attendu en binaire".into()) };
    let header = |key: &str| request.headers().get(key).and_then(|v| v.to_str().ok()).map(str::to_string);
    let name = header("name").ok_or("son sans nom")?;
    let rate: f64 = header("rate").and_then(|r| r.parse().ok()).ok_or("son sans fréquence")?;
    let samples = bytes.as_chunks::<4>().0.iter().map(|c| f32::from_le_bytes(*c)).collect();
    app.session.send(Command::AddSound { name, rate, samples });
    Ok(())
}

/// Plays a sound added before at linear `gain`, now or at song time `at`.
#[tauri::command]
fn play_sound(app: State<'_, App>, name: String, gain: f32, at: Option<f64>) {
    app.session.send(Command::Sound { name, gain, at });
}

/// The looping background sound (the crowd) glides to `gain`; none fades it out.
#[tauri::command]
fn set_bed(app: State<'_, App>, name: Option<String>, gain: f32) {
    app.session.send(Command::Bed { name, gain });
}

/// How forgiving the judge is (lenient, normal, strict), from the next song.
/// Wait mode (lessons): the song stops on each note or chord until the guitar plays it.
#[tauri::command]
fn set_wait(app: State<'_, App>, on: bool) {
    app.session.send(Command::Wait(on));
}

#[tauri::command]
fn set_judging(app: State<'_, App>, name: String) -> Result<(), String> {
    let judging = Judging::by_name(&name).ok_or_else(|| format!("jugement inconnu : {name}"))?;
    app.session.send(Command::Judging(judging));
    Ok(())
}

/// The player's progress (scores, phrase levels, mastery), kept in the library folder.
#[tauri::command]
fn read_progress(app: State<'_, App>) -> String {
    fs::read_to_string(app.library.join(PROGRESS)).unwrap_or_else(|_| "{}".into())
}

/// Saves the progress.
#[tauri::command]
fn write_progress(app: State<'_, App>, json: String) -> Result<(), String> {
    write_atomic(&app.library.join(PROGRESS), &json)
}

/// The career mode's save, kept with the library like the progress; "null" before the first.
#[tauri::command]
fn read_career(app: State<'_, App>) -> String {
    fs::read_to_string(app.library.join(CAREER)).unwrap_or_else(|_| "null".into())
}

#[tauri::command]
fn write_career(app: State<'_, App>, json: String) -> Result<(), String> {
    write_atomic(&app.library.join(CAREER), &json)
}

/// Writes `json` to `path` atomically: a crash mid-write keeps the previous file.
fn write_atomic(path: &Path, json: &str) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    let mut file = fs::File::create(&tmp).map_err(|e| e.to_string())?;
    file.write_all(json.as_bytes()).and_then(|_| file.sync_all()).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// Seconds of a song played while it is chosen in the library, and the fades at their ends (it
/// loops).
const PREVIEW_SECONDS: f64 = 30.0;
const PREVIEW_FADES: (f64, f64) = (1.5, 2.5);

/// The song `id` plays in the background, as when browsing songs: its chorus (else from a third
/// of the way in), looping, at `gain`; `None` fades it out.
#[tauri::command]
async fn preview_song(app: State<'_, App>, id: Option<String>, gain: f32) -> Result<(), String> {
    let asked = app.previews.fetch_add(1, Ordering::SeqCst) + 1;
    let Some(id) = id else {
        app.session.send(Command::Bed { name: None, gain: 0.0 });
        return Ok(());
    };
    let path = resolve(&app.library, &id)?;
    let (samples, rate) = tauri::async_runtime::spawn_blocking(move || preview_of(&path)).await.map_err(|e| e.to_string())??;
    if app.previews.load(Ordering::SeqCst) == asked {
        app.session.send(Command::AddSound { name: "preview".into(), rate: f64::from(rate), samples });
        app.session.send(Command::Bed { name: Some("preview".into()), gain });
    }
    Ok(())
}

/// Where a song's preview starts (s of its audio): its first chorus, else a third of the way in.
fn preview_start(chart: &Chart) -> f64 {
    let chorus = chart.sections.iter().find(|s| {
        let name = s.name.to_lowercase();
        (name.contains("chorus") || name.contains("refrain")) && s.start > 5.0
    });
    let start = chorus.map_or(chart.meta.duration / 3.0, |s| s.start) + chart.audio.offset;
    start.min(chart.meta.duration - PREVIEW_SECONDS).max(0.0)
}

/// PREVIEW_SECONDS of the recording of the chart at `path` (its mix, or its backing with the
/// guitar's stem), mono at the files' rate, from `preview_start`, faded in and out.
fn preview_of(path: &Path) -> Result<(Vec<f32>, u32), String> {
    let chart = Chart::from_json(&fs::read_to_string(path).map_err(|e| format!("{} : {e}", path.display()))?).map_err(|e| e.to_string())?;
    let files: Vec<&String> = match (&chart.audio.mix, &chart.audio.backing, &chart.audio.guitar) {
        (Some(mix), _, _) => vec![mix],
        (None, Some(backing), Some(guitar)) if path.with_file_name(guitar).is_file() => vec![backing, guitar],
        (None, Some(backing), _) => vec![backing],
        _ => return Err(format!("{} : pas d’enregistrement", path.display())),
    };
    let start = preview_start(&chart);
    let (mut out, rate) = read_excerpt(&path.with_file_name(files[0]), start, PREVIEW_SECONDS).map_err(|e| e.to_string())?;
    for name in &files[1..] {
        // The guitar's stem, at the backing's rate (the importer writes both alike).
        if let Ok((stem, r)) = read_excerpt(&path.with_file_name(name), start, PREVIEW_SECONDS)
            && r == rate
        {
            out.iter_mut().zip(stem).for_each(|(o, v)| *o += v);
        }
    }
    let r = f64::from(rate);
    let (fade_in, fade_out) = ((PREVIEW_FADES.0 * r) as usize, (PREVIEW_FADES.1 * r) as usize);
    let n = out.len();
    for (i, v) in out.iter_mut().enumerate() {
        *v *= (i as f32 / fade_in as f32).min(1.0) * ((n - i) as f32 / fade_out as f32).min(1.0);
    }
    Ok((out, rate))
}

/// A song's picture (a library path from `library`), as raw JPEG bytes. Read off the main thread:
/// a library opening asks for the pictures of every tile it shows.
#[tauri::command]
async fn song_cover(app: State<'_, App>, path: String) -> Result<tauri::ipc::Response, String> {
    let file = resolve(&app.library, &path)?;
    let bytes = tauri::async_runtime::spawn_blocking(move || fs::read(&file).map_err(|e| format!("{} : {e}", file.display())))
        .await
        .map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
fn play(app: State<'_, App>) {
    app.session.send(Command::Play);
}

#[tauri::command]
fn pause(app: State<'_, App>) {
    app.session.send(Command::Pause);
}

#[tauri::command]
fn seek(app: State<'_, App>, time: f64) {
    app.session.send(Command::Seek(time));
}

#[tauri::command]
fn set_volume(app: State<'_, App>, gain: f32) {
    app.session.send(Command::Volume(gain));
}

/// Playback speed (1: as recorded); the pitch stays the same.
#[tauri::command]
fn set_speed(app: State<'_, App>, rate: f64) {
    app.session.send(Command::Rate(rate));
}

/// Loop Trainer: loops `riff` from its start (a `pass` event each time round), or stops looping.
#[tauri::command]
fn set_riff(app: State<'_, App>, riff: Option<RiffLoop>) {
    app.session.send(Command::Riff(riff));
}

/// Song time now and the game events since the last call: once per rendered frame.
#[tauri::command]
fn poll(app: State<'_, App>) -> PollView {
    let p = app.session.poll();
    for e in &p.events {
        match e {
            UiEvent::Phrase { name, accuracy, level, next_level, .. } => {
                eprintln!("phrase {name} : {:.0} % (niveau {} → {})", accuracy * 100.0, level + 1, next_level + 1)
            }
            UiEvent::End => eprintln!("fin du morceau"),
            UiEvent::Pass { score } => eprintln!("passe : {} / {}", score.hits, score.hits + score.misses),
            _ => {}
        }
    }
    PollView { time: p.time, playing: p.playing, events: p.events, peak: p.peak, rate: p.rate }
}

#[tauri::command]
fn configure_input(app: State<'_, App>, settings: InputSettings) {
    app.session.send(Command::InputGain(10f32.powf(settings.input_gain_db / 20.0)));
    app.session.send(Command::InputOffset(settings.input_offset_ms / 1000.0));
    app.session.send(Command::Volume(settings.backing_volume));
    app.session.send(Command::MonitorGain(settings.monitor_volume));
    app.session.send(Command::StemVolume(settings.stem_volume));
}

/// The amp as the player set it: a model and its knobs (0..1), sent at start and on every change.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AmpSettings {
    model: String,
    gain: f32,
    bass: f32,
    mid: f32,
    treble: f32,
    volume: f32,
    delay: f32,
    reverb: f32,
    gate: bool,
    /// The noise gate's threshold (dBFS); `None`: the channel's own.
    #[serde(default)]
    gate_db: Option<f32>,
}

#[tauri::command]
fn configure_amp(app: State<'_, App>, amp: AmpSettings) -> Result<(), String> {
    let model = AmpModel::from_name(&amp.model).ok_or_else(|| format!("ampli inconnu : {}", amp.model))?;
    let knobs = AmpKnobs {
        gain: amp.gain,
        bass: amp.bass,
        mid: amp.mid,
        treble: amp.treble,
        volume: amp.volume,
        delay: amp.delay,
        reverb: amp.reverb,
        gate: amp.gate,
    };
    let mut chain = ChainParams::default().with_amp(model, knobs);
    if let Some(db) = amp.gate_db {
        chain.gate.threshold_db = db.clamp(-90.0, -20.0);
    }
    app.session.send(Command::Amp(chain));
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OutputDevice {
    name: String,
    current: bool,
}

/// Whether a device with these sample rate ranges can run the engine at `rate`: the others
/// (a virtual input at 96 kHz only) would fail to open, the engine staying on the device before.
fn runs_at(rates: &[(u32, u32)], rate: u32) -> bool {
    rates.iter().any(|&(lo, hi)| (lo..=hi).contains(&rate))
}

/// Where the sound can go: the Mac's speakers, headphones, an audio interface…
#[tauri::command]
async fn audio_outputs(app: State<'_, App>) -> Result<Vec<OutputDevice>, String> {
    let current = app.session.info().map(|i| i.output_name);
    let devices = tauri::async_runtime::spawn_blocking(list_devices).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
    Ok(devices
        .into_iter()
        .filter(|d| d.output_channels > 0 && runs_at(&d.output_rates, app.sample_rate))
        .map(|d| OutputDevice { current: current.as_deref() == Some(d.name.as_str()), name: d.name })
        .collect())
}

/// Plays through another output device (`None`: the Mac's default); the song in progress stops.
#[tauri::command]
fn set_output(app: State<'_, App>, name: Option<String>) {
    app.session.send(Command::Output(name));
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InputDevice {
    name: String,
    current: bool,
    rocksmith: bool,
}

/// What can feed the guitar: the USB guitar cable, an audio interface, the Mac's microphone…
#[tauri::command]
async fn audio_inputs(app: State<'_, App>) -> Result<Vec<InputDevice>, String> {
    let current = app.session.info().map(|i| i.input_name);
    let devices = tauri::async_runtime::spawn_blocking(list_devices).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
    Ok(devices
        .into_iter()
        .filter(|d| d.input_channels > 0 && runs_at(&d.input_rates, app.sample_rate))
        .map(|d| InputDevice { current: current.as_deref() == Some(d.name.as_str()), rocksmith: d.rocksmith, name: d.name })
        .collect())
}

/// Listens to another input device (`None`: the USB guitar cable, else the default input); the
/// song in progress stops.
#[tauri::command]
fn set_input(app: State<'_, App>, name: Option<String>) {
    app.session.send(Command::Input(name));
}

/// Demo mode: the game plays every note itself (no guitar needed).
/// Difficulty changed in the pause menu: dynamic, or every phrase at `level`, from the next one.
#[tauri::command]
fn set_difficulty(app: State<'_, App>, dynamic: bool, level: u32) {
    app.session.send(Command::Difficulty { dynamic, level });
}

#[tauri::command]
fn set_autopilot(app: State<'_, App>, on: bool) {
    app.session.send(Command::Autopilot(on));
}

/// Takes of what the guitar plays during songs, in the library's hidden `.takes` folder: to
/// replay them offline and tune the detection (`opensmith-replay`). They stay on this Mac.
#[tauri::command]
fn set_recording(app: State<'_, App>, on: bool) {
    app.session.send(Command::Record(on.then(|| app.library.join(".takes"))));
}

/// Tuner mode: the pitch of the ringing string streams in the poll events.
#[tauri::command]
fn set_tuner(app: State<'_, App>, on: bool) {
    app.session.send(Command::Tuner(on));
}

/// Plays clicks and measures how late the player's strums come (result in the poll events).
#[tauri::command]
fn calibrate_latency(app: State<'_, App>) {
    app.session.send(Command::Calibrate);
}

#[tauri::command]
fn audio_status(app: State<'_, App>) -> AudioStatus {
    let info = app.session.info();
    AudioStatus {
        ready: info.is_some(),
        error: app.session.error(),
        input: info.as_ref().map(|i| i.input_name.clone()),
        rocksmith: info.as_ref().is_some_and(|i| i.input_kind == InputKind::Rocksmith),
        output: info.as_ref().map(|i| i.output_name.clone()),
        monitor: info.as_ref().is_some_and(|i| i.monitor),
        switch_error: app.session.switch_error(),
        round_trip_ms: app.session.stats().map(|s| s.round_trip_ms),
        library: app.library.display().to_string(),
        autoplay: std::env::var("OPENSMITH_AUTOPLAY").ok(),
        autoimport: std::env::var("OPENSMITH_IMPORT").ok(),
    }
}

/// The song converter. `OPENSMITH_PIPELINE` if set. A development build runs the repository's
/// `pipeline-ingest` with `uv run`; a built app runs the copy it carries in its resources,
/// installed into its data folder (~/Library/Application Support/…) on the first import.
fn pipeline(resources: Option<PathBuf>, data: Option<PathBuf>) -> Option<Pipeline> {
    if let Some(dir) = std::env::var_os("OPENSMITH_PIPELINE") {
        return Pipeline::uv(Path::new(&dir));
    }
    if cfg!(debug_assertions) {
        return Pipeline::uv(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../pipeline-ingest"));
    }
    let resources = resources.filter(|r| r.join("pipeline-ingest").is_dir())?;
    Pipeline::bundled(&resources, &data?)
}

/// `OPENSMITH_LIBRARY`, else OpenSmith in the music folder (a development build: the
/// repository's `out` folder when there is one).
fn library_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("OPENSMITH_LIBRARY") {
        return dir.into();
    }
    let dev = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../out");
    if cfg!(debug_assertions) && dev.is_dir() {
        return dev.canonicalize().unwrap_or(dev);
    }
    // The system's music folder: ~/Music, XDG_MUSIC_DIR (named in the user's language), Windows' Music.
    dirs::audio_dir().unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join("Music")).join("OpenSmith")
}

/// Written in the library: the demo songs already put in it, one name a line, so that a player
/// who deletes one does not get it back, and a demo shipped later still arrives. (Empty: written
/// when the first demo was the only one.)
const DEMO_PLACED: &str = ".demo";
const FIRST_DEMO: &str = "OpenSmith - First Riff";

/// Puts the demo songs the app carries (`resources/demo`, one folder each) in the library, each
/// once.
fn place_demo(resources: &Path, library: &Path) {
    let marker = library.join(DEMO_PLACED);
    let mut placed: Vec<String> = match fs::read_to_string(&marker) {
        Ok(text) if text.trim().is_empty() => vec![FIRST_DEMO.into()],
        Ok(text) => text.lines().map(str::to_string).collect(),
        Err(_) => Vec::new(),
    };
    let before = placed.len();
    let mut songs: Vec<PathBuf> = fs::read_dir(resources.join("demo")).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
    songs.sort();
    for song in songs {
        let Some(name) = song.file_name().map(|n| n.to_string_lossy().into_owned()) else { continue };
        if placed.contains(&name) {
            continue;
        }
        let dest = library.join(&name);
        if !dest.exists() {
            if fs::create_dir_all(&dest).is_err() {
                continue;
            }
            for file in fs::read_dir(&song).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.is_file()) {
                let _ = fs::copy(&file, dest.join(file.file_name().unwrap_or_default()));
            }
        }
        placed.push(name);
    }
    if placed.len() != before || !marker.exists() {
        let _ = fs::write(marker, placed.join("\n"));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let config = EngineConfig::default();
    let sample_rate = config.sample_rate;
    let session = SessionHandle::spawn(
        move |d: Devices| Engine::start(EngineConfig { input: d.input, output: d.output, ..config.clone() }).map(EngineBackend).map_err(|e| e.to_string()),
        SessionConfig::default(),
    );
    // Backing track volume (`OPENSMITH_VOLUME`, linear; 0 for silent test runs).
    if let Some(gain) = std::env::var("OPENSMITH_VOLUME").ok().and_then(|v| v.parse().ok()) {
        session.send(Command::Volume(gain));
    }
    let root = library_dir();
    let _ = fs::create_dir_all(&root);
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(cloud::Cloud::new(cloud::Config::from_env(), Box::new(cloud::Keychain)))
        .setup(move |app| {
            // The page shows the window once drawn; should it fail, the window appears anyway.
            if let Some(window) = app.get_webview_window("main") {
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(3));
                    let _ = window.show();
                });
            }
            if let Ok(resources) = app.path().resource_dir() {
                place_demo(&resources, &root);
            }
            let pipeline = pipeline(app.path().resource_dir().ok(), app.path().app_data_dir().ok());
            if pipeline.is_none() {
                eprintln!("uv introuvable : la conversion de morceaux est désactivée");
            }
            let handle = app.handle().clone();
            app.manage(Importer::new(root.clone(), pipeline, move |job| {
                match job.state {
                    JobState::Done => eprintln!("conversion terminée : {} en {:.0} s", job.title.as_deref().unwrap_or(&job.name), job.elapsed),
                    JobState::Failed => eprintln!("conversion échouée : {} : {}", job.name, job.error.as_deref().unwrap_or("?")),
                    _ => {}
                }
                let _ = handle.emit("import", job);
            }));
            app.manage(App { session, library: root, sample_rate, charts: Charts::default(), previews: Arc::default() });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            cloud_status,
            cloud_sign_in,
            cloud_sign_out,
            cloud_reset_password,
            cloud_pull,
            cloud_push,
            cloud_delete_account,
            library,
            load_song,
            load_lesson,
            add_sound,
            play_sound,
            set_bed,
            set_judging,
            set_wait,
            play,
            pause,
            seek,
            set_volume,
            set_speed,
            set_riff,
            poll,
            audio_status,
            import_paths,
            imports,
            import_folder,
            set_import_paused,
            cancel_queued_imports,
            cancel_import,
            dismiss_import,
            import_formats,
            place_tab,
            scan_folder,
            configure_input,
            configure_amp,
            audio_outputs,
            set_output,
            audio_inputs,
            set_input,
            set_autopilot,
            set_recording,
            set_difficulty,
            set_tuner,
            calibrate_latency,
            song_cover,
            preview_song,
            read_progress,
            read_career,
            write_career,
            write_progress
        ])
        .build(tauri::generate_context!())
        .expect("Riffroad n'a pas pu démarrer")
        .run(|app, event| {
            // The import under way stops with the app and starts again at the next launch.
            if let tauri::RunEvent::Exit = event
                && let Some(importer) = app.try_state::<Importer>()
            {
                importer.shutdown();
            }
        });
}

#[cfg(test)]
mod tests {
    #[test]
    fn devices_that_cannot_run_at_the_engine_rate_are_not_offered() {
        assert!(runs_at(&[(44_100, 44_100), (48_000, 48_000), (96_000, 96_000)], 48_000));
        assert!(runs_at(&[(8_000, 192_000)], 48_000));
        assert!(!runs_at(&[(96_000, 96_000)], 48_000), "Wave Link's virtual inputs");
        assert!(!runs_at(&[], 48_000));
    }

    #[test]
    #[ignore = "the note tracker on the WAV in OPENSMITH_TRACK_WAV"]
    fn notes_heard_in_a_recording() {
        use opensmith_dsp::{NoteTracker as Tracker, TrackerConfig, TrackerEvent};
        let Ok(wav) = std::env::var("OPENSMITH_TRACK_WAV") else { return };
        let (x, _) = read_excerpt(Path::new(&wav), 0.0, 600.0).unwrap();
        for db in [0.0f32, 6.0, 12.0, 20.0] {
            let g = 10f32.powf(db / 20.0);
            let mut tracker = Tracker::new(TrackerConfig::default());
            let mut notes = Vec::new();
            for block in x.chunks(128) {
                let b: Vec<f32> = block.iter().map(|v| v * g).collect();
                tracker.process(&b, |e| {
                    if let TrackerEvent::NoteOn { midi, clarity, .. } = e {
                        notes.push((midi, (clarity * 100.0) as i32));
                    }
                });
            }
            eprintln!("gain +{db} dB: {} notes {:?}", notes.len(), &notes[..notes.len().min(12)]);
        }
    }

    #[test]
    #[ignore = "opens every input of this Mac"]
    fn which_inputs_open() {
        for d in list_devices().unwrap().into_iter().filter(|d| d.input_channels > 0) {
            let r = Engine::start(EngineConfig { input: Some(d.name.clone()), ..EngineConfig::default() });
            eprintln!("{} ({} ch, {:?}, {}): {}", d.name, d.input_channels, d.input_rates, d.interface, r.map_or_else(|e| e.to_string(), |_| "ok".into()));
        }
    }

    #[test]
    #[ignore = "times the scan of the music folder in OPENSMITH_TIME_LIBRARY"]
    fn library_scan_time() {
        let Ok(root) = std::env::var("OPENSMITH_TIME_LIBRARY") else { return };
        let charts = Charts::default();
        for pass in ["first", "again"] {
            let t = std::time::Instant::now();
            let n = Index::of(Path::new(&root), &charts).songs.len();
            eprintln!("{pass}: {n} songs in {:.2} s", t.elapsed().as_secs_f64());
        }
        for song in Index::of(Path::new(&root), &charts).songs.iter().filter(|s| s.has_audio).take(3) {
            let t = std::time::Instant::now();
            let (preview, rate) = preview_of(&Path::new(&root).join(&song.id)).unwrap();
            eprintln!("preview of {}: {:.1} s of sound in {:.3} s", song.title, preview.len() as f64 / f64::from(rate), t.elapsed().as_secs_f64());
        }
    }

    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let nanos = SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("opensmith-app-{name}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_preview_starts_on_the_chorus_else_a_third_in_and_stays_inside_the_song() {
        let mut song = Chart::from_json(&chart("Song", "song.mp3")).unwrap();
        song.meta.duration = 240.0;
        assert_eq!(preview_start(&song), 80.0);
        let span = |name: &str, start: f64| opensmith_game::chart::Span { name: name.into(), start, end: start + 20.0 };
        song.sections = vec![span("intro", 0.0), span("verse", 12.0), span("Chorus", 52.5), span("chorus", 110.0)];
        song.audio.offset = 1.5;
        assert_eq!(preview_start(&song), 54.0);
        song.sections = vec![span("chorus", 225.0)];
        assert_eq!(preview_start(&song), 240.0 - PREVIEW_SECONDS);
    }

    fn chart(title: &str, file: &str) -> String {
        format!(
            r#"{{"format":"opensmith-chart","version":1,
            "meta":{{"title":"{title}","artist":"A","album":null,"year":null,"duration":8.0,"source":{{"kind":"audio","file":"{file}"}},"generator":"test"}},
            "audio":{{"backing":null,"guitar":null,"mix":null,"offset":0.0}},
            "arrangement":{{"name":"Lead","type":"lead","tuning":{{"name":"Drop C","strings":[36,43,48,53,57,62]}},"capo":0,"maxDifficulty":0}},
            "tempo":{{"bpm":120.0,"timeSignature":[4,4]}},
            "beats":[{{"time":0.0,"bar":1}}],"sections":[],"phrases":[],"chordTemplates":[],
            "notes":[],"chords":[],"anchors":[],"handShapes":[]}}"#
        )
    }

    #[test]
    fn the_demo_song_lands_in_the_library_once() {
        let root = scratch("demo");
        let (resources, library) = (root.join("resources"), root.join("library"));
        fs::create_dir_all(resources.join("demo/Band - Demo")).unwrap();
        fs::create_dir_all(&library).unwrap();
        fs::write(resources.join("demo/Band - Demo/song_chart.json"), chart("Demo", "demo")).unwrap();
        fs::write(resources.join("demo/Band - Demo/backing.wav"), b"RIFF").unwrap();
        place_demo(&resources, &library);
        assert_eq!(fs::read(library.join("Band - Demo/backing.wav")).unwrap(), b"RIFF");
        assert!(library.join("Band - Demo/song_chart.json").is_file());
        // Deleted by the player: it stays deleted.
        fs::remove_dir_all(library.join("Band - Demo")).unwrap();
        place_demo(&resources, &library);
        assert!(!library.join("Band - Demo").exists());
    }

    #[test]
    fn a_demo_shipped_later_reaches_a_library_that_had_the_first_one() {
        let root = scratch("demo-later");
        let (resources, library) = (root.join("resources"), root.join("library"));
        for name in [FIRST_DEMO, "Band - Rock"] {
            fs::create_dir_all(resources.join("demo").join(name)).unwrap();
            fs::write(resources.join("demo").join(name).join("backing.ogg"), b"OggS").unwrap();
        }
        // A library from the days of the one demo: its marker empty, the first demo deleted.
        fs::create_dir_all(&library).unwrap();
        fs::write(library.join(DEMO_PLACED), "").unwrap();
        place_demo(&resources, &library);
        assert!(library.join("Band - Rock/backing.ogg").is_file());
        assert!(!library.join(FIRST_DEMO).exists());
        assert_eq!(fs::read_to_string(library.join(DEMO_PLACED)).unwrap(), format!("{FIRST_DEMO}\nBand - Rock"));
    }

    #[test]
    fn a_folder_queues_the_songs_not_yet_in_the_library_in_order() {
        let root = scratch("folder");
        let (library, dir) = (root.join("library"), root.join("music"));
        fs::create_dir_all(library.join("night-drive")).unwrap();
        fs::create_dir_all(dir.join("more")).unwrap();
        for f in ["night-drive.mp3", "backstage.mp3", "more/tour-bus.flac", "more/Crowd Surf.mp3", "notes.txt", ".hidden.mp3"] {
            fs::write(dir.join(f), b"song").unwrap();
        }
        // Night Drive is already in the library, imported from that very file.
        fs::write(library.join("night-drive/song_chart.json"), chart("Night Drive", "night-drive.mp3")).unwrap();
        let charts = Charts::default();
        let importer = Importer::new(library.clone(), None, |_| {});
        importer.set_paused(true);

        let names = |jobs: Vec<Job>| jobs.into_iter().map(|j| j.name).collect::<Vec<_>>();
        let queued = names(queue_folder(&library, &charts, &importer, &dir));
        assert_eq!(queued, ["backstage.mp3", "Crowd Surf.mp3", "tour-bus.flac"]);
        // Dropped again while it waits: nothing is queued twice.
        queue_folder(&library, &charts, &importer, &dir);
        assert_eq!(importer.queue().jobs.len(), 3);

        // A chart rewritten is read again, the others come from the cache.
        assert_eq!(Index::of(&library, &charts).songs[0].title, "Night Drive");
        fs::write(library.join("night-drive/song_chart.json"), chart("Night Drive (live)", "night-drive.mp3")).unwrap();
        assert_eq!(Index::of(&library, &charts).songs[0].title, "Night Drive (live)");
        assert_eq!(charts.lock().unwrap().len(), 1);
    }

    #[test]
    fn the_other_arrangements_of_a_song_come_with_it() {
        let library = scratch("arrangements").join("library");
        fs::create_dir_all(library.join("night-drive")).unwrap();
        let song = library.join("night-drive");
        fs::write(song.join("song_chart.json"), chart("Night Drive", "night-drive.mp3")).unwrap();
        let part = |name: &str, kind: &str| chart("Night Drive", "night-drive.mp3").replace(r#""name":"Lead","type":"lead""#, &format!(r#""name":"{name}","type":"{kind}""#));
        fs::write(song.join("song_chart.rhythm.json"), part("Rhythm", "rhythm")).unwrap();
        fs::write(song.join("song_chart.bass.json"), part("Bass", "bass")).unwrap();
        let charts = Charts::default();
        let songs = Index::of(&library, &charts).songs;
        assert_eq!(songs.len(), 1, "one song, not three");
        let parts: Vec<(&str, &str, &str)> =
            songs[0].others.iter().map(|o| (o.id.as_str(), o.arrangement.as_str(), o.arrangement_type.as_str())).collect();
        assert_eq!(parts, [("night-drive/song_chart.bass.json", "Bass", "bass"), ("night-drive/song_chart.rhythm.json", "Rhythm", "rhythm")]);
        assert_eq!(charts.lock().unwrap().len(), 3, "each one cached");
        let json = serde_json::to_value(&songs[0]).unwrap();
        assert_eq!(json["others"][1]["arrangementType"], "rhythm");
        assert!(json["others"][0].get("others").is_none());
    }

    #[test]
    fn a_feedpak_folder_is_one_song_not_a_folder_of_stems() {
        let root = scratch("feedpak");
        let (library, dir) = (root.join("library"), root.join("music"));
        let pack = dir.join("Night Drive.feedpak");
        fs::create_dir_all(pack.join("stems")).unwrap();
        fs::create_dir_all(&library).unwrap();
        for f in ["manifest.yaml", "stems/full.ogg", "stems/guitar.ogg"] {
            fs::write(pack.join(f), b"pack").unwrap();
        }
        fs::write(dir.join("Crowd Surf.feedpak"), b"zip").unwrap();
        let importer = Importer::new(library.clone(), None, |_| {});
        importer.set_paused(true);

        let queued: Vec<_> = queue_folder(&library, &Charts::default(), &importer, &dir).into_iter().map(|j| j.name).collect();
        assert_eq!(queued, ["Crowd Surf.feedpak", "Night Drive.feedpak"]);
        // Dropped on the window, the pack folder is a song to convert, not a music folder.
        let dropped = dropped_paths(&importer, vec![pack.to_string_lossy().into_owned()]);
        assert!(dropped.folders.is_empty() && dropped.jobs.len() == 1);
    }
}
