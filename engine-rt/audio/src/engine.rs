//! Duplex engine. Everything inside the two CoreAudio callbacks is wait-free and
//! allocation-free: DSP state is built beforehand and moved into the input callback, audio
//! crosses to the output callback through an `rtrb` ring, note events reach the caller through a
//! second ring, statistics through atomics.
//!
//! The callback bodies live in [`InputSide`] and [`OutputSide`] so that a [`Bridge`] can be
//! driven without hardware (simulated callback schedules in `tests/bridge.rs`).

use std::sync::atomic::Ordering::Relaxed;
use std::sync::atomic::{AtomicI64, AtomicU32, AtomicU64};
use std::sync::Arc;
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, StreamTrait};
use cpal::{BufferSize, StreamConfig, SupportedBufferSize};
use opensmith_dsp::fx::cabinet::CabinetIr;
use opensmith_dsp::{db_to_lin, ChainParams, GuitarChain, NoteTracker, TrackerConfig, TrackerEvent};

use crate::devices::{pick_input, pick_output, InputKind};
use crate::latency::StreamLatency;
use crate::player::{ClockCell, Player, PlayerClock, PlayerCommand, TapBlock, TAP_BLOCK};
use crate::AudioError;

#[derive(Clone, Debug)]
pub struct EngineConfig {
    /// Input name fragment; `None` = USB guitar cable, else the default input.
    pub input: Option<String>,
    /// Output name fragment; `None` = default output.
    pub output: Option<String>,
    pub sample_rate: u32,
    /// Requested CoreAudio buffer (frames).
    pub buffer_frames: u32,
    /// Channel of the input device carrying the guitar.
    pub input_channel: usize,
    /// `None`: monitor only the USB guitar cable (a laptop microphone into its own speakers howls).
    pub monitor: Option<bool>,
    pub monitor_gain_db: f32,
    pub chain: ChainParams,
    pub ir: Option<CabinetIr>,
    pub tracker: TrackerConfig,
}

