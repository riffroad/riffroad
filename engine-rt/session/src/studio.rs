//! The engine's studio: a song (the guitar's strokes, the drums, a bass line) recorded the way a
//! rock band records one. Two guitarists play the strokes, each on their own guitar (real
//! recorded notes, `SampleBank::players`) and with their own timing, through the amp, one left
//! and one right; the drums and the bass are synthesised, the drums in a small room; then the
//! mix: each part at its level, glued by a compressor, limited. The backing (drums and bass) and
//! the guitars come apart, as the game plays them, and add up to the mix.

use std::f64::consts::TAU;

use opensmith_dsp::fx::biquad::Biquad;
use opensmith_dsp::guitar::{render_with, Excitation, GuitarSound, Kind, Samples, Voice};
use opensmith_dsp::synth::Pcg32;
use opensmith_dsp::{AmpKnobs, AmpModel, ChainParams, GuitarChain};
use opensmith_game::Chart;
use realfft::RealFftPlanner;

pub const SAMPLE_RATE: u32 = 48_000;
const SR: f64 = SAMPLE_RATE as f64;

/// A piece of the drum kit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Piece {
    Kick,
    Snare,
    Hat,
    OpenHat,
    Ride,
    Crash,
    HighTom,
    LowTom,
    FloorTom,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Hit {
    pub time: f64,
    pub piece: Piece,
    /// 0..1.
    pub velocity: f32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BassNote {
    pub time: f64,
    pub midi: i32,
    pub length: f64,
    pub velocity: f32,
}

/// What the guitarist plays at one moment, a note or a chord, as long as it really sounds.
#[derive(Clone, Debug, PartialEq)]
pub struct Stroke {
    pub time: f64,
    /// Until the hand damps it (s).
    pub length: f64,
    /// Fret on each string, low E first; -1: not played.
    pub frets: [i32; 6],
    /// An upstroke: the high strings first.
    pub up: bool,
    pub palm: bool,
    pub accent: bool,
    /// Hammered on or pulled off: the fretting hand alone.
    pub legato: bool,
    /// Bent up this many semitones; slid this many frets over the note.
    pub bend: f64,
    pub slide: i32,
    pub vibrato: bool,
}

impl Stroke {
    pub fn note(time: f64, length: f64, string: usize, fret: i32) -> Stroke {
        let mut frets = [-1; 6];
        frets[string] = fret;
        Stroke::chord(time, length, frets)
    }

    pub fn chord(time: f64, length: f64, frets: [i32; 6]) -> Stroke {
        Stroke { time, length, frets, up: false, palm: false, accent: false, legato: false, bend: 0.0, slide: 0, vibrato: false }
    }
}

/// The strokes of a chart from elsewhere: what it plays at its hardest, each note or chord
/// ringing on to the next (palm-muted ones damped at once).
pub fn strokes_of(chart: &Chart) -> Vec<Stroke> {
    let top = chart.arrangement.max_difficulty;
    let at_top = |levels: [u32; 2]| levels[0] <= top && top <= levels[1];
    let mut out: Vec<Stroke> = Vec::new();
    for n in chart.notes.iter().filter(|n| at_top(n.levels)) {
        let t = n.techniques.clone().unwrap_or_default();
        let mut s = Stroke::note(n.time, n.sustain, n.string as usize, n.fret as i32);
        s.palm = t.palm_mute == Some(true);
        s.legato = t.hammer_on == Some(true) || t.pull_off == Some(true);
        s.bend = t.bend.unwrap_or(0.0) as f64;
        s.slide = t.slide_to.map_or(0, |to| to as i32 - n.fret as i32);
        s.vibrato = t.vibrato == Some(true);
        out.push(s);
    }
    for c in chart.chords.iter().filter(|c| at_top(c.levels)) {
        let mut frets = [-1; 6];
        for (s, f) in chart.chord_templates[c.template].frets.iter().enumerate().take(6) {
            frets[s] = *f;
        }
        let mut s = Stroke::chord(c.time, c.sustain, frets);
        s.up = c.strum.as_deref() == Some("up");
        s.palm = c.techniques.as_ref().and_then(|t| t.palm_mute) == Some(true);
        out.push(s);
    }
    out.sort_by(|a, b| a.time.total_cmp(&b.time));
    for i in 0..out.len() {
        let next = out.get(i + 1).map_or(out[i].time + 1.0, |n| n.time);
        out[i].length = if out[i].palm { 0.12 + out[i].length } else { out[i].length.max(next - out[i].time) };
    }
    out
}

/// What the drummer and the bass player play.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Rhythm {
    pub drums: Vec<Hit>,
    pub bass: Vec<BassNote>,
}

