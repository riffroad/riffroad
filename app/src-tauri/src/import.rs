//! Song imports: the Python pipeline (`opensmith-ingest`) run on one file at a time, its
//! progress read from the JSON lines it prints (`--progress-json`).
//!
//! Each import writes into its own library folder; `import.json` next to the chart remembers
//! which file it came from, so a music folder can show what is already converted.
//!
//! The queue is kept in the library folder (`imports.json`): closing the app stops the import
//! under way, and the next launch starts it again, then the rest of the queue.

use std::collections::{HashSet, VecDeque};
use std::fs;
use std::io::{BufRead, BufReader};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Instant, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// Files the pipeline turns into songs (anything ffmpeg decodes, in practice).
pub const AUDIO: &[&str] = &["mp3", "wav", "flac", "m4a", "aac", "ogg", "aif", "aiff"];
/// Tabs imported without audio (Guitar Pro 3–5) and feedpak songs (chart and audio; a
/// `.feedpak` folder counts as one file). Plugins of the pipeline add other formats
/// (`Importer::learn_formats`).
const TABS: &[(&str, &str)] = &[("gp3", "guitarpro"), ("gp4", "guitarpro"), ("gp5", "guitarpro"), ("feedpak", "feedpak")];
/// Written next to an imported chart: the file it came from.
pub const ORIGIN: &str = "import.json";
/// Written by the pipeline next to a chart made from a tab placed on the recording.
pub const TAB_RECORD: &str = "tab.json";
/// The queue, in the library folder: what is left to import when the app closes.
pub const QUEUE: &str = "imports.json";
/// Tabs placed on a song file of the same name (Guitar Pro).
const PLACED_TABS: &[&str] = &["gp3", "gp4", "gp5"];
/// Words of file names that say nothing about the song (as `align.NOISE` in the pipeline).
const NOISE: &[&str] = &[
    "official", "music", "video", "audio", "lyrics", "lyric", "hd", "hq", "4k", "upgrade", "remastered", "remaster", "version",
    "clip", "live", "feat", "ft", "the", "tab", "tabs", "guitar", "pro",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum JobState {
    Queued,
    Running,
    Done,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: u32,
    pub source: String,
    pub name: String,
    pub state: JobState,
    /// Pipeline stage (`decode`, `separate`, `stems`, `transcribe`, `beats`, `chart`).
    pub stage: Option<String>,
    /// Share of the whole import done.
    pub fraction: f64,
    /// Seconds since the import started.
    pub elapsed: f64,
    /// Library id of the chart, once done (the first one when the file held several songs).
    pub song: Option<String>,
    /// Songs imported from the file: one, or several for an archive of songs (a plugin's).
    pub songs: usize,
    pub title: Option<String>,
    pub error: Option<String>,
    /// Library folder of the song a tab is placed on (`None`: a new song).
    pub target: Option<String>,
    /// What the stage is doing now, in its own words (the pipeline being installed).
    pub detail: Option<String>,
    /// Library folder the running import writes into, removed if it is interrupted.
    #[serde(skip)]
    out: Option<PathBuf>,
    /// The running pipeline's process group.
    #[serde(skip)]
    pid: Option<u32>,
}

impl Job {
    fn new(id: u32, source: &Path, target: Option<String>) -> Job {
        Job {
            id,
            source: source.to_string_lossy().into_owned(),
            name: source.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            state: JobState::Queued,
            stage: None,
            fraction: 0.0,
            elapsed: 0.0,
            song: None,
            songs: 0,
            title: None,
            error: None,
            target,
            detail: None,
            out: None,
            pid: None,
        }
    }

    fn active(&self) -> bool {
        matches!(self.state, JobState::Queued | JobState::Running)
    }
}

/// The queue as kept on disk: imports waiting, the one under way, the failed ones.
#[derive(Default, Serialize, Deserialize)]
struct Saved {
    #[serde(default)]
    paused: bool,
    #[serde(default)]
    jobs: Vec<SavedJob>,
}

#[derive(Serialize, Deserialize)]
struct SavedJob {
    source: String,
    #[serde(default)]
    target: Option<String>,
    state: JobState,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    out: Option<PathBuf>,
    #[serde(default)]
    pid: Option<u32>,
}

/// Where an imported song came from.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Origin {
    pub source: String,
    pub size: u64,
    pub modified: u64,
}

impl Origin {
    pub fn of(path: &Path) -> Option<Origin> {
        let meta = fs::metadata(path).ok()?;
        let modified = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_secs();
        Some(Origin { source: path.to_string_lossy().into_owned(), size: meta.len(), modified })
    }
}

/// How to run the pipeline: `program args… <command> <file> -o <dir> --progress-json`.
#[derive(Clone, Debug)]
pub struct Pipeline {
    pub program: PathBuf,
    pub args: Vec<String>,
    /// PATH for the pipeline (ffmpeg, ffprobe): an app opened from the Finder gets a minimal one.
    pub path: String,
    /// The pipeline shipped inside a built app, installed before its first import.
    pub install: Option<Install>,
}

/// Finds uv where its installer or Homebrew put it; the PATH that goes with it.
fn find_uv() -> Option<(PathBuf, String)> {
    let home = dirs::home_dir().unwrap_or_default();
    let mut dirs = vec![home.join(".local/bin"), home.join(".cargo/bin")];
    #[cfg(unix)]
    dirs.extend(["/opt/homebrew/bin".into(), "/usr/local/bin".into()]);
    dirs.extend(std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect::<Vec<_>>()).unwrap_or_default());
    let program = dirs.iter().map(|d| d.join(format!("uv{}", std::env::consts::EXE_SUFFIX))).find(|p| p.is_file())?;
    let path = std::env::join_paths(&dirs).ok()?.to_string_lossy().into_owned();
    Some((program, path))
}

impl Pipeline {
    /// `uv run --project <project> opensmith-ingest`, uv found where its installer or Homebrew
    /// put it.
    pub fn uv(project: &Path) -> Option<Pipeline> {
        let (program, path) = find_uv()?;
        let args = ["run", "--project", &project.to_string_lossy(), "opensmith-ingest"].map(String::from).to_vec();
        Some(Pipeline { program, args, path, install: None })
    }

    /// The pipeline a built app carries in `resources` (`pipeline-ingest/` and `schema/`), run
    /// from its copy in `home` (see `Install`).
    pub fn bundled(resources: &Path, home: &Path) -> Option<Pipeline> {
        let (uv, path) = find_uv()?;
        Some(Pipeline::installed(uv, path, resources, home))
    }

    fn installed(uv: PathBuf, path: String, resources: &Path, home: &Path) -> Pipeline {
        let install = Install { bundled: resources.to_path_buf(), home: home.to_path_buf() };
        let project = install.project();
        let args = ["run", "--project", &project.to_string_lossy(), "--frozen", "--no-dev", "opensmith-ingest"].map(String::from).to_vec();
        Pipeline { program: uv, args, path, install: Some(install) }
    }

