//! Streaming note tracker: onset-gated, growing-window pitch detection → note events.
//!
//! Latency model. A note is timestamped at its attack (`onset_sample`, found within a sample or
//! two), which is what gameplay timing uses. Its pitch can only be confirmed once the window
//! since the attack holds `(1 + min_overlap)` fundamental periods (a periodicity must be seen
//! repeating) — about 16 ms for the open low E (period 12.1 ms), 5-6 ms for the high e. The
//! tracker re-analyses every `hop` samples (64 = one CoreAudio buffer), so confirmation arrives
//! after the pitch agrees across `confirm` consecutive analyses. The attack's timestamp does
//! not move while the pitch settles.
//!
//! Segmentation. Besides attacks, a sustaining note is watched by a periodicity-break detector:
//! every sample is predicted from the sample one period earlier, on the note's first five
//! harmonics only (higher partials of a stiff string drift out of phase every period). A re-pick
//! of the same string whose level barely changed, a hammer-on, a pull-off or a fast slide all
//! break that prediction within about a millisecond. The analysis window then restarts at the
//! break, so it never mixes two notes; the outcome (same pitch + energy rise or strong break →
//! re-pick, other pitch → new note, legato when no energy was added) is decided once the new
//! pitch is confirmed.

use crate::fx::biquad::Biquad;
use crate::{db_to_lin, note};
use crate::onset::{OnsetConfig, OnsetDetector};
use crate::pitch::{Mpm, PitchConfig, PitchDetector, PitchEstimate, Yin};

/// Pitch analysis runs on a 2 kHz low-passed copy of the input: the pitch lives in the low
/// harmonics, while the high partials of an attack decorrelate from one period to the next and
/// would hide the periodicity for several periods.
const ANALYSIS_LOWPASS_HZ: f32 = 2000.0;
/// The break detector keeps harmonics 1..≈5 of the sounding note.
const BREAK_BAND_HARMONICS: f32 = 5.5;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Algorithm {
    Mpm,
    Yin,
}

/// A pitch first measurable this long (ms) after its attack and its settling time belongs to a
/// later note than that attack.
const LATE_PITCH_MS: f32 = 20.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TrackerConfig {
    pub pitch: PitchConfig,
    pub onset: OnsetConfig,
    pub algorithm: Algorithm,
    pub a4_hz: f32,
    /// Analysis period in samples: the latency granularity.
    pub hop: usize,
    /// Clarity needed to start a note.
    pub note_on_clarity: f32,
    /// Clarity needed to keep tracking a sustaining note.
    pub hold_clarity: f32,
    /// Consecutive agreeing analyses before a note-on (1 = first confident analysis).
    pub confirm: usize,
    /// Below this hop RMS (dBFS) no note can sustain.
    pub min_level_db: f32,
    pub release_hysteresis_db: f32,
    /// Give up on an attack that shows no pitch for this long (muted/percussive hit).
    pub max_pending_ms: f32,
    /// Pitch drift (semitones) that counts as a new legato note when no break was detected
    /// (slow slides).
    pub legato_semitones: f32,
    /// Analyses below `hold_clarity` before a sustaining note is released.
    pub max_weak_hops: usize,
    /// Window length while sustaining, in fundamental periods.
    pub track_periods: f32,
    /// Periodicity-break threshold: smoothed prediction-error energy over signal energy.
    pub break_ratio: f32,
    /// A break back to the same pitch is a re-pick when the energy rose this much (dB) …
    pub repick_rise_db: f32,
    /// … or when the break was at least this strong.
    pub repick_ratio: f32,
    /// When an attack (or break) interrupts a sounding note, the first `settle_ms` after it —
    /// pick contact and the old vibration dying out — are left out of the pitch window.
    pub settle_ms: f32,
}