/// The guitars' sound: the amp, and how hard it is driven (its gain knob, 0..1).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Tone {
    pub amp: AmpModel,
    pub gain: f32,
}

/// A song recorded: stereo, interleaved, at `SAMPLE_RATE`. `backing` + `guitar` is the mix.
pub struct Recording {
    pub backing: Vec<f32>,
    pub guitar: Vec<f32>,
}

/// Loudness of each part in the mix, RMS dBFS: the guitars (the left one), the bass, the drums;
/// then the whole mix, and its peak ceiling.
const GUITAR_DB: f32 = -16.0;
const BASS_DB: f32 = -10.5;
const DRUMS_DB: f32 = -15.5;
const MIX_DB: f32 = -15.5;
const CEILING_DB: f32 = -1.5;

/// `strokes` and `rhythm` recorded over `seconds`, the two guitarists playing on `players'`
/// notes (synthesised strings where a player has none).
pub fn record(strokes: &[Stroke], rhythm: &Rhythm, tone: Tone, players: [Option<&dyn Samples>; 2], seconds: f64, seed: u64) -> Recording {
    let frames = (seconds * SR) as usize;
    let mut rng = Pcg32::new(seed);
    let room = room_ir(&mut rng);

    // The guitars: the second player sits a few ms behind the first, a touch less driven.
    let takes: Vec<Vec<f32>> = players
        .iter()
        .enumerate()
        .map(|(k, samples)| amped(&take(strokes, *samples, frames, 0.006 * k as f64, seed.wrapping_add(1 + k as u64)), tone, k))
        .collect();
    let mut guitar = [vec![0f32; frames], vec![0f32; frames]];
    let level = gain_to(rms_db(&[&takes[0]]), GUITAR_DB);
    for (take, side) in takes.iter().zip([-0.85, 0.85]) {
        add_panned(&mut guitar, take, side, level);
    }
    let mono: Vec<f32> = guitar[0].iter().zip(&guitar[1]).map(|(l, r)| 0.5 * (l + r)).collect();
    for ch in 0..2 {
        let wet = convolve(&mono, &room[1 - ch]);
        guitar[ch].iter_mut().zip(wet).for_each(|(g, w)| *g += 0.07 * w);
    }

    // The bass, compressed, in the middle.
    let mut low = bass(&rhythm.bass, frames, &mut rng);
    let squeeze = compressor_gain(&[&low], -18.0, 4.0, 20.0);
    low.iter_mut().zip(&squeeze).for_each(|(x, g)| *x *= g);
    let level = gain_to(rms_db(&[&low]), BASS_DB);
    let mut backing = [vec![0f32; frames], vec![0f32; frames]];
    add_panned(&mut backing, &low, 0.0, level);

    // The drums in their room, compressed together.
    let mut kit = drums(&rhythm.drums, frames, &mut rng);
    let mono: Vec<f32> = kit[0].iter().zip(&kit[1]).map(|(l, r)| 0.5 * (l + r)).collect();
    for ch in 0..2 {
        let wet = convolve(&mono, &room[ch]);
        kit[ch].iter_mut().zip(wet).for_each(|(d, w)| *d += 0.18 * w);
    }
    let squeeze = compressor_gain(&[&kit[0], &kit[1]], -16.0, 3.0, 15.0);
    for ch in kit.iter_mut() {
        ch.iter_mut().zip(&squeeze).for_each(|(d, g)| *d *= g);
    }
    let level = gain_to(rms_db(&[&kit[0], &kit[1]]), DRUMS_DB);
    for ch in 0..2 {
        backing[ch].iter_mut().zip(&kit[ch]).for_each(|(b, d)| *b += d * level);
    }

    // The mix bus: glue, loudness, ceiling; the same gain on both parts, so they still add up.
    let mix: Vec<Vec<f32>> = (0..2).map(|ch| backing[ch].iter().zip(&guitar[ch]).map(|(b, g)| b + g).collect()).collect();
    let mut gain = compressor_gain(&[&mix[0], &mix[1]], -17.0, 2.5, 40.0);
    let glued: Vec<Vec<f32>> = mix.iter().map(|m| m.iter().zip(&gain).map(|(x, g)| x * g).collect()).collect();
    let level = gain_to(rms_db(&[&glued[0], &glued[1]]), MIX_DB);
    gain.iter_mut().for_each(|g| *g *= level);
    let leveled: Vec<Vec<f32>> = mix.iter().map(|m| m.iter().zip(&gain).map(|(x, g)| x * g).collect()).collect();
    let limit = limiter_gain(&[&leveled[0], &leveled[1]], CEILING_DB, 5.0, 80.0);
    gain.iter_mut().zip(&limit).for_each(|(g, l)| *g *= l);
    let interleave = |parts: &[Vec<f32>; 2]| -> Vec<f32> { (0..frames).flat_map(|i| [parts[0][i] * gain[i], parts[1][i] * gain[i]]).collect() };
    Recording { backing: interleave(&backing), guitar: interleave(&guitar) }
}

