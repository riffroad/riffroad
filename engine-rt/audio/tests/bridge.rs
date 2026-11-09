//! The duplex bridge driven by simulated CoreAudio callback schedules: two devices with their
//! own clocks (ppm offsets), callback jitter, arbitrary phase. No hardware involved.

use opensmith_audio::{Bridge, EngineConfig, StatsSnapshot};
use opensmith_dsp::synth::{mix_into, Pcg32, Pluck};
use opensmith_dsp::{ChainParams, GuitarChain, TrackerEvent};

const SR: f64 = 48_000.0;
const BLOCK: usize = 64;

struct Schedule {
    seconds: f64,
    /// Input device clock offset relative to the output device (ppm).
    in_ppm: f64,
    /// Callback jitter (± microseconds, uniform).
    jitter_us: f64,
    /// Input callback phase within an output period (0..1).
    phase: f64,
    seed: u64,
    /// Print fill/correction every second (debugging).
    trace: bool,
}

struct Run {
    out_left: Vec<f32>,
    events: Vec<TrackerEvent>,
    stats: StatsSnapshot,
    /// Underruns counted after the first half of the run.
    late_underruns: u64,
}

fn simulate(bridge: &mut Bridge, input: &[f32], s: &Schedule) -> Run {
    let mut rng = Pcg32::new(s.seed);
    let out_period = BLOCK as f64 / SR;
    let in_period = BLOCK as f64 / (SR * (1.0 + s.in_ppm * 1e-6));
    let (mut t_in, mut t_out) = (s.phase * out_period, 0.0);
    let jitter = |rng: &mut Pcg32| (rng.uniform() as f64 * 2.0 - 1.0) * s.jitter_us * 1e-6;
    let (mut j_in, mut j_out) = (jitter(&mut rng), jitter(&mut rng));
    let mut pos = 0;
    let mut run = Run { out_left: Vec::new(), events: Vec::new(), stats: StatsSnapshot::default(), late_underruns: 0 };
    let mut half: Option<u64> = None;
    let mut block = vec![0f32; BLOCK];
    let mut out = vec![0f32; 2 * BLOCK];
    while t_out < s.seconds {
        if t_in + j_in <= t_out + j_out {
            for (k, v) in block.iter_mut().enumerate() {
                *v = input.get(pos + k).copied().unwrap_or(0.0);
            }
            bridge.input.process(&block, (t_in * 1e9) as u64, 2_000_000);
            pos += BLOCK;
            t_in += in_period;
            j_in = jitter(&mut rng);
        } else {
            bridge.output.process(&mut out, (t_out * 1e9) as u64, 4_000_000);
            run.out_left.extend(out.iter().step_by(2));
            t_out += out_period;
            j_out = jitter(&mut rng);
            if half.is_none() && t_out >= s.seconds / 2.0 {
                half = Some(bridge.monitor.stats().underruns);
            }
            if s.trace && (t_out / out_period).round() as u64 % 750 == 0 {
                let st = bridge.monitor.stats();
                println!("t={:5.1}s fill {}..{} setpoint {} drift {:+.1} ppm underruns {}", t_out, st.ring_min, st.ring_max, st.setpoint, st.drift_ppm, st.underruns);
            }
        }
        bridge.monitor.poll_events(|e| run.events.push(e));
    }
    run.stats = bridge.monitor.stats();
    run.late_underruns = run.stats.underruns - half.unwrap_or(0);
    run
}

fn config() -> EngineConfig {
    EngineConfig { buffer_frames: BLOCK as u32, ..EngineConfig::default() }
}

/// 1 s of silence, then the six open strings plucked 0.4 s apart.
fn open_strings() -> (Vec<f32>, Vec<i32>) {
    let mut x = vec![0.0; 48_000];
    let midis = [40, 45, 50, 55, 59, 64];
    let mut rng = Pcg32::new(5);
    for (k, &m) in midis.iter().enumerate() {
        let mut p = Pluck::new(opensmith_dsp::note::midi_to_freq(m as f32, 440.0));
        p.secs = 0.4;
        p.amp = 0.4;
        mix_into(&mut x, &p.render(48_000.0, &mut rng), 48_000 + k * 19_200, 1.0);
    }
    x.extend(std::iter::repeat_n(0.0, 24_000));
    (x, midis.to_vec())
}

fn note_ons(events: &[TrackerEvent]) -> Vec<i32> {
    events
        .iter()
        .filter_map(|e| match *e {
            TrackerEvent::NoteOn { midi, .. } => Some(midi),
            _ => None,
        })
        .collect()
}

#[test]
fn notes_and_processed_audio_flow_through_the_bridge() {
    let cfg = config();
    let (x, midis) = open_strings();
    let mut bridge = Bridge::new(&cfg, 1, 2, 1.0);
    let s = Schedule { seconds: x.len() as f64 / SR, in_ppm: 0.0, jitter_us: 0.0, phase: 0.5, seed: 1, trace: false };
    let run = simulate(&mut bridge, &x, &s);
    assert_eq!(note_ons(&run.events), midis);
    assert_eq!(run.stats.underruns, 0);

    // Output = the chain applied offline, delayed by the ring (+2 samples of interpolation).
    let mut chain = GuitarChain::new(48_000.0, ChainParams::default(), None);
    let mut reference = x.clone();
    for b in reference.chunks_mut(BLOCK) {
        chain.process(b);
    }
    let region = 60_000..150_000;
    let energy: f32 = reference[region.clone()].iter().map(|v| v * v).sum();
    let (delay, err) = (0..400)
        .map(|d| {
            let e: f32 = region.clone().map(|n| (run.out_left[n + d] - reference[n]).powi(2)).sum();
            (d, e)
        })
        .min_by(|a, b| a.1.total_cmp(&b.1))
        .unwrap();
    let err_db = 10.0 * (err / energy).log10();
    println!("bridge delay {delay} frames ({:.2} ms), residual {err_db:.1} dB", delay as f64 * 1e3 / SR);
    assert!(err_db < -40.0, "output differs from the processed input by {err_db:.1} dB");
    assert!(delay <= 2 * BLOCK + 4, "ring delay {delay} frames");
}