impl Default for TrackerConfig {
    fn default() -> Self {
        Self {
            pitch: PitchConfig::default(),
            onset: OnsetConfig::default(),
            algorithm: Algorithm::Mpm,
            a4_hz: note::A4_HZ,
            hop: 64,
            note_on_clarity: 0.9,
            hold_clarity: 0.6,
            confirm: 6, // Five more buffers (6.67 ms at 48 kHz) reject transient attack pitches.
            min_level_db: -66.0,
            release_hysteresis_db: 6.0,
            max_pending_ms: 150.0,
            legato_semitones: 0.65,
            max_weak_hops: 12,
            track_periods: 3.0,
            break_ratio: 0.2,
            repick_rise_db: 1.0,
            repick_ratio: 0.5,
            settle_ms: 4.0,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum TrackerEvent {
    /// Attack detected: the timing reference of the next note.
    Onset { sample: u64 },
    /// Pitch confirmed at `sample` for the note attacked at `onset_sample`.
    NoteOn {
        onset_sample: u64,
        sample: u64,
        midi: i32,
        freq_hz: f32,
        cents: f32,
        clarity: f32,
        legato: bool,
    },
    /// Continuous pitch of the sustaining note (bends, vibrato, tuner).
    Pitch { sample: u64, freq_hz: f32, midi_f: f32, clarity: f32 },
    NoteOff { sample: u64, midi: i32 },
}

#[derive(Clone, Copy, Debug)]
struct Active {
    onset: u64,
    /// First sample of the pitch window (after any settle period).
    start: u64,
    midi: i32,
    period: f32,
    weak_hops: usize,
    /// Candidate drifted note: (midi, first seen at).
    drift: Option<(i32, u64)>,
}

/// The note that was sounding when a periodicity break opened the current pending window.
#[derive(Clone, Copy, Debug)]
struct Interrupted {
    note: Active,
    /// Mean analysis-signal energy over the period preceding the break.
    energy: f32,
    /// Strongest break ratio seen during the period following the break.
    peak_ratio: f32,
}

#[derive(Clone, Copy, Debug)]
enum State {
    Idle,
    Pending { onset: u64, start: u64, agree: usize, cand: i32, from: Option<Interrupted> },
    Active(Active),
}

pub struct NoteTracker {
    cfg: TrackerConfig,
    detector: Box<dyn PitchDetector>,
    onset: OnsetDetector,
    lowpass: Biquad,
    /// Low-passed analysis signal, circular.
    hist: Vec<f32>,
    /// Break-detector band (first harmonics of the sounding note), circular.
    break_lp: Biquad,
    break_hist: Vec<f32>,
    /// When `break_lp` was last retuned.
    break_since: u64,
    /// 1 ms energy envelope of the break band, circular (release guard).
    env_hist: Vec<f32>,
    mask: usize,
    pos: u64,
    since_hop: usize,
    hop_energy: f64,
    level_db: f32,
    window: Vec<f32>,
    state: State,
    c_1ms: f32,
    sig_env: f32,
    err_env: f32,
}

impl NoteTracker {
    pub fn new(cfg: TrackerConfig) -> Self {
        let detector: Box<dyn PitchDetector> = match cfg.algorithm {
            Algorithm::Mpm => Box::new(Mpm::new(cfg.pitch)),
            Algorithm::Yin => Box::new(Yin::new(cfg.pitch)),
        };
        let hist_len = (2 * cfg.pitch.max_window + cfg.hop).next_power_of_two();
        let sr = cfg.pitch.sample_rate;
        Self {
            cfg,
            detector,
            onset: OnsetDetector::new(cfg.onset),
            lowpass: Biquad::lowpass(sr, ANALYSIS_LOWPASS_HZ, std::f32::consts::FRAC_1_SQRT_2),
            hist: vec![0.0; hist_len],
            break_lp: Biquad::lowpass(sr, ANALYSIS_LOWPASS_HZ, std::f32::consts::FRAC_1_SQRT_2),
            break_hist: vec![0.0; hist_len],
            break_since: 0,
            env_hist: vec![0.0; hist_len],
            mask: hist_len - 1,
            pos: 0,
            since_hop: 0,
            hop_energy: 0.0,
            level_db: -240.0,
            window: vec![0.0; cfg.pitch.max_window],
            state: State::Idle,
            c_1ms: 1.0 - (-1.0 / (1e-3 * sr)).exp(),
            sig_env: 0.0,
            err_env: 0.0,
        }
    }

    pub fn config(&self) -> &TrackerConfig {
        &self.cfg
    }

    /// Samples consumed so far.
    pub fn position(&self) -> u64 {
        self.pos
    }

    /// RMS level of the last analysis hop (dBFS).
    pub fn level_db(&self) -> f32 {
        self.level_db
    }

    /// MIDI note currently sounding, if any.
    pub fn active_note(&self) -> Option<i32> {
        match self.state {
            State::Active(a) => Some(a.midi),
            State::Pending { from: Some(i), .. } => Some(i.note.midi),
            _ => None,
        }
    }

    /// Feeds a block of any size. Events are delivered through `emit`; nothing allocates.
    pub fn process(&mut self, block: &[f32], mut emit: impl FnMut(TrackerEvent)) {
        let mut i = 0;
        while i < block.len() {
            let take = (self.cfg.hop - self.since_hop).min(block.len() - i);
            let chunk = &block[i..i + take];
            let attack = self.onset.process(chunk, self.pos);
            let mut broke = None;
            for &s in chunk {
                let idx = self.pos as usize & self.mask;
                self.hist[idx] = self.lowpass.process(s);
                let yb = self.break_lp.process(s);
                self.break_hist[idx] = yb;
                self.sig_env += self.c_1ms * (yb * yb - self.sig_env);
                self.env_hist[idx] = self.sig_env;
                if let Some(at) = self.watch_periodicity(yb) {
                    broke.get_or_insert(at);
                }
                self.pos += 1;
                self.hop_energy += s as f64 * s as f64;
            }
            if let Some(at) = attack {
                self.on_onset(at, &mut emit);
            } else if let Some(at) = broke {
                self.on_break(at);
            }
            self.since_hop += take;
            i += take;
            if self.since_hop == self.cfg.hop {
                let ms = self.hop_energy / self.cfg.hop as f64;
                self.level_db = (10.0 * (ms + 1e-24).log10()) as f32;
                self.hop_energy = 0.0;
                self.since_hop = 0;
                self.analyze(&mut emit);
            }
        }
    }

    /// Periodicity-break detector for one break-band sample (`self.pos` is its index). While a
    /// note is active it reports breaks; during the period right after a break it records how
    /// strong the break was.
    fn watch_periodicity(&mut self, yb: f32) -> Option<u64> {
        let lag = match self.state {
            State::Active(a) => {
                // Armed once the prediction reaches back to samples of this note, filtered by
                // the current band.
                let armed = (a.onset + (2.0 * a.period) as u64).max(self.break_since + a.period as u64) + 48;
                if self.pos < armed {
                    self.err_env = 0.0;
                    return None;
                }
                a.period
            }
            State::Pending { onset, from: Some(i), .. } if self.pos < onset + i.note.period as u64 => i.note.period,
            _ => return None,
        };
        let e = yb - self.lagged(self.pos, lag);
        self.err_env += self.c_1ms * (e * e - self.err_env);
        let ratio = self.err_env / (self.sig_env + 1e-20);
        match &mut self.state {
            State::Pending { from: Some(i), .. } => {
                i.peak_ratio = i.peak_ratio.max(ratio);
                None
            }
            _ => {
                // A fast decay (palm mute, release) also breaks the prediction: not a new note.
                let then = self.env_hist[(self.pos - lag as u64) as usize & self.mask];
                let fading = self.sig_env < 0.5 * then;
                (ratio > self.cfg.break_ratio && !fading).then_some(self.pos)
            }
        }
    }

    /// Break band at fractional position `pos − lag` (linear interpolation).
    fn lagged(&self, pos: u64, lag: f32) -> f32 {
        let t = pos as f32 - lag;
        let i = t.floor();
        let f = t - i;
        let i = i as u64;
        let a = self.break_hist[i as usize & self.mask];
        let b = self.break_hist[(i + 1) as usize & self.mask];
        a + f * (b - a)
    }

    /// Mean analysis-signal energy over `[from, to)`.
    fn energy(&self, from: u64, to: u64) -> f32 {
        let n = to.saturating_sub(from).max(1);
        let sum: f64 = (from..to)
            .map(|k| {
                let v = self.hist[k as usize & self.mask] as f64;
                v * v
            })
            .sum();
        (sum / n as f64) as f32
    }

    fn retune_break_band(&mut self, period: f32) {
        let sr = self.cfg.pitch.sample_rate;
        let fc = (BREAK_BAND_HARMONICS * sr / period).clamp(300.0, ANALYSIS_LOWPASS_HZ);
        self.break_lp = Biquad::lowpass(sr, fc, std::f32::consts::FRAC_1_SQRT_2);
        self.break_since = self.pos;
        self.err_env = 0.0;
    }

    fn on_onset(&mut self, at: u64, emit: &mut impl FnMut(TrackerEvent)) {
        match self.state {
            State::Active(a) => emit(TrackerEvent::NoteOff { sample: at, midi: a.midi }),
            State::Pending { from: Some(i), .. } => emit(TrackerEvent::NoteOff { sample: at, midi: i.note.midi }),
            _ => {}
        }
        emit(TrackerEvent::Onset { sample: at });
        let start = self.window_start(at);
        self.state = State::Pending { onset: at, start, agree: 0, cand: i32::MIN, from: None };
    }

    /// Pitch-window start for an attack at `at`: `settle_ms` later when something was already
    /// sounding, whose tail (and the pick contact) would bias the first estimates.
    fn window_start(&self, at: u64) -> u64 {
        let sr = self.cfg.pitch.sample_rate;
        let busy = db_to_lin(self.cfg.min_level_db + 20.0);
        if self.energy(at.saturating_sub((0.005 * sr) as u64), at) > busy * busy {
            at + (self.cfg.settle_ms * 1e-3 * sr) as u64
        } else {
            at
        }
    }

    /// The smoothed error crosses the threshold up to ~2 ms after the change itself: find the
    /// first sample of the last 3 ms whose instantaneous prediction error is large compared
    /// with the signal level before the change.
    fn backtrack_break(&self, at: u64, a: &Active) -> u64 {
        let reach = (0.003 * self.cfg.pitch.sample_rate) as u64;
        let armed = a.start + (2.0 * a.period) as u64;
        let from = at.saturating_sub(reach).max(armed).max(self.break_since + a.period as u64);
        let reference = self.env_hist[from as usize & self.mask];
        let threshold = 2.0 * self.cfg.break_ratio * reference;
        (from..at)
            .find(|&k| {
                let e = self.break_hist[k as usize & self.mask] - self.lagged(k, a.period);
                e * e > threshold
            })
            .unwrap_or(at)
    }

    fn on_break(&mut self, at: u64) {
        if let State::Active(a) = self.state {
            let at = self.backtrack_break(at, &a);
            let p = a.period.ceil() as u64;
            let energy = self.energy(at.saturating_sub(p), at);
            let peak_ratio = self.err_env / (self.sig_env + 1e-20);
            let from = Some(Interrupted { note: a, energy, peak_ratio });
            let start = at + (self.cfg.settle_ms * 1e-3 * self.cfg.pitch.sample_rate) as u64;
            self.state = State::Pending { onset: at, start, agree: 0, cand: i32::MIN, from };
        }
    }

    /// Runs the detector on the most recent `len` samples.
    fn detect_last(&mut self, len: usize) -> Option<PitchEstimate> {
        let len = len.min(self.window.len()).min(self.pos as usize);
        let start = self.pos - len as u64;
        for (k, w) in self.window[..len].iter_mut().enumerate() {
            *w = self.hist[(start as usize + k) & self.mask];
        }
        self.detector.detect(&self.window[..len])
    }

    fn pitch_event(&self, e: &PitchEstimate) -> TrackerEvent {
        TrackerEvent::Pitch {
            sample: self.pos,
            freq_hz: e.freq_hz,
            midi_f: note::freq_to_midi(e.freq_hz, self.cfg.a4_hz),
            clarity: e.clarity,
        }
    }

    fn analyze(&mut self, emit: &mut impl FnMut(TrackerEvent)) {
        match self.state {
            State::Idle => {}
            State::Pending { onset, start, agree, cand, from } => {
                self.analyze_pending(onset, start, agree, cand, from, emit)
            }
            State::Active(a) => self.analyze_active(a, emit),
        }
    }

    fn analyze_pending(
        &mut self,
        onset: u64,
        start: u64,
        agree: usize,
        cand: i32,
        from: Option<Interrupted>,
        emit: &mut impl FnMut(TrackerEvent),
    ) {
        let now = self.pos;
        if (now - onset) as f32 > self.cfg.max_pending_ms * 1e-3 * self.cfg.pitch.sample_rate {
            if let Some(i) = from {
                emit(TrackerEvent::NoteOff { sample: onset, midi: i.note.midi });
            }
            self.state = State::Idle;
            return;
        }
        let since = now.saturating_sub(start) as usize;
        let Some(e) = self.detect_last(since) else {
            self.state = State::Pending { onset, start, agree: 0, cand: i32::MIN, from };
            return;
        };
        if from.is_some() && e.clarity >= self.cfg.hold_clarity {
            emit(self.pitch_event(&e));
        }
        if e.clarity < self.cfg.note_on_clarity {
            self.state = State::Pending { onset, start, agree: 0, cand: i32::MIN, from };
            return;
        }
        let (midi, cents) = note::nearest_note(e.freq_hz, self.cfg.a4_hz);
        let agree = if midi == cand { agree + 1 } else { 1 };
        if agree < self.cfg.confirm {
            self.state = State::Pending { onset, start, agree, cand: midi, from };
            return;
        }
        let mut legato = false;
        if let Some(i) = from {
            // Period-synchronous energies on both sides of the break.
            let p = i.note.period.ceil() as u64;
            let rise_db = 10.0 * (self.energy(onset, (onset + p).min(now)) / i.energy.max(1e-12)).log10();
            let added = rise_db >= self.cfg.repick_rise_db;
            if midi == i.note.midi && !added && i.peak_ratio < self.cfg.repick_ratio {
                // Same pitch, no energy, weak break: the note simply goes on.
                self.state = State::Active(Active { period: e.period, weak_hops: 0, drift: None, ..i.note });
                return;
            }
            legato = midi != i.note.midi && !added;
            emit(TrackerEvent::NoteOff { sample: onset, midi: i.note.midi });
            if !legato {
                emit(TrackerEvent::Onset { sample: onset });
            }
        }
        // A pitch that shows up long after the attack (a chord strummed, then a note on its own
        // a few tens of ms later, too soft against the ringing chord to be noticed) started when
        // it could first have been measured, not at that attack.
        let onset = if from.is_none() {
            let sr = self.cfg.pitch.sample_rate;
            let measurable = now.saturating_sub((self.detector.min_window_for(e.freq_hz) + self.cfg.confirm.max(1) * self.cfg.hop) as u64);
            let settle = (self.cfg.settle_ms * 1e-3 * sr) as u64;
            if measurable > onset + settle + (LATE_PITCH_MS * 1e-3 * sr) as u64 {
                // Where the sound rose the most since the attack, by 5 ms steps.
                let step = (0.005 * sr) as u64;
                let from = (onset + settle).max(now.saturating_sub(self.mask as u64 / 2) + 2 * step);
                (from..=measurable)
                    .step_by(step as usize / 4)
                    .map(|t| (t, self.energy(t, t + step) / self.energy(t - 2 * step, t).max(1e-12)))
                    .filter(|&(_, rise)| rise >= 2.0)
                    .max_by(|a, b| a.1.total_cmp(&b.1))
                    .map_or(onset, |(t, _)| t)
            } else {
                onset
            }
        } else {
            onset
        };
        emit(TrackerEvent::NoteOn {
            onset_sample: onset,
            sample: now,
            midi,
            freq_hz: e.freq_hz,
            cents,
            clarity: e.clarity,
            legato,
        });
        self.retune_break_band(e.period);
        self.state = State::Active(Active { onset, start, midi, period: e.period, weak_hops: 0, drift: None });
    }

    fn analyze_active(&mut self, mut a: Active, emit: &mut impl FnMut(TrackerEvent)) {
        let now = self.pos;
        if self.level_db < self.cfg.min_level_db - self.cfg.release_hysteresis_db {
            emit(TrackerEvent::NoteOff { sample: now, midi: a.midi });
            self.state = State::Idle;
            return;
        }
        let sr = self.cfg.pitch.sample_rate;
        let since = now.saturating_sub(a.start) as usize;
        let want = (self.cfg.track_periods * a.period).ceil() as usize;
        let floor = self.detector.min_window_for(sr / a.period) + self.cfg.hop;
        let len = want.min(since).max(floor).min(self.cfg.pitch.max_window);
        match self.detect_last(len) {
            Some(e) if e.clarity >= self.cfg.hold_clarity => {
                a.weak_hops = 0;
                emit(self.pitch_event(&e));
                let midi_f = note::freq_to_midi(e.freq_hz, self.cfg.a4_hz);
                if (midi_f - a.midi as f32).abs() <= self.cfg.legato_semitones {
                    a.drift = None;
                    a.period = e.period;
                } else {
                    // Slow glide without a periodicity break: commit once the new pitch has
                    // filled a whole analysis window, so the window no longer mixes notes.
                    let n = midi_f.round() as i32;
                    let first = match a.drift {
                        Some((m, first)) if m == n => first,
                        _ => now,
                    };
                    a.drift = Some((n, first));
                    if now - first >= len as u64 && e.clarity >= self.cfg.note_on_clarity {
                        emit(TrackerEvent::NoteOff { sample: first, midi: a.midi });
                        let onset = first.saturating_sub(len as u64 / 2);
                        emit(TrackerEvent::NoteOn {
                            onset_sample: onset,
                            sample: now,
                            midi: n,
                            freq_hz: e.freq_hz,
                            cents: (midi_f - n as f32) * 100.0,
                            clarity: e.clarity,
                            legato: true,
                        });
                        self.retune_break_band(e.period);
                        a = Active { onset, start: onset, midi: n, period: e.period, weak_hops: 0, drift: None };
                    }
                }
            }
            _ => {
                a.weak_hops += 1;
                if a.weak_hops >= self.cfg.max_weak_hops {
                    emit(TrackerEvent::NoteOff { sample: now, midi: a.midi });
                    self.state = State::Idle;
                    return;
                }
            }
        }
        self.state = State::Active(a);
    }
}
