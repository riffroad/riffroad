//! Backing tracks read from WAV (imports) and from Ogg Vorbis (the songs shipped with the app).

use std::path::{Path, PathBuf};

use opensmith_session::{load_track, read_excerpt};

/// Three seconds of A (440 Hz) then three of E (660 Hz), stereo at 44.1 kHz, encoded with libvorbis.
fn ogg() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/data/a-then-e.ogg")
}

/// The same as a WAV, in the temporary folder.
fn wav() -> PathBuf {
    let path = std::env::temp_dir().join(format!("opensmith-track-{}.wav", std::process::id()));
    let spec = hound::WavSpec { channels: 2, sample_rate: 44_100, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
    let mut w = hound::WavWriter::create(&path, spec).unwrap();
    for i in 0..264_600 {
        let f = if i < 132_300 { 440.0 } else { 660.0 };
        let v = (0.5 * (2.0 * std::f64::consts::PI * f * i as f64 / 44_100.0).sin() * 32767.0) as i16;
        w.write_sample(v).unwrap();
        w.write_sample(v).unwrap();
    }
    w.finalize().unwrap();
    path
}

/// The tone's frequency, from its upward zero crossings.
fn frequency(x: &[f32], rate: u32) -> f64 {
    let ups = x.windows(2).filter(|w| w[0] < 0.0 && w[1] >= 0.0).count();
    ups as f64 * f64::from(rate) / x.len() as f64
}

#[test]
fn an_ogg_backing_plays_as_long_and_as_high_as_its_wav() {
    let wav = wav();
    for path in [ogg(), wav.clone()] {
        let track = load_track(&path, 48_000).unwrap();
        let seconds = track.frames() as f64 / 48_000.0;
        assert!((seconds - 6.0).abs() < 0.03, "{}: {seconds} s", path.display());
        for (at, hz) in [(1.0, 440.0), (4.0, 660.0)] {
            let (part, rate) = read_excerpt(&path, at, 0.5).unwrap();
            assert_eq!((part.len(), rate), (22_050, 44_100));
            assert!((frequency(&part, rate) - hz).abs() < 5.0, "{} at {at} s: {} Hz", path.display(), frequency(&part, rate));
        }
    }
    let _ = std::fs::remove_file(wav);
}

#[test]
fn an_ogg_excerpt_starts_on_the_sample_asked_without_decoding_what_comes_before() {
    let (tail, rate) = read_excerpt(&ogg(), 3.2, 10.0).unwrap();
    // 2.8 s left, to the sample.
    assert!((tail.len() as i64 - 123_480).abs() <= 1, "{} frames left after 3.2 s", tail.len());
    // Right at the change of note: A before, E after.
    let (before, _) = read_excerpt(&ogg(), 2.9, 0.08).unwrap();
    let (after, _) = read_excerpt(&ogg(), 3.02, 0.08).unwrap();
    assert!((frequency(&before, rate) - 440.0).abs() < 30.0 && (frequency(&after, rate) - 660.0).abs() < 30.0);
}