/// One guitarist's take of `strokes` as the cable carries it, `late` seconds behind.
fn take(strokes: &[Stroke], samples: Option<&dyn Samples>, frames: usize, late: f64, seed: u64) -> Vec<f32> {
    let mut rng = Pcg32::new(seed);
    let voices = perform(strokes, late, &mut rng);
    let sound = GuitarSound { sample_rate: SR, peak: 0.5, hum: 0.0, hiss: 0.0, ..GuitarSound::default() };
    let mut out = render_with(&voices, frames as f64 / SR, &sound, seed, samples);
    out.resize(frames, 0.0);
    out
}

const OPEN: [i32; 6] = [40, 45, 50, 55, 59, 64];

/// A guitarist playing `strokes`: on time give or take a few ms (a slow drift, a little
/// scatter), accents harder, chords strummed down or up, each string one note at a time.
fn perform(strokes: &[Stroke], late: f64, rng: &mut Pcg32) -> Vec<Voice> {
    let mut voices: Vec<Voice> = Vec::new();
    let mut drift = 0.0;
    for s in strokes {
        drift = 0.8 * drift + 0.004 * rng.gauss() as f64;
        let at = s.time + late + drift + 0.002 * rng.gauss() as f64;
        let level = rng.range(0.9, 1.0) * if s.accent { 1.0 } else { 0.85 } * if s.palm { 0.85 } else { 1.0 };
        let mut strings: Vec<usize> = (0..6).filter(|&k| s.frets[k] >= 0).collect();
        if s.up {
            strings.reverse();
        }
        let chord = strings.len() > 1;
        let gap = rng.range(0.004, if s.up { 0.008 } else { 0.012 }) as f64;
        for (j, &string) in strings.iter().enumerate() {
            let start = at + j as f64 * gap;
            let fret = s.frets[string];
            let glide = if s.slide != 0 {
                vec![(0.04, 0.0), ((s.length * 0.8).max(0.12), s.slide as f64)]
            } else if s.bend > 0.0 {
                vec![(0.06, 0.0), (0.2, s.bend)]
            } else {
                Vec::new()
            };
            let excitation = if s.legato { Excitation::Legato { level: level * 0.6 } } else { Excitation::Pick { level: level * if chord { 0.8 } else { 1.0 }, pos: rng.range(0.1, 0.25) } };
            voices.push(Voice {
                string,
                start,
                end: start + s.length + if s.palm { 0.0 } else { rng.range(0.0, 0.03) as f64 },
                midi: (OPEN[string] + fret) as f64,
                glide,
                vibrato: if s.vibrato { 0.15 } else { 0.0 },
                excitation,
                palm: s.palm,
                recorded: Some((fret, if s.palm { Kind::PalmMute } else { Kind::Plain }, rng.next_u32())),
                buzz: 0.0,
            });
        }
    }
    // One note at a time per string: the next one damps it.
    voices.sort_by(|a, b| a.start.total_cmp(&b.start));
    for i in 0..voices.len() {
        let s = voices[i].string;
        if let Some(next) = voices[i + 1..].iter().find(|v| v.string == s).map(|v| v.start) {
            voices[i].end = voices[i].end.min(next);
        }
    }
    voices
}

