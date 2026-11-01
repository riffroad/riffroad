/**
 * The game's sounds, made here rather than recorded, in a garage band's colours: the interface
 * as the guitar's wood (the pick tapping the pickguard, the body answering), the cues
 * in play (the drummer's sticks counting in, pick slides, power chords, feedback) and the crowd
 * of a small club (its murmur, cheers, whistles, applause, clapping in time), with the room
 * around them. Each is mono samples at its own rate, the same on every run (seeded noise), so
 * they can be checked by tests and need no file nor licence.
 */

export const SOUND_NAMES = [
  'hover',
  'click',
  'back',
  'tick',
  'error',
  'count',
  'countAccent',
  'streak',
  'levelUp',
  'grade',
  'fanfare',
  'crowd',
  'cheer',
  'applause',
  'clapping',
] as const;
export type SoundName = (typeof SOUND_NAMES)[number];

/** Sounds that loop (the crowd's background). */
export const LOOPS: readonly SoundName[] = ['crowd', 'clapping'];

const TAU = 2 * Math.PI;

/** Deterministic noise in [-1, 1) (mulberry32). */
function noise(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}

/** A biquad band-pass (constant peak gain), RBJ's cookbook. */
function bandpass(rate: number, freq: number, q: number): (x: number) => number {
  const w = (TAU * Math.min(freq, rate * 0.45)) / rate;
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  const b0 = alpha / a0;
  const a1 = (-2 * Math.cos(w)) / a0;
  const a2 = (1 - alpha) / a0;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  return (x) => {
    const y = b0 * x - b0 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    return y;
  };
}

/** A one-pole low-pass at `freq`. */
function lowpass(rate: number, freq: number): (x: number) => number {
  const k = 1 - Math.exp((-TAU * freq) / rate);
  let y = 0;
  return (x) => (y += k * (x - y));
}

/** Rises in `attack` s, then decays with time constant `tau`. */
const env = (t: number, attack: number, tau: number): number => (t < 0 ? 0 : t < attack ? t / attack : Math.exp(-(t - attack) / tau));

/** Band-limited sawtooth of `harmonics` partials at phase `ph` (cycles). */
const saw = (ph: number, harmonics: number): number => {
  let v = 0;
  for (let k = 1; k <= harmonics; k++) v += Math.sin(TAU * k * ph) / k;
  return v * 0.55;
};

function buffer(rate: number, seconds: number): Float32Array {
  return new Float32Array(Math.round(rate * seconds));
}

/** Scaled so that its loudest sample is `peak`. */
function normalize(x: Float32Array, peak: number): Float32Array {
  let max = 0;
  for (const v of x) max = Math.max(max, Math.abs(v));
  if (max > 0) for (let i = 0; i < x.length; i++) x[i] *= peak / max;
  return x;
}

/** A struck bell at `freq`: its partials (1, 2.76, 5.4) dying away at their own pace. */
function bell(x: Float32Array, rate: number, at: number, freq: number, gain: number, tau = 0.35): void {
  const start = Math.round(at * rate);
  for (let i = start; i < x.length; i++) {
    const t = (i - start) / rate;
    const e = env(t, 0.004, tau);
    if (e < 1e-4 && t > 0.01) break;
    x[i] += gain * e * (Math.sin(TAU * freq * t) + 0.35 * Math.sin(TAU * 2.76 * freq * t) * Math.exp(-t / (tau * 0.4)) + 0.15 * Math.sin(TAU * 5.4 * freq * t) * Math.exp(-t / (tau * 0.2)));
  }
}

/** One clap: a burst of noise a few milliseconds long, through the hands' resonance. */
function clap(x: Float32Array, rate: number, at: number, freq: number, gain: number, rand: () => number): void {
  const filter = bandpass(rate, freq, 1.6);
  const start = Math.round(at * rate);
  const length = Math.round((0.012 + 0.01 * Math.abs(rand())) * rate);
  for (let i = 0; i < length && start + i < x.length; i++) {
    const t = i / rate;
    x[start + i] += gain * filter(rand()) * env(t, 0.0008, 0.0035);
  }
}

