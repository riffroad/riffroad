import { describe, expect, it } from 'vitest';
import { guitarFor, LAST_TUNING, mustTune, type HeldTuning } from '../src/tuner';

const E: HeldTuning = { name: 'E Standard', strings: [40, 45, 50, 55, 59, 64], cents: 0 };
const EB: HeldTuning = { name: 'Eb Standard', strings: [39, 44, 49, 54, 58, 63], cents: 0 };

describe('the guitar between songs', () => {
  it('moves songs to the tuning the guitar was last tuned to, or to the one chosen', () => {
    expect(guitarFor(LAST_TUNING, EB)).toEqual({ name: 'Eb Standard', strings: EB.strings });
    expect(guitarFor(LAST_TUNING, null)).toBeNull();
    expect(guitarFor('Drop D', EB)?.strings).toEqual([38, 45, 50, 55, 59, 64]);
    expect(guitarFor('', EB)).toBeNull();
  });

  it('asks to tune only when the guitar is not known to be in the song’s tuning', () => {
    expect(mustTune(E, E)).toBe(false);
    expect(mustTune({ ...E, cents: 2 }, E)).toBe(false);
    expect(mustTune({ ...E, cents: -20 }, E)).toBe(true);
    expect(mustTune(EB, E)).toBe(true);
    expect(mustTune(E, null)).toBe(true);
  });
});

describe('the strings out of a song', () => {
  it('ring with the guitar, never with the input’s own noise', async () => {
    const { followNoise, ringOver } = await import('../src/highway/highway');
    // A cable hissing at -48 dBFS, steady: the floor settles on it and the strings stay still.
    let floor = -54;
    for (let k = 0; k < 600; k++) floor = followNoise(floor, -48 + (k % 3), 1 / 60);
    expect(floor).toBeGreaterThan(-49);
    expect(ringOver(-47, floor)).toBe(0);
    // A note 30 dB over it rings them; held for two seconds, the floor rose 6 dB at most and the
    // string still rings, a little less, as a real one dies away.
    expect(ringOver(-18, floor)).toBeGreaterThan(0.6);
    let held = floor;
    for (let k = 0; k < 120; k++) held = followNoise(held, -18, 1 / 60);
    expect(held - floor).toBeLessThanOrEqual(6.01);
    expect(ringOver(-18, held)).toBeGreaterThan(0.4);
  });
});

describe('the strings at rest', () => {
  it('stay under the bloom’s threshold, the yellow one too, and keep their colour', async () => {
    const THREE = await import('three');
    const { restOf, STRING_HEX } = await import('../src/highway/highway');
    for (const hex of STRING_HEX) {
      const c = new THREE.Color(hex);
      const k = restOf(c);
      expect(k * (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b), hex).toBeLessThan(0.62);
      expect(k, hex).toBeGreaterThan(0.7);
    }
    expect(restOf(new THREE.Color(STRING_HEX[1]))).toBeLessThan(1);
    expect(restOf(new THREE.Color(STRING_HEX[2]))).toBe(1);
  });
});
