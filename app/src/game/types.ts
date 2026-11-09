/** Game messages, as sent by the Rust session (engine-rt/session) or the local demo game. */

export type Target =
  | { kind: 'note'; string: number; fret: number; midi: number }
  | { kind: 'chord'; template: number; midis: number[] };

/** A note or chord the player must play, at the level chosen for its phrase iteration. */
export interface Expected {
  /** Position in the game's list, used by judgements. */
  index: number;
  /** Index in chart.notes or chart.chords (by target kind). */
  event: number;
  time: number;
  sustain: number;
  target: Target;
  iteration: number;
  level: number;
}

export type Status = 'pending' | 'hit' | 'missed';

/** Why a note was missed (engine-rt/game MissReason). */
export type MissReason =
  | { kind: 'unplayed' }
  /** The right note (a strum, for a chord) `error` seconds from its time, negative when early. */
  | { kind: 'timing'; error: number }
  /** Another note, `semitones` away: positive when too high. */
  | { kind: 'pitch'; semitones: number }
  /** Strummed in time, not heard as the chord. */
  | { kind: 'wrongChord' }
  | { kind: 'technique' };

export interface Score {
  hits: number;
  perfects: number;
  misses: number;
  extras: number;
  streak: number;
  bestStreak: number;
  points: number;
}

export type GameEvent =
  /** Start over (seek, restart): forget every expected note. */
  | { type: 'reset' }
  /** A phrase iteration became visible at `level`. */
  | { type: 'expected'; iteration: number; level: number; items: Expected[] }
  | { type: 'hit'; index: number; time: number; error: number; perfect: boolean }
  | { type: 'miss'; index: number; time: number; reason: MissReason }
  /** A missed note played after all, `error` seconds late. */
  | { type: 'late'; index: number; error: number }
  | { type: 'phrase'; iteration: number; name: string; accuracy: number; level: number; nextLevel: number }
  | { type: 'score'; score: Score }
  /** Loop Trainer: a pass over the loop is over, with its own score. */
  | { type: 'pass'; score: Score }
  /** What the guitar plays (live mode). */
  | { type: 'heard'; time: number; midi: number; cents: number }
  | { type: 'end' }
  /** Tuner mode: pitch of the ringing string (fractional MIDI note). */
  | { type: 'pitch'; midi: number; clarity: number }
  /** Out of a song (menus, free play): a note the guitar played, an attack without one pitch. */
  | { type: 'played'; midi: number; cents: number }
  | { type: 'strum' }
  /** Wait mode: the song stopped on expected note `index` until the guitar plays it. */
  | { type: 'waiting'; index: number }
  /** Latency calibration: clicks at first + k * period, the first countIn announce the beat. */
  | { type: 'calibrationStart'; first: number; period: number; countIn: number; clicks: number }
  | { type: 'calibrationHit'; index: number; error: number }
  /** Median strum delay to compensate (s) and its spread, from `hits` strums of `total`. */
  | { type: 'calibrated'; offset: number; spread: number; hits: number; total: number }
  /** A take of what the guitar played was saved. */
  | { type: 'takeSaved'; path: string; seconds: number };

export const emptyScore = (): Score => ({ hits: 0, perfects: 0, misses: 0, extras: 0, streak: 0, bestStreak: 0, points: 0 });

/** ×1 to ×4, one step per 10 notes in a row (engine-rt/game Score::multiplier). */
export const multiplier = (streak: number): number => Math.min(4, 1 + Math.floor(streak / 10));

export const accuracy = (s: Score): number => (s.hits + s.misses === 0 ? 0 : s.hits / (s.hits + s.misses));
