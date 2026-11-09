import { describe, expect, it } from 'vitest';
import { MIN_NOTES, missCounts, steadyOffset } from '../src/game/timing';

/** `n` errors around `center` (s), spread evenly over ±`width`. */
const around = (center: number, width: number, n = 30) => Array.from({ length: n }, (_, k) => center + width * (2 * (k / (n - 1)) - 1));

describe('latency told from the timing of a song', () => {
  it('a steady lag is latency to compensate', () => {
    expect(steadyOffset(around(0.04, 0.03))).toEqual({ medianMs: 40, spreadMs: 15, count: 30 });
    expect(steadyOffset(around(-0.025, 0.02))?.medianMs).toBe(-25);
  });

  it('in time, too irregular or too few notes: nothing to say', () => {
    expect(steadyOffset(around(0.008, 0.03))).toBeNull();
    expect(steadyOffset(around(0.05, 0.12))).toBeNull();
    expect(steadyOffset(around(0.05, 0.01, MIN_NOTES - 1))).toBeNull();
  });
});

describe('missed notes by reason', () => {
  it('counts each reason', () => {
    const n = missCounts([
      { kind: 'timing', error: -0.2 },
      { kind: 'timing', error: 0.15 },
      { kind: 'timing', error: 0.3 },
      { kind: 'pitch', semitones: 2 },
      { kind: 'pitch', semitones: -12 },
      { kind: 'wrongChord' },
      { kind: 'technique' },
      { kind: 'unplayed' },
      undefined,
    ]);
    expect(n).toEqual({ early: 1, late: 2, high: 1, low: 1, chord: 1, technique: 1, unplayed: 2 });
  });
});