impl Default for EngineConfig {
    fn default() -> Self {
        Self {
            input: None,
            output: None,
            sample_rate: 48_000,
            buffer_frames: 64,
            input_channel: 0,
            monitor: None,
            monitor_gain_db: 0.0,
            chain: ChainParams::default(),
            ir: None,
            tracker: TrackerConfig::default(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct StreamInfo {
    pub input_name: String,
    pub input_kind: InputKind,
    pub output_name: String,
    pub sample_rate: u32,
    pub input_channels: u16,
    pub input_channel: usize,
    pub output_channels: u16,
    pub requested_buffer: u32,
    /// Whether the requested buffer size was within the hardware range of both devices.
    pub input_fixed: bool,
    pub output_fixed: bool,
    pub monitor: bool,
}

#[derive(Default)]
struct Shared {
    started_ns: u64,
    in_callbacks: AtomicU64,
    out_callbacks: AtomicU64,
    in_frames: AtomicU64,
    out_frames: AtomicU64,
    in_block: AtomicU32,
    out_block: AtomicU32,
    dsp_ns_total: AtomicU64,
    dsp_ns_max: AtomicU64,
    in_latency_ns: AtomicU64,
    out_latency_ns: AtomicU64,
    /// Host time of the last input callback (ns, same clock as the output callback).
    in_callback_ns: AtomicU64,
    out_callback_ns: AtomicU64,
    /// Smoothed virtual fill seen by the output callback, in 1/16 frames.
    fill_x16: AtomicU32,
    ring_min: AtomicU32,
    ring_max: AtomicU32,
    setpoint: AtomicU32,
    /// Output read-rate correction, parts per billion.
    drift_ppb: AtomicI64,
    underruns: AtomicU64,
    priming: AtomicU64,
    overruns: AtomicU64,
    resyncs: AtomicU64,
    events_dropped: AtomicU64,
    peak_bits: AtomicU32,
    errors: AtomicU64,
    error_kinds: AtomicU32,
    /// Host time (ns, f64 bits) at which input sample 0 was captured, refreshed every input
    /// callback: maps tracker sample positions to host time.
    in_epoch_bits: AtomicU64,
    tap_dropped: AtomicU64,
    clock: ClockCell,
    /// Linear gain applied to the guitar before everything else (f32 bits).
    input_gain_bits: AtomicU32,
    /// Largest |sample| after the input gain since the meter was last read (f32 bits).
    meter_bits: AtomicU32,
    /// Linear gain of the monitored guitar in the output (f32 bits); stays 0 when monitoring
    /// is off (no USB guitar cable: the Mac's microphone would feed back).
    monitor_gain_bits: AtomicU32,
    monitor_enabled: bool,
}

/// Stream error categories reported by CoreAudio through cpal.
pub const ERROR_KINDS: [&str; 7] =
    ["xrun (HAL overload)", "device changed", "device unavailable", "stream invalidated", "device busy", "backend", "other"];

fn error_bit(kind: cpal::ErrorKind) -> u32 {
    use cpal::ErrorKind::*;
    1 << match kind {
        Xrun => 0,
        DeviceChanged => 1,
        DeviceNotAvailable => 2,
        StreamInvalidated => 3,
        DeviceBusy => 4,
        BackendError => 5,
        _ => 6,
    }
}

/// Point-in-time statistics. `dsp_*`, `ring_min/max` and `input_peak` cover the period since
/// the last snapshot.
#[derive(Clone, Copy, Debug, Default)]
pub struct StatsSnapshot {
    pub in_callbacks: u64,
    pub out_callbacks: u64,
    pub in_frames: u64,
    pub out_frames: u64,
    pub in_block: u32,
    pub out_block: u32,
    pub dsp_mean_us: f64,
    pub dsp_max_us: f64,
    /// Capture → input callback (hardware buffer + device latency + safety offset).
    pub in_latency_ms: f64,
    /// Output callback → DAC.
    pub out_latency_ms: f64,
    /// Mean time audio waits in the input→output ring.
    pub ring_ms: f64,
    /// Ring fill seen by the output callbacks (frames).
    pub ring_min: u32,
    pub ring_max: u32,
    /// Fill the drift controller currently aims at (frames).
    pub setpoint: u32,
    /// Output read-rate correction compensating the clock difference of the two devices.
    pub drift_ppm: f64,
    /// Guitar string → ears, excluding the analogue path.
    pub round_trip_ms: f64,
    pub underruns: u64,
    /// Underruns while the two streams found their phase (first 200 ms): not glitches.
    pub priming: u64,
    pub overruns: u64,
    pub resyncs: u64,
    pub events_dropped: u64,
    pub errors: u64,
    /// Bitset over `ERROR_KINDS`.
    pub error_kinds: u32,
    pub input_peak: f32,
    /// Raw input samples lost because the tap reader fell behind.
    pub tap_dropped: u64,
}

/// Guitar side of the duplex stream: the body of the input callback.
pub struct InputSide {
    channels: usize,
    channel: usize,
    mono: Vec<f32>,
    tracker: NoteTracker,
    chain: GuitarChain,
    /// Amp settings from the control thread; the latest applies at the next callback.
    chain_rx: rtrb::Consumer<ChainParams>,
    audio_tx: rtrb::Producer<f32>,
    event_tx: rtrb::Producer<TrackerEvent>,
    tap_tx: rtrb::Producer<TapBlock>,
    tap: TapBlock,
    sample_rate: f64,
    shared: Arc<Shared>,
}

/// Appends raw input samples (stream index of `x[0]`: `start`) to the tap, sending each full
/// block; a block the reader has no room for is counted as dropped.
fn push_tap(tap: &mut TapBlock, tx: &mut rtrb::Producer<TapBlock>, start: u64, x: &[f32], dropped: &AtomicU64) {
    for (k, &v) in x.iter().enumerate() {
        if tap.len == 0 {
            tap.first = start + k as u64;
        }
        tap.data[tap.len] = v;
        tap.len += 1;
        if tap.len == TAP_BLOCK {
            if tx.push(*tap).is_err() {
                dropped.fetch_add(TAP_BLOCK as u64, Relaxed);
            }
            tap.len = 0;
        }
    }
}

impl InputSide {
    /// One input callback: `data` interleaved, `callback_ns` its host time, `latency_ns` from
    /// capture to callback.
    pub fn process(&mut self, data: &[f32], callback_ns: u64, latency_ns: u64) {
        let t0 = Instant::now();
        let sh = &self.shared;
        sh.in_latency_ns.store(latency_ns, Relaxed);
        let frames = data.len() / self.channels;
        sh.in_callbacks.fetch_add(1, Relaxed);
        sh.in_frames.fetch_add(frames as u64, Relaxed);
        sh.in_block.store(frames as u32, Relaxed);
        let capture_ns = callback_ns.saturating_sub(latency_ns) as f64;
        let epoch = capture_ns - self.tracker.position() as f64 * 1e9 / self.sample_rate;
        sh.in_epoch_bits.store(epoch.to_bits(), Relaxed);
        let mut latest = None;
        while let Ok(p) = self.chain_rx.pop() {
            latest = Some(p);
        }
        if let Some(p) = latest {
            self.chain.set_params(p);
        }
        let mut peak = 0f32;
        let gain = f32::from_bits(sh.input_gain_bits.load(Relaxed));
        for part in data.chunks(self.channels * self.mono.len()) {
            let n = part.len() / self.channels;
            let buf = &mut self.mono[..n];
            for (i, v) in buf.iter_mut().enumerate() {
                *v = part[i * self.channels + self.channel] * gain;
                peak = peak.max(v.abs());
            }
            push_tap(&mut self.tap, &mut self.tap_tx, self.tracker.position(), buf, &sh.tap_dropped);
            let event_tx = &mut self.event_tx;
            self.tracker.process(buf, |e| {
                if event_tx.push(e).is_err() {
                    sh.events_dropped.fetch_add(1, Relaxed);
                }
            });
            self.chain.process(buf);
            let take = n.min(self.audio_tx.slots());
            if let Ok(chunk) = self.audio_tx.write_chunk_uninit(take) {
                chunk.fill_from_iter(buf[..take].iter().copied());
            }
            if take < n {
                sh.overruns.fetch_add((n - take) as u64, Relaxed);
            }
        }
        sh.in_callback_ns.store(callback_ns, Relaxed);
        // Bit patterns of non-negative floats order like their values.
        sh.peak_bits.fetch_max(peak.to_bits(), Relaxed);
        sh.meter_bits.fetch_max(peak.to_bits(), Relaxed);
        let ns = t0.elapsed().as_nanos() as u64;
        sh.dsp_ns_total.fetch_add(ns, Relaxed);
        sh.dsp_ns_max.fetch_max(ns, Relaxed);
    }
}

/// Largest read-rate correction (USB audio crystals are within ±100 ppm of each other).
const MAX_DRIFT: f64 = 1e-3;

/// Playback side: the body of the output callback.
///
/// The cable and the output are two devices with two crystals, so the ring is read with a
/// variable rate 1 + ε (cubic interpolation) chosen by a PI controller: drift is absorbed
/// continuously, without dropping or repeating samples.
///
/// The controlled quantity is the *virtual* fill — ring content plus the frames the input
/// device has captured since its last callback (host-time stamps of both callbacks). The raw
/// fill seen at output callbacks is a sawtooth: with independent clocks the callback phases
/// slide past each other and at each crossing one output period receives no input block. The
/// virtual fill is smooth across crossings (a delay-locked loop, as in JACK's bridges).
///
/// Setpoint: two blocks + 32 frames, so the ring never holds less than one block + 32 at an
/// output callback whatever the phase. An underrun raises it by 32 frames (up to four blocks);
/// it decays back by one frame per 30 clean seconds.
pub struct OutputSide {
    channels: usize,
    audio_rx: rtrb::Consumer<f32>,
    shared: Arc<Shared>,
    block: usize,
    sample_rate: f64,
    min_setpoint: f64,
    max_setpoint: f64,
    setpoint: f64,
    max_fill: usize,
    warmup_frames: u64,
    decay_callbacks: u64,
    clean_callbacks: u64,
    primed: bool,
    fill_avg: f64,
    fill_coef: f64,
    integral: f64,
    kp: f64,
    ki_dt: f64,
    phase: f64,
    hist: [f32; 4],
    player: Player,
}

/// 4-point Hermite interpolation between `x[1]` (t = 0) and `x[2]` (t = 1).
#[inline]
fn hermite(x: &[f32; 4], t: f32) -> f32 {
    let c1 = 0.5 * (x[2] - x[0]);
    let c2 = x[0] - 2.5 * x[1] + 2.0 * x[2] - 0.5 * x[3];
    let c3 = 0.5 * (x[3] - x[0]) + 1.5 * (x[1] - x[2]);
    ((c3 * t + c2) * t + c1) * t + x[1]
}

impl OutputSide {
    fn new(
        channels: usize,
        audio_rx: rtrb::Consumer<f32>,
        shared: Arc<Shared>,
        sr: f64,
        block: usize,
        commands: rtrb::Consumer<PlayerCommand>,
    ) -> Self {
        let dt = block as f64 / sr;
        // Fill dynamics: f' = sr·(δ − ε) with ε = Kp·e + Ki∫e → ω_n = √(sr·Ki), ζ = sr·Kp / 2ω_n.
        let omega = std::f64::consts::TAU * 0.1;
        let ki = omega * omega / sr;
        let kp = 2.0 * omega / sr;
        let min_setpoint = (2 * block + 32) as f64;
        Self {
            channels,
            audio_rx,
            shared,
            block,
            sample_rate: sr,
            min_setpoint,
            max_setpoint: (4 * block + 64) as f64,
            setpoint: min_setpoint,
            max_fill: 8 * block + 512,
            warmup_frames: sr as u64 / 5,
            decay_callbacks: (30.0 / dt) as u64,
            clean_callbacks: 0,
            primed: false,
            fill_avg: 0.0,
            fill_coef: dt / 0.25,
            integral: 0.0,
            kp,
            ki_dt: ki * dt,
            phase: 0.0,
            hist: [0.0; 4],
            player: Player::new(commands, sr),
        }
    }

    /// One output callback: `out` interleaved, `callback_ns` its host time, `latency_ns` from
    /// callback to playback. Plays the monitored guitar plus the backing track.
    pub fn process(&mut self, out: &mut [f32], callback_ns: u64, latency_ns: u64) {
        self.play_guitar(out, callback_ns, latency_ns);
        let clock = self.player.render(out, self.channels, callback_ns + latency_ns);
        self.shared.clock.publish(&clock);
    }

    /// The monitored guitar: input ring → adaptive resampler → `out` (overwritten).
    fn play_guitar(&mut self, out: &mut [f32], callback_ns: u64, latency_ns: u64) {
        let sh = &self.shared;
        sh.out_latency_ns.store(latency_ns, Relaxed);
        let frames = out.len() / self.channels;
        sh.out_callbacks.fetch_add(1, Relaxed);
        sh.out_callback_ns.store(callback_ns, Relaxed);
        let played = sh.out_frames.fetch_add(frames as u64, Relaxed);
        sh.out_block.store(frames as u32, Relaxed);

        let mut available = self.audio_rx.slots();
        if available > self.max_fill {
            // A stall (e.g. the output device was busy): jump back to the setpoint.
            let drop = available - self.setpoint as usize;
            if let Ok(chunk) = self.audio_rx.read_chunk(drop) {
                chunk.commit_all();
            }
            available -= drop;
            self.fill_avg = available as f64;
            sh.resyncs.fetch_add(1, Relaxed);
        }
        sh.ring_min.fetch_min(available as u32, Relaxed);
        sh.ring_max.fetch_max(available as u32, Relaxed);
        // Frames captured by the input device since its last callback (at most one block).
        let since_input = callback_ns.saturating_sub(sh.in_callback_ns.load(Relaxed)) as f64 * 1e-9;
        let mut virtual_fill = available as f64 + (since_input * self.sample_rate).min(self.block as f64);
        if !self.primed {
            if virtual_fill < self.setpoint - 1.0 || available < frames {
                out.fill(0.0);
                return;
            }
            // Join exactly at the setpoint: whatever queued up while waiting is dropped, so the
            // controller starts without an error to work off.
            let excess = ((virtual_fill - self.setpoint).floor().max(0.0) as usize).min(available - frames);
            if excess > 0 {
                if let Ok(chunk) = self.audio_rx.read_chunk(excess) {
                    chunk.commit_all();
                }
                virtual_fill -= excess as f64;
            }
            self.primed = true;
            self.fill_avg = virtual_fill;
            self.integral = 0.0;
        }

        self.fill_avg += self.fill_coef * (virtual_fill - self.fill_avg);
        let err = self.fill_avg - self.setpoint;
        self.integral = (self.integral + self.ki_dt * err).clamp(-MAX_DRIFT, MAX_DRIFT);
        let drift = (self.kp * err + self.integral).clamp(-MAX_DRIFT, MAX_DRIFT);
        let step = 1.0 + drift;
        sh.fill_x16.store((self.fill_avg * 16.0) as u32, Relaxed);
        sh.drift_ppb.store((drift * 1e9) as i64, Relaxed);

        let gain = f32::from_bits(sh.monitor_gain_bits.load(Relaxed));
        let mut starved = false;
        for frame in out.chunks_mut(self.channels) {
            if !starved {
                self.phase += step;
                while self.phase >= 1.0 {
                    match self.audio_rx.pop() {
                        Ok(s) => {
                            self.hist.rotate_left(1);
                            self.hist[3] = s;
                            self.phase -= 1.0;
                        }
                        Err(_) => {
                            starved = true;
                            break;
                        }
                    }
                }
            }
            let y = if starved { 0.0 } else { hermite(&self.hist, self.phase as f32) };
            frame.fill(y * gain);
        }

        if starved {
            self.primed = false;
            self.phase = 0.0;
            self.hist = [0.0; 4];
            self.clean_callbacks = 0;
            self.setpoint = (self.setpoint + 32.0).min(self.max_setpoint);
            let counter = if played < self.warmup_frames { &sh.priming } else { &sh.underruns };
            counter.fetch_add(1, Relaxed);
        } else {
            self.clean_callbacks += 1;
            if self.clean_callbacks % self.decay_callbacks == 0 {
                self.setpoint = (self.setpoint - 1.0).max(self.min_setpoint);
            }
        }
        sh.setpoint.store(self.setpoint as u32, Relaxed);
    }
}

/// Main-thread side: note events and statistics.
pub struct Monitor {
    events: rtrb::Consumer<TrackerEvent>,
    commands: rtrb::Producer<PlayerCommand>,
    chain_tx: rtrb::Producer<ChainParams>,
    tap: rtrb::Consumer<TapBlock>,
    shared: Arc<Shared>,
    sample_rate: f64,
    last: (u64, u64),
}

impl Monitor {
    pub fn sample_rate(&self) -> f64 {
        self.sample_rate
    }

    /// Queues a command for the player; false when the queue is full.
    pub fn send(&mut self, cmd: PlayerCommand) -> bool {
        self.commands.push(cmd).is_ok()
    }

    /// New settings for the guitar chain (amp model, knobs, effects), applied by the next input
    /// callback without allocating; false when the queue is full.
    pub fn set_chain(&mut self, params: ChainParams) -> bool {
        self.chain_tx.push(params).is_ok()
    }

    /// The player state published by the last output callback.
    pub fn clock(&self) -> PlayerClock {
        self.shared.clock.read()
    }

    /// Host time (ns) at which input sample `index` (tracker positions) was captured; `None`
    /// before the first input callback.
    pub fn input_time_ns(&self, index: f64) -> Option<f64> {
        if self.shared.in_callbacks.load(Relaxed) == 0 {
            return None;
        }
        Some(f64::from_bits(self.shared.in_epoch_bits.load(Relaxed)) + index * 1e9 / self.sample_rate)
    }

    /// Input sample index captured at host time `ns`.
    pub fn input_index_at(&self, ns: f64) -> Option<f64> {
        let zero = self.input_time_ns(0.0)?;
        Some((ns - zero) * self.sample_rate * 1e-9)
    }

    /// Linear gain applied to the guitar input (detection, tone, tap).
    pub fn set_input_gain(&mut self, gain: f32) {
        self.shared.input_gain_bits.store(gain.max(0.0).to_bits(), Relaxed);
    }

    /// Linear gain of the guitar heard in the output; ignored when monitoring is off.
    pub fn set_monitor_gain(&mut self, gain: f32) {
        if self.shared.monitor_enabled {
            self.shared.monitor_gain_bits.store(gain.max(0.0).to_bits(), Relaxed);
        }
    }

    pub fn monitor_enabled(&self) -> bool {
        self.shared.monitor_enabled
    }

    /// Device/stream errors require reopening; xruns recover without resetting statistics.
    pub fn stream_failed(&self) -> bool { self.stream_failed_at(crate::host_now_ns()) }

    /// Also catch a device which stops calling back without delivering an error. The host
    /// clock is explicit so simulated devices can exercise exactly this failure path.
    pub fn stream_failed_at(&self, now_ns: u64) -> bool {
        let stale = |at: u64| now_ns.saturating_sub(if at == 0 { self.shared.started_ns } else { at }) > 2_000_000_000;
        self.shared.error_kinds.load(Relaxed) & !1 != 0
            || stale(self.shared.in_callback_ns.load(Relaxed)) || stale(self.shared.out_callback_ns.load(Relaxed))
    }

    /// Largest |sample| of the guitar input (after the input gain) since the last call.
    pub fn take_peak(&mut self) -> f32 {
        f32::from_bits(self.shared.meter_bits.swap(0, Relaxed))
    }

    /// Drains the raw input blocks captured since the last call.
    pub fn drain_tap(&mut self, mut f: impl FnMut(&TapBlock)) {
        while let Ok(block) = self.tap.pop() {
            f(&block);
        }
    }

    /// Drains the note events produced since the last call.
    pub fn poll_events(&mut self, mut f: impl FnMut(TrackerEvent)) {
        while let Ok(e) = self.events.pop() {
            f(e);
        }
    }

    pub fn stats(&mut self) -> StatsSnapshot {
        let s = &self.shared;
        let sr = self.sample_rate;
        let in_callbacks = s.in_callbacks.load(Relaxed);
        let dsp_total = s.dsp_ns_total.load(Relaxed);
        let (last_cb, last_total) = std::mem::replace(&mut self.last, (in_callbacks, dsp_total));
        let n = in_callbacks.saturating_sub(last_cb).max(1);
        let in_latency_ms = s.in_latency_ns.load(Relaxed) as f64 * 1e-6;
        let out_latency_ms = s.out_latency_ns.load(Relaxed) as f64 * 1e-6;
        // The oldest frame read by an output callback was written (virtual fill − one block)
        // frames earlier.
        let fill = s.fill_x16.load(Relaxed) as f64 / 16.0;
        let ring_ms = (fill - s.out_block.load(Relaxed) as f64).max(0.0) * 1e3 / sr;
        StatsSnapshot {
            in_callbacks,
            out_callbacks: s.out_callbacks.load(Relaxed),
            in_frames: s.in_frames.load(Relaxed),
            out_frames: s.out_frames.load(Relaxed),
            in_block: s.in_block.load(Relaxed),
            out_block: s.out_block.load(Relaxed),
            dsp_mean_us: dsp_total.saturating_sub(last_total) as f64 / n as f64 * 1e-3,
            dsp_max_us: s.dsp_ns_max.swap(0, Relaxed) as f64 * 1e-3,
            in_latency_ms,
            out_latency_ms,
            ring_ms,
            ring_min: s.ring_min.swap(u32::MAX, Relaxed),
            ring_max: s.ring_max.swap(0, Relaxed),
            setpoint: s.setpoint.load(Relaxed),
            drift_ppm: s.drift_ppb.load(Relaxed) as f64 * 1e-3,
            round_trip_ms: in_latency_ms + ring_ms + out_latency_ms,
            underruns: s.underruns.load(Relaxed),
            priming: s.priming.load(Relaxed),
            overruns: s.overruns.load(Relaxed),
            resyncs: s.resyncs.load(Relaxed),
            events_dropped: s.events_dropped.load(Relaxed),
            errors: s.errors.load(Relaxed),
            error_kinds: s.error_kinds.load(Relaxed),
            input_peak: f32::from_bits(s.peak_bits.swap(0, Relaxed)),
            tap_dropped: s.tap_dropped.load(Relaxed),
        }
    }
}

/// The engine without CoreAudio: both callback bodies plus the main-thread monitor.
pub struct Bridge {
    pub input: InputSide,
    pub output: OutputSide,
    pub monitor: Monitor,
}

impl Bridge {
    /// `monitor_gain` is the linear output gain (0 mutes monitoring).
    pub fn new(cfg: &EngineConfig, in_channels: usize, out_channels: usize, monitor_gain: f32) -> Bridge {
        let sr = cfg.sample_rate;
        let mut tracker_cfg = cfg.tracker;
        tracker_cfg.pitch.sample_rate = sr as f32;
        tracker_cfg.onset.sample_rate = sr as f32;
        let shared = Arc::new(Shared {
            started_ns: crate::host_now_ns(),
            ring_min: AtomicU32::new(u32::MAX),
            input_gain_bits: AtomicU32::new(1f32.to_bits()),
            monitor_gain_bits: AtomicU32::new(monitor_gain.to_bits()),
            monitor_enabled: monitor_gain > 0.0,
            ..Shared::default()
        });
        let (audio_tx, audio_rx) = rtrb::RingBuffer::<f32>::new(8192);
        let (event_tx, events) = rtrb::RingBuffer::<TrackerEvent>::new(4096);
        let (commands, commands_rx) = rtrb::RingBuffer::<PlayerCommand>::new(64);
        let (chain_tx, chain_rx) = rtrb::RingBuffer::<ChainParams>::new(16);
        let (tap_tx, tap) = rtrb::RingBuffer::<TapBlock>::new(512);
        let block = cfg.buffer_frames.max(16) as usize;
        Bridge {
            input: InputSide {
                channels: in_channels,
                channel: cfg.input_channel.min(in_channels - 1),
                mono: vec![0.0; 4096],
                tracker: NoteTracker::new(tracker_cfg),
                chain: GuitarChain::new(sr as f32, cfg.chain, cfg.ir.as_ref()),
                chain_rx,
                audio_tx,
                event_tx,
                tap_tx,
                tap: TapBlock::default(),
                sample_rate: sr as f64,
                shared: shared.clone(),
            },
            output: OutputSide::new(out_channels, audio_rx, shared.clone(), sr as f64, block, commands_rx),
            monitor: Monitor { events, commands, chain_tx, tap, shared, sample_rate: sr as f64, last: (0, 0) },
        }
    }
}

pub struct Engine {
    _input: cpal::Stream,
    _output: cpal::Stream,
    info: StreamInfo,
    monitor: Monitor,
}

/// `Fixed(frames)` when the hardware range allows it, else the device default.
fn buffer_size(range: &SupportedBufferSize, frames: u32) -> (BufferSize, bool) {
    match range {
        SupportedBufferSize::Range { min, max } if (*min..=*max).contains(&frames) => (BufferSize::Fixed(frames), true),
        SupportedBufferSize::Unknown => (BufferSize::Fixed(frames), true),
        _ => (BufferSize::Default, false),
    }
}

impl Engine {
    pub fn start(cfg: EngineConfig) -> Result<Engine, AudioError> {
        let host = cpal::default_host();
        let (in_dev, kind) = pick_input(&host, cfg.input.as_deref())?;
        let out_dev = pick_output(&host, cfg.output.as_deref())?;
        let in_def = in_dev.default_input_config().map_err(AudioError::backend("input configuration"))?;
        let out_def = out_dev.default_output_config().map_err(AudioError::backend("output configuration"))?;
        let (in_ch, out_ch) = (in_def.channels() as usize, out_def.channels() as usize);
        if cfg.input_channel >= in_ch { return Err(AudioError::InputChannel { channel: cfg.input_channel + 1, channels: in_ch }); }
        let sr = cfg.sample_rate;
        let (in_buffer, input_fixed) = buffer_size(in_def.buffer_size(), cfg.buffer_frames);
        let (out_buffer, output_fixed) = buffer_size(out_def.buffer_size(), cfg.buffer_frames);
        let monitor = cfg.monitor.unwrap_or(kind == InputKind::Rocksmith);
        let gain = if monitor { db_to_lin(cfg.monitor_gain_db) } else { 0.0 };

        let Bridge { input: mut input_side, output: mut output_side, monitor: mon } = Bridge::new(&cfg, in_ch, out_ch, gain);
        // cpal's timestamps leave out the streams' own latency: added here, kept up to date (the
        // default output can change under the stream) by a thread that ends with the streams.
        let (in_name, out_name) = (in_dev.to_string(), cfg.output.as_ref().map(|_| out_dev.to_string()));
        let latency = Arc::new(StreamLatency::default());
        latency.refresh(&in_name, out_name.as_deref());
        let watched = Arc::downgrade(&latency);
        std::thread::Builder::new()
            .name("opensmith-latency".into())
            .spawn(move || {
                while let Some(latency) = watched.upgrade() {
                    latency.refresh(&in_name, out_name.as_deref());
                    drop(latency);
                    std::thread::sleep(Duration::from_millis(500));
                }
            })
            .ok();
        let ns = |t: cpal::StreamInstant| t.saturating_duration_since(cpal::StreamInstant::ZERO).as_nanos() as u64;
        let in_latency = latency.clone();
        let input_callback = move |data: &[f32], info: &cpal::InputCallbackInfo| {
            let ts = info.timestamp();
            let latency = ts.callback.saturating_duration_since(ts.capture).as_nanos() as u64 + in_latency.input_ns.load(Relaxed);
            input_side.process(data, ns(ts.callback), latency);
        };
        let output_callback = move |out: &mut [f32], info: &cpal::OutputCallbackInfo| {
            let ts = info.timestamp();
            let latency = ts.playback.saturating_duration_since(ts.callback).as_nanos() as u64 + latency.output_ns.load(Relaxed);
            output_side.process(out, ns(ts.callback), latency);
        };

        let in_config = StreamConfig { channels: in_ch as u16, sample_rate: sr, buffer_size: in_buffer };
        let out_config = StreamConfig { channels: out_ch as u16, sample_rate: sr, buffer_size: out_buffer };
        let errors = mon.shared.clone();
        let on_input_error = move |e: cpal::Error| {
            errors.errors.fetch_add(1, Relaxed);
            errors.error_kinds.fetch_or(error_bit(e.kind()), Relaxed);
        };
        let errors = mon.shared.clone();
        let on_output_error = move |e: cpal::Error| {
            errors.errors.fetch_add(1, Relaxed);
            errors.error_kinds.fetch_or(error_bit(e.kind()), Relaxed);
        };
        let input = in_dev
            .build_input_stream::<f32, _, _>(in_config, input_callback, on_input_error, None)
            .map_err(AudioError::backend(format!("opening input \"{in_dev}\" at {sr} Hz")))?;
        let output = out_dev
            .build_output_stream::<f32, _, _>(out_config, output_callback, on_output_error, None)
            .map_err(AudioError::backend(format!("opening output \"{out_dev}\" at {sr} Hz")))?;
        output.play().map_err(AudioError::backend("starting output"))?;
        input.play().map_err(AudioError::backend("starting input"))?;

        Ok(Engine {
            info: StreamInfo {
                input_channel: cfg.input_channel,
                input_name: in_dev.to_string(),
                input_kind: kind,
                output_name: out_dev.to_string(),
                sample_rate: sr,
                input_channels: in_ch as u16,
                output_channels: out_ch as u16,
                requested_buffer: cfg.buffer_frames,
                input_fixed,
                output_fixed,
                monitor,
            },
            _input: input,
            _output: output,
            monitor: mon,
        })
    }

    pub fn info(&self) -> &StreamInfo {
        &self.info
    }

    /// Drains the note events produced since the last call.
    pub fn poll_events(&mut self, f: impl FnMut(TrackerEvent)) {
        self.monitor.poll_events(f);
    }

    pub fn stats(&mut self) -> StatsSnapshot {
        self.monitor.stats()
    }

    /// Player commands, clock, input timing and raw input for a game session.
    pub fn monitor(&mut self) -> &mut Monitor {
        &mut self.monitor
    }
}
