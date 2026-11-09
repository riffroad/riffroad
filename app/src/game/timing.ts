import type { MissReason } from './types';

/** Notes judged before a steady lag can be told from the player's own timing. */
export const MIN_NOTES = 20;
/** A median error under this is in time (seconds). */
const IN_TIME = 0.015;
/** Half the spread of the middle half of the errors over this: too irregular to be latency. */
const STEADY = 0.035;

/** The player's attacks, over a song, all late (or early) by about the same amount. */
export interface SteadyOffset {
  /** Median error, ms: positive when late. */
  medianMs: number;
  /** Half the spread of the middle half of the errors, ms. */
  spreadMs: number;
  count: number;
}

/**
 * Timing errors (seconds, positive when late) from the hits and from the notes missed out of
 * time: when they all lean the same way by about as much, that is the latency left to
 * compensate, not the player.
 */
export function steadyOffset(errors: readonly number[]): SteadyOffset | null {
  if (errors.length < MIN_NOTES) return null;
  const sorted = [...errors].sort((a, b) => a - b);
  const at = (p: number) => {
    const x = p * (sorted.length - 1);
    const k = Math.floor(x);
    return sorted[k] + (sorted[Math.min(k + 1, sorted.length - 1)] - sorted[k]) * (x - k);
  };
  const median = at(0.5);
  const spread = (at(0.75) - at(0.25)) / 2;
  if (Math.abs(median) < IN_TIME || spread > STEADY) return null;
  return { medianMs: Math.round(median * 1000), spreadMs: Math.round(spread * 1000), count: errors.length };
}

/** Missed notes by reason. */
export interface MissCounts {
  early: number;
  late: number;
  high: number;
  low: number;
  chord: number;
  technique: number;
  unplayed: number;
}

export function missCounts(reasons: readonly (MissReason | undefined)[]): MissCounts {
  const n: MissCounts = { early: 0, late: 0, high: 0, low: 0, chord: 0, technique: 0, unplayed: 0 };
  for (const r of reasons) {
    if (r?.kind === 'timing') n[r.error < 0 ? 'early' : 'late']++;
    else if (r?.kind === 'pitch') n[r.semitones > 0 ? 'high' : 'low']++;
    else if (r?.kind === 'wrongChord') n.chord++;
    else if (r?.kind === 'technique') n.technique++;
    else n.unplayed++;
  }
  return n;
}
