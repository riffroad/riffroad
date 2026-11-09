//! A whole song through a session: the backing track goes out through a device with 12 ms of
//! latency, the guitar comes in through another one (3 ms, its own clock, 60 ppm off), and the
//! guitarist plays what they hear. Simulated callbacks, real tracker and chord verifier.

use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::sync::Arc;

use opensmith_audio::{Bridge, EngineConfig, InputSide, Monitor, OutputSide, Track};
use opensmith_dsp::synth::{mix_into, Pcg32, Pluck};
use opensmith_game::{Chart, Game, GameConfig, Target};
use opensmith_session::replay::{replay, Report};
use opensmith_session::{AudioBackend, CalibrationPlan, RiffLoop, Session, SessionConfig, Take, UiEvent, UiScore, UiTarget};

const SR: f64 = 48_000.0;
const BLOCK: usize = 64;
const PERIOD: f64 = BLOCK as f64 / SR;
const OUT_LATENCY: f64 = 0.012;
const IN_LATENCY: f64 = 0.003;
const IN_PPM: f64 = 60.0;
/// The input device starts a little after the output one.
const IN_START: f64 = 0.0137;
const COUNT_IN: f64 = 1.0;
const LEVEL: u32 = 4;

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

fn chart() -> Chart {
    Chart::load(concat!(env!("CARGO_MANIFEST_DIR"), "/../game/tests/fixtures/demo_rock.json")).unwrap()
}

fn config() -> SessionConfig {
    let mut cfg = SessionConfig::default();
    cfg.game = GameConfig { dynamic_difficulty: false, start_level: LEVEL, ..cfg.game };
    cfg
}

/// Host time (s) at which song time `t` reaches the player's ears: playback starts with the
/// first output callback, at host time 0, `COUNT_IN` seconds before the song.
fn heard_at(t: f64) -> f64 {
    OUT_LATENCY + COUNT_IN + t
}

/// Input stream index of the sample captured at host time `h`.
fn input_index(h: f64) -> usize {
    ((h - IN_START) * SR * (1.0 + IN_PPM * 1e-6)).round() as usize
}

/// The guitar signal: every expected note and chord played `delay` after it is heard.
fn performance(chart: &Chart, delay: f64) -> Vec<f32> {
    let mut out = vec![0.0f32; input_index(heard_at(chart.meta.duration + 1.0))];
    play_into(&mut out, chart, |_| true, |t| heard_at(t) + delay);
    out
}

/// Adds to `out` the expected notes and chords `keep` accepts (by song time), each played at the
/// host time `when` gives.
fn play_into(out: &mut Vec<f32>, chart: &Chart, keep: impl Fn(f64) -> bool, when: impl Fn(f64) -> f64) {
    play_tuned_into(out, chart, keep, when, 0.0);
}

/// `play_into` on a guitar tuned `cents` sharp of A440.
fn play_tuned_into(out: &mut Vec<f32>, chart: &Chart, keep: impl Fn(f64) -> bool, when: impl Fn(f64) -> f64, cents: f32) {
    let mut game = Game::new(chart.clone(), config().game);
    game.activate_all();
    let targets: Vec<(f64, Target)> =
        game.expected().iter().filter(|e| keep(e.time)).map(|e| (e.time, e.target.clone())).collect();
    let mut rng = Pcg32::new(11);
    for (k, (time, target)) in targets.iter().enumerate() {
        let next = targets.get(k + 1).map_or(when(*time) + 1.0, |t| when(t.0));
        let at = input_index(when(*time));
        let pitches = match target {
            Target::Note { midi, .. } => vec![*midi],
            Target::Chord { midis, .. } => midis.clone(),
        };
        for (j, m) in pitches.iter().enumerate() {
            let mut p = Pluck::new(440.0 * 2f32.powf(((m - 69) as f32 + cents / 100.0) / 12.0));
            p.secs = (next - when(*time)).clamp(0.08, 3.0) as f32;
            p.amp = if pitches.len() > 1 { 0.22 } else { 0.4 };
            p.pluck_pos = rng.range(0.12, 0.3);
            let mut sound = p.render(SR as f32, &mut rng);
            let n = sound.len();
            let fade = (0.004 * SR) as usize;
            for (i, v) in sound[n - fade..].iter_mut().enumerate() {
                *v *= 1.0 - i as f32 / fade as f32;
            }
            mix_into(out, &sound, at + j * (0.008 * SR) as usize, 1.0);
        }
    }
}

/// Two simulated devices and a session, run in host-time order.
struct Rig {
    session: Session<Sim>,
    input: InputSide,
    output: OutputSide,
    now: Arc<AtomicU64>,
    guitar: Vec<f32>,
    out_k: usize,
    in_k: usize,
    next_update: f64,
    events: Vec<UiEvent>,
}

impl Rig {
    fn new(guitar: Vec<f32>) -> Rig {
        let Bridge { input, output, monitor } = Bridge::new(&EngineConfig::default(), 1, 2, 0.0);
        let now = Arc::new(AtomicU64::new(0));
        let session = Session::new(Sim { monitor, now: now.clone() }, config());
        Rig { session, input, output, now, guitar, out_k: 0, in_k: 0, next_update: 0.0, events: Vec::new() }
    }