    /// The pipeline in its own process group (stopped whole, Python and all), at a lower
    /// priority than the game: imports go on while a song is played.
    fn command(&self, sub: &str, file: &Path, out: &Path) -> Command {
        let mut cmd = Command::new(&self.program);
        cmd.args(&self.args).arg(sub).arg(file).arg("-o").arg(out).arg("--progress-json");
        cmd.env("PATH", &self.path).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(unix)]
        {
            cmd.process_group(0);
            // SAFETY: setpriority is async-signal-safe; nothing else runs between fork and exec.
            unsafe {
                cmd.pre_exec(|| {
                    libc::setpriority(libc::PRIO_PROCESS, 0, 10);
                    Ok(())
                });
            }
        }
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NEW_PROCESS_GROUP | BELOW_NORMAL_PRIORITY_CLASS | CREATE_NO_WINDOW);
        cmd
    }
}

#[cfg(windows)]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
#[cfg(windows)]
const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;
/// No console window flashing up for the pipeline (the app has none).
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// A built app's pipeline: its sources and the chart schema, copied from the app's resources
/// into `home` as they are laid out in the repository (`pipeline-ingest/`, `schema/`), then
/// their Python environment made by `uv sync` (Python 3.11, PyTorch, Demucs, Basic Pitch:
/// about 2 GB, a few minutes, once). A new version of the app installs its own again.
#[derive(Clone, Debug)]
pub struct Install {
    pub bundled: PathBuf,
    pub home: PathBuf,
}

/// Written in the installed project once `uv sync` succeeded: the sources it was made from.
const INSTALLED: &str = ".installed";

impl Install {
    fn project(&self) -> PathBuf {
        self.home.join("pipeline-ingest")
    }

    /// A fingerprint of the sources the app carries.
    fn fingerprint(&self) -> String {
        use std::hash::{Hash, Hasher};
        fn walk(dir: &Path, root: &Path, h: &mut std::hash::DefaultHasher) {
            let mut entries: Vec<PathBuf> = fs::read_dir(dir).into_iter().flatten().flatten().map(|e| e.path()).collect();
            entries.sort();
            for path in entries {
                if path.file_name().is_some_and(|n| n == "__pycache__") {
                    continue;
                }
                if path.is_dir() {
                    walk(&path, root, h);
                } else {
                    path.strip_prefix(root).unwrap_or(&path).hash(h);
                    fs::read(&path).unwrap_or_default().hash(h);
                }
            }
        }
        let mut h = std::hash::DefaultHasher::new();
        walk(&self.bundled, &self.bundled, &mut h);
        format!("{:016x}", h.finish())
    }

    /// Is the copy missing, unfinished or older than the app's?
    pub fn needed(&self) -> bool {
        let done = fs::read_to_string(self.project().join(INSTALLED)).unwrap_or_default();
        let python = if cfg!(windows) { ".venv/Scripts/python.exe" } else { ".venv/bin/python" };
        done.trim() != self.fingerprint() || !self.project().join(python).exists()
    }

    /// Copies the sources over the previous ones (the Python environment stays, `uv sync`
    /// brings it up to date).
    fn copy(&self) -> std::io::Result<()> {
        fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
            fs::create_dir_all(to)?;
            for entry in fs::read_dir(from)?.flatten() {
                let (src, dst) = (entry.path(), to.join(entry.file_name()));
                if entry.file_name() == "__pycache__" {
                    continue;
                }
                if src.is_dir() {
                    copy_dir(&src, &dst)?;
                } else {
                    fs::copy(&src, &dst)?;
                }
            }
            Ok(())
        }
        let _ = fs::remove_file(self.project().join(INSTALLED));
        let _ = fs::remove_dir_all(self.project().join("src"));
        let _ = fs::remove_dir_all(self.home.join("schema"));
        for part in ["pipeline-ingest", "schema"] {
            copy_dir(&self.bundled.join(part), &self.home.join(part))?;
        }
        Ok(())
    }

    /// `uv sync` for the copied project, in its own process group like the pipeline.
    fn sync(&self, uv: &Path, path: &str) -> Command {
        let mut cmd = Command::new(uv);
        // Inexact: the plugins installed in the environment stay.
        cmd.args(["sync", "--project"]).arg(self.project()).args(["--frozen", "--no-dev", "--inexact"]);
        cmd.env("PATH", path).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
        #[cfg(unix)]
        cmd.process_group(0);
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
        cmd
    }
}

/// How far `uv sync` is, from the lines it prints: packages downloaded among those announced,
/// all of it once installed.
#[derive(Default)]
struct SyncProgress {
    announced: usize,
    downloaded: usize,
    fraction: f64,
}

impl SyncProgress {
    fn line(&mut self, line: &str) -> f64 {
        let line = line.trim();
        if line.starts_with("Downloading ") {
            self.announced += 1;
        } else if line.starts_with("Downloaded ") || line.starts_with("Built ") {
            self.downloaded += 1;
        } else if line.starts_with("Installed ") {
            self.fraction = 1.0;
        }
        if self.announced > 0 {
            self.fraction = self.fraction.max(0.05 + 0.9 * self.downloaded.min(self.announced) as f64 / self.announced as f64);
        }
        self.fraction
    }
}

/// Stops a pipeline and everything it started.
#[cfg(unix)]
fn kill_group(pgid: u32) {
    // SAFETY: a plain signal to a process group we started.
    unsafe {
        libc::killpg(pgid as libc::pid_t, libc::SIGKILL);
    }
}

/// Stops a pipeline and everything it started: Windows has no group to signal, the tree of
/// processes under it is ended.
#[cfg(windows)]
fn kill_group(pid: u32) {
    let _ = Command::new("taskkill").args(["/T", "/F", "/PID", &pid.to_string()]).creation_flags(CREATE_NO_WINDOW).output();
}

/// A pipeline left running by an app that quit without stopping it (a crash) is stopped, if
/// that process is still an OpenSmith import.
#[cfg(windows)]
fn stop_stale(pid: u32) {
    let query = format!("(Get-CimInstance Win32_Process -Filter 'ProcessId={pid}').CommandLine");
    let Ok(out) = Command::new("powershell").args(["-NoProfile", "-Command", &query]).creation_flags(CREATE_NO_WINDOW).output() else { return };
    if String::from_utf8_lossy(&out.stdout).contains("opensmith-ingest") {
        kill_group(pid);
    }
}

/// A pipeline left running by an app that quit without stopping it (a crash) is stopped, if
/// that process group is still an OpenSmith import.
#[cfg(unix)]
fn stop_stale(pgid: u32) {
    let Ok(ps) = Command::new("/bin/ps").args(["-A", "-o", "pgid=,command="]).output() else { return };
    let ours = String::from_utf8_lossy(&ps.stdout).lines().any(|l| {
        let (group, command) = l.trim_start().split_once(char::is_whitespace).unwrap_or_default();
        group == pgid.to_string() && command.contains("opensmith-ingest")
    });
    if ours {
        kill_group(pgid);
    }
}

fn words(name: &str) -> HashSet<String> {
    name.to_lowercase()
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| !w.is_empty() && !NOISE.contains(w))
        .map(String::from)
        .collect()
}

/// The Guitar Pro tab next to `audio` whose name says the same song (all of its words in the
/// song file's name, "Official Music Video" and the like aside), as the pipeline finds it.
pub fn tab_for(audio: &Path) -> Option<PathBuf> {
    let song = words(&audio.file_stem()?.to_string_lossy());
    let mut paths: Vec<PathBuf> = fs::read_dir(audio.parent()?).ok()?.flatten().map(|e| e.path()).collect();
    paths.sort();
    paths.into_iter().find(|p| {
        let tab = p.extension().is_some_and(|e| PLACED_TABS.contains(&e.to_string_lossy().to_lowercase().as_str()));
        let hidden = p.file_name().is_some_and(|n| n.to_string_lossy().starts_with('.'));
        let named = p.file_stem().map(|n| words(&n.to_string_lossy())).unwrap_or_default();
        tab && !hidden && named.len() >= 2 && named.is_subset(&song)
    })
}

