//! Replays a take offline through the whole engine: the same tracker, chord verifier, session
//! and game as live, fed with what the guitar played, on simulated audio callbacks (no device).
//! A change to the detection or the judging is measured on real playing this way.

use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::sync::Arc;

use opensmith_audio::{Bridge, EngineConfig, Monitor};

use crate::events::{UiEvent, UiMissReason, UiTarget};
use crate::session::{AudioBackend, Session, SessionConfig};
use crate::take::Take;

const BLOCK: usize = 64;
const OUT_LATENCY: f64 = 0.012;
const IN_LATENCY: f64 = 0.003;
/// The input device starts a little after the output one.
const IN_START: f64 = 0.0137;
/// Playback starts this long before the take's first sample (s).
const LEAD: f64 = 1.0;
/// Session updates, host seconds apart.
const UPDATE: f64 = 0.002;

struct Sim {
    monitor: Monitor,
    now: Arc<AtomicU64>,
}

impl AudioBackend for Sim {
    fn monitor(&mut self) -> &mut Monitor {
        &mut self.monitor
    }
    fn now_ns(&self) -> u64 {
        self.now.load(Relaxed)
    }
}

/// The take played again through the engine set up by `engine` (its tracker settings) and
/// `cfg` (judging), each phrase at the level it was played at: the session's events.
pub fn replay(take: &Take, engine: &EngineConfig, mut cfg: SessionConfig) -> Vec<UiEvent> {
    let sr = take.sample_rate as f64;
    // The input clock against the song clock (the device's drift), from the anchors.
    let ratio = match (take.anchors.first(), take.anchors.last()) {
        (Some(a), Some(b)) if b.1 > a.1 + 1.0 => (b.0 - a.0) as f64 / sr / (b.1 - a.1),
        _ => 1.0,
    };
    let (first, last) = take.span();
    let start = first - LEAD;
    // Song time `s` is heard at host time `s - start + OUT_LATENCY`; input sample `i` is
    // captured at host time `IN_START + i / (sr * ratio)`: the take starts `pad` samples in.
    let pad = ((LEAD + OUT_LATENCY - IN_START) * sr * ratio).round().max(0.0) as usize;
    let mut guitar = vec![0.0f32; pad];
    guitar.extend_from_slice(&take.guitar);

    cfg.game.input_offset = take.input_offset;
    let Bridge { mut input, mut output, monitor } = Bridge::new(&EngineConfig { sample_rate: take.sample_rate, ..engine.clone() }, 1, 2, 0.0);
    let now = Arc::new(AtomicU64::new(0));
    let mut session = Session::new(Sim { monitor, now: now.clone() }, cfg);
    session.load(take.chart.clone(), None, start);
    session.force_levels(take.levels.clone());
    session.play();

    let until = last - start + OUT_LATENCY + 0.5;
    let period = BLOCK as f64 / sr;
    let (mut out_k, mut in_k, mut next_update) = (0usize, 0usize, 0.0f64);
    let mut out = vec![0.0f32; BLOCK * 2];
    let silence = [0.0f32; BLOCK];
    let mut events = Vec::new();
    loop {
        let t_out = out_k as f64 * period;
        let t_in = IN_START + in_k as f64 * period / ratio + IN_LATENCY;
        let t = t_out.min(t_in).min(next_update);
        if t > until {
            break;
        }
        now.store((t * 1e9) as u64, Relaxed);
        if t == t_out {
            output.process(&mut out, (t * 1e9) as u64, (OUT_LATENCY * 1e9) as u64);
            out_k += 1;
        } else if t == t_in {
            let i = in_k * BLOCK;
            input.process(guitar.get(i..i + BLOCK).unwrap_or(&silence), (t * 1e9) as u64, (IN_LATENCY * 1e9) as u64);
            in_k += 1;
        } else {
            session.update();
            events.extend(session.take_events());
            next_update += UPDATE;
        }
    }
    events
}

/// What a replay (or a live play) judged.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Report {
    pub notes: usize,
    pub notes_hit: usize,
    pub chords: usize,
    pub chords_hit: usize,
    pub perfects: usize,
    /// Mean timing error of the hits (s).
    pub mean_error: f64,
    pub unplayed: usize,
    pub early: usize,
    pub late: usize,
    pub high: usize,
    pub low: usize,
    pub wrong_chord: usize,
    pub technique: usize,
    /// Notes played that the chart did not ask for.
    pub extras: u32,
}