    /// Runs callbacks and 2 ms session updates up to host time `until` (s).
    fn run(&mut self, until: f64) {
        let mut out = vec![0.0f32; BLOCK * 2];
        let silence = [0.0f32; BLOCK];
        loop {
            let t_out = self.out_k as f64 * PERIOD;
            let t_in = IN_START + self.in_k as f64 * PERIOD / (1.0 + IN_PPM * 1e-6) + IN_LATENCY;
            let t = t_out.min(t_in).min(self.next_update);
            if t > until {
                break;
            }
            self.now.store((t * 1e9) as u64, Relaxed);
            if t == t_out {
                self.output.process(&mut out, (t * 1e9) as u64, (OUT_LATENCY * 1e9) as u64);
                self.out_k += 1;
            } else if t == t_in {
                let i = self.in_k * BLOCK;
                let block = self.guitar.get(i..i + BLOCK).unwrap_or(&silence);
                self.input.process(block, (t * 1e9) as u64, (IN_LATENCY * 1e9) as u64);
                self.in_k += 1;
            } else {
                self.session.update();
                self.events.extend(self.session.take_events());
                self.next_update += 0.002;
            }
        }
    }
}

fn silent_track(seconds: f64) -> Track {
    Track::from_interleaved(&vec![0.0; (seconds * SR) as usize * 2], 2)
}

struct Outcome {
    expected: usize,
    hits: Vec<(f64, bool)>,
    misses: usize,
    heard: usize,
    ended: bool,
}

fn outcome(events: &[UiEvent]) -> Outcome {
    let mut sent = HashSet::new();
    let mut o = Outcome { expected: 0, hits: Vec::new(), misses: 0, heard: 0, ended: false };
    for e in events {
        match e {
            UiEvent::Reset => sent.clear(),
            UiEvent::Expected { items, .. } => {
                o.expected += items.len();
                sent.extend(items.iter().map(|i| i.index));
            }
            UiEvent::Hit { index, error, perfect, .. } => {
                assert!(sent.contains(index), "hit on note {index} before it was announced");
                o.hits.push((*error, *perfect));
            }
            UiEvent::Miss { index, .. } => {
                assert!(sent.contains(index), "miss on note {index} before it was announced");
                o.misses += 1;
            }
            UiEvent::Heard { .. } => o.heard += 1,
            UiEvent::End => o.ended = true,
            _ => {}
        }
    }
    o
}

#[test]
fn a_guitarist_playing_what_they_hear_is_judged_on_time() {
    let chart = chart();
    let mut rig = Rig::new(performance(&chart, 0.0));
    rig.session.load(chart.clone(), Some(silent_track(chart.meta.duration)), -COUNT_IN);
    rig.session.play();
    rig.run(heard_at(chart.meta.duration) + 1.0);

    let o = outcome(&rig.events);
    let accuracy = o.hits.len() as f64 / o.expected as f64;
    let mean = o.hits.iter().map(|h| h.0).sum::<f64>() / o.hits.len() as f64;
    let worst = o.hits.iter().map(|h| h.0.abs()).fold(0.0, f64::max);
    let perfects = o.hits.iter().filter(|h| h.1).count();
    println!(
        "{} expected, {} hits ({:.1} %), {} misses, {} perfect, timing error mean {:+.1} ms worst {:.1} ms, {} notes heard",
        o.expected,
        o.hits.len(),
        accuracy * 100.0,
        o.misses,
        perfects,
        mean * 1e3,
        worst * 1e3,
        o.heard
    );
    assert!(o.expected > 60);
    assert_eq!(o.hits.len() + o.misses, o.expected, "every note judged once");
    assert!(accuracy >= 0.95, "accuracy {accuracy}");
    assert!(mean.abs() < 0.005, "latencies compensated: mean error {mean}");
    assert!(worst < 0.04, "worst error {worst}");
    assert!(o.heard >= o.hits.len() / 2);
    assert!(o.ended, "the end of the backing track ends the song");
}

#[test]
fn a_song_recorded_sharp_of_a440_is_played_on_a_guitar_tuned_like_it() {
    // The recording is 84 cents sharp: the player tuned up to it plays every note 84 cents
    // above the chart's pitch, which alone would read as the next semitone.
    let mut chart = chart();
    let mut guitar = vec![0.0f32; input_index(heard_at(chart.meta.duration + 1.0))];
    play_tuned_into(&mut guitar, &chart, |_| true, heard_at, 84.0);
    let accuracy = |chart: &Chart| {
        let mut rig = Rig::new(guitar.clone());
        rig.session.load(chart.clone(), Some(silent_track(chart.meta.duration)), -COUNT_IN);
        rig.session.play();
        rig.run(heard_at(chart.meta.duration) + 1.0);
        let o = outcome(&rig.events);
        o.hits.len() as f64 / o.expected as f64
    };
    let ignored = accuracy(&chart);
    chart.arrangement.tuning.cents = 84.0;
    let followed = accuracy(&chart);
    println!("guitar 84 cents sharp: {:.1} % with the song's tuning, {:.1} % without", followed * 100.0, ignored * 100.0);
    assert!(followed >= 0.95, "accuracy {followed}");
    assert!(ignored < 0.5, "the offset matters: {ignored}");
}