/// Is `tab`, as it is now, the one the chart in `folder` was made from?
pub fn tab_placed(folder: &Path, tab: &Path) -> bool {
    #[derive(Deserialize)]
    struct Record {
        source: String,
        size: u64,
        modified: u64,
    }
    let Some(record) = fs::read_to_string(folder.join(TAB_RECORD)).ok().and_then(|t| serde_json::from_str::<Record>(&t).ok()) else {
        return false;
    };
    let now = Origin::of(tab);
    now.is_some_and(|o| Path::new(&record.source) == tab && o.size == record.size && o.modified == record.modified)
}

/// The pipeline command for a file, `None` if it is not something we import.
pub fn kind_of(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_string_lossy().to_lowercase();
    if AUDIO.contains(&ext.as_str()) {
        return Some("audio");
    }
    TABS.iter().find(|(e, _)| *e == ext).map(|(_, sub)| *sub)
}

/// The charts an import wrote: its folder's, or one per song in sub-folders (an archive of
/// several songs, from a plugin).
fn charts_in(out: &Path) -> Vec<PathBuf> {
    let own = out.join("song_chart.json");
    if own.is_file() {
        return vec![own];
    }
    let mut found: Vec<PathBuf> = fs::read_dir(out).into_iter().flatten().flatten().map(|e| e.path().join("song_chart.json")).filter(|p| p.is_file()).collect();
    found.sort();
    found
}

/// A new library folder named after the file: "Night Drive", "Night Drive 2"…
fn folder_for(library: &Path, file: &Path) -> PathBuf {
    let stem = file.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let clean: String = stem.chars().map(|c| if c.is_alphanumeric() || " -_.()'&".contains(c) { c } else { '-' }).collect();
    let base = clean.trim().trim_matches('.').chars().take(80).collect::<String>();
    let base = if base.is_empty() { "morceau".to_string() } else { base };
    let mut dir = library.join(&base);
    let mut n = 2;
    while dir.exists() {
        dir = library.join(format!("{base} {n}"));
        n += 1;
    }
    dir
}

type Notify = Box<dyn Fn(&Job) + Send + Sync>;

struct Inner {
    library: PathBuf,
    pipeline: Option<Pipeline>,
    notify: Notify,
    state: Mutex<State>,
    wake: Condvar,
    /// The pipeline process now running, to cancel it.
    child: Mutex<Option<(u32, Child)>>,
    /// Files the pipeline's plugins import: extension → command (`learn_formats`).
    formats: Mutex<Vec<(String, String)>>,
    /// Held while the converter is installed (an import, or a chord fixed before any import).
    installing: Mutex<()>,
}

impl Inner {
    /// The pipeline command for a file: built in (`kind_of`) or a plugin's.
    fn kind(&self, path: &Path) -> Option<String> {
        if let Some(sub) = kind_of(path) {
            return Some(sub.to_string());
        }
        let ext = path.extension()?.to_string_lossy().to_lowercase();
        self.formats.lock().unwrap().iter().find(|(e, _)| *e == ext).map(|(_, sub)| sub.clone())
    }

    /// Asks the pipeline which files its plugins import (`opensmith-ingest formats`). A built
    /// app's pipeline not installed yet has no plugins: it is asked once installed.
    fn learn_formats(&self) {
        let Some(pipeline) = &self.pipeline else { return };
        if pipeline.install.as_ref().is_some_and(Install::needed) {
            return;
        }
        let mut cmd = Command::new(&pipeline.program);
        cmd.args(&pipeline.args).arg("formats").env("PATH", &pipeline.path).stdin(Stdio::null()).stderr(Stdio::null());
        let Ok(done) = cmd.output() else { return };
        let found: std::collections::BTreeMap<String, String> = serde_json::from_slice(&done.stdout).unwrap_or_default();
        *self.formats.lock().unwrap() = found.into_iter().filter(|(ext, _)| kind_of(Path::new(&format!("x.{ext}"))).is_none()).collect();
    }
}

#[derive(Default)]
struct State {
    jobs: Vec<Job>,
    queue: VecDeque<u32>,
    next_id: u32,
    /// No new import starts (the one under way finishes).
    paused: bool,
    /// The app is closing: the import under way is left to resume at the next launch.
    closing: bool,
}

impl State {
    fn push(&mut self, source: &Path, target: Option<String>) -> Job {
        self.next_id += 1;
        let job = Job::new(self.next_id, source, target);
        self.jobs.push(job.clone());
        self.queue.push_back(job.id);
        job
    }
}

/// The queue as the imports screen shows it.
#[derive(Clone, Debug, Serialize)]
pub struct Queue {
    pub paused: bool,
    pub jobs: Vec<Job>,
}

/// Imports run one at a time on a worker thread (stem separation fills the GPU).
#[derive(Clone)]
pub struct Importer {
    inner: Arc<Inner>,
}