/** Many people talking: noise through vowel formants that change at the pace of syllables. */
function babble(x: Float32Array, rate: number, talkers: number, gain: number, rand: () => number): void {
  const VOWELS = [
    [730, 1090],
    [530, 1840],
    [570, 840],
    [300, 870],
    [440, 1020],
    [270, 2290],
  ];
  for (let k = 0; k < talkers; k++) {
    let f1 = bandpass(rate, 500, 6);
    let f2 = bandpass(rate, 1500, 8);
    let next = 0;
    let syllable = 0.2;
    let level = 0;
    const voice = 0.6 + 0.4 * Math.abs(rand());
    for (let i = 0; i < x.length; i++) {
      const t = i / rate;
      if (t >= next) {
        const [a, b] = VOWELS[Math.floor(Math.abs(rand()) * VOWELS.length) % VOWELS.length];
        const shift = 0.85 + 0.3 * Math.abs(rand());
        f1 = bandpass(rate, a * shift, 6);
        f2 = bandpass(rate, b * shift, 8);
        syllable = 0.12 + 0.2 * Math.abs(rand());
        // Now and then a talker pauses.
        level = rand() > -0.6 ? voice : 0;
        next = t + syllable;
      }
      const into = (t - (next - syllable)) / syllable;
      const shape = Math.sin(Math.PI * Math.min(1, Math.max(0, into)));
      const n = rand();
      x[i] += gain * level * shape * (f1(n) + 0.6 * f2(n));
    }
  }
}

/** "Wooo": voices sliding up and holding, through an "oo" to "oh" vowel. */
function woo(x: Float32Array, rate: number, voices: number, from: number, length: number, gain: number, rand: () => number): void {
  for (let k = 0; k < voices; k++) {
    const f0 = 220 + 200 * Math.abs(rand());
    const start = from + 0.4 * Math.abs(rand());
    const hold = length * (0.6 + 0.4 * Math.abs(rand()));
    const vib = 5 + 1.5 * rand();
    const f1 = bandpass(rate, 380 + 120 * Math.abs(rand()), 5);
    const f2 = bandpass(rate, 850 + 150 * Math.abs(rand()), 6);
    let ph = 0;
    const s0 = Math.round(start * rate);
    const s1 = Math.min(x.length, Math.round((start + hold) * rate));
    for (let i = s0; i < s1; i++) {
      const t = (i - s0) / rate;
      const rise = Math.min(1, t / 0.35);
      const f = f0 * (1 + 0.35 * rise * rise) * (1 + 0.012 * Math.sin(TAU * vib * t)) * (t > hold - 0.4 ? 1 - 0.25 * ((t - hold + 0.4) / 0.4) : 1);
      ph += f / rate;
      const e = Math.min(1, t / 0.15) * Math.min(1, (hold - t) / 0.3);
      const v = saw(ph, 12);
      x[i] += gain * e * (f1(v) + 0.7 * f2(v));
    }
  }
}

/** The last `fade` seconds blended into the first ones: the sound loops without a seam. */
function loopable(x: Float32Array, rate: number, fade: number): Float32Array {
  const n = Math.round(fade * rate);
  const out = x.slice(0, x.length - n);
  for (let i = 0; i < n; i++) {
    const k = i / n;
    out[i] = out[i] * Math.sqrt(k) + x[x.length - n + i] * Math.sqrt(1 - k);
  }
  return out;
}

/** Applause by `people` clapping at their own pace, rising fast and dying away over `seconds`. */
function applause(rate: number, seconds: number, people: number, seed: number): Float32Array {
  const x = buffer(rate, seconds);
  const rand = noise(seed);
  for (let p = 0; p < people; p++) {
    const pace = 3.2 + 1.8 * Math.abs(rand());
    const hand = 900 + 1600 * Math.abs(rand());
    const loud = 0.5 + 0.5 * Math.abs(rand());
    // Each stops at their own time in the second half.
    const stop = seconds * (0.45 + 0.5 * Math.abs(rand()));
    for (let t = 0.05 * Math.abs(rand()); t < stop; t += (1 + 0.15 * rand()) / pace) {
      const fade = t > stop - 0.6 ? (stop - t) / 0.6 : 1;
      clap(x, rate, t, hand * (1 + 0.08 * rand()), loud * fade, rand);
    }
  }
  return x;
}

/** A plucked string (Karplus-Strong) at `freq`, from `at` s, ringing `ring` s to -60 dB; a palm
 * on the strings (`ring` under a quarter second) also dulls it. */