#[test]
fn playing_late_is_measured_and_too_late_is_missed() {
    let chart = chart();
    let until = 12.0;
    for (delay, expect_hits) in [(0.06, true), (0.16, false)] {
        let mut rig = Rig::new(performance(&chart, delay));
        rig.session.load(chart.clone(), Some(silent_track(chart.meta.duration)), -COUNT_IN);
        rig.session.play();
        rig.run(heard_at(until));
        let o = outcome(&rig.events);
        let judged = o.hits.len() + o.misses;
        assert!(judged > 10);
        if expect_hits {
            assert!(o.hits.len() as f64 >= 0.9 * judged as f64, "{} of {judged}", o.hits.len());
            let mean = o.hits.iter().map(|h| h.0).sum::<f64>() / o.hits.len() as f64;
            assert!((mean - delay).abs() < 0.006, "measured {mean} for {delay}");
            assert!(o.hits.iter().all(|h| !h.1), "60 ms late is not perfect");
        } else {
            assert!(o.hits.is_empty(), "{} hits {delay} s late", o.hits.len());
        }
    }
}

#[test]
fn seeking_restarts_judging_where_the_song_resumes() {
    let chart = chart();
    let mut rig = Rig::new(performance(&chart, 0.0));
    rig.session.load(chart.clone(), Some(silent_track(chart.meta.duration)), -COUNT_IN);
    rig.session.play();
    rig.run(5.0);
    let target = 20.0;
    rig.session.seek(target);
    assert_eq!(rig.session.time(), target, "the requested time until the player catches up");
    rig.events.clear();
    rig.run(5.5);
    assert!(matches!(rig.events.first(), Some(UiEvent::Reset)));
    // The seek applies at the next output callback and is heard OUT_LATENCY later.
    let expected = target + 0.5 - OUT_LATENCY;
    assert!((rig.session.time() - expected).abs() < 0.002, "{} vs {expected}", rig.session.time());
    let announced: Vec<f64> = rig
        .events
        .iter()
        .flat_map(|e| match e {
            UiEvent::Expected { items, .. } => items.iter().map(|i| i.time).collect(),
            _ => vec![],
        })
        .collect();
    assert!(!announced.is_empty() && announced.iter().all(|&t| t >= target));
}


/// A string ringing at `freq` for `secs` (fundamental + two harmonics, slow decay), from `at` s.
fn ringing(freq: f64, at: f64, secs: f64) -> Vec<f32> {
    let start = input_index(at);
    let n = (secs * SR) as usize;
    let mut out = vec![0.0f32; start + n + BLOCK];
    for i in 0..n {
        let t = i as f64 / SR;
        let w = std::f64::consts::TAU * freq * t;
        let v = (0.3 * w.sin() + 0.15 * (2.0 * w).sin() + 0.08 * (3.0 * w).sin()) * (-t / 2.0).exp();
        out[start + i] = v as f32;
    }
    out
}

fn tuner_reading(freq: f64) -> Vec<f32> {
    let mut rig = Rig::new(ringing(freq, 0.5, 3.0));
    rig.session.set_tuner(true);
    rig.run(3.0);
    let mut midis: Vec<f32> = rig.events.iter().filter_map(|e| if let UiEvent::Pitch { midi, .. } = e { Some(*midi) } else { None }).collect();
    midis.sort_by(f32::total_cmp);
    midis
}

#[test]
fn the_tuner_reads_a_low_drop_c_string_to_the_cent() {
    for (freq, cents) in [(65.406, 0.0), (66.0, 15.65), (64.9, -13.44)] {
        let midis = tuner_reading(freq);
        assert!(midis.len() > 40, "{} pitch readings for {freq} Hz", midis.len());
        let median = midis[midis.len() / 2];
        let measured = (median as f64 - 36.0) * 100.0;
        assert!((measured - cents).abs() < 1.0, "{freq} Hz: {measured:.2} cents, expected {cents}");
        // Steady to the cent: the needle does not wander.
        let spread = (midis[midis.len() * 19 / 20] - midis[midis.len() / 20]) * 100.0;
        assert!(spread < 1.0, "{freq} Hz: readings spread over {spread:.2} cents");
    }
    let mut quiet = Rig::new(ringing(65.406, 0.5, 2.0));
    quiet.run(2.0);
    assert!(!quiet.events.iter().any(|e| matches!(e, UiEvent::Pitch { .. })), "no pitch stream outside tuner mode");
}

#[test]
fn a_note_played_out_of_a_song_is_reported_for_the_strings_on_screen() {
    let mut rig = Rig::new(ringing(110.0, 0.5, 1.5));
    rig.run(2.0);
    let played: Vec<i32> = rig.events.iter().filter_map(|e| if let UiEvent::Played { midi, .. } = e { Some(*midi) } else { None }).collect();
    assert_eq!(played, [45], "the open A, once");
}