impl Importer {
    /// Replaces chords everywhere in an MP3's chord chart (`changes`: "G=Em"…) with the
    /// converter's `chords` command, which makes the chart again; how many beats changed. The
    /// converter a new version of the app brings is installed first, as before an import.
    pub fn fix_chords(&self, chart: &Path, changes: &[String]) -> Result<u32, String> {
        let pipeline = self.inner.pipeline.as_ref().ok_or("uv is not installed: run `brew install uv ffmpeg`")?;
        if let Some(install) = &pipeline.install {
            let _installing = self.inner.installing.lock().unwrap();
            if install.needed() {
                install.copy().map_err(|e| format!("could not copy the converter: {e}"))?;
                let done = install.sync(&pipeline.program, &pipeline.path).output().map_err(|e| format!("uv sync did not start: {e}"))?;
                if !done.status.success() {
                    return Err(format!("installing the converter failed: {}", last_line(&done.stderr)));
                }
                let _ = fs::write(install.project().join(INSTALLED), install.fingerprint());
            }
        }
        let mut cmd = Command::new(&pipeline.program);
        cmd.args(&pipeline.args).arg("chords").arg(chart);
        for change in changes {
            cmd.arg("--set").arg(change);
        }
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);
        let done = cmd.env("PATH", &pipeline.path).stdin(Stdio::null()).output().map_err(|e| e.to_string())?;
        if !done.status.success() {
            return Err(last_line(&done.stderr));
        }
        #[derive(Deserialize)]
        struct Done {
            changed: u32,
        }
        serde_json::from_str::<Done>(&last_line(&done.stdout)).map(|d| d.changed).map_err(|e| e.to_string())
    }

    /// Starts the worker, on the queue left by the last run if there is one.
    pub fn new(library: PathBuf, pipeline: Option<Pipeline>, notify: impl Fn(&Job) + Send + Sync + 'static) -> Importer {
        let state = resume(&library);
        let inner = Arc::new(Inner {
            library,
            pipeline,
            notify: Box::new(notify),
            state: Mutex::new(state),
            wake: Condvar::new(),
            child: Mutex::new(None),
            formats: Mutex::new(Vec::new()),
            installing: Mutex::new(()),
        });
        let learner = inner.clone();
        thread::Builder::new().name("opensmith-formats".into()).spawn(move || learner.learn_formats()).expect("formats thread");
        let worker = inner.clone();
        thread::Builder::new().name("opensmith-import".into()).spawn(move || work(&worker)).expect("import thread");
        Importer { inner }
    }

    /// Queues a file; `None` if it is not a song or tab file. A file already waiting or under
    /// way is not queued twice.
    /// The extensions the pipeline's plugins import, besides the built-in ones.
    pub fn plugin_formats(&self) -> Vec<String> {
        self.inner.formats.lock().unwrap().iter().map(|(ext, _)| ext.clone()).collect()
    }

    /// Is `path` a file the pipeline imports (built in or through a plugin)?
    pub fn accepts(&self, path: &Path) -> bool {
        self.inner.kind(path).is_some()
    }

    /// Asks the pipeline again which files its plugins import (a plugin was just installed).
    pub fn learn_formats(&self) {
        self.inner.learn_formats();
    }

    pub fn add(&self, path: &Path) -> Option<Job> {
        self.inner.kind(path)?;
        let source = path.to_string_lossy();
        let mut st = self.inner.state.lock().unwrap();
        if let Some(job) = st.jobs.iter().find(|j| j.active() && j.target.is_none() && j.source == source) {
            return Some(job.clone());
        }
        let job = st.push(path, None);
        save(&self.inner, &st);
        drop(st);
        (self.inner.notify)(&job);
        self.inner.wake.notify_all();
        Some(job)
    }

    /// Queues placing a Guitar Pro `tab` on the song already converted in library `folder`.
    pub fn place_tab(&self, tab: &Path, folder: &Path) -> Job {
        let mut st = self.inner.state.lock().unwrap();
        let job = st.push(tab, Some(folder.to_string_lossy().into_owned()));
        save(&self.inner, &st);
        drop(st);
        (self.inner.notify)(&job);
        self.inner.wake.notify_all();
        job
    }

    pub fn queue(&self) -> Queue {
        let st = self.inner.state.lock().unwrap();
        Queue { paused: st.paused, jobs: st.jobs.clone() }
    }

    /// Holds the queue (the import under way finishes), or lets it go on.
    pub fn set_paused(&self, on: bool) {
        let mut st = self.inner.state.lock().unwrap();
        st.paused = on;
        save(&self.inner, &st);
        drop(st);
        self.inner.wake.notify_all();
    }

    /// Stops an import (kills the pipeline if it is running).
    pub fn cancel(&self, id: u32) {
        let mut st = self.inner.state.lock().unwrap();
        st.queue.retain(|&q| q != id);
        if let Some(job) = st.jobs.iter_mut().find(|j| j.id == id && j.state == JobState::Queued) {
            job.state = JobState::Cancelled;
            let job = job.clone();
            save(&self.inner, &st);
            drop(st);
            (self.inner.notify)(&job);
            return;
        }
        drop(st);
        if let Some((running, child)) = self.inner.child.lock().unwrap().as_ref()
            && *running == id
        {
            kill_group(child.id());
        }
    }

    /// Cancels every import still waiting (not the one under way).
    pub fn cancel_queued(&self) {
        let mut st = self.inner.state.lock().unwrap();
        let waiting: Vec<u32> = st.queue.drain(..).collect();
        let mut cancelled = Vec::new();
        for job in st.jobs.iter_mut().filter(|j| waiting.contains(&j.id) && j.state == JobState::Queued) {
            job.state = JobState::Cancelled;
            cancelled.push(job.clone());
        }
        save(&self.inner, &st);
        drop(st);
        cancelled.iter().for_each(|j| (self.inner.notify)(j));
    }

    /// Forgets a finished import.
    pub fn dismiss(&self, id: u32) {
        let mut st = self.inner.state.lock().unwrap();
        st.jobs.retain(|j| j.id != id || j.active());
        save(&self.inner, &st);
    }

    /// The app closes: no new import starts, the one under way stops and stays in the queue,
    /// to start again at the next launch.
    pub fn shutdown(&self) {
        self.inner.state.lock().unwrap().closing = true;
        if let Some((_, child)) = self.inner.child.lock().unwrap().as_ref() {
            kill_group(child.id());
        }
    }
}

/// The queue left by the last run: the import it stopped (its partial folder removed) and those
/// waiting go back in line, the failed ones stay to be retried.
fn resume(library: &Path) -> State {
    let mut st = State::default();
    let Some(saved) = fs::read_to_string(library.join(QUEUE)).ok().and_then(|t| serde_json::from_str::<Saved>(&t).ok()) else {
        return st;
    };
    st.paused = saved.paused;
    for s in saved.jobs {
        if s.state == JobState::Running {
            if let Some(pid) = s.pid {
                stop_stale(pid);
            }
            // Only a new song's folder, inside the library, is ever removed.
            if let Some(out) = s.out.filter(|o| s.target.is_none() && o.starts_with(library) && o != library) {
                let _ = fs::remove_dir_all(out);
            }
        }
        if s.state == JobState::Failed {
            st.next_id += 1;
            let mut job = Job::new(st.next_id, Path::new(&s.source), s.target);
            job.state = JobState::Failed;
            job.error = s.error;
            st.jobs.push(job);
        } else if matches!(s.state, JobState::Queued | JobState::Running) {
            st.push(Path::new(&s.source), s.target);
        }
    }
    st
}

/// Writes the queue down (atomically): waiting, under way and failed imports, and the pause.
fn save(inner: &Inner, st: &State) {
    let path = inner.library.join(QUEUE);
    let jobs: Vec<SavedJob> = st
        .jobs
        .iter()
        .filter(|j| j.active() || j.state == JobState::Failed)
        .map(|j| SavedJob {
            source: j.source.clone(),
            target: j.target.clone(),
            state: j.state,
            error: j.error.clone(),
            out: j.out.clone(),
            pid: j.pid,
        })
        .collect();
    if jobs.is_empty() && !st.paused {
        let _ = fs::remove_file(&path);
        return;
    }
    let Ok(text) = serde_json::to_string_pretty(&Saved { paused: st.paused, jobs }) else { return };
    let tmp = path.with_extension("json.tmp");
    if fs::write(&tmp, text).is_ok() {
        let _ = fs::rename(&tmp, &path);
    }
}

/// Changes a job and tells the app; the queue is written down when its state or folder changes.
fn update(inner: &Inner, id: u32, f: impl FnOnce(&mut Job)) -> Option<Job> {
    let mut st = inner.state.lock().unwrap();
    let job = st.jobs.iter_mut().find(|j| j.id == id)?;
    let before = (job.state, job.out.clone(), job.pid);
    f(job);
    let changed = before != (job.state, job.out.clone(), job.pid);
    let job = job.clone();
    if changed {
        save(inner, &st);
    }
    drop(st);
    (inner.notify)(&job);
    Some(job)
}

fn work(inner: &Inner) {
    loop {
        let id = {
            let mut st = inner.state.lock().unwrap();
            loop {
                if !st.paused
                    && !st.closing
                    && let Some(id) = st.queue.pop_front()
                {
                    break id;
                }
                st = inner.wake.wait(st).unwrap();
            }
        };
        run(inner, id);
    }
}