impl Report {
    pub fn of(events: &[UiEvent]) -> Report {
        let mut r = Report::default();
        let mut chord = std::collections::HashMap::new();
        let mut errors = Vec::new();
        for e in events {
            match e {
                UiEvent::Reset => chord.clear(),
                UiEvent::Expected { items, .. } => {
                    chord.extend(items.iter().map(|i| (i.index, matches!(i.target, UiTarget::Chord { .. }))));
                }
                UiEvent::Hit { index, error, perfect, .. } => {
                    let is_chord = chord.get(index).copied().unwrap_or(false);
                    *if is_chord { &mut r.chords } else { &mut r.notes } += 1;
                    *if is_chord { &mut r.chords_hit } else { &mut r.notes_hit } += 1;
                    r.perfects += *perfect as usize;
                    errors.push(*error);
                }
                UiEvent::Miss { index, reason, .. } => {
                    *if chord.get(index).copied().unwrap_or(false) { &mut r.chords } else { &mut r.notes } += 1;
                    match reason {
                        UiMissReason::Unplayed => r.unplayed += 1,
                        UiMissReason::Timing { error } if *error < 0.0 => r.early += 1,
                        UiMissReason::Timing { .. } => r.late += 1,
                        UiMissReason::Pitch { semitones } if *semitones > 0 => r.high += 1,
                        UiMissReason::Pitch { .. } => r.low += 1,
                        UiMissReason::WrongChord => r.wrong_chord += 1,
                        UiMissReason::Technique => r.technique += 1,
                    }
                }
                UiEvent::Late { .. } => {
                    // The miss it explains was counted unplayed or off pitch: now late.
                    if r.unplayed > 0 {
                        r.unplayed -= 1;
                    } else if r.high + r.low > 0 {
                        if r.high > 0 { r.high -= 1 } else { r.low -= 1 }
                    }
                    r.late += 1;
                }
                UiEvent::Score { score } => r.extras = score.extras,
                _ => {}
            }
        }
        r.mean_error = if errors.is_empty() { 0.0 } else { errors.iter().sum::<f64>() / errors.len() as f64 };
        r
    }

    pub fn judged(&self) -> usize {
        self.notes + self.chords
    }

    pub fn hits(&self) -> usize {
        self.notes_hit + self.chords_hit
    }

    pub fn accuracy(&self) -> f64 {
        if self.judged() == 0 { 0.0 } else { self.hits() as f64 / self.judged() as f64 }
    }
}

impl fmt::Display for Report {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        let pct = |a: usize, b: usize| if b == 0 { "—".to_string() } else { format!("{:.0} %", 100.0 * a as f64 / b as f64) };
        write!(
            f,
            "{} : notes {} ({}/{}), accords {} ({}/{}), timing {:+.0} ms ; ratées : {} pas jouées, {} tôt, {} tard, {} haut, {} bas, {} mauvais accord, {} techniques ; {} en trop",
            pct(self.hits(), self.judged()),
            pct(self.notes_hit, self.notes),
            self.notes_hit,
            self.notes,
            pct(self.chords_hit, self.chords),
            self.chords_hit,
            self.chords,
            self.mean_error * 1000.0,
            self.unplayed,
            self.early,
            self.late,
            self.high,
            self.low,
            self.wrong_chord,
            self.technique,
            self.extras
        )
    }
}

/// How the judging of a replayed performance agrees with what was played: for each kind of
/// playing, how many items and how many the game counted as hits.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Agreement {
    /// (what was played, deserves a hit, items, judged hits), in order of first appearance.
    pub rows: Vec<(&'static str, bool, usize, usize)>,
    /// What was played right but refused: (kind of item and technique, the reason given), count.
    pub refused: Vec<(String, usize)>,
    /// What was played wrong (or not at all) but counted: (kind of item and technique, what was
    /// played), count.
    pub counted: Vec<(String, usize)>,
}

