//! A band made by the engine for the lessons of the learning path: drums and a bass, synthesized
//! from the hits and notes the app lays on the lesson's beats. It is the lesson's backing track,
//! so it stops with the song in wait mode and slows down with it, as the metronome did.

use opensmith_audio::Track;
use opensmith_dsp::synth::Pcg32;
use serde::Deserialize;

/// A drum of the kit.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Drum {
    Kick,
    Snare,
    Hat,
}

/// What the band plays: drum hits (song time, drum) and bass notes (song time, MIDI, seconds).
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
pub struct Band {
    pub drums: Vec<(f64, Drum)>,
    pub bass: Vec<(f64, i32, f64)>,
}

/// Loudest sample of the mix: room left for the guitar over it.
const PEAK: f32 = 0.7;

/// `band`, stereo at `sample_rate`, `seconds` long (the hats a little to the right).
pub fn band(band: &Band, seconds: f64, sample_rate: u32) -> Track {
    let sr = sample_rate as f64;
    let frames = (seconds.max(0.0) * sr) as usize;
    let mut left = vec![0f32; frames];
    let mut right = vec![0f32; frames];
    let mut rng = Pcg32::new(7);
    for &(time, drum) in &band.drums {
        let (sound, pan) = match drum {
            Drum::Kick => (kick(sr), 0.5),
            Drum::Snare => (snare(sr, &mut rng), 0.5),
            Drum::Hat => (hat(sr, &mut rng), 0.62),
        };
        add(&mut left, &mut right, &sound, time, sr, pan);
    }
    for &(time, midi, length) in &band.bass {
        add(&mut left, &mut right, &bass(midi, length, sr), time, sr, 0.5);
    }
    let loudest = left.iter().chain(&right).fold(0f32, |m, v| m.max(v.abs()));
    let gain = if loudest > PEAK { PEAK / loudest } else { 1.0 };
    let data: Vec<f32> = left.iter().zip(&right).flat_map(|(l, r)| [l * gain, r * gain]).collect();
    Track::from_interleaved(&data, 2)
}

/// `sound` from song time `time`, `pan` of it to the right (0.5: centre).
fn add(left: &mut [f32], right: &mut [f32], sound: &[f32], time: f64, sr: f64, pan: f32) {
    let start = (time.max(0.0) * sr) as usize;
    for (i, v) in sound.iter().enumerate() {
        let Some(l) = left.get_mut(start + i) else { break };
        *l += v * (1.0 - pan) * 2.0f32.sqrt();
        right[start + i] += v * pan * 2.0f32.sqrt();
    }
}

/// A kick: a sine falling from 150 to 50 Hz, 0.35 s.
fn kick(sr: f64) -> Vec<f32> {
    let mut phase = 0.0;
    (0..(0.35 * sr) as usize)
        .map(|i| {
            let t = i as f64 / sr;
            phase += std::f64::consts::TAU * (50.0 + 100.0 * (-t / 0.03).exp()) / sr;
            (0.9 * (-t / 0.22).exp() * phase.sin()) as f32
        })
        .collect()
}

/// A snare: a short tone and its noise, 0.25 s.
fn snare(sr: f64, rng: &mut Pcg32) -> Vec<f32> {
    let mut last = 0.0f32;
    (0..(0.25 * sr) as usize)
        .map(|i| {
            let t = i as f64 / sr;
            // The noise's low end taken off (first difference): the snares, not a rumble.
            let noise = rng.range(-1.0, 1.0);
            let bright = noise - 0.6 * last;
            last = noise;
            let tone = (std::f64::consts::TAU * 185.0 * t).sin() * (-t / 0.06).exp();
            (0.32 * bright as f64 * (-t / 0.09).exp() + 0.3 * tone) as f32
        })
        .collect()
}

/// A closed hi-hat: bright noise, 60 ms.
fn hat(sr: f64, rng: &mut Pcg32) -> Vec<f32> {
    let mut last = 0.0f32;
    (0..(0.06 * sr) as usize)
        .map(|i| {
            let t = i as f64 / sr;
            let noise = rng.range(-1.0, 1.0);
            let bright = noise - last;
            last = noise;
            (0.14 * bright as f64 * (-t / 0.018).exp()) as f32
        })
        .collect()
}

/// A bass note: a few harmonics, darker as it rings, `length` seconds then a short release.
fn bass(midi: i32, length: f64, sr: f64) -> Vec<f32> {
    let freq = 440.0 * 2f64.powf((midi as f64 - 69.0) / 12.0);
    let release = 0.03;
    (0..((length + release) * sr) as usize)
        .map(|i| {
            let t = i as f64 / sr;
            let attack = (t / 0.005).min(1.0);
            let body = 0.55 + 0.45 * (-t / 0.15).exp();
            let end = if t > length { (1.0 - (t - length) / release).max(0.0) } else { 1.0 };
            let bright = (-t / 0.25).exp();
            let wave: f64 = (1..=4).map(|h| (std::f64::consts::TAU * freq * h as f64 * t).sin() * (if h == 1 { 1.0 } else { 0.5 * bright / h as f64 })).sum();
            (0.33 * attack * body * end * wave) as f32
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: u32 = 48_000;

    /// Mean square of the left channel between `from` and `to` (s).
    fn energy(track: &Track, from: f64, to: f64) -> f32 {
        let frames: Vec<f32> = track.samples().chunks(2).map(|f| f[0]).collect();
        let part = &frames[(from * SR as f64) as usize..(to * SR as f64) as usize];
        part.iter().map(|v| v * v).sum::<f32>() / part.len() as f32
    }

    #[test]
    fn the_band_plays_when_it_is_told_and_nowhere_else() {
        let b = Band { drums: vec![(0.5, Drum::Kick), (1.0, Drum::Snare), (1.5, Drum::Hat)], bass: vec![(2.0, 40, 0.5)] };
        let track = band(&b, 3.0, SR);
        assert_eq!(track.samples().len(), 3 * SR as usize * 2);
        assert!(energy(&track, 0.0, 0.49) == 0.0, "silent before the first hit");
        for (from, to) in [(0.5, 0.6), (1.0, 1.1), (1.5, 1.52), (2.0, 2.4)] {
            assert!(energy(&track, from, to) > 1e-4, "{from}..{to}");
        }
        assert!(track.samples().iter().all(|v| v.abs() <= PEAK + 1e-6), "room left for the guitar");
    }

    #[test]
    fn the_bass_sounds_its_note() {
        // E2 (82.4 Hz): about 82 upward zero crossings in one second of it.
        let track = band(&Band { drums: vec![], bass: vec![(0.0, 40, 1.0)] }, 1.0, SR);
        let left: Vec<f32> = track.samples().chunks(2).map(|f| f[0]).collect();
        let ups = left.windows(2).filter(|w| w[0] <= 0.0 && w[1] > 0.0).count();
        assert!((78..=88).contains(&ups), "{ups} crossings");
    }

    #[test]
    fn a_band_reads_from_what_the_app_sends() {
        let b: Band = serde_json::from_str(r#"{"drums":[[0.5,"kick"],[1.0,"hat"]],"bass":[[0.5,28,0.4]]}"#).unwrap();
        assert_eq!(b.drums, vec![(0.5, Drum::Kick), (1.0, Drum::Hat)]);
        assert_eq!(b.bass, vec![(0.5, 28, 0.4)]);
    }
}
