use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering::Relaxed};
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use opensmith_audio::{host_now_ns, Engine, Monitor, StatsSnapshot, StreamInfo, Track};
use opensmith_dsp::ChainParams;
use opensmith_game::Chart;

use crate::calibration::CalibrationPlan;
use crate::events::UiEvent;
use crate::session::{AudioBackend, Judging, RiffLoop, Session, SessionConfig};

/// How often the session thread reads the engine and judges.
const PERIOD: Duration = Duration::from_millis(2);
/// Events kept for a UI that stopped polling (oldest dropped).
const MAX_EVENTS: usize = 10_000;

/// The CoreAudio engine as a session backend.
pub struct EngineBackend(pub Engine);

impl AudioBackend for EngineBackend {
    fn monitor(&mut self) -> &mut Monitor {
        self.0.monitor()
    }

    fn now_ns(&self) -> u64 {
        host_now_ns()
    }

    fn info(&self) -> Option<StreamInfo> {
        Some(self.0.info().clone())
    }
    fn failure(&mut self) -> Option<String> {
        // An xrun is transient. Device changes, invalidation and backend failures require
        // reopening streams; errors are published by callbacks without locking them.
        self.0.monitor().stream_failed().then(|| "Le flux audio a été interrompu ; reconnexion…".into())
    }
}

pub enum Command {
    /// A song, its backing track, where to start, and the level each phrase starts at.
    Load { chart: Box<Chart>, track: Option<Track>, start: f64, levels: HashMap<String, u32> },
    Play,
    Pause,
    Seek(f64),
    Volume(f32),
    /// Linear gain of the song's own guitar (a stem of the track).
    StemVolume(f32),
    /// Difficulty level every phrase starts at, from the next load.
    StartLevel(u32),
    /// Dynamic difficulty on or off (Score Attack: a fixed level), from the next load.
    Dynamic(bool),
    /// Difficulty changed during the song (from the next phrase): dynamic, or a fixed level.
    Difficulty { dynamic: bool, level: u32 },
    /// Tuner mode on or off.
    Tuner(bool),
    /// Latency calibration on clicks.
    Calibrate,
    /// Latency compensation (s).
    InputOffset(f64),
    /// Linear gain of the guitar input.
    InputGain(f32),
    /// Linear gain of the guitar in the headphones.
    MonitorGain(f32),
    /// Playback speed, pitch unchanged.
    Rate(f64),
    /// Loop Trainer loop, or none.
    Riff(Option<RiffLoop>),
    /// The guitar's sound: amp model, knobs, effects.
    Amp(ChainParams),
    /// Play through this output device (name fragment; `None`: the Mac's default). The song
    /// in progress stops; the guitar settings carry over.
    Output(Option<String>),
    /// Listen to this input device (name fragment; `None`: the USB guitar cable, else the Mac's
    /// default input). Like an output change, the song in progress stops.
    Input(Option<String>),
    InputChannel(usize),
    Monitoring(Option<bool>),
    /// Demo mode: the game plays every note itself.
    Autopilot(bool),
    /// Records what the guitar plays during songs into takes under this folder (`None`: stop).
    Record(Option<std::path::PathBuf>),
    /// A sound to play on demand over the music (interface, crowd): mono at `rate` Hz.
    AddSound { name: String, rate: f64, samples: Vec<f32> },
    /// Plays a sound at linear `gain`, now or at song time `at` (a count-in on the beat).
    Sound { name: String, gain: f32, at: Option<f64> },
    /// The looping background sound (the crowd) glides to `gain`; `None` fades it out.
    Bed { name: Option<String>, gain: f32 },
    /// How forgiving the judge is, from the next song.
    Judging(Judging),
    /// Wait mode on or off (lessons): the song stops on each note until the guitar plays it.
    Wait(bool),
}

/// The devices a backend is built on: name fragments, `None` for the automatic choice.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Devices {
    pub input: Option<String>,
    pub output: Option<String>,
    pub input_channel: usize,
    pub monitor: Option<bool>,
}