/// Installs a built app's pipeline before the import `id`, which shows its progress (stage
/// `install`). `Err(None)`: stopped (import cancelled or app closing), already reported.
/// The last line a process wrote that says something.
fn last_line(out: &[u8]) -> String {
    String::from_utf8_lossy(out).lines().rev().find(|l| !l.trim().is_empty()).unwrap_or_default().trim().to_string()
}

fn install_pipeline(inner: &Inner, id: u32, install: &Install, pipeline: &Pipeline) -> Result<(), Option<String>> {
    let _installing = inner.installing.lock().unwrap();
    update(inner, id, |j| {
        j.stage = Some("install".into());
        j.fraction = 0.0;
    });
    install.copy().map_err(|e| Some(format!("could not copy the converter to {}: {e}", install.home.display())))?;
    let mut child = install.sync(&pipeline.program, &pipeline.path).spawn().map_err(|e| Some(format!("uv sync did not start: {e}")))?;
    update(inner, id, |j| j.pid = Some(child.id()));
    let stderr = child.stderr.take();
    *inner.child.lock().unwrap() = Some((id, child));
    let mut progress = SyncProgress::default();
    let mut last = String::new();
    for line in stderr.into_iter().flat_map(|e| BufReader::new(e).lines().map_while(Result::ok)) {
        let fraction = progress.line(&line);
        last = line.trim().to_string();
        update(inner, id, |j| {
            j.fraction = fraction;
            j.detail = Some(last.clone());
        });
    }
    let status = inner.child.lock().unwrap().take().map(|(_, mut c)| c.wait());
    let (cancelled, closing) = {
        let st = inner.state.lock().unwrap();
        (st.jobs.iter().any(|j| j.id == id && j.state == JobState::Cancelled), st.closing)
    };
    if closing {
        return Err(None);
    }
    if cancelled || matches!(status, Some(Ok(s)) if s.code().is_none()) {
        update(inner, id, |j| j.state = JobState::Cancelled);
        return Err(None);
    }
    if !matches!(status, Some(Ok(s)) if s.success()) {
        return Err(Some(format!("installing the converter failed: {last}")));
    }
    let _ = fs::write(install.project().join(INSTALLED), install.fingerprint());
    inner.learn_formats();
    update(inner, id, |j| {
        j.fraction = 0.0;
        j.detail = None;
    });
    Ok(())
}