impl Agreement {
    pub fn of(truth: &[(bool, usize, crate::guitarist::Played)], events: &[UiEvent], chart: &opensmith_game::Chart) -> Agreement {
        use std::collections::HashMap;
        let mut item = HashMap::new();
        let mut hit: HashMap<(bool, usize), bool> = HashMap::new();
        let mut why: HashMap<(bool, usize), UiMissReason> = HashMap::new();
        for e in events {
            match e {
                UiEvent::Expected { items, .. } => {
                    item.extend(items.iter().map(|i| (i.index, (matches!(i.target, UiTarget::Chord { .. }), i.event))));
                }
                UiEvent::Hit { index, .. } | UiEvent::Miss { index, .. } => {
                    if let Some(&key) = item.get(index) {
                        hit.insert(key, matches!(e, UiEvent::Hit { .. }));
                        if let UiEvent::Miss { reason, .. } = e {
                            why.insert(key, *reason);
                        }
                    }
                }
                _ => {}
            }
        }
        let mut a = Agreement::default();
        for &(chord, event, played) in truth {
            let Some(&judged) = hit.get(&(chord, event)) else { continue };
            let tech = if chord { chart.chords[event].techniques.clone() } else { chart.notes[event].techniques.clone() }.unwrap_or_default();
            let what = |tech: &opensmith_game::chart::Techniques| {
                [
                    (tech.mute == Some(true), "étouffé"),
                    (tech.palm_mute == Some(true), "palm mute"),
                    (tech.harmonic == Some(true) || tech.pinch_harmonic == Some(true), "harmonique"),
                    (tech.hammer_on == Some(true) || tech.pull_off == Some(true), "lié"),
                    (tech.slide_to.is_some(), "slide"),
                    (tech.bend.is_some_and(|b| b > 0.0), "bend"),
                ]
                .iter()
                .find(|k| k.0)
                .map_or("", |k| k.1)
            };
            if !played.deserves_hit() && judged {
                let key = format!("{} {} ← {}", if chord { "accord" } else { "note" }, what(&tech), played.label()).replace("  ", " ");
                match a.counted.iter_mut().find(|r| r.0 == key) {
                    Some(r) => r.1 += 1,
                    None => a.counted.push((key, 1)),
                }
            }
            if played.deserves_hit() && !judged {
                let kind = what(&tech);
                let reason = match why.get(&(chord, event)) {
                    Some(UiMissReason::Unplayed) | None => "pas entendue",
                    Some(UiMissReason::Timing { .. }) => "hors du temps",
                    Some(UiMissReason::Pitch { .. }) => "mauvaise hauteur",
                    Some(UiMissReason::WrongChord) => "mauvais accord",
                    Some(UiMissReason::Technique) => "technique non réalisée",
                };
                let key = format!("{} {kind} → {reason}", if chord { "accord" } else { "note" }).replace("  ", " ");
                match a.refused.iter_mut().find(|r| r.0 == key) {
                    Some(r) => r.1 += 1,
                    None => a.refused.push((key, 1)),
                }
            }
            let label = played.label();
            match a.rows.iter_mut().find(|r| r.0 == label) {
                Some(r) => {
                    r.2 += 1;
                    r.3 += judged as usize;
                }
                None => a.rows.push((label, played.deserves_hit(), 1, judged as usize)),
            }
        }
        a
    }

    pub fn add(&mut self, other: &Agreement) {
        for (mine, theirs) in [(&mut self.refused, &other.refused), (&mut self.counted, &other.counted)] {
            for r in theirs {
                match mine.iter_mut().find(|s| s.0 == r.0) {
                    Some(s) => s.1 += r.1,
                    None => mine.push(r.clone()),
                }
            }
        }
        for r in &other.rows {
            match self.rows.iter_mut().find(|s| s.0 == r.0) {
                Some(s) => {
                    s.2 += r.2;
                    s.3 += r.3;
                }
                None => self.rows.push(*r),
            }
        }
    }

    /// Share of what was played right counted as hits, and of what was played wrong refused.
    pub fn fairness(&self) -> (f64, f64) {
        let share = |good: bool| {
            let (n, ok) = self.rows.iter().filter(|r| r.1 == good).fold((0, 0), |(n, ok), r| (n + r.2, ok + if good { r.3 } else { r.2 - r.3 }));
            if n == 0 { f64::NAN } else { ok as f64 / n as f64 }
        };
        (share(true), share(false))
    }
}

impl fmt::Display for Agreement {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        for (label, good, n, hits) in &self.rows {
            let (verdict, k) = if *good { ("comptée", *hits) } else { ("refusée", n - hits) };
            writeln!(f, "  {label:<30} {n:>7}   {verdict} {:>5.1} %", 100.0 * k as f64 / (*n).max(1) as f64)?;
        }
        let (right, wrong) = self.fairness();
        write!(f, "  bien joué compté {:.1} %, mal joué refusé {:.1} %", 100.0 * right, 100.0 * wrong)?;
        for (title, list) in [("bien joué mais refusé", &self.refused), ("mal joué mais compté", &self.counted)] {
            let mut list = list.clone();
            list.sort_by_key(|r| std::cmp::Reverse(r.1));
            if !list.is_empty() {
                write!(f, "\n  {title} :")?;
                for (key, n) in list.iter().take(8) {
                    write!(f, "\n    {n:>6}  {key}")?;
                }
            }
        }
        Ok(())
    }
}