/// What the UI gets at each frame.
#[derive(Clone, Debug, Default)]
pub struct Poll {
    /// Song time heard now (s).
    pub time: f64,
    pub playing: bool,
    pub events: Vec<UiEvent>,
    /// Loudest guitar sample since the last poll (after the input gain).
    pub peak: f32,
    /// Song seconds per second.
    pub rate: f64,
}

#[derive(Default)]
struct Outbox {
    events: Vec<UiEvent>,
    time: f64,
    at_ns: u64,
    playing: bool,
    info: Option<StreamInfo>,
    error: Option<String>,
    stats: Option<StatsSnapshot>,
    peak: f32,
    rate: f64,
    /// Why the last output switch failed (the previous output still plays).
    switch_error: Option<String>,
}

/// A session on its own thread, judging every 2 ms whatever the UI does (a hidden window
/// renders less often, the game must not). The app holds this handle.
pub struct SessionHandle {
    tx: Sender<Command>,
    outbox: Arc<Mutex<Outbox>>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl SessionHandle {
    /// Starts the thread; `make(devices)` builds the backend there (CoreAudio streams stay on
    /// it), with the automatic devices first, again on `Command::Output` or `Command::Input`.
    pub fn spawn<B, F>(make: F, cfg: SessionConfig) -> SessionHandle
    where
        B: AudioBackend + 'static,
        F: FnMut(Devices) -> Result<B, String> + Send + 'static,
    {
        let (tx, rx) = mpsc::channel();
        let outbox = Arc::new(Mutex::new(Outbox { rate: 1.0, ..Outbox::default() }));
        let stop = Arc::new(AtomicBool::new(false));
        let (o, s) = (outbox.clone(), stop.clone());
        let thread = thread::Builder::new()
            .name("opensmith-session".into())
            .spawn(move || run(make, cfg, rx, o, s))
            .expect("session thread");
        SessionHandle { tx, outbox, stop, thread: Some(thread) }
    }

    pub fn send(&self, cmd: Command) {
        let _ = self.tx.send(cmd);
    }

    /// Song time now and the events since the last poll.
    pub fn poll(&self) -> Poll {
        let mut o = self.outbox.lock().unwrap();
        let mut time = o.time;
        if o.playing {
            time += (host_now_ns() as f64 - o.at_ns as f64) * 1e-9 * o.rate;
        }
        let (events, peak) = (std::mem::take(&mut o.events), std::mem::take(&mut o.peak));
        Poll { time, playing: o.playing, events, peak, rate: o.rate }
    }

    pub fn info(&self) -> Option<StreamInfo> {
        self.outbox.lock().unwrap().info.clone()
    }

    /// Why the audio engine could not start, if it could not.
    pub fn error(&self) -> Option<String> {
        self.outbox.lock().unwrap().error.clone()
    }

    /// Why the last change of output device failed, if it did.
    pub fn switch_error(&self) -> Option<String> {
        self.outbox.lock().unwrap().switch_error.clone()
    }

    pub fn stats(&self) -> Option<StatsSnapshot> {
        self.outbox.lock().unwrap().stats
    }
}

impl Drop for SessionHandle {
    fn drop(&mut self) {
        self.stop.store(true, Relaxed);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

fn run<B, F>(mut make: F, cfg: SessionConfig, rx: Receiver<Command>, outbox: Arc<Mutex<Outbox>>, stop: Arc<AtomicBool>)
where
    B: AudioBackend,
    F: FnMut(Devices) -> Result<B, String>,
{
    let mut devices = Devices::default();
    let mut wanted = devices.clone();
    let mut session: Option<Session<B>> = None;
    let mut healthy = false;
    let mut pending = std::collections::VecDeque::new();
    let mut retry_at = Instant::now();
    let mut last_stats = Instant::now();
    while !stop.load(Relaxed) {
        let mut changed = false;
        loop {
            match rx.try_recv() {
                Ok(cmd) => {
                    let before = wanted.clone();
                    match cmd {
                        Command::Output(name) => { wanted.output = name; changed = true; },
                        Command::Input(name) => { wanted.input = name; wanted.input_channel = 0; changed = true; }
                        Command::InputChannel(channel) => wanted.input_channel = channel,
                        Command::Monitoring(monitor) => wanted.monitor = monitor,
                        other => pending.push_back(other),
                    }
                    changed |= before != wanted;
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => return,
            }
        }
        if let Some(s) = session.as_mut().filter(|_| healthy) {
            if let Some(error) = s.backend().failure() {
                healthy = false;
                let mut o = outbox.lock().unwrap();
                o.error = Some(error);
                o.info = None;
                o.playing = false;
                o.stats = None;
                retry_at = Instant::now();
            }
        }
        if changed || (!healthy && Instant::now() >= retry_at) {
            match make(wanted.clone()) {
                Ok(backend) => {
                    let info = backend.info();
                    if let Some(s) = session.as_mut() { drop(s.replace_backend(backend)); }
                    else { session = Some(Session::new(backend, cfg)); }
                    devices = wanted.clone();
                    healthy = true;
                    let mut o = outbox.lock().unwrap();
                    o.info = info;
                    o.error = None;
                    o.switch_error = None;
                    o.stats = None;
                }
                Err(error) => {
                    let mut o = outbox.lock().unwrap();
                    if healthy { o.switch_error = Some(error); wanted = devices.clone(); }
                    else { o.error = Some(error); o.info = None; o.playing = false; }
                    retry_at = Instant::now() + Duration::from_millis(500);
                }
            }
        }
        if !healthy {
            // Keep preferences/load requests while an interface is absent, without spinning
            // on CoreAudio or losing the command receiver after the first failure.
            if pending.len() > MAX_EVENTS { pending.drain(..pending.len() - MAX_EVENTS); }
            thread::sleep(PERIOD);
            continue;
        }
        let session = session.as_mut().unwrap();
        for command in pending.drain(..) { apply(session, command); }
        session.update();
        let peak = session.take_peak();
        let events = session.take_events();
        let time = session.time();
        let at_ns = host_now_ns();
        let playing = session.playing();
        let rate = session.rate();
        let stats = (last_stats.elapsed() > Duration::from_millis(500)).then(|| {
            last_stats = Instant::now();
            session.backend().monitor().stats()
        });
        {
            let mut o = outbox.lock().unwrap();
            o.events.extend(events);
            let excess = o.events.len().saturating_sub(MAX_EVENTS);
            o.events.drain(..excess);
            o.peak = o.peak.max(peak);
            (o.time, o.at_ns, o.playing, o.rate) = (time, at_ns, playing, rate);
            if stats.is_some() { o.stats = stats; }
        }
        thread::sleep(PERIOD);
    }
}

fn apply<B: AudioBackend>(session: &mut Session<B>, command: Command) {
    match command {
        Command::Load { chart, track, start, levels } => { session.load(*chart, track, start); session.set_levels(levels); }
        Command::Play => session.play(),
        Command::Pause => session.pause(),
        Command::Seek(t) => session.seek(t),
        Command::Volume(g) => session.set_volume(g),
        Command::StemVolume(g) => session.set_stem_volume(g),
        Command::StartLevel(l) => session.set_start_level(l),
        Command::Dynamic(on) => session.set_dynamic(on),
        Command::Difficulty { dynamic, level } => session.set_difficulty(dynamic, level),
        Command::Tuner(on) => session.set_tuner(on),
        Command::Calibrate => session.calibrate(CalibrationPlan::default()),
        Command::InputOffset(s) => session.set_input_offset(s),
        Command::InputGain(g) => session.set_input_gain(g),
        Command::Amp(params) => session.set_chain(params),
        Command::Autopilot(on) => session.set_autopilot(on),
        Command::Record(base) => session.record(base),
        Command::MonitorGain(g) => session.set_monitor_gain(g),
        Command::Rate(r) => session.set_rate(r),
        Command::Riff(riff) => session.set_riff(riff),
        Command::AddSound { name, rate, samples } => session.add_sound(name, rate, samples),
        Command::Sound { name, gain, at } => session.play_sound(&name, gain, at),
        Command::Bed { name, gain } => session.set_bed(name, gain),
        Command::Judging(j) => session.set_judging(j),
        Command::Wait(on) => session.set_wait(on),
        Command::Input(_) | Command::Output(_) | Command::InputChannel(_) | Command::Monitoring(_) => unreachable!(),
    }
}