#[test]
fn same_clock_settles_at_two_blocks() {
    let cfg = config();
    let mut bridge = Bridge::new(&cfg, 1, 2, 0.0);
    let s = Schedule { seconds: 10.0, in_ppm: 0.0, jitter_us: 20.0, phase: 0.5, seed: 2, trace: false };
    let run = simulate(&mut bridge, &[], &s);
    let st = run.stats;
    println!("setpoint {} fill {}..{} ring {:.2} ms drift {:+.1} ppm", st.setpoint, st.ring_min, st.ring_max, st.ring_ms, st.drift_ppm);
    assert_eq!((st.underruns, st.resyncs, st.overruns), (0, 0, 0));
    assert_eq!(st.setpoint as usize, 2 * BLOCK + 32);
    assert!(st.ring_ms < 2.2, "ring adds {:.2} ms", st.ring_ms);
    assert!(st.drift_ppm.abs() < 20.0);
}

/// Independent crystals: the controller learns the offset and the phase crossings (every
/// 1.33 ms / offset) are absorbed by the second block — no dropout, no resync.
#[test]
fn clock_drift_is_absorbed_without_dropouts() {
    for (i, in_ppm) in [-300.0, -100.0, 100.0, 300.0].into_iter().enumerate() {
        let cfg = config();
        let mut bridge = Bridge::new(&cfg, 1, 2, 0.0);
        let s = Schedule { seconds: 60.0, in_ppm, jitter_us: 20.0, phase: 0.3, seed: 10 + i as u64, trace: false };
        let run = simulate(&mut bridge, &[], &s);
        let st = run.stats;
        println!(
            "input {in_ppm:+} ppm: compensation {:+.1} ppm, fill {}..{}, underruns {}, resyncs {}",
            st.drift_ppm, st.ring_min, st.ring_max, st.underruns, st.resyncs
        );
        assert_eq!(st.underruns, 0, "{in_ppm} ppm");
        assert_eq!(st.resyncs, 0, "{in_ppm} ppm");
        assert!((st.drift_ppm - in_ppm).abs() < 30.0, "{in_ppm} ppm: controller at {:+.1} ppm", st.drift_ppm);
    }
}

/// Callbacks of both devices landing at the same instant in random order: at most a couple of
/// dropouts while the margin adapts, none afterwards.
#[test]
fn coincident_callbacks_in_random_order_settle() {
    let cfg = config();
    let mut bridge = Bridge::new(&cfg, 1, 2, 0.0);
    let s = Schedule { seconds: 30.0, in_ppm: 0.0, jitter_us: 150.0, phase: 0.0, seed: 3, trace: false };
    let run = simulate(&mut bridge, &[], &s);
    let st = run.stats;
    println!("random order: underruns {} (late {}), setpoint {}", st.underruns, run.late_underruns, st.setpoint);
    assert!(st.underruns <= 2);
    assert_eq!(run.late_underruns, 0);
}

#[test]
fn the_selected_input_channel_feeds_detection_and_monitoring() {
    // The guitar is on input 2; input 1 carries a completely different signal.
    for channel in [0, 1] {
        let cfg = EngineConfig { input_channel: channel, ..Default::default() };
        let mut bridge = Bridge::new(&cfg, 2, 2, 0.5);
        assert!(bridge.monitor.monitor_enabled());
        bridge.monitor.set_monitor_gain(0.25);
        let block: Vec<f32> = (0..64).flat_map(|_| [0.01, 0.3]).collect();
        bridge.input.process(&block, 1_000_000, 0);
        let expected = if channel == 0 { 0.01 } else { 0.3 };
        assert!((bridge.monitor.take_peak() - expected).abs() < 1e-6);
        let mut tap = Vec::new(); bridge.monitor.drain_tap(|b| tap.extend_from_slice(b.samples()));
        assert!(tap.iter().all(|v| (*v - expected).abs() < 1e-6));
    }
    let cfg = EngineConfig::default();
    let mut bridge = Bridge::new(&cfg, 1, 2, 0.0);
    bridge.monitor.set_monitor_gain(1.0);
    assert!(!bridge.monitor.monitor_enabled(), "a gain change must not enable a microphone's return implicitly");
}

#[test]
fn a_silent_disconnection_is_detected_on_either_callback_side() {
    for input_stops in [false, true] {
        let mut b = Bridge::new(&EngineConfig::default(), 1, 2, 0.0);
        let start = opensmith_audio::host_now_ns();
        b.input.process(&[0.0; BLOCK], start, 0);
        b.output.process(&mut [0.0; BLOCK * 2], start, 0);
        assert!(!b.monitor.stream_failed_at(start + 100_000_000));
        let later = start + 2_100_000_000;
        if input_stops { b.output.process(&mut [0.0; BLOCK * 2], later, 0); }
        else { b.input.process(&[0.0; BLOCK], later, 0); }
        assert!(b.monitor.stream_failed_at(later), "stalled side, input={input_stops}");
    }
}