/// A take through the bridge pickup, the amp, and the EQ of a guitar in a rock mix.
fn amped(di: &[f32], tone: Tone, k: usize) -> Vec<f32> {
    let sr = SR as f32;
    // The recorded guitars were played on a dark pickup: the bridge humbucker's resonance and top.
    let mut pickup = [Biquad::peaking(sr, 3200.0, 0.9, 10.0), Biquad::high_shelf(sr, 5000.0, 0.707, 5.0)];
    let mut x: Vec<f32> = di.iter().map(|&v| pickup.iter_mut().fold(v, |v, f| f.process(v))).collect();
    let level = gain_to(active_rms_db(&x), -20.0);
    x.iter_mut().for_each(|v| *v *= level);
    let k = k as f32;
    let knobs = AmpKnobs { gain: tone.gain - 0.05 * k, bass: 0.6, mid: 0.5, treble: 0.9 - 0.05 * k, volume: 0.8, delay: 0.0, reverb: 0.0, gate: true };
    let mut chain = GuitarChain::new(sr, ChainParams::default().with_amp(tone.amp, knobs), None);
    for block in x.chunks_mut(128) {
        chain.process(block);
    }
    // Rumble and some low end out (the bass's room), air on top.
    let mut eq = [
        Biquad::highpass(sr, 90.0, 0.707),
        Biquad::highpass(sr, 90.0, 0.707),
        Biquad::peaking(sr, 180.0, 0.8, -3.0),
        Biquad::high_shelf(sr, 6000.0, 0.707, 7.0),
        Biquad::lowpass(sr, 12000.0, 0.707),
    ];
    x.iter_mut().for_each(|v| *v = eq.iter_mut().fold(*v, |v, f| f.process(v)));
    x
}

/// The bass: picked strings, a little drive, the lows kept round.
fn bass(notes: &[BassNote], frames: usize, rng: &mut Pcg32) -> Vec<f32> {
    let sr = SR as f32;
    let mut out = vec![0f32; frames];
    let release = 0.03;
    for n in notes {
        let freq = 440.0 * 2f64.powf((n.midi as f64 - 69.0) / 12.0);
        let note = bass_string(freq, n.length + release, n.velocity, rng);
        let end = (n.length * SR) as usize;
        let tail = (release * SR) as usize;
        let start = (n.time * SR).round().max(0.0) as usize;
        for (k, v) in note.iter().enumerate() {
            let Some(o) = out.get_mut(start + k) else { break };
            let fade = if k > end { 1.0 - (k - end) as f32 / tail as f32 } else { 1.0 };
            *o += v * fade.max(0.0);
        }
    }
    let mut hp = Biquad::highpass(sr, 35.0, 0.707);
    out.iter_mut().for_each(|v| *v = hp.process(*v));
    let peak = out.iter().fold(0f32, |m, v| m.max(v.abs())).max(1e-9);
    let mut eq = [Biquad::lowpass(sr, 1000.0, 0.54), Biquad::lowpass(sr, 1000.0, 1.31), Biquad::peaking(sr, 80.0, 0.8, 4.0), Biquad::peaking(sr, 350.0, 1.0, -3.0)];
    out.iter_mut().for_each(|v| {
        let driven = (1.2 * *v / peak).tanh() / 1.2f32.tanh();
        *v = eq.iter_mut().fold(driven, |v, f| f.process(v));
    });
    out
}

/// A picked bass string (Karplus–Strong, in tune by an allpass): a noise burst shaped by the
/// pick, its position's comb and its hardness, ringing for about 3 s; at its first swings' peak
/// times `velocity`.
fn bass_string(freq: f64, seconds: f64, velocity: f32, rng: &mut Pcg32) -> Vec<f32> {
    let period = SR / freq;
    let l = (period - 0.6).floor() as usize;
    let delta = period - 0.5 - l as f64;
    let c_ap = (1.0 - delta) / (1.0 + delta);
    let g = 10f64.powf(-3.0 / (3.0 * freq));
    let burst: Vec<f64> = (0..l).map(|_| rng.range(-1.0, 1.0) as f64).collect();
    let pos = ((0.18 * l as f64) as usize).max(1);
    let hard = 0.15 + 0.16 * velocity as f64;
    let mut soft = 0.0;
    let mut line: Vec<f64> = (0..l)
        .map(|i| {
            soft += hard * ((burst[i] - burst[(i + l - pos) % l]) - soft);
            soft
        })
        .collect();
    let n = (seconds * SR) as usize;
    let mut out = Vec::with_capacity(n);
    let (mut idx, mut prev, mut ap_x1, mut ap_y1) = (0usize, 0f64, 0f64, 0f64);
    for _ in 0..n {
        let d = line[idx];
        let lp = g * 0.5 * (d + prev);
        prev = d;
        let ap = c_ap * lp + ap_x1 - c_ap * ap_y1;
        ap_x1 = lp;
        ap_y1 = ap;
        line[idx] = ap;
        out.push(d as f32);
        idx = (idx + 1) % l;
    }
    let first = out.iter().take((4.0 * period) as usize).fold(1e-9f32, |m, v| m.max(v.abs()));
    out.iter_mut().for_each(|v| *v *= velocity / first);
    out
}

