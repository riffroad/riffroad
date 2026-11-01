use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::Arc;
use std::thread::JoinHandle;

use opensmith_audio::{Monitor, PlayerClock, PlayerCommand, Sound, StreamInfo, Track, MAX_RATE, MIN_RATE};
use opensmith_dsp::fx::resample::resample_fast;
use opensmith_dsp::notefeat::{NoteFeatures, BINS, HOP, PER_SEMITONE, WINDOW};
use opensmith_dsp::notenet::NoteNet;
use opensmith_dsp::{ChainParams, ChordConfig, ChordVerifier, TrackerEvent, TunerAnalyzer, TunerConfig};
use opensmith_game::{Chart, Game, GameConfig, Score, Status, Target};

use crate::calibration::{Calibration, CalibrationPlan};
use crate::events::{UiEvent, UiExpected};
use serde::Deserialize;
use crate::history::TapHistory;
use crate::take::{Recording, Take};

/// Raw input reaches the session in tap blocks: allow for one block of delay (s).
const TAP_DELAY: f64 = 0.006;
/// Attacks older than this are forgotten (s).
const ATTACK_MEMORY: f64 = 2.0;
/// Step between the windows searched for a chord whose strum the tracker did not notice (s).
const SCAN_STEP: f64 = 0.005;
/// Tuner mode sends the pitch at most this often (s).
const PITCH_EVERY: f64 = 0.02;
/// How long a strum takes across the strings (s): a chord is checked up to this long after its
/// attack.
const STRUM: f64 = 0.05;
/// Wait mode: a note or chord is waited on when the song reaches it, if it reached it no more
/// than this long ago (s).
const WAIT_CATCH: f64 = 0.25;
/// A strum the tracker did not notice still makes the guitar this much louder (dB): over the
/// 40 ms from it against the 45 ms before.
const STRUM_RISE_DB: f32 = 2.0;
/// Takes shorter than this are not kept (s).
const MIN_TAKE: f64 = 10.0;

/// Where a session gets its audio: the CoreAudio engine, or a simulation in tests.
pub trait AudioBackend {
    fn monitor(&mut self) -> &mut Monitor;
    /// Host time now (ns), the clock of the audio callback timestamps.
    fn now_ns(&self) -> u64;
    fn info(&self) -> Option<StreamInfo> {
        None
    }
}

/// How forgiving the judge is: the player's choice (Settings → Game), strict to lenient.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Judging {
    /// A note or chord counts when played within ± this many seconds of its time.
    pub hit_window: f64,
    /// Share of a chord's notes the detector must hear in its strum.
    pub chord_share: f32,
    /// How surely the detector must say a note was attacked for it to count.
    pub heard: f32,
    /// How surely a note foreign to a chord must be heard in its strum to make it wrong.
    pub foreign: f32,
}

impl Judging {
    // Measured on the virtual guitarist's 24 songs, a beginner's right playing counted / wrong
    // refused: strict 85.7 / 83.5 %, normal 88.3 / 81.4 %, lenient 93.1 / 72.8 %.
    pub const STRICT: Judging = Judging { hit_window: 0.10, chord_share: 0.75, heard: 0.5, foreign: 0.85 };
    pub const NORMAL: Judging = Judging { hit_window: 0.10, chord_share: 0.66, heard: 0.4, foreign: 0.93 };
    pub const LENIENT: Judging = Judging { hit_window: 0.12, chord_share: 0.5, heard: 0.4, foreign: 0.97 };

