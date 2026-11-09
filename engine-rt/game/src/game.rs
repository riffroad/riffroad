//! Game rules: judging the player against the chart, score and streak, dynamic difficulty.
//!
//! Times are song seconds (the backing track's clock). Notes are judged on their *attack*
//! timestamp from the tracker, known within a millisecond, even though the pitch is confirmed
//! about 25 ms later on the low E: a late confirmation never makes a hit late. Chords are
//! judged by the chord verifier, which the engine runs on the audio of the chords listed by
//! `chords_ready`.
//!
//! A note is judged to the nearest semitone once the player's own tuning drift, learnt from the
//! notes hit, is taken off. A different octave is a different note. Dead
//! notes, muted strums and pinch harmonics have no pitch to check: their attack is judged alone.
//! A natural harmonic is judged at the pitch it sounds.
//!
//! A miss says why, from what the guitar played around the note: nothing, the right note too
//! early or too late, another note (too high, too low), or a strum the verifier did not hear as
//! the chord. A note played late enough to come after its miss explains it then (`Late`).
//!
//! Dynamic difficulty: every phrase name has its own level. When a phrase
//! iteration is over, a good run (≥ `level_up` accuracy) raises that phrase's level, a poor one
//! (< `level_down`) lowers it. The level of an iteration is fixed when it becomes visible,
//! `lookahead` seconds before it starts, so notes never change under the player's eyes.

use std::collections::{HashMap, VecDeque};

use crate::chart::{Chart, Note};
use crate::performance::Performance;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GameConfig {
    /// A note counts when played within ± this many seconds of its time.
    pub hit_window: f64,
    /// Tighter window for a "perfect".
    pub perfect_window: f64,
    /// Seconds subtracted from player timestamps (input + output latency calibration).
    pub input_offset: f64,
    /// Phrases become visible, and their level is fixed, this long before they start.
    pub lookahead: f64,
    pub dynamic_difficulty: bool,
    /// Level of every phrase at the start (and the fixed level without dynamic difficulty).
    pub start_level: u32,
    pub level_up: f64,
    pub level_down: f64,
}