/// Runs one import to its end; the job ends Done, Failed or Cancelled.
fn run(inner: &Inner, id: u32) {
    let start = Instant::now();
    let Some(job) = update(inner, id, |j| {
        if j.state == JobState::Queued {
            j.state = JobState::Running;
        }
    }) else {
        return;
    };
    if job.state != JobState::Running {
        return;
    }
    let source = PathBuf::from(&job.source);
    let fail = |error: String| {
        update(inner, id, |j| {
            j.state = JobState::Failed;
            j.error = Some(error);
            j.elapsed = start.elapsed().as_secs_f64();
        });
    };
    let Some(pipeline) = &inner.pipeline else {
        return fail("uv is not installed: run `brew install uv ffmpeg` to convert songs".into());
    };
    // A tab placed on a converted song works in that song's folder, which must survive a failure.
    let target = job.target.as_ref().map(PathBuf::from);
    let sub = match &target {
        Some(_) => "retab".to_string(),
        None => match inner.kind(&source) {
            Some(sub) => sub,
            None => return fail("unsupported file format".into()),
        },
    };
    if !source.is_file() {
        return fail(format!("file not found: {}", source.display()));
    }
    if let Some(install) = pipeline.install.as_ref().filter(|i| i.needed()) {
        match install_pipeline(inner, id, install, pipeline) {
            Ok(()) => {}
            Err(None) => return,
            Err(Some(e)) => return fail(e),
        }
    }
    let out = target.clone().unwrap_or_else(|| folder_for(&inner.library, &source));
    // The folder is written down before the pipeline starts: an import interrupted by closing
    // the app leaves nothing behind at the next launch.
    update(inner, id, |j| j.out = target.is_none().then(|| out.clone()));
    let mut child = match pipeline.command(&sub, &source, &out).spawn() {
        Ok(c) => c,
        Err(e) => return fail(format!("the converter did not start: {e}")),
    };
    update(inner, id, |j| j.pid = Some(child.id()));
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    *inner.child.lock().unwrap() = Some((id, child));

    // stderr is drained on its own thread so the pipeline never blocks on a full pipe.
    let errors = thread::spawn(move || {
        let mut tail: VecDeque<String> = VecDeque::new();
        for line in stderr.map(|e| BufReader::new(e).lines().map_while(Result::ok).collect::<Vec<_>>()).unwrap_or_default() {
            if tail.len() == 20 {
                tail.pop_front();
            }
            tail.push_back(line);
        }
        tail
    });
    let mut reported: Option<String> = None;
    let mut title = None;
    for line in stdout.into_iter().flat_map(|o| BufReader::new(o).lines().map_while(Result::ok)) {
        let Ok(msg) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        if let Some(stage) = msg.get("stage").and_then(|s| s.as_str()) {
            let fraction = msg.get("fraction").and_then(|f| f.as_f64()).unwrap_or(0.0);
            update(inner, id, |j| {
                j.stage = Some(stage.to_string());
                j.fraction = fraction.max(j.fraction);
                j.elapsed = start.elapsed().as_secs_f64();
            });
        } else if let Some(e) = msg.get("error").and_then(|e| e.as_str()) {
            reported = Some(e.to_string());
        } else if msg.get("done").is_some() {
            title = msg.get("title").and_then(|t| t.as_str()).map(String::from);
        }
    }
    let status = inner.child.lock().unwrap().take().map(|(_, mut c)| c.wait());
    let tail = errors.join().unwrap_or_default();
    let charts = charts_in(&out);
    let (cancelled, closing) = {
        let st = inner.state.lock().unwrap();
        (st.jobs.iter().any(|j| j.id == id && j.state == JobState::Cancelled), st.closing)
    };
    let ok = matches!(status, Some(Ok(s)) if s.success()) && !charts.is_empty();
    if !ok {
        if target.is_none() {
            let _ = fs::remove_dir_all(&out);
        }
        // Stopped by the app closing: still in the queue as under way, for the next launch.
        if closing {
            return;
        }
        if cancelled || matches!(status, Some(Ok(s)) if s.code().is_none()) {
            update(inner, id, |j| {
                j.state = JobState::Cancelled;
                j.elapsed = start.elapsed().as_secs_f64();
            });
            return;
        }
        let why = reported.or_else(|| tail.back().cloned()).unwrap_or_else(|| "the conversion failed".into());
        return fail(why);
    }
    if let Some(origin) = Origin::of(&source).filter(|_| target.is_none()) {
        for chart in &charts {
            let _ = fs::write(chart.with_file_name(ORIGIN), serde_json::to_string_pretty(&origin).unwrap_or_default());
        }
    }
    let chart = &charts[0];
    let song = chart.strip_prefix(&inner.library).unwrap_or(chart).components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/");
    let songs = charts.len();
    update(inner, id, |j| {
        j.state = JobState::Done;
        j.stage = Some("done".into());
        j.fraction = 1.0;
        j.song = Some(song);
        j.songs = songs;
        j.title = title;
        j.elapsed = start.elapsed().as_secs_f64();
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    fn scratch(name: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("opensmith-import-{name}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A stand-in pipeline: a shell script receiving `<command> <file> -o <dir> --progress-json`.
    fn fake(dir: &Path, body: &str) -> Pipeline {
        let script = dir.join("fake-ingest.sh");
        fs::write(&script, format!("#!/bin/sh\nout=\"$4\"\n{body}\n")).unwrap();
        Pipeline { program: "/bin/sh".into(), args: vec![script.to_string_lossy().into_owned()], path: std::env::var("PATH").unwrap_or_default(), install: None }
    }

    #[test]
    fn a_chord_fixed_runs_the_converter_on_the_chart_and_says_how_many_beats() {
        let dir = scratch("fix-chords");
        let chart = dir.join("song_chart.chords.json");
        // The converter is asked `chords <chart> --set G=Em --set C=C5`, and answers on its last line.
        let pipeline = fake(&dir, r#"[ "$1" = chords ] && [ "$3 $4 $5 $6" = "--set G=Em --set C=C5" ] && echo "$2" > "$2.done" && echo 'Loading…' && echo '{"changed": 12}'"#);
        let importer = Importer::new(dir.join("library"), Some(pipeline), |_| {});
        assert_eq!(importer.fix_chords(&chart, &["G=Em".into(), "C=C5".into()]), Ok(12));
        assert!(dir.join("song_chart.chords.json.done").exists());
        // A refusal comes back in the converter's words.
        let failing = Importer::new(dir.join("library"), Some(fake(&dir, "echo 'not a chord chart: C/E at 1.00 s' >&2; exit 1")), |_| {});
        assert_eq!(failing.fix_chords(&chart, &[]), Err("not a chord chart: C/E at 1.00 s".into()));
    }

    fn setup(name: &str, body: &str) -> (Importer, mpsc::Receiver<Job>, PathBuf, PathBuf) {
        let dir = scratch(name);
        let library = dir.join("library");
        fs::create_dir_all(&library).unwrap();
        let song = dir.join("Some Band - Song.mp3");
        fs::write(&song, b"mp3").unwrap();
        let (tx, rx) = mpsc::channel();
        let importer = Importer::new(library.clone(), Some(fake(&dir, body)), move |j| drop(tx.send(j.clone())));
        (importer, rx, library, song)
    }

    fn until_finished(rx: &mpsc::Receiver<Job>) -> Vec<Job> {
        until_finished_within(rx, Duration::from_secs(10))
    }

    fn until_finished_within(rx: &mpsc::Receiver<Job>, quiet: Duration) -> Vec<Job> {
        let mut seen = Vec::new();
        loop {
            let job = rx.recv_timeout(quiet).expect("import never finished");
            let end = matches!(job.state, JobState::Done | JobState::Failed | JobState::Cancelled);
            seen.push(job);
            if end {
                return seen;
            }
        }
    }

    #[test]
    fn an_import_reports_its_progress_and_lands_in_the_library() {
        let (importer, rx, library, song) = setup(
            "ok",
            r#"echo 'loading libraries…'
echo '{"stage": "decode", "fraction": 0.0}'
echo '{"stage": "separate", "fraction": 0.3}'
echo 'warning: something' >&2
echo '{"stage": "separate", "fraction": 0.55}'
mkdir -p "$out" && echo '{}' > "$out/song_chart.json"
echo '{"done": true, "title": "Song"}'"#,
        );
        assert!(importer.add(&library.join("cover.jpg")).is_none(), "not a song");
        let job = importer.add(&song).unwrap();
        let seen = until_finished(&rx);
        let fractions: Vec<f64> = seen.iter().map(|j| j.fraction).collect();
        assert!(fractions.windows(2).all(|w| w[0] <= w[1]), "{fractions:?}");
        assert!(seen.iter().any(|j| j.stage.as_deref() == Some("separate") && j.fraction == 0.3));
        let done = seen.last().unwrap();
        assert_eq!((done.id, done.state), (job.id, JobState::Done));
        assert_eq!(done.song.as_deref(), Some("Some Band - Song/song_chart.json"));
        assert_eq!(done.title.as_deref(), Some("Song"));
        let origin: Origin = serde_json::from_str(&fs::read_to_string(library.join("Some Band - Song").join(ORIGIN)).unwrap()).unwrap();
        assert_eq!(origin.source, song.to_string_lossy());

        // The same file again gets its own folder.
        importer.add(&song).unwrap();
        assert_eq!(until_finished(&rx).last().unwrap().song.as_deref(), Some("Some Band - Song 2/song_chart.json"));
    }

    #[test]
    fn a_built_app_installs_its_pipeline_before_the_first_import() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("install");
        let resources = dir.join("resources");
        fs::create_dir_all(resources.join("pipeline-ingest/src/pkg/__pycache__")).unwrap();
        fs::create_dir_all(resources.join("schema")).unwrap();
        fs::write(resources.join("pipeline-ingest/pyproject.toml"), "[project]").unwrap();
        fs::write(resources.join("pipeline-ingest/src/pkg/cli.py"), "").unwrap();
        fs::write(resources.join("pipeline-ingest/src/pkg/__pycache__/cli.pyc"), "").unwrap();
        fs::write(resources.join("schema/chart.schema.json"), "{}").unwrap();
        // A stand-in uv: `sync` prints what uv prints and makes the environment, `run` imports.
        let uv = dir.join("uv");
        fs::write(
            &uv,
            r#"#!/bin/sh
if [ "$1" = sync ]; then
  echo 'Resolved 3 packages in 2ms' >&2
  echo 'Downloading torch (70.0MiB)' >&2
  echo 'Downloading numpy (5.1MiB)' >&2
  echo ' Downloaded numpy' >&2
  echo ' Downloaded torch' >&2
  echo 'Installed 3 packages in 1.2s' >&2
  mkdir -p "$3/.venv/bin" && touch "$3/.venv/bin/python" && echo synced >> "$3/../syncs"
  exit 0
fi
out="${10}"
mkdir -p "$out" && echo '{}' > "$out/song_chart.json"
echo '{"done": true, "title": "Song"}'
"#,
        )
        .unwrap();
        fs::set_permissions(&uv, fs::Permissions::from_mode(0o755)).unwrap();
        let (library, data) = (dir.join("library"), dir.join("data"));
        fs::create_dir_all(&library).unwrap();
        let song = dir.join("Some Band - Song.mp3");
        fs::write(&song, b"mp3").unwrap();
        let pipeline = Pipeline::installed(uv, std::env::var("PATH").unwrap_or_default(), &resources, &data);
        let (tx, rx) = mpsc::channel();
        let importer = Importer::new(library, Some(pipeline), move |j| drop(tx.send(j.clone())));

        importer.add(&song).unwrap();
        let seen = until_finished(&rx);
        assert_eq!(seen.last().unwrap().state, JobState::Done, "{seen:?}");
        let install: Vec<&Job> = seen.iter().filter(|j| j.stage.as_deref() == Some("install")).collect();
        assert!(install.iter().any(|j| j.detail.as_deref() == Some("Downloaded torch")));
        assert!(install.iter().any(|j| j.fraction > 0.9), "the install shows its progress");
        assert!(data.join("pipeline-ingest/src/pkg/cli.py").is_file() && data.join("schema/chart.schema.json").is_file());
        assert!(!data.join("pipeline-ingest/src/pkg/__pycache__").exists());

        // Installed once: the next import goes straight to the pipeline.
        importer.add(&song).unwrap();
        let seen = until_finished(&rx);
        assert_eq!(seen.last().unwrap().state, JobState::Done);
        assert!(seen.iter().all(|j| j.stage.as_deref() != Some("install")));
        assert_eq!(fs::read_to_string(data.join("syncs")).unwrap(), "synced\n");

        // A new version of the app installs its own sources again.
        fs::write(resources.join("pipeline-ingest/src/pkg/cli.py"), "print('new')").unwrap();
        importer.add(&song).unwrap();
        until_finished(&rx);
        assert_eq!(fs::read_to_string(data.join("syncs")).unwrap(), "synced\nsynced\n");
        assert_eq!(fs::read_to_string(data.join("pipeline-ingest/src/pkg/cli.py")).unwrap(), "print('new')");
    }

    #[test]
    fn an_archive_of_several_songs_from_a_plugin_lands_as_one_song_each() {
        let (importer, rx, library, song) = setup(
            "archive",
            r#"if [ "$1" = formats ]; then echo '{"arc": "arc", "mp3": "nope"}'; exit 0; fi
[ "$1" = arc ] || exit 1
for s in "Band A - One" "Band B - Two"; do mkdir -p "$out/$s" && echo '{}' > "$out/$s/song_chart.json"; done
echo '{"done": true, "title": "2 morceaux", "songs": 2}'"#,
        );
        // The plugin's files are known once the pipeline was asked; built-in ones stay built in.
        importer.learn_formats();
        assert_eq!(importer.plugin_formats(), ["arc"]);
        assert!(!importer.accepts(Path::new("notes.txt")));
        let archive = song.with_file_name("songs.arc");
        fs::write(&archive, b"ARC").unwrap();
        importer.add(&archive).unwrap();
        let done = until_finished(&rx).pop().unwrap();
        assert_eq!((done.state, done.songs), (JobState::Done, 2));
        assert_eq!(done.song.as_deref(), Some("songs/Band A - One/song_chart.json"));
        for s in ["Band A - One", "Band B - Two"] {
            let origin: Origin = serde_json::from_str(&fs::read_to_string(library.join("songs").join(s).join(ORIGIN)).unwrap()).unwrap();
            assert_eq!(origin.source, archive.to_string_lossy(), "each song remembers the archive");
        }
    }

    #[test]
    fn each_kind_of_file_goes_to_its_pipeline_command() {
        assert_eq!(kind_of(Path::new("a/Song.MP3")), Some("audio"));
        assert_eq!(kind_of(Path::new("a/tab.gp4")), Some("guitarpro"));
        assert_eq!(kind_of(Path::new("a/Night Drive.feedpak")), Some("feedpak"));
        assert_eq!(kind_of(Path::new("a/notes.txt")), None);
    }

    #[test]
    fn a_tab_is_found_next_to_its_song_by_name() {
        let dir = scratch("tabs");
        for name in [
            "Larsen - Come Back Home (Official Music Video).mp3",
            "Band Of The Week - D.I.Y. (Official HD Video).mp3",
            "Band Of The Week - Night Drive (Official HD Video).mp3",
            "larsen-come_back_home.gp3",
            "band-of-the-week-d_i_y.gp4",
            "notes.gp5",
        ] {
            fs::write(dir.join(name), b"").unwrap();
        }
        let tab = |song: &str| tab_for(&dir.join(song)).map(|p| p.file_name().unwrap().to_string_lossy().into_owned());
        assert_eq!(tab("Larsen - Come Back Home (Official Music Video).mp3").as_deref(), Some("larsen-come_back_home.gp3"));
        assert_eq!(tab("Band Of The Week - D.I.Y. (Official HD Video).mp3").as_deref(), Some("band-of-the-week-d_i_y.gp4"));
        assert_eq!(tab("Band Of The Week - Night Drive (Official HD Video).mp3"), None);
    }

    #[test]
    fn a_tab_is_placed_on_a_converted_song_in_its_own_folder() {
        // The fake pipeline fails once, then writes the chart and the tab record.
        let (importer, rx, library, song) = setup(
            "retab",
            r#"if [ "$1" != "retab" ]; then exit 3; fi
if [ ! -f "$out/attempted" ]; then touch "$out/attempted"; echo '{"error": "no stem"}'; exit 1; fi
echo '{"stage": "chart", "fraction": 0.5}'
echo '{}' > "$out/song_chart.json"
echo "{\"source\": \"$2\"}" > "$out/tab.json"
echo '{"done": true, "title": "Song"}'"#,
        );
        let folder = library.join("Some Band - Song");
        fs::create_dir_all(&folder).unwrap();
        let origin = r#"{"source": "song.mp3", "size": 3, "modified": 1}"#;
        fs::write(folder.join(ORIGIN), origin).unwrap();
        let tab = song.with_file_name("some-band-song.gp4");
        fs::write(&tab, b"gp4").unwrap();

        importer.place_tab(&tab, &folder);
        let failed = until_finished(&rx).pop().unwrap();
        assert_eq!((failed.state, failed.error.as_deref()), (JobState::Failed, Some("no stem")));
        assert!(folder.join(ORIGIN).is_file(), "a failed placement keeps the song");

        importer.place_tab(&tab, &folder);
        let done = until_finished(&rx).pop().unwrap();
        assert_eq!(done.state, JobState::Done);
        assert_eq!(done.song.as_deref(), Some("Some Band - Song/song_chart.json"));
        assert_eq!(fs::read_to_string(folder.join(ORIGIN)).unwrap(), origin, "the song still comes from its audio file");
        assert!(folder.join(TAB_RECORD).is_file());
    }

    #[test]
    fn a_failed_import_says_why_and_leaves_nothing_behind() {
        let (importer, rx, library, song) = setup(
            "fail",
            r#"mkdir -p "$out"
echo '{"stage": "decode", "fraction": 0.0}'
echo '{"error": "ffmpeg could not read Song.mp3: Invalid data"}'
exit 1"#,
        );
        importer.add(&song).unwrap();
        let done = until_finished(&rx).pop().unwrap();
        assert_eq!(done.state, JobState::Failed);
        assert_eq!(done.error.as_deref(), Some("ffmpeg could not read Song.mp3: Invalid data"));
        let left: Vec<_> = fs::read_dir(&library).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(left, [QUEUE], "partial output removed, the failure kept to retry");
    }

    #[test]
    fn an_import_can_be_cancelled_while_running_or_queued() {
        let (importer, rx, library, song) = setup(
            "cancel",
            r#"mkdir -p "$out"
echo '{"stage": "separate", "fraction": 0.1}'
exec sleep 30"#,
        );
        let first = importer.add(&song).unwrap();
        let other = song.with_file_name("Other Band - Other Song.mp3");
        fs::write(&other, b"mp3").unwrap();
        let second = importer.add(&other).unwrap();
        loop {
            let j = rx.recv_timeout(Duration::from_secs(10)).unwrap();
            if j.id == first.id && j.stage.is_some() {
                break;
            }
        }
        importer.cancel(second.id);
        importer.cancel(first.id);
        let mut ended = Vec::new();
        while ended.len() < 2 {
            let j = rx.recv_timeout(Duration::from_secs(10)).unwrap();
            if j.state == JobState::Cancelled {
                ended.push(j.id);
            }
        }
        ended.sort();
        assert_eq!(ended, vec![first.id, second.id]);
        assert!(fs::read_dir(&library).unwrap().next().is_none());
        importer.dismiss(first.id);
        assert_eq!(importer.queue().jobs.len(), 1);
        assert!(!library.join(QUEUE).exists(), "nothing left to resume");
    }

    /// Waits for `n` imports to end, whatever else is reported meanwhile.
    fn until_ended(rx: &mpsc::Receiver<Job>, n: usize) -> Vec<Job> {
        let mut ended = Vec::new();
        while ended.len() < n {
            let job = rx.recv_timeout(Duration::from_secs(10)).expect("imports never finished");
            if !job.active() {
                ended.push(job);
            }
        }
        ended
    }

    #[test]
    fn a_queue_closed_mid_import_resumes_at_the_next_launch() {
        // Songs wait while a `hold` file sits next to them, as if they took long to import.
        let body = r#"mkdir -p "$out"
echo '{"stage": "decode", "fraction": 0.1}'
while [ -f "$(dirname "$2")/hold" ]; do sleep 0.05; done
echo '{}' > "$out/song_chart.json"
echo '{"done": true}'"#;
        let (importer, rx, library, song) = setup("resume", body);
        let dir = song.parent().unwrap().to_path_buf();
        let hold = dir.join("hold");
        fs::write(&hold, b"").unwrap();
        let songs: Vec<PathBuf> = ["One.mp3", "Two.mp3", "Three.mp3"].iter().map(|n| dir.join(n)).collect();
        for s in &songs {
            fs::write(s, b"PSAR").unwrap();
            importer.add(s).unwrap();
        }
        assert_eq!(importer.add(&songs[2]).unwrap().id, 3, "a song waiting is not queued twice");
        loop {
            let j = rx.recv_timeout(Duration::from_secs(10)).unwrap();
            if j.name == "One.mp3" && j.stage.is_some() {
                break;
            }
        }
        assert!(library.join("One").is_dir());

        // The app closes during the first import: it stops, the queue stays on disk.
        importer.shutdown();
        let saved: Saved = serde_json::from_str(&fs::read_to_string(library.join(QUEUE)).unwrap()).unwrap();
        let states: Vec<JobState> = saved.jobs.iter().map(|j| j.state).collect();
        assert_eq!(states, [JobState::Running, JobState::Queued, JobState::Queued]);
        assert_eq!(saved.jobs[0].out.as_deref(), Some(library.join("One").as_path()));
        let deadline = Instant::now() + Duration::from_secs(5);
        while library.join("One").exists() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }

        // Next launch: the three of them, in order, each in one folder.
        fs::remove_file(&hold).unwrap();
        let (tx, rx) = mpsc::channel();
        let pipeline = importer.inner.pipeline.clone();
        let again = Importer::new(library.clone(), pipeline, move |j| drop(tx.send(j.clone())));
        assert_eq!(again.queue().jobs.len(), 3);
        let ended = until_ended(&rx, 3);
        let names: Vec<&str> = ended.iter().map(|j| j.name.as_str()).collect();
        assert_eq!(names, ["One.mp3", "Two.mp3", "Three.mp3"]);
        assert!(ended.iter().all(|j| j.state == JobState::Done));
        let mut folders: Vec<String> = fs::read_dir(&library).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        folders.sort();
        assert_eq!(folders, ["One", "Three", "Two"], "no leftover nor duplicate, queue file gone");
    }

    #[test]
    fn a_paused_queue_waits_and_stays_paused_at_the_next_launch() {
        let (importer, rx, library, song) = setup(
            "pause",
            r#"mkdir -p "$out" && echo '{}' > "$out/song_chart.json"
echo '{"done": true}'"#,
        );
        importer.set_paused(true);
        importer.add(&song).unwrap();
        assert!(rx.recv_timeout(Duration::from_millis(400)).is_ok_and(|j| j.state == JobState::Queued));
        assert!(rx.recv_timeout(Duration::from_millis(400)).is_err(), "nothing starts while paused");
        importer.shutdown();

        let (tx, rx) = mpsc::channel();
        let again = Importer::new(library.clone(), importer.inner.pipeline.clone(), move |j| drop(tx.send(j.clone())));
        assert!(again.queue().paused);
        assert!(rx.recv_timeout(Duration::from_millis(400)).is_err());
        again.set_paused(false);
        assert_eq!(until_ended(&rx, 1)[0].state, JobState::Done);
        assert!(!library.join(QUEUE).exists());
    }

    #[test]
    fn the_queue_can_be_emptied_and_failures_are_kept_for_later() {
        let (importer, rx, library, song) = setup("empty", "echo '{\"error\": \"archive illisible\"}'; exit 1");
        importer.set_paused(true);
        let dir = song.parent().unwrap();
        for n in ["A.mp3", "B.mp3", "C.mp3"] {
            fs::write(dir.join(n), b"PSAR").unwrap();
            importer.add(&dir.join(n)).unwrap();
        }
        importer.cancel_queued();
        assert!(importer.queue().jobs.iter().all(|j| j.state == JobState::Cancelled));
        importer.add(&song).unwrap();
        importer.set_paused(false);
        let failed = until_ended(&rx, 4).pop().unwrap();
        assert_eq!((failed.state, failed.error.as_deref()), (JobState::Failed, Some("archive illisible")));

        let again = Importer::new(library.clone(), None, |_| {});
        let kept = again.queue().jobs;
        assert_eq!(kept.len(), 1);
        assert_eq!((kept[0].state, kept[0].name.as_str()), (JobState::Failed, "Some Band - Song.mp3"));
    }

    #[test]
    #[ignore = "runs the Python pipeline through uv (about 20 s)"]
    fn the_real_pipeline_converts_an_mp3() {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let mp3 = repo.join("out/demo/demo_rock.mp3");
        let library = scratch("real").join("library");
        fs::create_dir_all(&library).unwrap();
        let pipeline = Pipeline::uv(&repo.join("pipeline-ingest")).expect("uv installed");
        let (tx, rx) = mpsc::channel();
        let importer = Importer::new(library.clone(), Some(pipeline), move |j| drop(tx.send(j.clone())));
        importer.add(&mp3).unwrap();
        let seen = until_finished_within(&rx, Duration::from_secs(120));
        let done = seen.last().unwrap();
        assert_eq!(done.state, JobState::Done, "{:?}", done.error);
        let stages: Vec<&str> = seen.iter().filter_map(|j| j.stage.as_deref()).collect();
        let separating = seen.iter().filter(|j| j.stage.as_deref() == Some("separate")).count();
        println!("{} updates, {separating} during separation, {:.1} s", seen.len(), done.elapsed);
        assert!(separating > 3, "separation reports its own progress");
        for stage in ["decode", "separate", "stems", "transcribe", "beats", "chart", "done"] {
            assert!(stages.contains(&stage), "stage {stage} missing from {stages:?}");
        }
        let fractions: Vec<f64> = seen.iter().map(|j| j.fraction).collect();
        assert!(fractions.windows(2).all(|w| w[0] <= w[1]));
        let folder = library.join(done.song.as_deref().unwrap()).parent().unwrap().to_path_buf();
        assert!(folder.join("backing_track_no_guitar.wav").is_file());
        assert!(folder.join(ORIGIN).is_file());
        assert_eq!(done.title.as_deref(), Some("demo rock"), "title from the file name (no tags)");
    }
}