function pluck(x: Float32Array, rate: number, at: number, freq: number, ring: number, gain: number, rand: () => number): void {
  const n = Math.max(2, Math.round(rate / freq));
  const line = new Float32Array(n);
  const pick = lowpass(rate, 5000);
  for (let i = 0; i < n; i++) line[i] = pick(rand());
  const loss = Math.pow(10, -3 / (ring * freq));
  const palm = ring < 0.25 ? lowpass(rate, 700) : (v: number) => v;
  let prev = 0;
  for (let i = Math.round(at * rate), k = 0; i < x.length; i++, k = (k + 1) % n) {
    const out = line[k];
    line[k] = loss * palm(0.5 * (out + prev));
    prev = out;
    x[i] += gain * out;
  }
}

/** The pick tapping the guitar's wood: a burst of noise through the body's resonance at `freq`,
 * with the pick's own snap above it; no note. */
function knock(x: Float32Array, rate: number, at: number, freq: number, gain: number, rand: () => number): void {
  const body = bandpass(rate, freq, 4);
  const snap = bandpass(rate, freq * 3.1, 2);
  const start = Math.round(at * rate);
  for (let i = start; i < x.length; i++) {
    const t = (i - start) / rate;
    if (t > 0.08) break;
    const n = rand() * env(t, 0.0002, 0.002);
    x[i] += gain * (body(n) * 3 + 0.5 * snap(n));
  }
}

/** The last `seconds` of `x` faded to silence (a cut sound would click). */
function fadeOut(x: Float32Array, rate: number, seconds: number): Float32Array {
  const n = Math.min(x.length, Math.round(seconds * rate));
  for (let k = 0; k < n; k++) x[x.length - 1 - k] *= 0.5 - 0.5 * Math.cos((Math.PI * k) / n);
  return x;
}

/** A power chord (root, fifth, octave) strummed down from `at`. */
function powerChord(x: Float32Array, rate: number, at: number, root: number, ring: number, gain: number, rand: () => number): void {
  [1, 1.4983, 2].forEach((m, k) => pluck(x, rate, at + 0.007 * k, root * m, ring, gain, rand));
}

/** Through a cranked amp: the muddy lows cut, driven into a soft clipper, then a speaker
 * cabinet's top end rolled off past `tone` Hz. */
function amp(x: Float32Array, rate: number, drive: number, tone = 3500): Float32Array {
  const low = lowpass(rate, 100);
  const cab = lowpass(rate, tone);
  const cab2 = lowpass(rate, tone * 1.4);
  const presence = bandpass(rate, 1800, 0.9);
  for (let i = 0; i < x.length; i++) {
    const d = Math.tanh(drive * (x[i] - low(x[i])));
    x[i] = cab2(cab(d)) + 0.25 * presence(d);
  }
  return x;
}

/** A pick slid along the wound strings for `seconds`: their windings rasp at `from` Hz, then
 * `to` as the pick speeds up or slows down. */
function scrape(x: Float32Array, rate: number, at: number, seconds: number, from: number, to: number, gain: number, rand: () => number): void {
  const s0 = Math.round(at * rate);
  const n = Math.round(seconds * rate);
  const body = bandpass(rate, 2300, 1.1);
  let ph = 0;
  for (let i = 0; i < n && s0 + i < x.length; i++) {
    const k = i / n;
    ph += (from * Math.pow(to / from, k)) / rate;
    const ridge = 0.35 + 0.65 * Math.max(0, Math.sin(TAU * ph));
    const e = Math.min(1, i / (0.015 * rate)) * (k > 0.6 ? (1 - k) / 0.4 : 1);
    x[s0 + i] += gain * e * body(rand() * ridge);
  }
}

/** The drummer's sticks knocked together: a woody click and their short ring at `pitch` Hz. */
function sticks(x: Float32Array, rate: number, pitch: number, gain: number, rand: () => number): void {
  const wood = bandpass(rate, pitch, 4);
  for (let i = 0; i < x.length; i++) {
    const t = i / rate;
    x[i] += gain * (1.5 * wood(rand()) * env(t, 0.0003, 0.003) + 0.5 * Math.sin(TAU * pitch * t) * env(t, 0.0005, 0.012) + 0.25 * Math.sin(TAU * 2.3 * pitch * t) * env(t, 0.0005, 0.006));
  }
}