/// The kit, stereo: each hit synthesised anew (no two alike), at its level and place.
fn drums(hits: &[Hit], frames: usize, rng: &mut Pcg32) -> [Vec<f32>; 2] {
    let sr = SR as f32;
    let mut out = [vec![0f32; frames], vec![0f32; frames]];
    for h in hits {
        let (mut sound, db, pan) = match h.piece {
            Piece::Kick => {
                let mut eq = [Biquad::peaking(sr, 60.0, 1.0, 3.0), Biquad::peaking(sr, 400.0, 1.2, -4.0)];
                let s: Vec<f32> = kick(rng).into_iter().map(|v| eq.iter_mut().fold(v, |v, f| f.process(v))).collect();
                (s, 2.0, 0.0)
            }
            Piece::Snare => {
                let mut eq = Biquad::peaking(sr, 220.0, 1.0, 2.0);
                (snare(rng).into_iter().map(|v| eq.process(v)).collect(), -5.0, 0.0)
            }
            Piece::Hat => (metal(0.08, if h.velocity < 0.6 { 0.025 } else { 0.035 }, 7000.0, rng), -17.0, 0.3),
            Piece::OpenHat => (metal(0.5, 0.16, 6000.0, rng), -18.0, 0.3),
            Piece::Ride => (ride(rng), -19.0, 0.4),
            Piece::Crash => (metal(2.5, 0.9, 3500.0, rng), -17.0, -0.35),
            Piece::HighTom => (tom(190.0), -6.0, 0.2),
            Piece::LowTom => (tom(140.0), -6.0, -0.2),
            Piece::FloorTom => (tom(105.0), -6.0, -0.4),
        };
        let gain = 10f32.powf(db / 20.0) * h.velocity;
        sound.iter_mut().for_each(|v| *v *= gain);
        let start = (h.time * SR).round().max(0.0) as usize;
        let (l, r) = pan_gains(pan);
        for (k, v) in sound.iter().enumerate() {
            let Some(o) = out[0].get_mut(start + k) else { break };
            *o += v * l;
            out[1][start + k] += v * r;
        }
    }
    out
}

/// A kick: a sine sweeping down onto ~48 Hz, a beater click, a little saturation.
fn kick(rng: &mut Pcg32) -> Vec<f32> {
    let mut click = Biquad::highpass(SR as f32, 3000.0, 0.707);
    let mut phase = 0.0;
    (0..(0.35 * SR) as usize)
        .map(|i| {
            let t = i as f64 / SR;
            phase += TAU * (48.0 + 110.0 * (-t / 0.025).exp()) / SR;
            let body = phase.sin() * (-t / 0.16).exp();
            let beater = click.process(rng.gauss()) as f64 * (-t / 0.003).exp();
            (1.5 * (body + 0.25 * beater)).tanh() as f32
        })
        .collect()
}

/// A snare: the shell's two modes, the wires' noise, the stick's crack.
fn snare(rng: &mut Pcg32) -> Vec<f32> {
    let sr = SR as f32;
    let mut wires = [Biquad::highpass(sr, 1500.0, 0.707), Biquad::lowpass(sr, 9000.0, 0.707)];
    let mut crack = Biquad::highpass(sr, 4000.0, 0.707);
    (0..(0.4 * SR) as usize)
        .map(|i| {
            let t = i as f64 / SR;
            let shell = 0.6 * (TAU * 185.0 * t).sin() * (-t / 0.06).exp() + 0.35 * (TAU * 330.0 * t).sin() * (-t / 0.04).exp();
            let w = wires.iter_mut().fold(rng.gauss(), |v, f| f.process(v)) as f64 * (-t / 0.13).exp();
            let c = crack.process(rng.gauss()) as f64 * (-t / 0.006).exp();
            (shell + 0.9 * w + 0.4 * c) as f32
        })
        .collect()
}

/// Cymbal partials (the classic inharmonic six), raised a little.
const METAL: [f64; 6] = [205.3, 304.4, 369.6, 522.7, 540.0, 800.0];