impl Default for GameConfig {
    fn default() -> Self {
        Self {
            hit_window: 0.10,
            perfect_window: 0.04,
            input_offset: 0.0,
            lookahead: 3.0,
            dynamic_difficulty: true,
            start_level: 0,
            level_up: 0.85,
            level_down: 0.5,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Target {
    Note { string: u8, fret: u8, midi: i32 },
    Chord { template: usize, midis: Vec<i32> },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Pending,
    Hit,
    Missed,
}

/// A note or chord the player has to play.
#[derive(Clone, Debug)]
pub struct Expected {
    /// Index in `Chart::notes` or `Chart::chords`, by target kind.
    pub event: usize,
    pub time: f64,
    pub sustain: f64,
    pub target: Target,
    /// Phrase iteration (index in `Chart::phrases`).
    pub iteration: usize,
    pub status: Status,
    /// The chord verifier, or the note detector for a note the tracker did not hear, already
    /// looked at it.
    pub checked: bool,
    /// Missed notes: why (what the chords' verifier found, before the miss).
    pub reason: Option<MissReason>,
    /// Judged on its attack alone, whatever the pitch: a dead note, a muted strum, a pinch
    /// harmonic.
    pub attack_only: bool,
}

/// Why a note or chord was missed, from what the guitar played around it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum MissReason {
    /// Nothing heard that could be it.
    Unplayed,
    /// The right note (a strum, for a chord) outside the window, `error` seconds from the note's
    /// time: negative when early.
    Timing { error: f64 },
    /// Another note in the window, `semitones` from the expected one: positive when too high.
    Pitch { semitones: i32 },
    /// Chords: strummed in time, but not heard as the chord.
    WrongChord,
    /// Attack was right, but the requested sustain or pitch gesture was not played.
    Technique,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Judgement {
    Hit { index: usize, time: f64, error: f64, perfect: bool },
    Miss { index: usize, time: f64, reason: MissReason },
    /// A note already missed was played after all, `error` seconds late: the reason of its miss,
    /// known only now.
    Late { index: usize, error: f64 },
    PhraseDone { iteration: usize, name: String, accuracy: f64, level: u32, next_level: u32 },
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Score {
    pub hits: u32,
    pub perfects: u32,
    pub misses: u32,
    /// Notes played that the chart did not ask for (not penalised).
    pub extras: u32,
    pub streak: u32,
    pub best_streak: u32,
    pub points: u64,
}

impl Score {
    pub fn accuracy(&self) -> f64 {
        let judged = self.hits + self.misses;
        if judged == 0 { 0.0 } else { self.hits as f64 / judged as f64 }
    }

    /// ×1 to ×4, one step per 10 notes in a row.
    pub fn multiplier(&self) -> u64 {
        (1 + self.streak as u64 / 10).min(4)
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct Iteration {
    level: u32,
    hits: u32,
    total: u32,
    activated: bool,
    done: bool,
}

pub struct Game {
    chart: Chart,
    cfg: GameConfig,
    levels: HashMap<String, u32>,
    iterations: Vec<Iteration>,
    next_iteration: usize,
    expected: Vec<Expected>,
    score: Score,
    /// Notes before this song time are not judged (seek, retry from a phrase).
    start_at: f64,
    /// Only notes in this span are shown and judged (Loop Trainer); kept across restarts.
    range: (f64, f64),
    /// What the guitar played lately that no note took, (attack, MIDI), to explain misses.
    stray: VecDeque<(f64, i32)>,
    /// Strums lately (pitch or not), for the misses of chords.
    strums: VecDeque<f64>,
    /// Attacks already scored, shared by the tracker and the slower note/chord verifiers.
    used_attacks: VecDeque<(f64, f64)>,
    performances: HashMap<usize, Performance>,
    /// How far the player's guitar sounds off the chart's pitches (semitones, within
    /// ±`MAX_DRIFT`), learnt from the notes hit: a guitar a little out of tune, or going out of
    /// tune, is still judged right.
    drift: f64,
    /// Replays: the level each phrase iteration is played at, as in the take (`None`: not
    /// reached then, so not played now).
    forced: Option<Vec<Option<u32>>>,
}

/// Extra time after a chord's hit window for its verification to come back: the strum's
/// spread, then the 160 ms of audio the note detector looks at.
const CHORD_GRACE: f64 = 0.25;
/// Extra time after a note's hit window for it to be confirmed: by the tracker a few tens of ms
/// after its attack (its attack time is judged), or by the note detector, which needs 120 ms of
/// audio after it.
const NOTE_GRACE: f64 = 0.18;
/// The right note this far from a missed one (and outside its window) was played too early or
/// too late.
const TIMING_SPAN: f64 = 0.35;
/// The onset and pitch detectors can date the same pick a few milliseconds apart.
const ATTACK_EPSILON: f64 = 0.003;
/// The tuning drift learnt from the notes hit stays within this many semitones.
const MAX_DRIFT: f64 = 0.45;

/// The pitch a note sounds as written: a natural harmonic sounds the partial of its node; a
/// dead note, a pinch harmonic or a harmonic off the usual nodes has no pitch to judge (`None`).
fn sounding(chart: &Chart, n: &Note) -> Option<i32> {
    let t = n.techniques.clone().unwrap_or_default();
    if t.mute == Some(true) || t.pinch_harmonic == Some(true) {
        return None;
    }
    let open = chart.pitch(n.string, 0);
    if t.harmonic == Some(true) {
        return match n.fret {
            12 => Some(open + 12),
            7 | 19 => Some(open + 19),
            5 | 24 => Some(open + 24),
            4 | 9 | 16 => Some(open + 28),
            3 => Some(open + 31),
            _ => None,
        };
    }
    Some(chart.pitch(n.string, n.fret))
}

impl Game {
    pub fn new(chart: Chart, cfg: GameConfig) -> Game {
        let iterations = vec![Iteration::default(); chart.phrases.len()];
        Game {
            chart,
            cfg,
            levels: HashMap::new(),
            iterations,
            next_iteration: 0,
            expected: Vec::new(),
            score: Score::default(),
            start_at: f64::NEG_INFINITY,
            range: (f64::NEG_INFINITY, f64::INFINITY),
            stray: VecDeque::new(),
            strums: VecDeque::new(),
            used_attacks: VecDeque::new(),
            performances: HashMap::new(),
            drift: 0.0,
            forced: None,
        }
    }

    /// Starts over at song time `t` (seek, retry): notes before `t` are not judged, score and
    /// streak start from zero, the levels learnt for each phrase are kept.
    pub fn restart_at(&mut self, t: f64) {
        self.expected.clear();
        self.score = Score::default();
        self.iterations = vec![Iteration::default(); self.chart.phrases.len()];
        self.next_iteration = 0;
        self.start_at = t;
        self.stray.clear();
        self.strums.clear();
        self.used_attacks.clear();
        self.performances.clear();
        while self.next_iteration < self.chart.phrases.len() && self.chart.phrases[self.next_iteration].end <= t {
            self.iterations[self.next_iteration] = Iteration { activated: true, done: true, ..Iteration::default() };
            self.next_iteration += 1;
        }
    }

    pub fn chart(&self) -> &Chart {
        &self.chart
    }

    pub fn score(&self) -> Score {
        self.score
    }

    /// Current level of a phrase (dynamic difficulty).
    pub fn level(&self, phrase: &str) -> u32 {
        let start = self.cfg.start_level.min(self.chart.arrangement.max_difficulty);
        if self.cfg.dynamic_difficulty { *self.levels.get(phrase).unwrap_or(&start) } else { start }
    }

    /// Level at which a phrase iteration is played (fixed when it became visible).
    pub fn iteration_level(&self, iteration: usize) -> Option<u32> {
        self.iterations.get(iteration).filter(|i| i.activated).map(|i| i.level)
    }

    /// Everything made visible so far, in time order per phrase.
    pub fn expected(&self) -> &[Expected] {
        &self.expected
    }

    /// Makes every phrase visible now (previews, tests, offline tools).
    pub fn activate_all(&mut self) {
        self.activate(f64::INFINITY);
    }

    /// Levels the phrases start at (by name), learnt in earlier sessions; capped at the
    /// chart's top level.
    pub fn set_levels(&mut self, levels: HashMap<String, u32>) {
        let top = self.chart.arrangement.max_difficulty;
        self.levels = levels.into_iter().map(|(name, level)| (name, level.min(top))).collect();
    }

    /// Replays a take: each phrase iteration at the level it was played at (`None`: skipped),
    /// whatever the player does now.
    pub fn force_levels(&mut self, levels: Vec<Option<u32>>) {
        self.forced = Some(levels);
    }

    /// Difficulty changed during the song (pause menu): dynamic difficulty from the levels
    /// learnt, or every phrase at `start_level`. The phrases already visible keep their level,
    /// the next ones take the new one.
    pub fn set_difficulty(&mut self, dynamic: bool, start_level: u32) {
        self.cfg.dynamic_difficulty = dynamic;
        self.cfg.start_level = start_level;
    }

    /// Loop Trainer: only the notes from `from` (included) to `to` are shown and judged
    /// (phrases already visible keep theirs: restart to apply it); infinite bounds for the
    /// whole song.
    pub fn set_range(&mut self, from: f64, to: f64) {
        self.range = (from, to);
    }

    /// Latency compensation: seconds subtracted from attack times (calibration result).
    pub fn set_input_offset(&mut self, seconds: f64) {
        self.cfg.input_offset = seconds;
    }

    /// Makes visible what the clock at `now` reveals (the other calls do it too); lets a caller
    /// announce new notes before judging anything.
    pub fn activate_until(&mut self, now: f64) {
        self.activate(now - self.cfg.input_offset);
    }

    fn activate(&mut self, now: f64) {
        while self.next_iteration < self.chart.phrases.len()
            && self.chart.phrases[self.next_iteration].start <= now + self.cfg.lookahead
        {
            let k = self.next_iteration;
            let phrase = &self.chart.phrases[k];
            let forced = self.forced.as_ref().map(|f| f.get(k).copied().flatten());
            if forced == Some(None) {
                self.iterations[k] = Iteration { activated: true, ..Iteration::default() };
                self.next_iteration += 1;
                continue;
            }
            let level = forced.flatten().unwrap_or_else(|| self.level(&phrase.name));
            let (start, end) = (phrase.start, phrase.end);
            let (from, to) = (self.start_at.max(self.range.0), self.range.1);
            let shown = |levels: [u32; 2], t: f64| {
                levels[0] <= level && level <= levels[1] && start <= t && t < end && t >= from && t < to
            };
            let mut new: Vec<Expected> = Vec::new();
            for (event, n) in self.chart.notes.iter().enumerate() {
                if shown(n.levels, n.time) {
                    let heard = sounding(&self.chart, n);
                    let midi = heard.unwrap_or_else(|| self.chart.pitch(n.string, n.fret));
                    new.push(Expected {
                        event,
                        time: n.time,
                        sustain: n.sustain,
                        target: Target::Note { string: n.string, fret: n.fret, midi },
                        iteration: k,
                        status: Status::Pending,
                        checked: false,
                        reason: None,
                        attack_only: heard.is_none(),
                    });
                }
            }
            for (event, c) in self.chart.chords.iter().enumerate() {
                if shown(c.levels, c.time) {
                    new.push(Expected {
                        event,
                        time: c.time,
                        sustain: c.sustain,
                        target: Target::Chord { template: c.template, midis: self.chart.chord_pitches(c.template) },
                        iteration: k,
                        status: Status::Pending,
                        checked: false,
                        reason: None,
                        attack_only: c.techniques.as_ref().and_then(|t| t.mute) == Some(true),
                    });
                }
            }
            new.sort_by(|a, b| a.time.total_cmp(&b.time));
            self.iterations[k] = Iteration { level, total: new.len() as u32, activated: true, ..Iteration::default() };
            self.expected.extend(new);
            self.next_iteration += 1;
        }
    }

    fn hit(&mut self, index: usize, error: f64) -> Judgement {
        let perfect = error.abs() <= self.cfg.perfect_window;
        let e = &mut self.expected[index];
        e.status = Status::Hit;
        self.used_attacks.push_back((e.time + error, if matches!(e.target, Target::Chord { .. }) { 0.05 } else { 0.0 }));
        self.iterations[e.iteration].hits += 1;
        let s = &mut self.score;
        s.hits += 1;
        s.perfects += perfect as u32;
        s.streak += 1;
        s.best_streak = s.best_streak.max(s.streak);
        s.points += (100 + 50 * perfect as u64) * s.multiplier();
        Judgement::Hit { index, time: e.time, error, perfect }
    }

    /// An attack starts a performance when more than its initial pitch is requested. Reserve
    /// it immediately so neither the fallback nor a neighbouring item can reuse it.
    fn attacked(&mut self, index: usize, error: f64) -> Option<Judgement> {
        let e = &self.expected[index];
        if self.performances.contains_key(&index) { return None; }
        let (base, target, techniques) = match e.target {
            Target::Note { midi, fret, .. } => {
                let t = self.chart.notes[e.event].techniques.clone().unwrap_or_default();
                (Some(midi as f64), t.slide_to.map(|f| f as f64 - fret as f64).or(t.bend.map(f64::from)), t)
            }
            Target::Chord { .. } => (None, None, self.chart.chords[e.event].techniques.clone().unwrap_or_default()),
        };
        let gesture = target.is_some() || techniques.vibrato == Some(true) || techniques.palm_mute == Some(true);
        if e.attack_only || (!gesture && e.sustain < 0.35) { return Some(self.hit(index, error)); }
        let attack = e.time + error;
        let next = self.expected.iter().filter(|n| n.time > e.time + 1e-6).map(|n| n.time).fold(self.chart.meta.duration.min(self.range.1), f64::min);
        let wanted = if techniques.palm_mute == Some(true) { 0.23 } else if gesture { e.sustain.max(0.3) } else { e.sustain };
        let duration = wanted.min((next - e.time).max(0.03));
        if !gesture && duration < 0.12 { return Some(self.hit(index, error)); }
        self.used_attacks.push_back((attack, if matches!(e.target, Target::Chord { .. }) { 0.05 } else { 0.0 }));
        self.performances.insert(index, Performance::new(attack, duration, error, base, target, techniques));
        None
    }

    /// Continuous tracker pitch, with the same tuning compensation as attack judgements.
    pub fn observe_pitch(&mut self, time: f64, pitch: f64) {
        let time = time - self.cfg.input_offset;
        for performance in self.performances.values_mut() { performance.pitch(time, pitch - self.drift); }
    }

    /// Raw guitar envelope (dBFS), before the amp/gate: sustain and palm-mute evidence.
    pub fn observe_level(&mut self, time: f64, db: f32) {
        let time = time - self.cfg.input_offset;
        for performance in self.performances.values_mut() { performance.level(time, db); }
    }

    pub fn performing(&self, index: usize) -> bool { self.performances.contains_key(&index) }

    pub fn performed_attack(&self, index: usize) -> Option<f64> {
        self.performances.get(&index).map(|p| p.attack + self.cfg.input_offset)
    }

    /// Wait mode gates attacks by fresh input samples, rather than distances on its stopped
    /// song clock. A new stop must not inherit the preceding strum's spread on that clock.
    pub fn begin_waiting(&mut self) { self.used_attacks.clear(); }

    pub fn sustained_notes(&self) -> Vec<(usize, f64, i32, f64)> {
        self.performances.iter().filter_map(|(&index, p)| p.spectral_target().map(|m| (index, p.attack, m.round() as i32, p.spectral_after))).collect()
    }

    pub fn observe_sustain(&mut self, index: usize, time: f64, heard: bool) {
        if let Some(p) = self.performances.get_mut(&index) { p.spectral_hold(time - self.cfg.input_offset, heard); }
    }

    /// A lesson's clock stands still. Finish this attempt using elapsed input time, without
    /// advancing (and missing) the rest of the chart. A failed gesture can be tried again.
    pub fn finish_waiting(&mut self, index: usize, elapsed: f64) -> Option<Judgement> {
        let p = self.performances.get(&index)?;
        if elapsed < p.until - p.attack + NOTE_GRACE { return None; }
        let p = self.performances.remove(&index).unwrap();
        if p.passed() { Some(self.hit(index, p.error)) }
        else {
            self.used_attacks.retain(|&(a, _)| (a - p.attack).abs() > ATTACK_EPSILON);
            self.expected[index].checked = false;
            None
        }
    }

    /// The tracker heard a note: attack at `time` (song seconds), pitch `midi`.
    pub fn on_note(&mut self, time: f64, midi: i32) -> Option<Judgement> {
        self.on_pitch(time, midi as f64)
    }

    /// The tracker heard a note: attack at `time` (song seconds), `pitch` in fractional MIDI
    /// with the recording's own tuning already taken off.
    pub fn on_pitch(&mut self, time: f64, pitch: f64) -> Option<Judgement> {
        if !self.attack_available(time) {
            return None;
        }
        let t = time - self.cfg.input_offset;
        self.activate(t);
        let w = self.cfg.hit_window;
        let midi = (pitch - self.drift).round() as i32;
        // Only the requested pitch, including its octave; the nearest in time.
        let best = self
            .expected
            .iter()
            .enumerate()
            .filter(|(_, e)| e.status == Status::Pending && !e.attack_only && (e.time - t).abs() <= w)
            .filter_map(|(i, e)| match e.target {
                Target::Note { midi: m, .. } if m == midi => Some((i, e.time)),
                _ => None,
            })
            .min_by(|a, b| (a.1 - t).abs().total_cmp(&(b.1 - t).abs()));
        if let Some((index, at)) = best {
            let off = pitch - midi as f64;
            self.drift = (self.drift + 0.2 * (off - self.drift)).clamp(-MAX_DRIFT, MAX_DRIFT);
            return self.attacked(index, t - at);
        }
        if let Some(index) = self.attack_only_at(t) {
            return Some(self.hit(index, t - self.expected[index].time));
        }
        self.strums.push_back(t);
        let in_chord = self.expected.iter().any(|e| {
            (e.time - t).abs() <= w + CHORD_GRACE
                && matches!(&e.target, Target::Chord { template, midis } if midis.contains(&midi) || self.chart.free_thirds(*template).contains(&midi.rem_euclid(12)))
        });
        if in_chord {
            return None;
        }
        self.score.extras += 1;
        self.stray.push_back((t, midi));
        self.late(t, |e| !e.attack_only && matches!(e.target, Target::Note { midi: m, .. } if m == midi))
    }

    /// The tracker heard an attack at `time` (song seconds), with or without a pitch: it plays
    /// a dead note or a muted strum, and chords strummed out of time say so.
    pub fn on_strum(&mut self, time: f64) -> Option<Judgement> {
        if !self.attack_available(time) {
            return None;
        }
        let t = time - self.cfg.input_offset;
        self.activate(t);
        self.strums.push_back(t);
        if let Some(index) = self.attack_only_at(t) {
            return Some(self.hit(index, t - self.expected[index].time));
        }
        if self.claimed(t, None) {
            return None;
        }
        self.late(t, |e| e.attack_only || matches!(e.target, Target::Chord { .. }))
    }

    /// The pending item judged on its attack alone nearest to an attack at `t`, in its window.
    fn attack_only_at(&self, t: f64) -> Option<usize> {
        let w = self.cfg.hit_window;
        self.expected
            .iter()
            .enumerate()
            .filter(|(_, e)| e.status == Status::Pending && e.attack_only && (e.time - t).abs() <= w)
            .min_by(|a, b| (a.1.time - t).abs().total_cmp(&(b.1.time - t).abs()))
            .map(|(i, _)| i)
    }

    /// A missed item `fits` takes, not explained by its timing yet, whose window ended less
    /// than `TIMING_SPAN` before `t`: it was played late.
    fn late(&mut self, t: f64, fits: impl Fn(&Expected) -> bool) -> Option<Judgement> {
        let w = self.cfg.hit_window;
        let index = self.expected.iter().rposition(|e| {
            e.status == Status::Missed
                && fits(e)
                && t - e.time > w
                && t - e.time <= TIMING_SPAN
                && !matches!(e.reason, Some(MissReason::Timing { .. }))
        })?;
        let e = &mut self.expected[index];
        let error = t - e.time;
        e.reason = Some(MissReason::Timing { error });
        Some(Judgement::Late { index, error })
    }

    /// Whether an attack at `t` belongs to another item than `index`: one in whose window it is.
    fn claimed(&self, t: f64, index: Option<usize>) -> bool {
        let w = self.cfg.hit_window;
        self.expected.iter().enumerate().any(|(i, e)| Some(i) != index && (e.time - t).abs() <= w)
    }

    /// Why expected item `index` was missed.
    fn reason(&self, index: usize) -> MissReason {
        let e = &self.expected[index];
        let w = self.cfg.hit_window;
        let nearest = |times: &mut dyn Iterator<Item = f64>, span: f64| {
            times.filter(|&a| (a - e.time).abs() <= span).min_by(|x, y| (x - e.time).abs().total_cmp(&(y - e.time).abs()))
        };
        if e.attack_only {
            // Any attack in its window would have played it: one outside it was out of time.
            let strum = nearest(&mut self.strums.iter().copied().filter(|&a| !self.claimed(a, Some(index))), TIMING_SPAN);
            return match strum {
                Some(a) if (a - e.time).abs() > w => MissReason::Timing { error: a - e.time },
                _ => MissReason::Unplayed,
            };
        }
        match &e.target {
            Target::Note { midi, .. } => {
                let right = nearest(&mut self.stray.iter().filter(|s| s.1 == *midi).map(|s| s.0), TIMING_SPAN);
                if let Some(a) = right {
                    return MissReason::Timing { error: a - e.time };
                }
                let wrong = self
                    .stray
                    .iter()
                    .filter(|s| (s.0 - e.time).abs() <= w)
                    .min_by(|x, y| (x.0 - e.time).abs().total_cmp(&(y.0 - e.time).abs()));
                match wrong {
                    Some(&(_, m)) => MissReason::Pitch { semitones: m - midi },
                    None => MissReason::Unplayed,
                }
            }
            Target::Chord { .. } => {
                if let Some(reason) = e.reason {
                    return reason;
                }
                let strum = nearest(&mut self.strums.iter().copied().filter(|&a| !self.claimed(a, Some(index))), TIMING_SPAN);
                match strum {
                    Some(a) if (a - e.time).abs() > w => MissReason::Timing { error: a - e.time },
                    Some(_) => MissReason::WrongChord,
                    None => MissReason::Unplayed,
                }
            }
        }
    }

    /// The autopilot (demo mode): every pending note and chord whose time has come is played,
    /// right on time.
    pub fn autoplay(&mut self, now: f64) -> Vec<Judgement> {
        let t = now - self.cfg.input_offset;
        self.activate(t);
        let due: Vec<usize> =
            self.expected.iter().enumerate().filter(|(_, e)| e.status == Status::Pending && e.time <= t).map(|(i, _)| i).collect();
        due.into_iter().map(|i| self.hit(i, 0.0)).collect()
    }

    /// Pending chords whose strum is at least `analysis` seconds old and not verified yet:
    /// (index, time, pitches). Verify the audio from `time` and report with `on_chord`.
    pub fn chords_ready(&mut self, now: f64, analysis: f64) -> Vec<(usize, f64, Vec<i32>)> {
        let t = now - self.cfg.input_offset;
        self.activate(t);
        self.expected
            .iter()
            .enumerate()
            .filter(|(_, e)| e.status == Status::Pending && !e.checked && !e.attack_only && e.time + analysis <= t)
            .filter_map(|(i, e)| match &e.target {
                Target::Chord { midis, .. } => Some((i, e.time, midis.clone())),
                Target::Note { .. } => None,
            })
            .collect()
    }

    /// Pending single notes, not heard by the tracker, whose time is at least `analysis` seconds
    /// old and not checked yet: (index, time, MIDI). Check the audio and report with
    /// `on_note_heard`.
    pub fn notes_ready(&mut self, now: f64, analysis: f64) -> Vec<(usize, f64, i32)> {
        let t = now - self.cfg.input_offset;
        self.activate(t);
        self.expected
            .iter()
            .enumerate()
            .filter(|(_, e)| e.status == Status::Pending && !e.checked && !e.attack_only && e.time + analysis <= t)
            .filter_map(|(i, e)| match e.target {
                Target::Note { midi, .. } => Some((i, e.time, midi)),
                Target::Chord { .. } => None,
            })
            .collect()
    }

    /// What the note detector made of expected note `index` the tracker did not hear: `heard`
    /// in the audio of the attack at `attack` (song time as heard), if there was one.
    pub fn on_note_heard(&mut self, index: usize, heard: bool, attack: Option<f64>) -> Option<Judgement> {
        if attack.is_some_and(|a| !self.attack_available(a)) {
            return None;
        }
        let e = self.expected.get_mut(index)?;
        if e.status != Status::Pending || !matches!(e.target, Target::Note { .. }) {
            return None;
        }
        e.checked = true;
        let error = attack.map(|a| a - self.cfg.input_offset - e.time)?;
        if !heard || error.abs() > self.cfg.hit_window + 1e-9 {
            return None;
        }
        self.attacked(index, error)
    }

    /// Result of the chord verifier for expected chord `index`; `attack` is the strum time
    /// if the tracker saw it.
    pub fn on_chord(&mut self, index: usize, accepted: bool, attack: Option<f64>) -> Option<Judgement> {
        if attack.is_some_and(|a| {
            let t = a - self.cfg.input_offset;
            self.used_attacks.iter().any(|&(used, spread)| t >= used - ATTACK_EPSILON && t <= used + spread + ATTACK_EPSILON)
        }) {
            return None;
        }
        let e = self.expected.get_mut(index)?;
        if e.status != Status::Pending || !matches!(e.target, Target::Chord { .. }) {
            return None;
        }
        e.checked = true;
        let error = attack.map(|a| a - self.cfg.input_offset - e.time);
        if !accepted {
            if error.is_some() {
                e.reason = Some(MissReason::WrongChord);
            }
            return None;
        }
        let error = error.unwrap_or(0.0);
        if error.abs() > self.cfg.hit_window + 1e-9 {
            e.reason = Some(MissReason::Timing { error });
            return None;
        }
        self.attacked(index, error)
    }

    /// Whether an attack (song time before latency compensation) can still score an item.
    /// Both detectors consult the same claims, so a late confirmation cannot score a pick twice.
    pub fn attack_available(&self, time: f64) -> bool {
        let t = time - self.cfg.input_offset;
        !self.used_attacks.iter().any(|&(used, _)| (used - t).abs() <= ATTACK_EPSILON)
    }

    /// The same pitch rule for the tracker and the fallback verifier, with learned tuning
    /// drift but no octave substitution.
    pub fn pitch_matches(&self, pitch: f64, midi: i32) -> bool {
        (pitch - self.drift).round() as i32 == midi
    }

    /// Moves the clock to `now`: unplayed notes become misses, finished phrase iterations
    /// update dynamic difficulty.
    pub fn advance(&mut self, now: f64) -> Vec<Judgement> {
        let t = now - self.cfg.input_offset;
        self.activate(t);
        let mut out = Vec::new();
        let w = self.cfg.hit_window;
        let mut finished: Vec<usize> = self.performances.iter().filter(|(_, p)| p.until + NOTE_GRACE < t).map(|(&i, _)| i).collect();
        finished.sort_by(|&a, &b| self.expected[a].time.total_cmp(&self.expected[b].time).then(a.cmp(&b)));
        for index in finished {
            let p = self.performances.remove(&index).unwrap();
            if p.passed() { out.push(self.hit(index, p.error)); }
            else {
                self.expected[index].reason = Some(MissReason::Technique);
            }
        }
        for index in 0..self.expected.len() {
            let e = &self.expected[index];
            let grace = if matches!(e.target, Target::Chord { .. }) { CHORD_GRACE } else { NOTE_GRACE };
            if e.status == Status::Pending && !self.performances.contains_key(&index) && e.time + w + grace < t {
                let time = e.time;
                let reason = e.reason.unwrap_or_else(|| self.reason(index));
                let e = &mut self.expected[index];
                e.status = Status::Missed;
                e.reason = Some(reason);
                self.score.misses += 1;
                self.score.streak = 0;
                out.push(Judgement::Miss { index, time, reason });
            }
        }
        let old = t - TIMING_SPAN - w - CHORD_GRACE;
        self.used_attacks.retain(|&(a, _)| a >= old);
        while self.stray.front().is_some_and(|s| s.0 < old) {
            self.stray.pop_front();
        }
        while self.strums.front().is_some_and(|&s| s < old) {
            self.strums.pop_front();
        }
        for k in 0..self.iterations.len() {
            let it = self.iterations[k];
            let phrase = &self.chart.phrases[k];
            if !it.activated || it.done || phrase.end + w + CHORD_GRACE >= t
                || self.expected.iter().any(|e| e.iteration == k && e.status == Status::Pending) {
                continue;
            }
            self.iterations[k].done = true;
            if it.total == 0 {
                continue;
            }
            let accuracy = it.hits as f64 / it.total as f64;
            let mut next = it.level;
            if self.cfg.dynamic_difficulty {
                let top = self.chart.arrangement.max_difficulty;
                if accuracy >= self.cfg.level_up && it.level < top {
                    next = it.level + 1;
                } else if accuracy < self.cfg.level_down && it.level > 0 {
                    next = it.level - 1;
                }
                self.levels.insert(phrase.name.clone(), next);
            }
            out.push(Judgement::PhraseDone { iteration: k, name: phrase.name.clone(), accuracy, level: it.level, next_level: next });
        }
        out
    }
}