/** Feedback: the amp starts to howl at `freq` from `at` s, swelling with a slow wobble. */
function feedback(x: Float32Array, rate: number, at: number, freq: number, gain: number): void {
  let ph = 0;
  for (let i = Math.round(at * rate); i < x.length; i++) {
    const t = i / rate - at;
    ph += (freq * (1 + 0.004 * Math.sin(TAU * 5 * t))) / rate;
    x[i] += gain * Math.min(1, t / 0.5) * (Math.sin(TAU * ph) + 0.3 * Math.sin(TAU * 2 * ph));
  }
}

/** Someone whistling with two fingers: up to the note, held, a little drop at the end. */
function whistle(x: Float32Array, rate: number, at: number, length: number, freq: number, gain: number, rand: () => number): void {
  const breath = bandpass(rate, freq, 3);
  let ph = 0;
  const s0 = Math.round(at * rate);
  for (let i = s0; i < Math.min(x.length, s0 + Math.round(length * rate)); i++) {
    const t = (i - s0) / rate;
    const f = freq * (0.8 + 0.2 * Math.min(1, t / 0.08)) * (t > length - 0.12 ? 1 - 0.12 * ((t - length + 0.12) / 0.12) : 1);
    ph += f / rate;
    const e = Math.min(1, t / 0.03) * Math.min(1, (length - t) / 0.05);
    x[i] += gain * e * (Math.sin(TAU * ph) + 0.15 * breath(rand()));
  }
}

/** A small club around the sound: its walls' echoes dying in about `tail` s (four combs, then
 * two all-passes, Schroeder's), `wet` of them added. */
function room(x: Float32Array, rate: number, wet: number, tail = 0.6): Float32Array {
  const combs = [0.0297, 0.0371, 0.0411, 0.0437].map((d) => ({ line: new Float32Array(Math.round(d * rate)), k: 0, g: Math.pow(10, (-3 * d) / tail), dull: lowpass(rate, 3000) }));
  const passes = [0.005, 0.0017].map((d) => ({ line: new Float32Array(Math.round(d * rate)), k: 0 }));
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    let s = 0;
    for (const c of combs) {
      const y = c.line[c.k];
      c.line[c.k] = x[i] + c.g * c.dull(y);
      c.k = (c.k + 1) % c.line.length;
      s += y;
    }
    s *= 0.25;
    for (const a of passes) {
      const b = a.line[a.k];
      const o = b - 0.7 * s;
      a.line[a.k] = s + 0.7 * o;
      a.k = (a.k + 1) % a.line.length;
      s = o;
    }
    out[i] = x[i] + wet * s;
  }
  return out;
}