/// A cymbal: square waves at metal's partials and noise, kept above `lo` Hz, dying in `decay` s.
fn metal(seconds: f64, decay: f64, lo: f32, rng: &mut Pcg32) -> Vec<f32> {
    let sr = SR as f32;
    let phases: Vec<f64> = METAL.iter().map(|_| rng.range(0.0, 6.0) as f64).collect();
    let mut band = [Biquad::highpass(sr, lo, 0.707), Biquad::lowpass(sr, 14000.0, 0.707), Biquad::highpass(sr, lo, 0.707)];
    (0..(seconds * SR) as usize)
        .map(|i| {
            let t = i as f64 / SR;
            let tone: f64 = METAL.iter().zip(&phases).map(|(f, p)| (TAU * f * 1.7 * t + p).sin().signum()).sum();
            let x = (0.6 * tone) as f32 + 0.8 * rng.gauss();
            band.iter_mut().fold(x, |v, f| f.process(v)) * (-t / decay).exp() as f32
        })
        .collect()
}

/// A ride: a cymbal's wash under the bell's ping.
fn ride(rng: &mut Pcg32) -> Vec<f32> {
    let mut out = metal(1.5, 0.6, 4500.0, rng);
    for (i, v) in out.iter_mut().enumerate() {
        let t = i as f64 / SR;
        *v = 0.6 * *v + (0.25 * ((TAU * 3150.0 * t).sin() + 0.6 * (TAU * 4720.0 * t).sin()) * (-t / 0.25).exp()) as f32;
    }
    out
}

/// A tom: a sine falling a little onto `f0`.
fn tom(f0: f64) -> Vec<f32> {
    let mut phase = 0.0;
    (0..(0.5 * SR) as usize)
        .map(|i| {
            let t = i as f64 / SR;
            phase += TAU * f0 * (1.0 + 0.4 * (-t / 0.04).exp()) / SR;
            (phase.sin() * (-t / 0.22).exp()) as f32
        })
        .collect()
}

/// A small room's impulse response, stereo: decorrelated noise dying in 0.7 s, darker than the
/// direct sound, 8 ms after it; each side at unit energy.
fn room_ir(rng: &mut Pcg32) -> [Vec<f32>; 2] {
    let n = (1.2 * SR) as usize;
    let side = |rng: &mut Pcg32| {
        let mut lp = Biquad::lowpass(SR as f32, 6000.0, 0.707);
        let mut ir: Vec<f32> = (0..n).map(|i| lp.process(rng.gauss() * (-6.9 * i as f64 / SR / 0.7).exp() as f32)).collect();
        ir[..(0.008 * SR) as usize].iter_mut().for_each(|v| *v = 0.0);
        let energy = ir.iter().map(|v| v * v).sum::<f32>().sqrt().max(1e-9);
        ir.iter_mut().for_each(|v| *v /= energy);
        ir
    };
    [side(rng), side(rng)]
}

/// `x` convolved with `ir` (overlap-add on FFT blocks), as long as `x`.
fn convolve(x: &[f32], ir: &[f32]) -> Vec<f32> {
    let size = (2 * ir.len()).next_power_of_two();
    let block = size - ir.len() + 1;
    let mut planner = RealFftPlanner::<f32>::new();
    let (fwd, inv) = (planner.plan_fft_forward(size), planner.plan_fft_inverse(size));
    let mut buf = vec![0f32; size];
    buf[..ir.len()].copy_from_slice(ir);
    let mut h = fwd.make_output_vec();
    fwd.process(&mut buf, &mut h).expect("sizes match");
    let mut spec = fwd.make_output_vec();
    let mut out = vec![0f32; x.len() + size];
    for (b, chunk) in x.chunks(block).enumerate() {
        buf.iter_mut().for_each(|v| *v = 0.0);
        buf[..chunk.len()].copy_from_slice(chunk);
        fwd.process(&mut buf, &mut spec).expect("sizes match");
        spec.iter_mut().zip(&h).for_each(|(s, h)| *s *= h);
        inv.process(&mut spec, &mut buf).expect("sizes match");
        for (o, v) in out[b * block..].iter_mut().zip(&buf) {
            *o += v / size as f32;
        }
    }
    out.truncate(x.len());
    out
}

/// A feed-forward RMS compressor's gain, the channels linked: above `threshold` dBFS, `ratio`:1,
/// the level followed over `ms`.
fn compressor_gain(channels: &[&[f32]], threshold: f32, ratio: f32, ms: f32) -> Vec<f32> {
    let frames = channels.iter().map(|c| c.len()).min().unwrap_or(0);
    let c = 1.0 - (-1.0 / (ms * 1e-3 * SR as f32)).exp();
    let mut env = 0.0f32;
    (0..frames)
        .map(|i| {
            let level = channels.iter().fold(0f32, |m, ch| m.max(ch[i] * ch[i]));
            env += c * (level - env);
            let over = 10.0 * env.max(1e-24).log10() - threshold;
            10f32.powf(-over.max(0.0) * (1.0 - 1.0 / ratio) / 20.0)
        })
        .collect()
}