/// Strums `delay` after each measured click of `plan` is heard.
fn strums_on_clicks(plan: &CalibrationPlan, delay: f64) -> Vec<f32> {
    let mut rng = Pcg32::new(5);
    let mut out = vec![0.0f32; input_index(OUT_LATENCY + plan.end() + 1.0)];
    for k in plan.count_in..plan.count_in + plan.clicks {
        let mut p = Pluck::new(82.41);
        p.secs = 0.15;
        p.amp = 0.4;
        let sound = p.render(SR as f32, &mut rng);
        mix_into(&mut out, &sound, input_index(OUT_LATENCY + plan.click(k) + delay), 1.0);
    }
    out
}

#[test]
fn calibration_measures_the_latency_nobody_reported() {
    let plan = CalibrationPlan::default();
    // Bluetooth headphones, say: the clicks reach the ears 25 ms later than the system says.
    let unreported = 0.025;
    let mut rig = Rig::new(strums_on_clicks(&plan, unreported));
    rig.session.calibrate(plan);
    rig.run(OUT_LATENCY + plan.end() + 0.5);
    assert!(matches!(rig.events.iter().find(|e| matches!(e, UiEvent::CalibrationStart { .. })), Some(UiEvent::CalibrationStart { count_in: 4, clicks: 12, .. })));
    let hits = rig.events.iter().filter(|e| matches!(e, UiEvent::CalibrationHit { .. })).count();
    let Some(&UiEvent::Calibrated { offset, spread, hits: counted, total }) = rig.events.iter().find(|e| matches!(e, UiEvent::Calibrated { .. })) else {
        panic!("no calibration result");
    };
    println!("calibration: {:+.1} ms ± {:.1} ms, {counted}/{total} strums", offset * 1e3, spread * 1e3);
    assert_eq!((hits, counted, total), (12, 12, 12));
    assert!((offset - unreported).abs() < 0.003, "measured {offset}");
    assert!(spread < 0.003);
}

#[test]
fn the_calibrated_offset_centres_a_late_player() {
    let chart = chart();
    let late = 0.04;
    let mut rig = Rig::new(performance(&chart, late));
    rig.session.set_input_offset(late);
    rig.session.load(chart.clone(), Some(silent_track(chart.meta.duration)), -COUNT_IN);
    rig.session.play();
    rig.run(heard_at(12.0));
    let o = outcome(&rig.events);
    assert!(o.hits.len() as f64 >= 0.9 * (o.hits.len() + o.misses) as f64);
    let mean = o.hits.iter().map(|h| h.0).sum::<f64>() / o.hits.len() as f64;
    assert!(mean.abs() < 0.005, "mean error {mean} after compensating {late}");
    assert!(o.hits.iter().filter(|h| h.1).count() as f64 > 0.8 * o.hits.len() as f64, "perfect again once compensated");
}

