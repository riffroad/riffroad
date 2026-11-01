/** Chart format shared with the Python pipeline and the Rust engine (schema/chart.schema.json). */
import { t } from './i18n';

export interface Techniques {
  hammerOn?: boolean;
  pullOff?: boolean;
  slideTo?: number;
  bend?: number;
  vibrato?: boolean;
  palmMute?: boolean;
  mute?: boolean;
  harmonic?: boolean;
  pinchHarmonic?: boolean;
  tremolo?: boolean;
  accent?: boolean;
  tap?: boolean;
  linkNext?: boolean;
}

export interface Span {
  name: string;
  start: number;
  end: number;
}

export interface Phrase extends Span {
  maxDifficulty: number;
}

export interface Beat {
  time: number;
  /** Bar number, on downbeats only. */
  bar?: number;
}

export interface ChordTemplate {
  name: string;
  /** Fret per string, low string first; -1 = not played. */
  frets: number[];
  fingers: number[];
}

export interface Note {
  time: number;
  string: number;
  fret: number;
  sustain: number;
  levels: [number, number];
  techniques?: Techniques;
}

export interface Chord {
  time: number;
  template: number;
  sustain: number;
  levels: [number, number];
  strum?: 'down' | 'up';
  techniques?: Techniques;
}

export interface Anchor {
  time: number;
  fret: number;
  width: number;
}

export interface HandShape {
  template: number;
  start: number;
  end: number;
}

export interface Chart {
  format: 'opensmith-chart';
  version: number;
  meta: {
    title: string;
    artist: string;
    album?: string | null;
    year?: number | null;
    duration: number;
    source: { kind: string; file: string };
    generator: string;
  };
  audio: { backing: string | null; guitar: string | null; mix: string | null; offset: number };
  arrangement: {
    name: string;
    type: 'lead' | 'rhythm' | 'bass';
    /** `cents`: the recording's pitch against A440; the guitar is tuned that much up. */
    tuning: { name: string; strings: number[]; cents?: number };
    capo: number;
    maxDifficulty: number;
  };
  tempo: { bpm: number; timeSignature: [number, number] };
  beats: Beat[];
  sections: Span[];
  phrases: Phrase[];
  chordTemplates: ChordTemplate[];
  notes: Note[];
  chords: Chord[];
  anchors: Anchor[];
  handShapes: HandShape[];
}

export const DEFAULT_ANCHOR: Anchor = { time: 0, fret: 1, width: 4 };

/**
 * Checks the header only. Event order is kept as is: the game engine refers to notes, chords
 * and phrases by index, so the renderer must see the same arrays.
 */
export function parseChart(json: unknown): Chart {
  const c = json as Chart;
  if (!c || c.format !== 'opensmith-chart') throw new Error(t('ce fichier n\'est pas un chart Riffroad'));
  if (c.version !== 1) throw new Error(t('version de chart non gérée : {version}', { version: c.version }));
  return c;
}

/**
 * Seconds of silence before a song's music (at most `most`): only what the first note needs to come
 * from the far end of the highway (`lookahead` s ahead) with a second to spare. A song whose
 * guitar comes in later starts on its music at once.
 */
export function leadIn(chart: Pick<Chart, 'notes' | 'chords'>, lookahead: number, most: number): number {
  let first = Infinity;
  for (const n of chart.notes) first = Math.min(first, n.time);
  for (const c of chart.chords) first = Math.min(first, c.time);
  return Math.min(most, Math.max(0, lookahead + 1 - first));
}

export function pitch(chart: Chart, string: number, fret: number): number {
  return chart.arrangement.tuning.strings[string] + fret;
}

/** Pitches of a chord template, low string first. */
export function chordPitches(chart: Chart, template: number): number[] {
  const frets = chart.chordTemplates[template]?.frets ?? [];
  return frets.flatMap((f, s) => (f >= 0 ? [pitch(chart, s, f)] : []));
}

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function noteName(midi: number): string {
  return NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
}

/** Index of the last item whose key is ≤ t, -1 if none (items sorted by key). */
export function lastAtOrBefore<T>(items: readonly T[], t: number, key: (x: T) => number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (key(items[mid]) <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/** Index of the first item whose key is ≥ t, items.length if none. */
export function firstAtOrAfter<T>(items: readonly T[], t: number, key: (x: T) => number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (key(items[mid]) < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function anchorAt(chart: Chart, t: number): Anchor {
  return chart.anchors[Math.max(0, lastAtOrBefore(chart.anchors, t, (a) => a.time))] ?? DEFAULT_ANCHOR;
}

/** Phrase iteration playing at `t`, -1 before the first one. */
/** Share of a song's notes played from the start at each step, beginner to complete. */
const START_SHARES = [0.3, 0.4, 0.6, 0.8, 1];

/** The level a song starts at for the player's choice `step` (0 beginner … 4 complete): the
 * first level playing the step's share of the song's notes (`levelNotes`: notes and chords at
 * each level), so a beginner gets about a third of them whatever the song's levels: 5 when made
 * from audio, up to 30 in a detailed hand-made chart, whose lowest levels play a note now and
 * then. Without the counts, the same share of the way up the levels. */
export function startLevelFor(step: number, maxDifficulty: number, levelNotes?: readonly number[]): number {
  const k = Math.min(4, Math.max(0, Math.round(step)));
  if (k === 4 || !levelNotes?.length) return Math.round((k / 4) * maxDifficulty);
  const full = Math.max(...levelNotes);
  const level = levelNotes.findIndex((n) => n >= START_SHARES[k] * full);
  return Math.min(maxDifficulty, level < 0 ? maxDifficulty : level);
}

/** Notes and chords played at each level 0..maxDifficulty. */
export function levelNotes(chart: Pick<Chart, 'notes' | 'chords' | 'arrangement'>): number[] {
  const out = new Array<number>(chart.arrangement.maxDifficulty + 1).fill(0);
  for (const e of [...chart.notes, ...chart.chords]) {
    for (let d = e.levels[0]; d <= Math.min(e.levels[1], out.length - 1); d++) out[d]++;
  }
  return out;
}

export function phraseIndexAt(chart: Chart, t: number): number {
  return lastAtOrBefore(chart.phrases, t, (p) => p.start);
}

export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