/** The sound `name`, mono at `rate` Hz. */
export function synthesize(name: SoundName, rate: number): Float32Array {
  switch (name) {
    case 'hover': {
      // The pick brushing the pickguard: barely there.
      const x = buffer(rate, 0.06);
      knock(x, rate, 0, 2400, 0.25, noise(51));
      return normalize(fadeOut(x, rate, 0.01), 0.05);
    }
    case 'click': {
      // The pick tapping the guitar's top, the body answering.
      const x = buffer(rate, 0.09);
      knock(x, rate, 0, 1100, 1, noise(51));
      return normalize(fadeOut(room(x, rate, 0.08, 0.15), rate, 0.01), 0.2);
    }
    case 'back': {
      // Lower on the body, deeper.
      const x = buffer(rate, 0.09);
      knock(x, rate, 0, 700, 1, noise(51));
      return normalize(fadeOut(room(x, rate, 0.08, 0.15), rate, 0.01), 0.18);
    }
    case 'tick': {
      // A fingernail on the pickguard.
      const x = buffer(rate, 0.06);
      knock(x, rate, 0, 1800, 0.6, noise(51));
      return normalize(fadeOut(x, rate, 0.01), 0.09);
    }
    case 'error': {
      // Two dull knocks: no.
      const x = buffer(rate, 0.18);
      const rand = noise(51);
      knock(x, rate, 0, 500, 1, rand);
      knock(x, rate, 0.07, 480, 0.9, rand);
      return normalize(fadeOut(x, rate, 0.01), 0.22);
    }
    case 'count':
    case 'countAccent': {
      // The drummer counting in on the sticks; the first count harder.
      const x = buffer(rate, 0.08);
      sticks(x, rate, name === 'count' ? 1900 : 2300, 1, noise(name === 'count' ? 17 : 19));
      return normalize(x, name === 'count' ? 0.42 : 0.55);
    }
    case 'streak': {
      // A pick slide down the low strings.
      const x = buffer(rate, 0.55);
      scrape(x, rate, 0, 0.5, 1400, 300, 1, noise(21));
      return normalize(amp(x, rate, 4), 0.32);
    }
    case 'levelUp': {
      // A pick slide up, ending on a pinched harmonic that squeals.
      const x = buffer(rate, 0.6);
      const rand = noise(27);
      scrape(x, rate, 0, 0.22, 300, 1300, 1, rand);
      pluck(x, rate, 0.2, 1318.5, 0.9, 0.5, rand);
      return normalize(amp(x, rate, 5, 5000), 0.28);
    }
    case 'grade': {
      // An E5 left ringing, until the amp starts to feed back.
      const x = buffer(rate, 1.3);
      const rand = noise(23);
      powerChord(x, rate, 0, 82.41, 2.5, 1, rand);
      feedback(x, rate, 0.45, 659.26, 0.05);
      return normalize(room(amp(x, rate, 8), rate, 0.25), 0.6);
    }
    case 'fanfare': {
      // A garage riff: two chugs, then G5 and A5 left ringing.
      const x = buffer(rate, 1.6);
      const rand = noise(29);
      powerChord(x, rate, 0, 82.41, 0.08, 1, rand);
      powerChord(x, rate, 0.14, 82.41, 0.08, 1, rand);
      powerChord(x, rate, 0.28, 98.0, 0.3, 1, rand);
      powerChord(x, rate, 0.42, 110.0, 2, 1, rand);
      return normalize(room(amp(x, rate, 8), rate, 0.25), 0.45);
    }
    case 'crowd': {
      // A small club before the band: a few talkers, a low rumble, the amps humming on stage,
      // a bottle now and then, a shout, a whistle; the room's walls close by.
      const x = buffer(rate, 8.6);
      const rand = noise(31);
      babble(x, rate, 10, 1, rand);
      const lp = lowpass(rate, 180);
      for (let i = 0; i < x.length; i++) {
        const t = i / rate;
        x[i] += 0.6 * lp(rand()) + 0.03 * (Math.sin(TAU * 50 * t) + 0.5 * Math.sin(TAU * 150 * t) + 0.25 * Math.sin(TAU * 250 * t));
      }
      for (const at of [1.3, 6.2]) woo(x, rate, 1, at, 0.7, 0.35, rand);
      for (const at of [0.7, 2.9, 5.1, 7.4]) bell(x, rate, at, 3600 + 900 * Math.abs(rand()), 0.06, 0.05);
      whistle(x, rate, 4.1, 0.5, 2900, 0.12, rand);
      return normalize(loopable(room(x, rate, 0.35), rate, 0.6), 0.55);
    }
    case 'cheer': {
      const x = buffer(rate, 3.6);
      const rand = noise(41);
      babble(x, rate, 16, 0.8, rand);
      woo(x, rate, 14, 0.05, 2.6, 1, rand);
      const claps = applause(rate, 3.6, 24, 43);
      for (let i = 0; i < x.length; i++) {
        const t = i / rate;
        x[i] = x[i] * Math.min(1, t / 0.25) * Math.min(1, (3.6 - t) / 1.2) + 0.8 * claps[i];
      }
      for (const [at, f] of [[0.3, 2800], [0.9, 3300], [1.6, 3000]]) whistle(x, rate, at, 0.6, f, 0.25, rand);
      return normalize(room(x, rate, 0.35), 0.7);
    }
    case 'applause':
      return normalize(room(applause(rate, 5, 36, 53), rate, 0.35), 0.6);
    case 'clapping': {
      // Clapping in time, two claps a second, as a crowd calls for one more song.
      // Made half a second longer, the end blended into the start: four seconds that loop.
      const x = buffer(rate, 4.5);
      const rand = noise(61);
      babble(x, rate, 10, 0.25, rand);
      for (let p = 0; p < 30; p++) {
        const hand = 900 + 1600 * Math.abs(rand());
        const loud = 0.5 + 0.5 * Math.abs(rand());
        for (let beat = 0; beat < 9; beat++) clap(x, rate, beat / 2 + 0.012 * (rand() + 1), hand, loud, rand);
      }
      return normalize(loopable(room(x, rate, 0.25), rate, 0.5), 0.6);
    }
  }
}

/** Rate each sound is made at: the crowd needs less. */
export function rateOf(name: SoundName): number {
  return ['crowd', 'cheer', 'applause', 'clapping'].includes(name) ? 24_000 : 48_000;
}
