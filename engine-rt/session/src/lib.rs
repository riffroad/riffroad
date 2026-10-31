//! A game session: the audio engine plays the backing track and listens to the guitar, the game
//! judges what it hears against the chart, and the UI receives a stream of events.
//!
//! Timing: the output callback publishes when each backing-track frame reaches the listener, the
//! input callback when each guitar sample was captured, both in host time. An attack is placed in
//! the song where the player *heard* it, whatever the latencies of the two devices.

mod calibration;
pub mod composer;
mod events;
pub mod guitarist;
mod history;
pub mod replay;
pub mod samples;
mod runner;
mod session;
mod take;
mod track;

pub use calibration::{metronome, Calibration, CalibrationPlan, CalibrationResult, MIN_HITS};
pub use events::{UiEvent, UiExpected, UiMissReason, UiScore, UiTarget};
pub use history::TapHistory;
pub use runner::{Command, Devices, EngineBackend, Poll, SessionHandle};
pub use session::{AudioBackend, Judging, RiffLoop, Session, SessionConfig};
pub use take::{Take, TakeError, TakeScore};
pub use track::{load_track, load_track_with_stem, TrackError};
