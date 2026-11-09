//! OpenSmith CoreAudio engine: device discovery (Real Tone Cable first, default input
//! as fallback) and a low-latency duplex stream (guitar in → note tracker + FX chain → out).
//!
//! CoreAudio exposes the cable and the speakers/headphones as two devices with two clocks, so
//! "duplex" is an input stream and an output stream bridged by a wait-free SPSC ring buffer,
//! read on the output side through an adaptive resampler that absorbs the clock drift.

pub mod clock;
pub mod devices;
pub mod engine;
pub mod latency;
pub mod player;
pub mod sfx;

pub use devices::{is_rocksmith_name, list_devices, DeviceInfo, InputKind};
pub use clock::host_now_ns;
pub use engine::{Bridge, Engine, EngineConfig, InputSide, Monitor, OutputSide, StatsSnapshot, StreamInfo, ERROR_KINDS};
pub use player::{PlayerClock, PlayerCommand, TapBlock, Track, MAX_RATE, MIN_RATE, TAP_BLOCK};
pub use sfx::Sound;

#[derive(Debug, thiserror::Error)]
pub enum AudioError {
    #[error("no audio input device available")]
    NoInput,
    #[error("no audio output device available")]
    NoOutput,
    #[error("input channel {channel} is unavailable (device has {channels} channels)")]
    InputChannel { channel: usize, channels: usize },
    #[error("no {direction} device matching \"{pattern}\"")]
    NotFound { direction: &'static str, pattern: String },
    #[error("{context}: {source}")]
    Backend {
        context: String,
        #[source]
        source: cpal::Error,
    },
}

impl AudioError {
    pub(crate) fn backend(context: impl Into<String>) -> impl FnOnce(cpal::Error) -> AudioError {
        let context = context.into();
        move |source| AudioError::Backend { context, source }
    }
}
