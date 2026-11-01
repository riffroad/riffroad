//! Sounds mixed over the guitar and the song: the interface's clicks, the game's cues, the
//! crowd. Each plays once, now or when the song reaches a frame (a count-in on the beat);
//! one background sound (the crowd) loops, its gain gliding to where it is asked to be. Voices
//! are kept in room reserved up front: the callback never allocates, and the caller keeps its
//! own reference to every sound, so the callback never frees one either.

use std::sync::Arc;

/// Interleaved stereo frames at the output's sample rate.
pub type Sound = Arc<[f32]>;

/// Sounds playing at once; one more is not played.
const VOICES: usize = 24;
/// Time constant of the background sound's gain (s).
const GLIDE: f64 = 0.4;

struct Voice {
    sound: Sound,
    /// Next frame of the sound.
    pos: usize,
    gain: f32,
    /// Track frame it waits for, `None` once started.
    at: Option<i64>,
    /// Output frames to wait in the next callback before it starts.
    delay: usize,
}

struct Bed {
    sound: Sound,
    pos: usize,
    gain: f32,
    target: f32,
}

pub(crate) struct Sfx {
    voices: Vec<Voice>,
    bed: Option<Bed>,
    /// The background sound another replaced, fading out under it.
    fading: Option<Bed>,
    /// Per-frame step of the background gain toward its target.
    glide: f32,
}

impl Sfx {
    pub(crate) fn new(sample_rate: f64) -> Sfx {
        Sfx { voices: Vec::with_capacity(VOICES), bed: None, fading: None, glide: (1.0 - (-1.0 / (GLIDE * sample_rate)).exp()) as f32 }
    }

    /// Plays `sound` at `gain`, now or once the track reaches frame `at`.
    pub(crate) fn play(&mut self, sound: Sound, gain: f32, at: Option<i64>) {
        if self.voices.len() < VOICES && sound.len() >= 2 {
            self.voices.push(Voice { sound, pos: 0, gain, at, delay: 0 });
        }
    }

    /// The background sound glides to `gain`; another sound rises to `gain` from its start as the
    /// one before fades out; none fades out.
    pub(crate) fn bed(&mut self, sound: Option<Sound>, gain: f32) {
        match (sound, &mut self.bed) {
            (Some(s), Some(b)) if Arc::ptr_eq(&s, &b.sound) => b.target = gain,
            (Some(s), _) if s.len() >= 2 => {
                if let Some(mut old) = self.bed.replace(Bed { sound: s, pos: 0, gain: 0.0, target: gain }) {
                    old.target = 0.0;
                    self.fading = Some(old);
                }
            }
            (_, Some(b)) => b.target = 0.0,
            _ => {}
        }
    }

    /// The track moved (load, seek): sounds waiting for a frame are dropped.
    pub(crate) fn cut_waiting(&mut self) {
        self.voices.retain(|v| v.at.is_none());
    }

    /// Adds the sounds to `out` (interleaved, `channels` per frame). `track`: the frame the
    /// callback starts at and the frames it moves per output frame, while the song plays.
    pub(crate) fn render(&mut self, out: &mut [f32], channels: usize, track: Option<(f64, f64)>) {
        let channels = channels.max(1);
        let frames = out.len() / channels;
        for v in &mut self.voices {
            if let (Some(at), Some((start, rate))) = (v.at, track)
                && (at as f64) < start + rate * frames as f64
            {
                v.delay = (((at as f64 - start) / rate).ceil().max(0.0) as usize).min(frames);
                v.at = None;
            }
        }
        for v in self.voices.iter_mut().filter(|v| v.at.is_none()) {
            let len = v.sound.len() / 2;
            for frame in out.chunks_mut(channels).skip(std::mem::take(&mut v.delay)) {
                if v.pos >= len {
                    break;
                }
                mix(frame, v.sound[2 * v.pos] * v.gain, v.sound[2 * v.pos + 1] * v.gain);
                v.pos += 1;
            }
        }
        let mut k = 0;
        while k < self.voices.len() {
            if self.voices[k].at.is_none() && self.voices[k].pos >= self.voices[k].sound.len() / 2 {
                self.voices.swap_remove(k);
            } else {
                k += 1;
            }
        }
        for slot in [&mut self.bed, &mut self.fading] {
            if let Some(b) = slot {
                let len = b.sound.len() / 2;
                for frame in out.chunks_mut(channels) {
                    b.gain += (b.target - b.gain) * self.glide;
                    mix(frame, b.sound[2 * b.pos] * b.gain, b.sound[2 * b.pos + 1] * b.gain);
                    b.pos = (b.pos + 1) % len;
                }
                if b.target == 0.0 && b.gain < 1e-4 {
                    *slot = None;
                }
            }
        }
    }
}

#[inline]
fn mix(frame: &mut [f32], l: f32, r: f32) {
    if frame.len() == 1 {
        frame[0] += 0.5 * (l + r);
    } else {
        frame[0] += l;
        frame[1] += r;
    }
}