/// A look-ahead brickwall limiter's gain: every peak under `ceiling_db`, the gain going down
/// `look_ms` ahead of it and back up over `release_ms`.
fn limiter_gain(channels: &[&[f32]], ceiling_db: f32, look_ms: f32, release_ms: f32) -> Vec<f32> {
    let frames = channels.iter().map(|c| c.len()).min().unwrap_or(0);
    let ceiling = 10f32.powf(ceiling_db / 20.0);
    let need: Vec<f32> = (0..frames).map(|i| (ceiling / channels.iter().fold(1e-12f32, |m, ch| m.max(ch[i].abs()))).min(1.0)).collect();
    // The least gain needed within `look` samples either side (a monotonic queue).
    let look = (look_ms * 1e-3 * SR as f32) as usize;
    let mut window: std::collections::VecDeque<usize> = std::collections::VecDeque::new();
    let mut least = vec![1f32; frames];
    for i in 0..frames + look {
        if i < frames {
            while window.back().is_some_and(|&j| need[j] >= need[i]) {
                window.pop_back();
            }
            window.push_back(i);
        }
        if i >= look {
            let at = i - look;
            while window.front().is_some_and(|&j| j + look < at) {
                window.pop_front();
            }
            least[at] = window.front().map_or(1.0, |&j| need[j]);
        }
    }
    // Averaged over half the look-ahead: the gain ramps down instead of stepping, and still
    // meets each peak (every value averaged is at most the peak's need).
    let half = look / 2;
    let mut sums = vec![0f64; frames + 1];
    for (i, l) in least.iter().enumerate() {
        sums[i + 1] = sums[i] + *l as f64;
    }
    let ramped: Vec<f32> = (0..frames)
        .map(|i| {
            let (a, b) = (i.saturating_sub(half), (i + half + 1).min(frames));
            ((sums[b] - sums[a]) / (b - a) as f64) as f32
        })
        .collect();
    let c = 1.0 - (-1.0 / (release_ms * 1e-3 * SR as f32)).exp();
    let mut smooth = 1.0f32;
    ramped
        .iter()
        .map(|&l| {
            smooth = (smooth + c * (l - smooth)).min(l);
            smooth
        })
        .collect()
}

/// RMS of the channels together, dBFS.
fn rms_db(channels: &[&[f32]]) -> f32 {
    let (sum, n) = channels.iter().fold((0f64, 0usize), |(s, n), ch| (s + ch.iter().map(|v| (*v as f64).powi(2)).sum::<f64>(), n + ch.len()));
    (10.0 * (sum / n.max(1) as f64).max(1e-24).log10()) as f32
}

/// RMS of where `x` plays (its 50 ms windows above a hundredth of the loudest's power), dBFS.
fn active_rms_db(x: &[f32]) -> f32 {
    let powers: Vec<f64> = x.chunks((0.05 * SR) as usize).map(|w| w.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / w.len() as f64).collect();
    let loudest = powers.iter().fold(0f64, |m, p| m.max(*p));
    let played: Vec<f64> = powers.into_iter().filter(|p| *p > loudest / 100.0).collect();
    (10.0 * (played.iter().sum::<f64>() / played.len().max(1) as f64).max(1e-24).log10()) as f32
}

/// The linear gain bringing `from_db` to `to_db` (none for silence).
fn gain_to(from_db: f32, to_db: f32) -> f32 {
    if from_db < -100.0 {
        1.0
    } else {
        10f32.powf((to_db - from_db) / 20.0)
    }
}

/// Equal-power pan, `p` from -1 (left) to 1 (right): the two sides' gains.
fn pan_gains(p: f32) -> (f32, f32) {
    let a = (p + 1.0) * std::f32::consts::FRAC_PI_4;
    (a.cos(), a.sin())
}

