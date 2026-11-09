//! Real command thread and audio bridge; only the device's availability is simulated.
use std::sync::{Arc, Mutex, atomic::{AtomicBool, AtomicUsize, Ordering::SeqCst}};
use std::time::{Duration, Instant};
use opensmith_audio::{Bridge, EngineConfig, InputKind, Monitor, StreamInfo};
use opensmith_session::{AudioBackend, Command, Devices, SessionConfig, SessionHandle};

struct Device { monitor: Monitor, info: StreamInfo, disconnected: Arc<AtomicBool> }
impl AudioBackend for Device {
    fn monitor(&mut self) -> &mut Monitor { &mut self.monitor }
    fn now_ns(&self) -> u64 { opensmith_audio::host_now_ns() }
    fn info(&self) -> Option<StreamInfo> { Some(self.info.clone()) }
    fn failure(&mut self) -> Option<String> { self.disconnected.load(SeqCst).then(|| "unplugged".into()) }
}
fn device(d: &Devices, disconnected: Arc<AtomicBool>) -> Device {
    let cfg = EngineConfig { input_channel: d.input_channel, ..Default::default() };
    let Bridge { monitor, .. } = Bridge::new(&cfg, 2, 2, if d.monitor == Some(true) { 1.0 } else { 0.0 });
    Device { monitor, disconnected, info: StreamInfo { input_name: d.input.clone().unwrap_or("default".into()), input_kind: InputKind::Requested,
        output_name: "headphones".into(), sample_rate: 48_000, input_channels: 2, input_channel: d.input_channel, output_channels: 2,
        requested_buffer: 64, input_fixed: true, output_fixed: true, monitor: d.monitor == Some(true) } }
}
fn until(condition: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(3);
    while !condition() { assert!(Instant::now() < deadline, "audio thread did not reach expected state"); std::thread::sleep(Duration::from_millis(2)); }
}

#[test]
fn an_initial_failure_keeps_listening_for_a_device_change_and_clears_the_error() {
    let available = Arc::new(AtomicBool::new(false)); let flag = available.clone();
    let h = SessionHandle::spawn(move |d| if flag.load(SeqCst) { Ok(device(&d, Arc::new(AtomicBool::new(false)))) } else { Err("absent".into()) }, SessionConfig::default());
    until(|| h.error().is_some());
    available.store(true, SeqCst);
    h.send(Command::Input(Some("USB interface".into())));
    until(|| h.info().is_some_and(|i| i.input_name == "USB interface"));
    assert!(h.error().is_none());
}

#[test]
fn an_unplugged_device_is_marked_unready_and_retried_until_it_returns() {
    let available = Arc::new(AtomicBool::new(true)); let disconnected = Arc::new(AtomicBool::new(false));
    let (a, f) = (available.clone(), disconnected.clone());
    let h = SessionHandle::spawn(move |d| if a.load(SeqCst) { Ok(device(&d, f.clone())) } else { Err("absent".into()) }, SessionConfig::default());
    until(|| h.info().is_some());
    available.store(false, SeqCst); disconnected.store(true, SeqCst);
    until(|| h.info().is_none() && h.error().is_some());
    assert!(!h.poll().playing);
    disconnected.store(false, SeqCst); available.store(true, SeqCst);
    until(|| h.info().is_some() && h.error().is_none());
}

#[test]
fn channel_and_monitoring_changes_rebuild_once_and_failed_switch_preserves_working_audio() {
    let seen = Arc::new(Mutex::new(Vec::new())); let calls = seen.clone();
    let h = SessionHandle::spawn(move |d: Devices| {
        calls.lock().unwrap().push(d.clone());
        if d.input.as_deref() == Some("missing") { Err("not found".into()) }
        else { Ok(device(&d, Arc::new(AtomicBool::new(false)))) }
    }, SessionConfig::default());
    until(|| h.info().is_some());
    h.send(Command::InputChannel(1)); h.send(Command::Monitoring(Some(true)));
    until(|| h.info().is_some_and(|i| i.input_channel == 1 && i.monitor));
    h.send(Command::Input(Some("missing".into())));
    until(|| h.switch_error().is_some());
    assert!(h.info().is_some_and(|i| i.input_channel == 1 && i.monitor));
    assert!(h.error().is_none());
    assert!(seen.lock().unwrap().iter().any(|d| d.input_channel == 1 && d.monitor == Some(true)));
}

#[test]
fn startup_also_retries_without_an_explicit_device_change() {
    let attempts = Arc::new(AtomicUsize::new(0)); let n = attempts.clone();
    let h = SessionHandle::spawn(move |d| if n.fetch_add(1, SeqCst) == 0 { Err("temporarily busy".into()) }
        else { Ok(device(&d, Arc::new(AtomicBool::new(false)))) }, SessionConfig::default());
    until(|| h.info().is_some());
    assert!(attempts.load(SeqCst) >= 2); assert!(h.error().is_none());
}