    pub fn by_name(name: &str) -> Option<Judging> {
        match name {
            "strict" => Some(Judging::STRICT),
            "normal" => Some(Judging::NORMAL),
            "lenient" => Some(Judging::LENIENT),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct SessionConfig {
    pub game: GameConfig,
    /// How forgiving the judge is; its hit window is the game's.
    pub judging: Judging,
    /// Audio after a strum that the chord verifier looks at (s).
    pub chord_window: f64,
    /// Concert pitch.
    pub a4: f32,
}

impl Default for SessionConfig {
    fn default() -> Self {
        let judging = Judging::NORMAL;
        SessionConfig { game: GameConfig { lookahead: 3.4, hit_window: judging.hit_window, ..GameConfig::default() }, judging, chord_window: 0.09, a4: 440.0 }
    }
}

/// Loop Trainer: the music loops over `start..end` (song seconds) and the notes from `from`
/// to `to` are judged again on every pass. `start` comes a little before `from` to get ready,
/// `end` long enough after `to` for the last notes to be judged before the loop goes back.
#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
pub struct RiffLoop {
    pub start: f64,
    pub end: f64,
    pub from: f64,
    pub to: f64,
}

/// One song being played: owns the game, drives the player, turns tracker events into
/// judgements. `update` is called every few milliseconds; `take_events` hands the UI its news.
pub struct Session<B: AudioBackend> {
    backend: B,
    cfg: SessionConfig,
    sample_rate: f64,
    game: Option<Game>,
    /// Chart time + offset = track time.
    offset: f64,
    /// The song's tuning against A440 (cents): the guitar plays that much sharp.
    cents: f64,
    duration: f64,
    has_track: bool,
    /// Every track sent to the player, released here once the callback no longer holds it.
    tracks: Vec<Arc<Track>>,
    generation: u32,
    /// Song time asked by the last load or seek, until the player clock reflects it.
    target: f64,
    sent: usize,
    events: Vec<UiEvent>,
    history: TapHistory,
    verifier: ChordVerifier,
    scratch: Vec<f32>,
    attacks: VecDeque<f64>,
    last_score: Score,
    ended: bool,
    tuner: bool,
    /// Tuner mode's own analysis, on a long window of the input.
    tuning: Option<TunerAnalyzer>,
    /// Demo mode: the game plays the notes itself.
    autopilot: bool,
    /// Input sample of the last pitch sent in tuner mode.
    last_pitch: u64,
    calibration: Option<Calibration>,
    /// Playback speed (track seconds per second).
    rate: f64,
    riff: Option<RiffLoop>,
    /// Loop count of the player clock already turned into passes.
    loops_seen: u32,
    /// What was set on the audio engine, applied again to a new one (another output).
    applied: Applied,
    sounds: Sounds,
    /// Where takes go (`record`), and the one being recorded.
    record_to: Option<PathBuf>,
    recording: Option<Recording>,
    saving: Vec<JoinHandle<()>>,
    /// The learned note detector: which notes a strum or a pick attacked.
    listener: Option<Listener>,
    /// Chords already checked at their attack (by index): not checked again until the end of
    /// their window.
    tried: std::collections::HashSet<usize>,
    /// Wait mode (lessons): the song stands still on each note or chord until the guitar plays it.
    wait: bool,
    waiting: Option<Waiting>,
    /// Notes and chords let go by hand (the song resumed from the pause menu): not waited on again.
    waived: HashSet<usize>,
}

/// The note or chord the song stopped on, in wait mode.
struct Waiting {
    /// Its index in the game's expected list.
    index: usize,
    /// Input sample from which the guitar is listened to.
    from: u64,
    /// Attacks heard since (input samples), not checked yet.
    attacks: Vec<u64>,
}

/// The learned note detector (`opensmith_dsp::notenet`) and its working buffers.
struct Listener {
    net: NoteNet,
    feats: NoteFeatures,
    audio: Vec<f32>,
    window: Vec<f32>,
}

impl Listener {
    /// The detector the engine ships with.
    fn builtin() -> Option<Listener> {
        let net = NoteNet::from_bytes(include_bytes!("../../dsp/assets/notenet.bin")).ok()?;
        let window = vec![0.0; net.frames() * BINS];
        Some(Listener { net, feats: NoteFeatures::new(), audio: Vec::new(), window })
    }

    /// Seconds of audio it needs after an attack.
    fn after(&self) -> f64 {
        (self.net.after * HOP + WINDOW / 2) as f64 / 48_000.0
    }

    /// How likely each note was attacked at track time `t`: (lowest MIDI note, probabilities).
    /// The song plays at `rate` (the detector's frames are real time) and the guitar is tuned
    /// `cents` off A440 like the recording (brought back to A440 for the detector).
    #[allow(clippy::too_many_arguments)]
    fn attacked(&mut self, monitor: &Monitor, clock: &PlayerClock, history: &TapHistory, t: f64, rate: f64, cents: f64, sr: f64) -> Option<(i32, Vec<f32>)> {
        let half = WINDOW / 2;
        let span = 2 * half + (self.net.frames() - 1) * HOP;
        let from = t - rate * (self.net.before * HOP + half) as f64 / sr;
        strum_audio(monitor, clock, history, &mut self.audio, from, span as f64 / sr, sr)?;
        Some(self.probabilities(cents))
    }

    /// `attacked` at input sample `attack` (a song waiting on the player stands still: its time
    /// no longer tells where the guitar's audio is).
    fn attacked_at(&mut self, history: &TapHistory, attack: u64, cents: f64) -> Option<(i32, Vec<f32>)> {
        let half = WINDOW / 2;
        let span = 2 * half + (self.net.frames() - 1) * HOP;
        let from = attack.checked_sub((self.net.before * HOP + half) as u64)?;
        self.audio.resize(span, 0.0);
        history.read(from, &mut self.audio).then(|| self.probabilities(cents))
    }

    /// The detector on the audio read last (`audio`).
    fn probabilities(&mut self, cents: f64) -> (i32, Vec<f32>) {
        let half = WINDOW / 2;
        // Bins the guitar's pitches sit above A440's (fractional), read back onto A440's.
        let shift = (cents * PER_SEMITONE as f64 / 100.0) as f32;
        let mut tuned = [0.0f32; BINS];
        for (f, row) in self.window.chunks_mut(BINS).enumerate() {
            self.feats.frame(&self.audio, half + f * HOP, row);
            if shift != 0.0 {
                for (b, t) in tuned.iter_mut().enumerate() {
                    let at = b as f32 + shift;
                    let (k, frac) = (at.floor(), at - at.floor());
                    let get = |i: f32| if i >= 0.0 && (i as usize) < BINS { row[i as usize] } else { 0.0 };
                    *t = get(k) * (1.0 - frac) + get(k + 1.0) * frac;
                }
                row.copy_from_slice(&tuned);
            }
        }
        (self.net.first, self.net.attacked(&self.window))
    }
}

/// Where the detector looks at a strum, from its start: a strum takes up to 60 ms across the
/// strings, the detector counts what was attacked within 35 ms of where it looks.
const STRUM_LOOKS: [f64; 3] = [-0.01, 0.015, 0.04];

/// Whether the detector's `probs` (from MIDI `first`) say the chord `pitches` was strummed:
/// three quarters of its notes heard, and no note foreign to it (not in its pitch classes) heard
/// surely, but for an open string next to the chord's that the strum brushed on its way
/// (`brushable`): beginners do it all the time, and it is still the chord.
fn strummed(first: i32, probs: &[f32], pitches: &[i32], brushable: &[i32], judging: &Judging) -> bool {
    let p = |m: i32| probs.get((m - first) as usize).copied().unwrap_or(0.0);
    let heard = pitches.iter().filter(|&&m| p(m) >= judging.heard).count();
    let classes: Vec<i32> = pitches.iter().map(|m| m.rem_euclid(12)).collect();
    let foreign = (0..probs.len() as i32)
        .map(|k| k + first)
        .any(|m| !classes.contains(&m.rem_euclid(12)) && !brushable.contains(&m) && p(m) >= judging.foreign);
    heard as f32 >= (judging.chord_share * pitches.len() as f32 - 1e-4).ceil() && !foreign
}

/// Sounds the session may be asked to play over the music (interface, crowd): mono at their
/// own rate as given, and stereo at the output's rate as it plays them.
#[derive(Default)]
struct Sounds {
    given: HashMap<String, (f64, Vec<f32>)>,
    ready: HashMap<String, Sound>,
    ready_rate: f64,
    /// The background sound and its gain, played again on a new output device.
    bed: Option<(String, f32)>,
}

#[derive(Clone, Copy, Default)]
struct Applied {
    input_gain: Option<f32>,
    monitor_gain: Option<f32>,
    volume: Option<f32>,
    /// Gain of the song's own guitar stem, for every track loaded.
    stem: f32,
    chain: Option<ChainParams>,
}

impl<B: AudioBackend> Session<B> {
    pub fn new(mut backend: B, cfg: SessionConfig) -> Self {
        let sample_rate = backend.monitor().sample_rate();
        Session {
            backend,
            cfg,
            sample_rate,
            game: None,
            offset: 0.0,
            cents: 0.0,
            duration: 0.0,
            has_track: false,
            tracks: Vec::new(),
            generation: 0,
            target: 0.0,
            sent: 0,
            events: Vec::new(),
            history: TapHistory::new(1 << 18),
            verifier: ChordVerifier::new(chord_config()),
            scratch: Vec::new(),
            attacks: VecDeque::new(),
            last_score: Score::default(),
            ended: false,
            tuner: false,
            tuning: None,
            autopilot: false,
            last_pitch: 0,
            calibration: None,
            rate: 1.0,
            riff: None,
            loops_seen: 0,
            applied: Applied::default(),
            sounds: Sounds::default(),
            record_to: None,
            recording: None,
            saving: Vec::new(),
            listener: Listener::builtin(),
            tried: std::collections::HashSet::new(),
            wait: false,
            waiting: None,
            waived: HashSet::new(),
        }
    }

    /// Plays through another audio engine (another output device): the song and the clock
    /// start over (load again), the guitar settings, amp, volume and speed carry over. Returns
    /// the previous engine, to drop once this one runs.
    pub fn replace_backend(&mut self, backend: B) -> B {
        self.finish_take();
        let old = std::mem::replace(&mut self.backend, backend);
        self.sample_rate = self.backend.monitor().sample_rate();
        // The new device's input stream counts from zero again.
        self.history = TapHistory::new(1 << 18);
        self.set_tuner(self.tuner);
        self.tracks.clear();
        self.game = None;
        self.has_track = false;
        self.calibration = None;
        self.riff = None;
        self.generation = self.generation.wrapping_add(1);
        self.loops_seen = 0;
        self.restart_view(0.0);
        let (a, rate) = (self.applied, self.rate);
        let monitor = self.backend.monitor();
        if let Some(g) = a.input_gain {
            monitor.set_input_gain(g);
        }
        if let Some(g) = a.monitor_gain {
            monitor.set_monitor_gain(g);
        }
        if let Some(g) = a.volume {
            monitor.send(PlayerCommand::Gain(g));
        }
        if let Some(c) = a.chain {
            monitor.set_chain(c);
        }
        if rate != 1.0 {
            monitor.send(PlayerCommand::Rate(rate));
        }
        if let Some((name, gain)) = self.sounds.bed.clone() {
            self.set_bed(Some(name), gain);
        }
        old
    }

    /// How forgiving the judge is, from the next song.
    pub fn set_judging(&mut self, judging: Judging) {
        self.cfg.judging = judging;
        self.cfg.game.hit_window = judging.hit_window;
    }

    /// Keeps `samples` (mono, `rate` Hz) to play as `name`, replacing any sound of that name.
    pub fn add_sound(&mut self, name: String, rate: f64, samples: Vec<f32>) {
        self.sounds.ready.remove(&name);
        self.sounds.given.insert(name, (rate, samples));
    }

    /// The sound `name` as the output plays it (resampled once for each output rate).
    fn sound(&mut self, name: &str) -> Option<Sound> {
        let sr = self.sample_rate;
        if self.sounds.ready_rate != sr {
            self.sounds.ready.clear();
            self.sounds.ready_rate = sr;
        }
        if let Some(s) = self.sounds.ready.get(name) {
            return Some(s.clone());
        }
        let (rate, mono) = self.sounds.given.get(name)?;
        let mono = if (rate - sr).abs() < 0.5 { mono.clone() } else { resample_fast(mono, *rate as f32, sr as f32, 16) };
        let sound: Sound = mono.iter().flat_map(|&v| [v, v]).collect::<Vec<f32>>().into();
        self.sounds.ready.insert(name.to_string(), sound.clone());
        Some(sound)
    }

    /// Plays the sound `name` at linear `gain`, now or at song time `at` (a count-in).
    pub fn play_sound(&mut self, name: &str, gain: f32, at: Option<f64>) {
        let at = at.map(|t| self.frame_of(t));
        if let Some(sound) = self.sound(name) {
            self.backend.monitor().send(PlayerCommand::Sound { sound, gain, at });
        }
    }

    /// The looping background sound (the crowd) glides to `gain`; `None` fades it out.
    pub fn set_bed(&mut self, name: Option<String>, gain: f32) {
        let sound = name.as_deref().and_then(|n| self.sound(n));
        self.sounds.bed = name.filter(|_| sound.is_some()).map(|n| (n, gain));
        self.backend.monitor().send(PlayerCommand::Bed { sound, gain });
    }

    /// The guitar's sound: amp model, knobs, effects.
    pub fn set_chain(&mut self, params: ChainParams) {
        self.applied.chain = Some(params);
        self.backend.monitor().set_chain(params);
    }

    pub fn backend(&mut self) -> &mut B {
        &mut self.backend
    }

    pub fn chart(&self) -> Option<&Chart> {
        self.game.as_ref().map(Game::chart)
    }

    pub fn score(&self) -> Option<Score> {
        self.game.as_ref().map(Game::score)
    }

    /// Loads a song and its backing track, stopped at song time `start` (negative: count-in).
    pub fn load(&mut self, chart: Chart, track: Option<Track>, start: f64) {
        self.finish_take();
        let track = track.map(Arc::new);
        if let Some(t) = &track {
            t.set_stem_gain(self.applied.stem);
        }
        self.tracks.extend(track.clone());
        self.has_track = track.is_some();
        self.offset = chart.audio.offset;
        self.cents = chart.arrangement.tuning.cents;
        self.duration = chart.meta.duration;
        self.generation = self.generation.wrapping_add(1);
        let frame = self.frame_of(start);
        self.set_rate(1.0);
        self.riff = None;
        self.loops_seen = 0;
        self.backend.monitor().send(PlayerCommand::Load { track, frame, generation: self.generation });
        let mut game = Game::new(chart, self.cfg.game);
        game.restart_at(start);
        self.game = Some(game);
        self.calibration = None;
        self.restart_view(start);
        self.start_take();
    }

    /// Replays a take: each phrase iteration at the level it was played at (`None`: skipped).
    pub fn force_levels(&mut self, levels: Vec<Option<u32>>) {
        if let Some(game) = &mut self.game {
            game.force_levels(levels);
        }
    }

    /// Records what the guitar plays during songs into takes under `base` (one folder per
    /// play, from a load or a seek to the end, a seek or the next load), to replay them offline;
    /// `None` stops (the take so far is kept). Loop Trainer passes and slowed-down plays are not
    /// recorded.
    pub fn record(&mut self, base: Option<PathBuf>) {
        if base.is_none() {
            self.finish_take();
        }
        let start = base.is_some() && self.record_to.is_none();
        self.record_to = base;
        if start {
            self.start_take();
        }
    }

    fn start_take(&mut self) {
        if self.record_to.is_some() && self.game.is_some() && self.riff.is_none() && !self.autopilot {
            self.recording = Some(Recording::default());
        }
    }

    /// Saves the take being recorded (on another thread), if long enough.
    fn finish_take(&mut self) {
        let (Some(rec), Some(base), Some(game)) = (self.recording.take(), self.record_to.clone(), self.game.as_ref()) else { return };
        let sr = self.sample_rate;
        if (rec.guitar.len() as f64) < MIN_TAKE * sr {
            return;
        }
        let take = Take {
            chart: game.chart().clone(),
            sample_rate: sr as u32,
            guitar: rec.guitar,
            anchors: rec.anchors,
            input_offset: self.cfg.game.input_offset,
            levels: (0..game.chart().phrases.len()).map(|k| game.iteration_level(k)).collect(),
            score: game.score().into(),
        };
        let dir = take.folder_in(&base);
        self.events.push(UiEvent::TakeSaved { path: dir.display().to_string(), seconds: take.seconds() });
        self.saving.retain(|h| !h.is_finished());
        self.saving.push(std::thread::spawn(move || {
            if let Err(e) = take.save(&dir) {
                eprintln!("prise non enregistrée : {e}");
            }
        }));
    }

    /// Waits for the takes being written.
    pub fn wait_takes(&mut self) {
        for h in self.saving.drain(..) {
            let _ = h.join();
        }
    }

    /// Plays the click track of `plan` and measures how late the player's strums come.
    pub fn calibrate(&mut self, plan: CalibrationPlan) {
        self.finish_take();
        let track = Arc::new(plan.track(self.sample_rate as u32));
        self.tracks.push(track.clone());
        self.has_track = true;
        self.offset = 0.0;
        self.duration = plan.end();
        self.game = None;
        self.generation = self.generation.wrapping_add(1);
        let generation = self.generation;
        self.set_rate(1.0);
        self.riff = None;
        self.loops_seen = 0;
        let monitor = self.backend.monitor();
        monitor.send(PlayerCommand::Load { track: Some(track), frame: 0, generation });
        monitor.send(PlayerCommand::Play);
        self.restart_view(0.0);
        self.events.push(UiEvent::CalibrationStart { first: plan.first, period: plan.period, count_in: plan.count_in, clicks: plan.clicks });
        self.calibration = Some(Calibration::new(plan));
    }

    /// Levels each phrase (by name) starts at in the loaded song: what the player reached last
    /// time (dynamic difficulty picks up from there).
    pub fn set_levels(&mut self, levels: HashMap<String, u32>) {
        if let Some(game) = &mut self.game {
            game.set_levels(levels);
        }
    }

    /// Tuner mode: the pitch of the ringing string is sent continuously.
    /// Demo mode: the game plays every note itself, on time (the guitar is still heard).
    pub fn set_autopilot(&mut self, on: bool) {
        self.autopilot = on;
        if on {
            self.recording = None; // the autopilot's notes are not the player's
        }
    }

    pub fn set_tuner(&mut self, on: bool) {
        self.tuner = on;
        self.last_pitch = 0;
        self.tuning = on.then(|| TunerAnalyzer::new(TunerConfig { sample_rate: self.sample_rate as f32, ..TunerConfig::default() }));
    }

    /// Tuner mode: the ringing string's pitch, measured on the last 170 ms of input, every 20 ms.
    fn tune(&mut self) {
        let Some(analyzer) = &mut self.tuning else { return };
        let end = self.history.end();
        let (every, window) = ((PITCH_EVERY * self.sample_rate) as u64, analyzer.window());
        if end < window as u64 || (end >= self.last_pitch && end < self.last_pitch + every) {
            return;
        }
        self.last_pitch = end;
        self.scratch.resize(window, 0.0);
        if !self.history.read(end - window as u64, &mut self.scratch) {
            return;
        }
        if let Some(r) = analyzer.analyze(&self.scratch) {
            self.events.push(UiEvent::Pitch { midi: r.midi as f32, clarity: r.clarity });
        }
    }

    /// Latency compensation (s), from the calibration; applies to the song being played too.
    pub fn set_input_offset(&mut self, seconds: f64) {
        self.cfg.game.input_offset = seconds;
        let seconds = seconds * self.rate;
        if let Some(game) = &mut self.game {
            game.set_input_offset(seconds);
        }
    }

    /// Linear gain of the guitar input.
    pub fn set_input_gain(&mut self, gain: f32) {
        self.applied.input_gain = Some(gain);
        self.backend.monitor().set_input_gain(gain);
    }

    /// Linear gain of the guitar heard in the headphones (only with the USB guitar cable).
    pub fn set_monitor_gain(&mut self, gain: f32) {
        self.applied.monitor_gain = Some(gain);
        self.backend.monitor().set_monitor_gain(gain);
    }

    /// Loudest guitar sample since the last call (level meter).
    pub fn take_peak(&mut self) -> f32 {
        self.backend.monitor().take_peak()
    }

    pub fn play(&mut self) {
        self.backend.monitor().send(PlayerCommand::Play);
    }

    /// Wait mode: the song stops on each note or chord when it is due, and goes on once the
    /// guitar played it (in time, then: a lesson's notes, however long the fingers take). Off,
    /// a song waiting goes on.
    pub fn set_wait(&mut self, on: bool) {
        self.wait = on;
        if !on && self.waiting.take().is_some() {
            self.play();
        }
    }

    pub fn pause(&mut self) {
        self.backend.monitor().send(PlayerCommand::Pause);
    }

    /// Moves to song time `t`: judging starts over from there, phrase levels are kept.
    pub fn seek(&mut self, t: f64) {
        self.finish_take();
        self.generation = self.generation.wrapping_add(1);
        self.loops_seen = 0;
        let frame = self.frame_of(t);
        self.backend.monitor().send(PlayerCommand::Seek { frame, generation: self.generation });
        if let Some(game) = &mut self.game {
            game.restart_at(t);
        }
        self.restart_view(t);
        self.start_take();
    }

    /// Playback speed (1: as recorded), the pitch unchanged: the song clock, the notes and the
    /// judging follow it.
    pub fn set_rate(&mut self, rate: f64) {
        self.rate = rate.clamp(MIN_RATE, MAX_RATE);
        self.backend.monitor().send(PlayerCommand::Rate(self.rate));
        // The latency is real time: slowed down, it is that much less song time.
        let lag = self.cfg.game.input_offset * self.rate;
        if let Some(game) = &mut self.game {
            game.set_input_offset(lag);
        }
    }

    pub fn rate(&self) -> f64 {
        self.rate
    }

    /// Loop Trainer on (`Some`: plays the loop from its start, a `Pass` event each time it goes
    /// back) or off (`None`: plays on from where it is, every note judged from the next seek).
    pub fn set_riff(&mut self, riff: Option<RiffLoop>) {
        if riff.is_some() {
            self.finish_take();
        }
        self.riff = riff;
        let frames = riff.map(|r| (self.frame_of(r.start), self.frame_of(r.end)));
        self.backend.monitor().send(PlayerCommand::Loop(frames));
        let (from, to) = riff.map_or((f64::NEG_INFINITY, f64::INFINITY), |r| (r.from, r.to));
        if let Some(game) = &mut self.game {
            game.set_range(from, to);
        }
        if let Some(r) = riff {
            self.seek(r.start);
        }
    }

    pub fn riff(&self) -> Option<RiffLoop> {
        self.riff
    }

    /// Difficulty level every phrase starts at, from the next load.
    pub fn set_start_level(&mut self, level: u32) {
        self.cfg.game.start_level = level;
    }

    /// Dynamic difficulty from the next load; off, every phrase stays at the start level
    /// (Score Attack).
    pub fn set_dynamic(&mut self, on: bool) {
        self.cfg.game.dynamic_difficulty = on;
    }

    /// Difficulty changed during the song: from the next phrase, and for the next loads.
    pub fn set_difficulty(&mut self, dynamic: bool, level: u32) {
        self.cfg.game.dynamic_difficulty = dynamic;
        self.cfg.game.start_level = level;
        if let Some(game) = &mut self.game {
            game.set_difficulty(dynamic, level);
        }
    }

    /// Linear gain of the backing track.
    pub fn set_volume(&mut self, gain: f32) {
        self.applied.volume = Some(gain);
        self.backend.monitor().send(PlayerCommand::Gain(gain));
    }

    /// Linear gain of the song's own guitar, when its track has it as a stem (silent by
    /// default): heard at once, and kept for the next songs.
    pub fn set_stem_volume(&mut self, gain: f32) {
        self.applied.stem = gain;
        for t in &self.tracks {
            t.set_stem_gain(gain);
        }
    }

    /// Song time heard now (s).
    pub fn time(&mut self) -> f64 {
        let now = self.backend.now_ns() as f64;
        match self.synced_clock() {
            Some(c) => c.time_at(now, self.sample_rate) - self.offset,
            None => self.target,
        }
    }

    pub fn playing(&mut self) -> bool {
        self.synced_clock().is_some_and(|c| c.playing)
    }

    pub fn take_events(&mut self) -> Vec<UiEvent> {
        std::mem::take(&mut self.events)
    }

    /// Reads the audio engine and judges: call every few milliseconds.
    pub fn update(&mut self) {
        self.tracks.retain(|t| Arc::strong_count(t) > 1);
        let (sr, offset) = (self.sample_rate, self.offset);
        let history = &mut self.history;
        let recording = &mut self.recording;
        self.backend.monitor().drain_tap(|b| {
            history.push(b.first, b.samples());
            if let Some(r) = recording.as_mut() {
                r.pending.push((b.first, b.samples().to_vec()));
            }
        });
        let mut onsets = Vec::new();
        let mut notes = Vec::new();
        self.backend.monitor().poll_events(|e| match e {
            TrackerEvent::Onset { sample } => onsets.push(sample),
            TrackerEvent::NoteOn { onset_sample, midi, cents, .. } => notes.push((onset_sample, midi, cents)),
            _ => {}
        });
        self.tune();
        // Out of a song, what the guitar plays still shows on the strings.
        if !self.synced_clock().is_some_and(|c| c.playing) {
            self.events.extend(notes.iter().map(|&(_, midi, cents)| UiEvent::Played { midi, cents }));
            if notes.is_empty() && !onsets.is_empty() {
                self.events.push(UiEvent::Strum);
            }
        }
        // Until the player applied the last load or seek, what was heard belongs to the past.
        let Some(clock) = self.synced_clock() else {
            if let Some(r) = &mut self.recording {
                r.pending.clear();
            }
            return;
        };
        if clock.loops != self.loops_seen {
            self.loops_seen = clock.loops;
            self.next_pass();
        }
        let host_now = self.backend.now_ns() as f64;
        let now = clock.time_at(host_now, sr) - offset;
        let monitor = self.backend.monitor();
        let song = |m: &Monitor, sample: u64| m.input_time_ns(sample as f64).map(|h| clock.time_at(h, sr) - offset);
        if let Some(r) = &mut self.recording {
            // Only the song played as recorded: not paused (but waiting on the player, a lesson's
            // note being played), not slowed down.
            let live = (clock.playing || self.waiting.is_some()) && self.rate == 1.0;
            for (first, samples) in std::mem::take(&mut r.pending) {
                if let Some(t) = song(monitor, first).filter(|_| live) {
                    r.add(t, &samples, sr);
                }
            }
        }
        let strums: Vec<f64> = onsets.iter().filter_map(|&s| song(monitor, s)).collect();
        self.attacks.extend(strums.iter().copied());
        while self.attacks.front().is_some_and(|&t| t < now - ATTACK_MEMORY) {
            self.attacks.pop_front();
        }
        let heard: Vec<(f64, i32, f32)> =
            notes.iter().filter_map(|&(s, midi, cents)| song(monitor, s).map(|t| (t, midi, cents))).collect();
        // A note's attack is a strum too when the onset detector missed it (a chord over a
        // ringing one).
        self.attacks.extend(heard.iter().map(|h| h.0));

        if let Some(cal) = self.calibration.as_mut() {
            for &t in &strums {
                if let Some((index, error)) = cal.strum(t) {
                    self.events.push(UiEvent::CalibrationHit { index, error });
                }
            }
            if clock.ended || now > cal.plan.end() {
                let r = cal.result();
                self.events.push(UiEvent::Calibrated { offset: r.offset, spread: r.spread, hits: r.hits, total: r.total });
                self.calibration = None;
            }
        }

        let Some(game) = self.game.as_mut() else {
            self.events.extend(heard.into_iter().map(|(time, midi, cents)| UiEvent::Heard { time, midi, cents }));
            return;
        };
        game.activate_until(now);
        flush_expected(game, &mut self.sent, &mut self.events);
        if self.wait {
            let input_now = monitor.input_index_at(host_now).map_or(0, |i| i.max(0.0) as u64);
            match self.waiting.take() {
                // Resumed by hand (the pause menu): that one is let go.
                Some(w) if clock.playing => {
                    self.waived.insert(w.index);
                }
                Some(mut w) => {
                    w.attacks.extend(onsets.iter().chain(notes.iter().map(|n| &n.0)).copied().filter(|&s| s >= w.from));
                    let listen = self.listener.as_ref().map_or(self.cfg.chord_window, Listener::after);
                    let ready = input_now.saturating_sub(((STRUM + listen + TAP_DELAY) * sr) as u64);
                    let e = &game.expected()[w.index];
                    let (index, time) = (w.index, e.time);
                    let judging = self.cfg.judging;
                    let (listener, history, cents) = (&mut self.listener, &self.history, self.cents);
                    let played = match &e.target {
                        Target::Note { midi, .. } => {
                            let midi = *midi;
                            // The tracker's pitch, else the detector at an attack.
                            notes.iter().any(|&(s, m, c)| s >= w.from && (heard_pitch(m, c, cents) - midi as f64).abs() < 0.5)
                                || w.attacks.iter().filter(|&&a| a <= ready).any(|&a| {
                                    listener
                                        .as_mut()
                                        .and_then(|l| l.attacked_at(history, a, cents))
                                        .is_some_and(|(first, probs)| probs.get((midi - first) as usize).is_some_and(|&p| p >= judging.heard))
                                })
                        }
                        Target::Chord { template, midis } => {
                            let brushable = game.chart().brushable(*template);
                            w.attacks.iter().filter(|&&a| a <= ready).any(|&a| match listener.as_mut() {
                                Some(l) => {
                                    let mut best: Option<(i32, Vec<f32>)> = None;
                                    for d in STRUM_LOOKS {
                                        let at = (a as f64 + (d - STRUM / 2.0) * sr).max(0.0) as u64;
                                        let Some((first, probs)) = l.attacked_at(history, at, cents) else { return false };
                                        match best.as_mut() {
                                            Some((_, b)) => b.iter_mut().zip(&probs).for_each(|(b, p)| *b = b.max(*p)),
                                            None => best = Some((first, probs)),
                                        }
                                    }
                                    best.is_some_and(|(first, probs)| strummed(first, &probs, midis, &brushable, &judging))
                                }
                                None => {
                                    self.scratch.resize((self.cfg.chord_window * sr) as usize, 0.0);
                                    let a4 = self.cfg.a4 * 2f32.powf(cents as f32 / 1200.0);
                                    history.read(a, &mut self.scratch) && self.verifier.verify(&self.scratch, midis, a4).accepted
                                }
                            })
                        }
                    };
                    if played {
                        // On the beat: the song waited for it.
                        let at = Some(time + self.cfg.game.input_offset);
                        let judged = match game.expected()[index].target {
                            Target::Note { .. } => game.on_note_heard(index, true, at),
                            Target::Chord { .. } => game.on_chord(index, true, at),
                        };
                        self.events.extend(judged.map(UiEvent::from));
                        monitor.send(PlayerCommand::Play);
                    } else {
                        w.attacks.retain(|&a| a > ready);
                        self.waiting = Some(w);
                    }
                }
                None if clock.playing => {
                    // The next note or chord due, just now (not one long gone).
                    let due = game
                        .expected()
                        .iter()
                        .enumerate()
                        .filter(|(i, e)| e.status == Status::Pending && !self.waived.contains(i) && e.time <= now && e.time > now - WAIT_CATCH)
                        .min_by(|a, b| a.1.time.total_cmp(&b.1.time))
                        .map(|(i, _)| i);
                    if let Some(index) = due {
                        monitor.send(PlayerCommand::Pause);
                        self.waiting = Some(Waiting { index, from: input_now, attacks: Vec::new() });
                        self.events.push(UiEvent::Waiting { index });
                    }
                }
                None => {}
            }
        }
        if self.autopilot && clock.playing {
            self.events.extend(game.autoplay(now).into_iter().map(UiEvent::from));
        }
        if clock.playing {
            for &t in &strums {
                self.events.extend(game.on_strum(t).map(UiEvent::from));
            }
        }
        for (time, midi, cents) in heard {
            self.events.push(UiEvent::Heard { time, midi, cents });
            if clock.playing {
                self.events.extend(game.on_pitch(time, heard_pitch(midi, cents, self.cents)).map(UiEvent::from));
            }
        }

        if clock.playing {
            let (w, window) = (self.cfg.game.hit_window, self.cfg.chord_window);
            let judging = self.cfg.judging;
            let heard = judging.heard;
            // Audio needed after a strum: the chord window, or what the note detector looks at.
            let listen = self.listener.as_ref().map_or(window, Listener::after);
            let a4 = self.cfg.a4 * 2f32.powf(self.cents as f32 / 1200.0);
            // Strums are heard `lag` late (latency compensation): a chord at `time` is strummed
            // around `time + lag` on the clock of the attacks and of the guitar's audio.
            let lag = self.cfg.game.input_offset * self.rate;
            for (index, time, pitches) in game.chords_ready(now, listen) {
                let brushable = match &game.expected()[index].target {
                    Target::Chord { template, .. } => game.chart().brushable(*template),
                    Target::Note { .. } => Vec::new(),
                };
                let at = time + lag;
                let attack = self
                    .attacks
                    .iter()
                    .copied()
                    .filter(|a| (a - at).abs() <= w)
                    .min_by(|x, y| (x - at).abs().total_cmp(&(y - at).abs()));
                let listener = &mut self.listener;
                let learned = listener.is_some();
                let (rate, cents) = (self.rate, self.cents);
                let mut verify = |t: f64| match listener.as_mut() {
                    // The detector looks around the attack itself.
                    Some(l) => {
                        // Each note at the best of the looks along the strum.
                        let mut best: Option<(i32, Vec<f32>)> = None;
                        for d in STRUM_LOOKS {
                            let Some((first, probs)) = l.attacked(monitor, &clock, &self.history, t - STRUM / 2.0 + d + offset, rate, cents, sr) else { return false };
                            match best.as_mut() {
                                Some((_, b)) => b.iter_mut().zip(&probs).for_each(|(b, p)| *b = b.max(*p)),
                                None => best = Some((first, probs)),
                            }
                        }
                        best.is_some_and(|(first, probs)| strummed(first, &probs, &pitches, &brushable, &judging))
                    }
                    None => strum_audio(monitor, &clock, &self.history, &mut self.scratch, t + offset, window, sr)
                        .is_some_and(|audio| self.verifier.verify(audio, &pitches, a4).accepted),
                };
                // The strum's own audio as soon as it is in; failing that, at the end of the
                // window, the chord where the guitar got louder in it (the tracker may not have
                // noticed the strum): a chord still ringing from earlier never does.
                let history = &self.history;
                // The steepest rise of the guitar between `from` and `to`: where a strum starts.
                let steepest = |from: f64, to: f64| {
                    let steps = ((to - from) / SCAN_STEP).round() as i64;
                    (0..=steps)
                        .map(|k| from + k as f64 * SCAN_STEP)
                        .filter_map(|t| rise_db(monitor, &clock, history, t + offset, sr).map(|r| (t, r)))
                        .filter(|&(_, r)| r >= STRUM_RISE_DB)
                        .max_by(|x, y| x.1.total_cmp(&y.1))
                };
                let mut verdict = None;
                if let Some(a) = attack.filter(|&a| now >= a + STRUM + listen + TAP_DELAY && self.tried.insert(index)) {
                    // The strum takes a few tens of ms across the strings: checked as it ends
                    // too, and then dated where the guitar got louder the most (the attack seen
                    // may be a note just before the chord).
                    if let Some(d) = [0.0, STRUM / 2.0, STRUM].into_iter().find(|&d| verify(a + d)) {
                        let start = if d == 0.0 { a } else { steepest(a, a + d).map_or(a, |(t, _)| t) };
                        verdict = Some((true, Some(start)));
                    }
                }
                if verdict.is_none() && now >= at + w + STRUM + listen + TAP_DELAY {
                    // Where it got louder; with the detector, at the chord's time too (it only
                    // answers for what was attacked right there).
                    let found = steepest(at - w, at + w)
                        .map(|(t, _)| t)
                        .filter(|&t| verify(t + STRUM / 2.0))
                        .or_else(|| learned.then_some(at).filter(|&t| verify(t + STRUM / 2.0)));
                    verdict = Some((found.is_some(), found.or(attack)));
                }
                if let Some((accepted, at)) = verdict {
                    self.events.extend(game.on_chord(index, accepted, at).map(UiEvent::from));
                }
            }
            // Notes the tracker did not hear (another string ringing over them, a soft
            // hammer-on): the detector, at the attack nearest to them.
            if let Some(listener) = self.listener.as_mut() {
                for (index, time, midi) in game.notes_ready(now, w + listen + TAP_DELAY) {
                    // At the end of its window: each attack seen in it, nearest first, and the
                    // note's own time when none was seen near it.
                    let at = time + lag;
                    let mut candidates: Vec<f64> = self.attacks.iter().copied().filter(|a| (a - at).abs() <= w).collect();
                    candidates.sort_by(|x, y| (x - at).abs().total_cmp(&(y - at).abs()));
                    if candidates.first().is_none_or(|a| (a - at).abs() > 0.03) {
                        candidates.push(at);
                    }
                    let heard = candidates.into_iter().find(|&a| {
                        listener
                            .attacked(monitor, &clock, &self.history, a + offset, self.rate, self.cents, sr)
                            .is_some_and(|(first, probs)| probs.get((midi - first) as usize).is_some_and(|&p| p >= heard))
                    });
                    self.events.extend(game.on_note_heard(index, heard.is_some(), heard).map(UiEvent::from));
                }
            }
        }

        self.events.extend(game.advance(now).into_iter().map(UiEvent::from));
        flush_expected(game, &mut self.sent, &mut self.events);
        let score = game.score();
        if score != self.last_score {
            self.last_score = score;
            self.events.push(UiEvent::Score { score: score.into() });
        }
        let finished = if self.has_track { clock.ended } else { now > self.duration + 1.0 };
        if finished && !self.ended {
            self.ended = true;
            self.events.push(UiEvent::End);
            self.finish_take();
        }
    }

    /// The loop went back to its start: the pass is over (whatever is still pending counts as
    /// missed), its score goes out, and the notes are announced again for the next one.
    fn next_pass(&mut self) {
        let (Some(riff), Some(game)) = (self.riff, self.game.as_mut()) else { return };
        self.events.extend(game.advance(f64::INFINITY).into_iter().map(UiEvent::from));
        self.events.push(UiEvent::Pass { score: game.score().into() });
        game.restart_at(riff.start);
        self.restart_view(riff.start);
    }

    fn frame_of(&self, t: f64) -> i64 {
        ((t + self.offset) * self.sample_rate).round() as i64
    }

    fn restart_view(&mut self, t: f64) {
        self.tried.clear();
        self.waiting = None;
        self.waived.clear();
        self.target = t;
        self.sent = 0;
        self.attacks.clear();
        self.last_score = Score::default();
        self.ended = false;
        self.events.push(UiEvent::Reset);
    }

    /// The player clock, once it reflects the last load or seek.
    fn synced_clock(&mut self) -> Option<PlayerClock> {
        let c = self.backend.monitor().clock();
        (c.valid && c.generation == self.generation).then_some(c)
    }
}

impl<B: AudioBackend> Drop for Session<B> {
    /// The take being recorded is kept, and written before the session goes.
    fn drop(&mut self) {
        self.finish_take();
        self.wait_takes();
    }
}

/// Announces the notes made visible since the last call, one event per phrase iteration.
fn flush_expected(game: &Game, sent: &mut usize, events: &mut Vec<UiEvent>) {
    let expected = game.expected();
    while *sent < expected.len() {
        let iteration = expected[*sent].iteration;
        let level = game.iteration_level(iteration).unwrap_or(0);
        let mut items = Vec::new();
        while *sent < expected.len() && expected[*sent].iteration == iteration {
            items.push(UiExpected::new(*sent, &expected[*sent], level));
            *sent += 1;
        }
        events.push(UiEvent::Expected { iteration, level, items });
    }
}

/// The guitar audio of a strum heard at track time `t`, `window` seconds of it.
fn strum_audio<'a>(
    monitor: &Monitor,
    clock: &PlayerClock,
    history: &TapHistory,
    scratch: &'a mut Vec<f32>,
    t: f64,
    window: f64,
    sr: f64,
) -> Option<&'a [f32]> {
    let first = monitor.input_index_at(clock.host_at(t, sr))?;
    if first < 0.0 {
        return None;
    }
    scratch.resize((window * sr) as usize, 0.0);
    history.read(first.round() as u64, scratch).then_some(&scratch[..])
}

/// What makes a chord count: three quarters of its notes heard (a string missed or let mute is
/// fine), and no more than 40 % of the sound, nor a single peak within 9 dB of the loudest,
/// unexplained by it. Measured with the virtual guitarist (`opensmith-simulate`) on charts of
/// every kind: chords played right counted 85 % of the time (55 % when every note and almost
/// no other sound was required), wrong ones refused 87 %.
fn chord_config() -> ChordConfig {
    ChordConfig { min_present: 0.75, max_foreign: 0.4, foreign_peak_db: -9.0, ..ChordConfig::default() }
}

/// How much louder (dB) the guitar is over the 40 ms from track time `t` than over the 45 ms
/// before.
fn rise_db(monitor: &Monitor, clock: &PlayerClock, history: &TapHistory, t: f64, sr: f64) -> Option<f32> {
    let mean = |from: f64, secs: f64| {
        let mut buf = Vec::new();
        strum_audio(monitor, clock, history, &mut buf, from, secs, sr).map(|a| a.iter().map(|v| v * v).sum::<f32>() / a.len().max(1) as f32)
    };
    let (before, after) = (mean(t - 0.05, 0.045)?, mean(t, 0.04)?);
    Some(10.0 * ((after + 1e-12) / (before + 1e-12)).log10())
}

/// The pitch heard (fractional MIDI) on the chart's scale: the recording's own tuning taken off
/// (the player tuned to it).
fn heard_pitch(midi: i32, cents: f32, song_cents: f64) -> f64 {
    midi as f64 + (cents as f64 - song_cents) / 100.0
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The detector's probabilities from MIDI 40, `heard` the notes named.
    fn probs(heard: &[(i32, f32)]) -> Vec<f32> {
        let mut p = vec![0.02f32; 40];
        for &(m, v) in heard {
            p[(m - 40) as usize] = v;
        }
        p
    }

    #[test]
    fn each_judging_level_forgives_what_it_says() {
        let g5 = [43, 50, 55];
        // Two of the three strings clear, the third faint: only strict wants all three.
        let faint = probs(&[(43, 0.9), (50, 0.9), (55, 0.3)]);
        assert!(!strummed(40, &faint, &g5, &[], &Judging::STRICT));
        assert!(strummed(40, &faint, &g5, &[], &Judging::NORMAL));
        // A foreign note heard fairly surely (0.9): wrong for strict, forgiven above.
        let foreign = probs(&[(43, 0.9), (50, 0.9), (55, 0.9), (46, 0.9)]);
        assert!(!strummed(40, &foreign, &g5, &[], &Judging::STRICT));
        assert!(strummed(40, &foreign, &g5, &[], &Judging::NORMAL));
        // Heard for sure, a foreign note is wrong at every level but lenient, which forgives
        // only a little more.
        let loud = probs(&[(43, 0.9), (50, 0.9), (55, 0.9), (46, 0.99)]);
        assert!(!strummed(40, &loud, &g5, &[], &Judging::NORMAL));
        assert!(!strummed(40, &loud, &g5, &[], &Judging::LENIENT));
        // Half the chord is enough when lenient.
        let half = probs(&[(43, 0.9), (50, 0.3), (55, 0.9)]);
        assert!(strummed(40, &half, &[43, 50, 55, 59], &[], &Judging::LENIENT));
        assert!(!strummed(40, &half, &[43, 50, 55, 59], &[], &Judging::NORMAL));
    }
}