#[test]
fn a_take_replayed_offline_is_judged_as_it_was_live() {
    // A sloppy player: 30 ms late, every fifth note skipped, every seventh a semitone high.
    let chart = chart();
    let mut guitar = vec![0.0f32; input_index(heard_at(chart.meta.duration + 1.0))];
    let mut game = Game::new(chart.clone(), config().game);
    game.activate_all();
    let times: Vec<f64> = game.expected().iter().map(|e| e.time).collect();
    let nth = |t: f64| times.iter().position(|&x| x == t).unwrap_or(0);
    play_into(&mut guitar, &chart, |t| nth(t) % 5 != 4 && nth(t) % 7 != 6, |t| heard_at(t) + 0.03);
    let mut wrong = chart.clone();
    for n in wrong.notes.iter_mut() {
        n.fret += 1;
    }
    wrong.chords.clear();
    play_into(&mut guitar, &wrong, |t| nth(t) % 7 == 6, |t| heard_at(t) + 0.03);

    let dir = std::env::temp_dir().join(format!("opensmith-takes-{}", std::process::id()));
    let mut rig = Rig::new(guitar);
    rig.session.record(Some(dir.clone()));
    rig.session.load(chart.clone(), Some(silent_track(chart.meta.duration)), -COUNT_IN);
    rig.session.play();
    rig.run(heard_at(chart.meta.duration) + 1.0);
    rig.session.wait_takes();
    let live = Report::of(&rig.events);
    let saved = rig.events.iter().find_map(|e| if let UiEvent::TakeSaved { path, .. } = e { Some(path.clone()) } else { None });
    let take = Take::load(std::path::Path::new(&saved.expect("a take saved at the end of the song"))).unwrap();
    assert!((take.seconds() - chart.meta.duration).abs() < 1.5, "{} s", take.seconds());
    assert_eq!(take.score.hits as usize, live.hits());

    let again = Report::of(&replay(&take, &EngineConfig::default(), config()));
    println!("live   {live}\nreplay {again}");
    assert!(live.hits() > 20 && live.unplayed > 5 && live.high > 3, "a mixed performance: {live}");
    assert_eq!(again.judged(), live.judged(), "the same notes judged");
    assert!(again.hits().abs_diff(live.hits()) <= 1, "{} hits replayed, {} live", again.hits(), live.hits());
    assert!((again.mean_error - live.mean_error).abs() < 0.003, "timing {} vs {}", again.mean_error, live.mean_error);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn chords_too_are_judged_through_a_large_latency_compensation() {
    // A Bluetooth headset: everything is heard and played 150 ms late, compensated.
    let chart = chart();
    let lag = 0.15;
    let mut rig = Rig::new(performance(&chart, lag));
    rig.session.set_input_offset(lag);
    rig.session.load(chart.clone(), Some(silent_track(chart.meta.duration)), -COUNT_IN);
    rig.session.play();
    rig.run(heard_at(chart.meta.duration) + 1.0);
    let chords: HashSet<usize> = rig
        .events
        .iter()
        .flat_map(|e| match e {
            UiEvent::Expected { items, .. } => items.iter().filter(|i| matches!(i.target, UiTarget::Chord { .. })).map(|i| i.index).collect(),
            _ => Vec::new(),
        })
        .collect();
    let hit: HashSet<usize> = rig.events.iter().filter_map(|e| if let UiEvent::Hit { index, .. } = e { Some(*index) } else { None }).collect();
    assert!(chords.len() >= 4, "{} chords", chords.len());
    let chords_hit = chords.iter().filter(|i| hit.contains(i)).count();
    assert!(chords_hit as f64 >= 0.9 * chords.len() as f64, "{chords_hit} of {} chords", chords.len());
    let o = outcome(&rig.events);
    assert!(o.hits.len() as f64 >= 0.95 * o.expected as f64, "{} of {}", o.hits.len(), o.expected);
}

#[test]
fn slowed_down_the_latency_compensation_stays_in_real_time() {
    // At half speed, a player 60 ms late (the audio chain's latency, compensated) is on time:
    // 60 ms of real time is only 30 ms of song time.
    let chart = chart();
    let (rate, late) = (0.5, 0.06);
    let heard = |t: f64| OUT_LATENCY + (t + COUNT_IN) / rate;
    let mut guitar = vec![0.0f32; input_index(heard(8.0) + 1.0)];
    play_into(&mut guitar, &chart, |t| t < 8.0, |t| heard(t) + late);
    let mut rig = Rig::new(guitar);
    rig.session.set_input_offset(late);
    rig.session.load(chart.clone(), Some(silent_track(chart.meta.duration)), -COUNT_IN);
    rig.session.set_rate(rate);
    rig.session.play();
    rig.run(heard(8.0));
    let o = outcome(&rig.events);
    assert!(o.hits.len() > 10 && o.hits.len() as f64 >= 0.9 * (o.hits.len() + o.misses) as f64, "{} hits, {} misses: {:?}", o.hits.len(), o.misses, rig.events.iter().filter(|e| matches!(e, UiEvent::Miss { .. })).collect::<Vec<_>>());
    let mean = o.hits.iter().map(|h| h.0).sum::<f64>() / o.hits.len() as f64;
    assert!(mean.abs() < 0.006, "mean error {mean} at half speed");
}

#[test]
fn loop_trainer_loops_a_phrase_slowed_down_and_judges_every_pass() {
    let chart = chart();
    let mut rig = Rig::new(Vec::new());
    rig.session.load(chart.clone(), Some(silent_track(chart.meta.duration)), -COUNT_IN);
    rig.session.play();
    rig.run(0.5);
    // Phrase B, two seconds to get ready, half a second for the last notes to be judged.
    let (from, to) = (chart.phrases[2].start, chart.phrases[2].end);
    let riff = RiffLoop { start: from - 2.0, end: to + 0.5, from, to };
    let rate = 0.75;
    rig.session.set_rate(rate);
    rig.session.set_riff(Some(riff));
    // The loop starts with the next output callback and is heard OUT_LATENCY later; the player
    // plays the first pass along and lets the second one go by.
    let start = rig.out_k as f64 * PERIOD + OUT_LATENCY;
    let pass = (riff.end - riff.start) / rate;
    let mut guitar = vec![0.0f32; input_index(start + 2.0 * pass + 2.0)];
    play_into(&mut guitar, &chart, |t| t >= from && t < to, |t| start + (t - riff.start) / rate);
    rig.guitar = guitar;
    rig.events.clear();
    rig.run(start + 2.0 * pass + 1.0);

    let passes: Vec<UiScore> = rig
        .events
        .iter()
        .filter_map(|e| match e {
            UiEvent::Pass { score } => Some(*score),
            _ => None,
        })
        .collect();
    assert_eq!(passes.len(), 2, "two times round");
    let judged = passes[0].hits + passes[0].misses;
    println!("pass 1: {} of {judged}, pass 2: {} of {}", passes[0].hits, passes[1].hits, passes[1].hits + passes[1].misses);
    assert!(judged > 10);
    assert!(passes[0].hits as f64 >= 0.9 * judged as f64, "played along at 75 %: {} of {judged}", passes[0].hits);
    assert_eq!((passes[1].hits, passes[1].misses), (0, judged), "nothing played, everything missed");
    let announced: Vec<f64> = rig
        .events
        .iter()
        .flat_map(|e| match e {
            UiEvent::Expected { items, .. } => items.iter().map(|i| i.time).collect(),
            _ => vec![],
        })
        .collect();
    assert!(announced.iter().all(|&t| t >= from && t < to), "only the phrase's notes");
    assert_eq!(announced.len(), 3 * judged as usize, "announced again for each pass (the third has begun)");
    let resets = rig.events.iter().filter(|e| matches!(e, UiEvent::Reset)).count();
    assert_eq!(resets, 3, "the start, then each time round");
    let t = rig.session.time();
    assert!(t >= riff.start && t < riff.end, "{t} inside the loop");

    // Loop Trainer off: the song plays on past the loop, at full speed.
    rig.session.set_riff(None);
    rig.session.set_rate(1.0);
    let now = rig.out_k as f64 * PERIOD;
    rig.run(now + riff.end - t + 1.0);
    assert!(rig.session.time() > riff.end);
    assert_eq!(rig.session.rate(), 1.0);
}

/// Monitored guitar out of `output` for a steady tone into `input` (loudest sample, second half).
fn monitored(input: &mut InputSide, output: &mut OutputSide, blocks: usize) -> f32 {
    let tone: Vec<f32> = (0..BLOCK * blocks).map(|i| (i as f32 * 0.05).sin() * 0.2).collect();
    let mut out = vec![0f32; BLOCK * 2];
    let mut loudest = 0f32;
    for (j, block) in tone.chunks(BLOCK).enumerate() {
        let t = (j as f64 * PERIOD * 1e9) as u64;
        input.process(block, t + 500_000, 500_000);
        output.process(&mut out, t + 700_000, 4_000_000);
        if j > blocks / 2 {
            loudest = out.iter().fold(loudest, |m, v| m.max(v.abs()));
        }
    }
    loudest
}

#[test]
fn another_output_keeps_the_guitar_settings_and_the_amp() {
    use opensmith_dsp::{AmpKnobs, AmpModel, ChainParams};

    let now = Arc::new(AtomicU64::new(0));
    let first = Bridge::new(&EngineConfig::default(), 1, 2, 1.0);
    let mut session = Session::new(Sim { monitor: first.monitor, now: now.clone() }, config());
    session.load(chart(), None, -COUNT_IN);
    session.set_input_gain(2.0);
    let quiet = ChainParams::default().with_amp(AmpModel::Clean, AmpKnobs { volume: 0.2, ..AmpKnobs::default() });
    session.set_chain(quiet);
    session.take_events();

    let Bridge { mut input, mut output, monitor } = Bridge::new(&EngineConfig::default(), 1, 2, 1.0);
    drop(session.replace_backend(Sim { monitor, now }));
    assert!(session.chart().is_none(), "the song stops with the old output");
    assert!(session.take_events().contains(&UiEvent::Reset));
    let heard = monitored(&mut input, &mut output, 200);
    assert!((session.take_peak() - 0.4).abs() < 1e-3, "input gain carried over");

    let Bridge { input: mut fresh_in, output: mut fresh_out, .. } = Bridge::new(&EngineConfig::default(), 1, 2, 1.0);
    let default_amp = monitored(&mut fresh_in, &mut fresh_out, 200);
    assert!(heard > 0.0 && heard < default_amp / 3.0, "the quiet amp carried over: {heard} vs {default_amp}");
}

#[test]
fn the_virtual_guitarist_is_judged_fairly() {
    use opensmith_session::guitarist::{perform, Player};
    use opensmith_session::replay::Agreement;
    let chart = chart();
    let judge = |player: &Player| {
        let perf = perform(&chart, LEVEL, player, 3);
        let events = replay(&perf.take, &EngineConfig::default(), config());
        Agreement::of(&perf.truth, &events, &chart)
    };
    let clean = judge(&Player::clean());
    println!("clean\n{clean}");
    assert!(clean.fairness().0 >= 0.85, "a clean player counted: {:?}", clean.fairness());
    let beginner = judge(&Player::beginner());
    println!("beginner\n{beginner}");
    let (right, wrong) = beginner.fairness();
    assert!(right >= 0.6 && wrong >= 0.8, "a beginner: {right} of the right playing counted, {wrong} of the wrong refused");
}

#[test]
fn sounds_are_played_at_the_output_rate_by_name() {
    let Bridge { mut output, monitor, .. } = Bridge::new(&EngineConfig::default(), 1, 2, 0.0);
    let mut session = Session::new(Sim { monitor, now: Arc::new(AtomicU64::new(0)) }, config());
    // Made at 24 kHz, heard at 48 kHz: twice as many frames, the same level.
    session.add_sound("tick".into(), 24_000.0, vec![1.0; 100]);
    session.play_sound("tick", 0.5, None);
    session.play_sound("unknown", 1.0, None);
    let mut out = vec![0f32; BLOCK * 2];
    let mut left = Vec::new();
    for k in 0..10u64 {
        output.process(&mut out, k * 1_333_333, 5_000_000);
        left.extend(out.chunks(2).map(|f| f[0]));
    }
    let loud = left.iter().filter(|v| (**v - 0.5).abs() < 0.05).count();
    assert!((180..=200).contains(&loud), "{loud} frames at the sound's level");
    assert!(left[260..].iter().all(|v| v.abs() < 1e-3), "and nothing after it");
}

#[test]
fn in_wait_mode_the_song_stops_on_each_note_until_the_guitar_plays_it() {
    // The guitarist only plays once the song stopped, 0.8 s later, chords as well as notes.
    const REACT: f64 = 0.8;
    const SONG: f64 = 12.0;
    let chart = chart();
    let mut rig = Rig::new(vec![0.0; input_index(heard_at(chart.meta.duration) + 120.0)]);
    rig.session.load(chart.clone(), Some(silent_track(chart.meta.duration)), -COUNT_IN);
    rig.session.set_wait(true);
    rig.session.play();
    let mut targets = std::collections::HashMap::new();
    let (mut seen, mut waits, mut host) = (0, Vec::new(), 0.0);
    let mut rng = Pcg32::new(5);
    while host < 90.0 {
        host += 0.005;
        rig.run(host);
        for e in &rig.events[seen..] {
            match e {
                UiEvent::Expected { items, .. } => targets.extend(items.iter().map(|i| (i.index, (i.time, i.target.clone())))),
                UiEvent::Waiting { index } => {
                    let (time, target) = targets[index].clone();
                    if time > SONG {
                        continue;
                    }
                    waits.push(*index);
                    let midis = match target {
                        UiTarget::Note { midi, .. } => vec![midi],
                        UiTarget::Chord { midis, .. } => midis,
                    };
                    let at = input_index(host + REACT);
                    for (j, m) in midis.iter().enumerate() {
                        let mut p = Pluck::new(440.0 * 2f32.powf((m - 69) as f32 / 12.0));
                        let held = chart.notes.iter().find(|n| n.time == time).map(|n| n.sustain)
                            .or_else(|| chart.chords.iter().find(|c| c.time == time).map(|c| c.sustain)).unwrap_or(0.6);
                        p.secs = held.max(0.6) as f32 + 0.1;
                        p.amp = if midis.len() > 1 { 0.22 } else { 0.4 };
                        let sound = p.render(SR as f32, &mut rng);
                        mix_into(&mut rig.guitar, &sound, at + j * (0.008 * SR) as usize, 1.0);
                    }
                }
                _ => {}
            }
        }
        seen = rig.events.len();
        if waits.len() > 3 && targets.get(waits.last().unwrap()).is_some_and(|t| t.0 > SONG - 1.0) {
            break;
        }
    }
    let o = outcome(&rig.events);
    let early: Vec<usize> = targets.iter().filter(|(_, t)| t.0 <= SONG - 1.0).map(|(i, _)| *i).collect();
    println!("{} waits, {} hits, {} misses, stopped on {} of the {} notes and chords before {} s", waits.len(), o.hits.len(), o.misses, early.iter().filter(|i| waits.contains(i)).count(), early.len(), SONG - 1.0);
    assert!(early.len() > 10, "the test plays a dozen notes and chords at least");
    assert!(early.iter().any(|i| matches!(targets[i].1, UiTarget::Chord { .. })), "chords among them");
    assert!(early.iter().all(|i| waits.contains(i)), "the song stopped on every one of them");
    assert_eq!(o.misses, 0, "none missed, however late they were played");
    assert!(o.hits.len() >= early.len(), "each counted");
    assert!(o.hits.iter().all(|h| h.0.abs() < 1e-6 && h.1), "on the beat: the song waited for them");
    // It stood still: twelve seconds of song took more than REACT longer each.
    assert!(host > heard_at(SONG - 1.0) + REACT * early.len() as f64);
}

/// A phrase ending exactly with its audio, and an item whose verification finishes after it.
fn final_item(chord: bool) -> Chart {
    let mut c = chart();
    c.meta.duration = 1.2; c.audio.offset = 0.0;
    c.phrases.truncate(1); c.phrases[0].start = 0.0; c.phrases[0].end = 1.2;
    if chord {
        c.notes.clear(); c.chords.truncate(1);
        c.chords[0].time = 1.15; c.chords[0].sustain = 0.0; c.chords[0].levels = [0, LEVEL];
    } else {
        c.chords.clear(); c.notes.truncate(1);
        c.notes[0].time = 1.15; c.notes[0].sustain = 0.0; c.notes[0].levels = [0, LEVEL]; c.notes[0].techniques = None;
    }
    c
}

#[test]
fn the_last_miss_phrase_and_final_score_are_published_before_end_once() {
    let c = final_item(false);
    let mut rig = Rig::new(vec![]);
    rig.session.load(c.clone(), Some(silent_track(c.meta.duration)), -COUNT_IN);
    rig.session.play(); rig.run(heard_at(c.meta.duration) + 1.0);
    let end = rig.events.iter().position(|e| matches!(e, UiEvent::End)).expect("song ended");
    assert_eq!(rig.events.iter().filter(|e| matches!(e, UiEvent::End)).count(), 1);
    let before = &rig.events[..end];
    assert_eq!(before.iter().filter(|e| matches!(e, UiEvent::Miss { .. })).count(), 1);
    assert_eq!(before.iter().filter(|e| matches!(e, UiEvent::Phrase { accuracy, .. } if *accuracy == 0.0)).count(), 1);
    assert!(before.iter().any(|e| matches!(e, UiEvent::Score { score } if score.misses == 1 && score.hits == 0)));
    assert!(!rig.events[end+1..].iter().any(|e| matches!(e, UiEvent::Hit { .. } | UiEvent::Miss { .. } | UiEvent::Score { .. })));
}

#[test]
fn the_last_note_and_chord_can_be_confirmed_after_the_backing_stops() {
    for chord in [false, true] {
        let c = final_item(chord);
        let mut rig = Rig::new(performance(&c, 0.06));
        rig.session.load(c.clone(), Some(silent_track(c.meta.duration)), -COUNT_IN);
        rig.session.play(); rig.run(heard_at(c.meta.duration) + 1.0);
        let o = outcome(&rig.events);
        assert_eq!((o.hits.len(), o.misses), (1, 0), "last item, chord={chord}: {:?}", rig.events);
        let end = rig.events.iter().position(|e| matches!(e, UiEvent::End)).unwrap();
        assert!(rig.events[..end].iter().any(|e| matches!(e, UiEvent::Phrase { accuracy, .. } if *accuracy == 1.0)));
    }
}

/// Controlled continuous string vibration fed to the real tracker, through both device clocks.
fn gesture(techniques: opensmith_game::chart::Techniques, sustain: f64, seconds: f64, shift: impl Fn(f64) -> f64, t60: f64) -> bool {
    let mut c = final_item(false); c.meta.duration = 3.0; c.phrases[0].end = 3.0;
    let n = &mut c.notes[0]; n.time = 1.0; n.string = 2; n.fret = 5; n.sustain = sustain; n.techniques = Some(techniques);
    let first = input_index(heard_at(1.0));
    let mut guitar = vec![0.0; first + (seconds * SR) as usize + BLOCK];
    let mut phase = 0.0;
    for k in 0..(seconds * SR) as usize {
        let t = k as f64 / SR;
        let hz = 440.0 * 2f64.powf((55.0 + shift(t) - 69.0) / 12.0);
        phase += std::f64::consts::TAU * hz / SR;
        let env = (t / 0.002).min(1.0) * ((seconds - t) / 0.005).min(1.0) * (-6.9 * t / t60).exp();
        guitar[first + k] = (env * (0.3 * phase.sin() + 0.12 * (2.0 * phase).sin() + 0.05 * (3.0 * phase).sin())) as f32;
    }
    let mut rig = Rig::new(guitar);
    rig.session.load(c, None, -COUNT_IN); rig.session.play(); rig.run(heard_at(4.0));
    let o = outcome(&rig.events);
    assert_eq!(o.hits.len() + o.misses, 1, "exactly one final judgement: {:?}", rig.events);
    !o.hits.is_empty()
}

#[test]
fn the_audio_path_checks_sustain_bend_slide_vibrato_and_palm_mute() {
    use opensmith_game::chart::Techniques;
    assert!(gesture(Techniques::default(), 0.6, 0.8, |_| 0.0, 3.0), "held note");
    assert!(!gesture(Techniques::default(), 0.6, 0.08, |_| 0.0, 3.0), "short attack cannot be held");
    assert!(!gesture(Techniques::default(), 0.6, 0.8, |t| if t < 0.1 { 0.0 } else { -12.0 }, 3.0), "a lower octave after the attack cannot prove the hold via its harmonics");
    let bend = Techniques { bend: Some(2.0), ..Default::default() };
    assert!(gesture(bend.clone(), 0.6, 0.8, |t| 2.0 * ((t - 0.08) / 0.35).clamp(0.0, 1.0), 3.0), "correct bend");
    assert!(!gesture(bend.clone(), 0.6, 0.8, |_| 0.0, 3.0), "straight note instead of bend");
    assert!(!gesture(bend, 0.6, 0.8, |t| ((t - 0.08) / 0.35).clamp(0.0, 1.0), 3.0), "one semitone is not two");
    let slide = Techniques { slide_to: Some(9), ..Default::default() };
    assert!(gesture(slide.clone(), 0.6, 0.8, |t| 4.0 * ((t - 0.08) / 0.35).clamp(0.0, 1.0), 3.0), "correct slide");
    assert!(!gesture(slide, 0.6, 0.8, |_| 0.0, 3.0), "straight note instead of slide");
    let vib = Techniques { vibrato: Some(true), ..Default::default() };
    assert!(gesture(vib.clone(), 0.6, 0.8, |t| if t < 0.07 { 0.0 } else { 0.22 * (std::f64::consts::TAU * 5.0 * (t - 0.07)).sin() }, 3.0), "vibrato");
    assert!(!gesture(vib, 0.6, 0.8, |_| 0.0, 3.0), "straight note instead of vibrato");
    let pm = Techniques { palm_mute: Some(true), ..Default::default() };
    assert!(gesture(pm.clone(), 0.0, 0.3, |_| 0.0, 0.3), "damped pitched note");
    assert!(!gesture(pm, 0.0, 0.8, |_| 0.0, 3.0), "ringing note instead of palm mute");
}