fn add_panned(out: &mut [Vec<f32>; 2], x: &[f32], pan: f32, gain: f32) {
    let (l, r) = pan_gains(pan);
    for (i, v) in x.iter().enumerate().take(out[0].len()) {
        out[0][i] += v * gain * l;
        out[1][i] += v * gain * r;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::composer::compose;
    use crate::samples::SampleBank;
    use opensmith_dsp::{TunerAnalyzer, TunerConfig};

    /// A beat from 1 s: kick and snare in turn every half second, the bass on each kick.
    fn beat(seconds: f64) -> Rhythm {
        let mut r = Rhythm::default();
        let mut t = 1.0;
        while t < seconds - 1.0 {
            r.drums.push(Hit { time: t, piece: Piece::Kick, velocity: 1.0 });
            r.drums.push(Hit { time: t + 0.25, piece: Piece::Hat, velocity: 0.6 });
            r.drums.push(Hit { time: t + 0.5, piece: Piece::Snare, velocity: 1.0 });
            r.bass.push(BassNote { time: t, midi: 33, length: 0.45, velocity: 1.0 });
            t += 1.0;
        }
        r.drums.push(Hit { time: 1.0, piece: Piece::Crash, velocity: 0.9 });
        r
    }

    const CRUNCH: Tone = Tone { amp: AmpModel::Crunch, gain: 0.85 };

    #[test]
    fn a_song_recorded_starts_with_the_band_adds_up_to_its_mix_and_stays_under_the_ceiling() {
        let players = SampleBank::players().expect("notes");
        let chart = compose(3, 10.0);
        let seconds = chart.meta.duration + 1.0;
        let rec = record(&strokes_of(&chart), &beat(seconds), CRUNCH, [Some(&players[0]), Some(&players[1])], seconds, 9);
        let frames = (seconds * SR) as usize;
        assert_eq!((rec.backing.len(), rec.guitar.len()), (2 * frames, 2 * frames), "stereo, the song's length");
        // Nothing before the band's first hit (but the FFT's rounding, far below hearing), then
        // drums and bass.
        assert!(rec.backing[..2 * (0.99 * SR) as usize].iter().all(|v| v.abs() < 1e-5), "silent before 1 s");
        let rms = |x: &[f32]| (x.iter().map(|v| v * v).sum::<f32>() / x.len() as f32).sqrt();
        assert!(rms(&rec.backing[2 * SR as usize..4 * SR as usize]) > 0.03, "the band plays");
        // The guitarists: one left, one right, not the same take.
        let (left, right): (Vec<f32>, Vec<f32>) = rec.guitar.chunks(2).map(|f| (f[0], f[1])).unzip();
        assert!(rms(&left) > 0.03 && rms(&right) > 0.03, "both guitars play");
        let dot: f32 = left.iter().zip(&right).map(|(l, r)| l * r).sum();
        let correlation = dot / (rms(&left) * rms(&right) * left.len() as f32);
        assert!(correlation < 0.8, "two takes, not one copied: correlation {correlation:.2}");
        let ceiling = 10f32.powf(CEILING_DB / 20.0) + 1e-3;
        let loudest = rec.backing.iter().zip(&rec.guitar).fold(0f32, |m, (b, g)| m.max((b + g).abs()));
        assert!(loudest <= ceiling, "mix peaks at {loudest:.3}");
    }

    #[test]
    fn the_same_seed_records_the_same_song() {
        let players = SampleBank::players().expect("notes");
        let chart = compose(5, 4.0);
        let seconds = chart.meta.duration;
        let banks = [Some(&players[0] as &dyn Samples), Some(&players[1] as &dyn Samples)];
        let a = record(&strokes_of(&chart), &beat(seconds), CRUNCH, banks, seconds, 4);
        let b = record(&strokes_of(&chart), &beat(seconds), CRUNCH, banks, seconds, 4);
        assert!(a.backing == b.backing && a.guitar == b.guitar);
    }

    #[test]
    fn each_guitarist_plays_the_charts_note_in_tune() {
        let players = SampleBank::players().expect("notes");
        let mut tuner = TunerAnalyzer::new(TunerConfig { min_clarity: 0.5, ..TunerConfig::default() });
        // D3 on the A string, fifth fret.
        for (k, bank) in players.iter().enumerate() {
            let di = take(&[Stroke::note(1.0, 2.0, 1, 5)], Some(bank), (4.0 * SR) as usize, 0.0, k as u64);
            let silent = di[..(0.95 * SR) as usize].iter().all(|v| v.abs() < 1e-6);
            assert!(silent, "player {k}: nothing before the note");
            let reading = tuner.analyze(&di[(1.2 * SR) as usize..(1.2 * SR) as usize + 8192]).expect("rings");
            let cents = 100.0 * (reading.midi - 50.0);
            assert!(cents.abs() < 10.0, "player {k}: {cents:+.1} cents");
        }
    }
}
