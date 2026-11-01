import { describe, expect, it } from 'vitest';
import { leadIn, type Chart } from '../src/chart';
import { countIn, SoundBoard, type SoundOut } from '../src/sfx';
import type { SoundName } from '../src/sounds';

const chart = (bpm: number, first: number) => ({ tempo: { bpm, timeSignature: [4, 4] }, beats: [{ time: first, bar: 1 }] }) as unknown as Chart;

/** What the board asked the engine, and a clock it moves by hand. */
function board() {
  const played: { name: SoundName; gain: number; at?: number }[] = [];
  const beds: { name: SoundName | null; gain: number }[] = [];
  const out: SoundOut = { sound: (name, gain, at) => played.push({ name, gain, at }), bed: (name, gain) => beds.push({ name, gain }) };
  const clock = { t: 0 };
  return { b: new SoundBoard(out, () => clock.t), played, beds, clock };
}

describe('lead-in', () => {
  const song = (notes: number[], chords: number[] = []) => ({ notes: notes.map((time) => ({ time })), chords: chords.map((time) => ({ time })) }) as unknown as Chart;

  it('starts on the music when the guitar comes in later than the highway shows', () => {
    expect(leadIn(song([12, 14]), 3, 3)).toBe(0);
    expect(leadIn(song([4.5]), 3, 3)).toBe(0);
  });

  it('waits only what the first note needs to come from the far end, chords counted', () => {
    expect(leadIn(song([3]), 3, 3)).toBe(1);
    expect(leadIn(song([20], [2.5]), 3, 3)).toBe(1.5);
    expect(leadIn(song([0.2]), 3, 3)).toBe(3);
    expect(leadIn(song([]), 3, 3)).toBe(0);
  });
});

describe('sound board', () => {
  it('counts in on the song’s own beat, into its first one', () => {
    expect(countIn(chart(120, 0), -3)).toEqual([-2, -1.5, -1, -0.5]);
    // Slow: the lead-in holds fewer beats.
    expect(countIn(chart(60, 0), -3)).toEqual([-2, -1]);
    // The song's first beat a little after its start: the count leads into it.
    expect(countIn(chart(120, 0.3), -3)).toEqual([-1.7, -1.2, -0.7, -0.2]);
    const { b, played } = board();
    b.countIn(chart(120, 0), -3);
    expect(played.map((p) => [p.name, p.at])).toEqual([
      ['countAccent', -2],
      ['count', -1.5],
      ['count', -1],
      ['count', -0.5],
    ]);
  });

  it('ticks once when the mouse sweeps over a menu, and follows the volume sliders', () => {
    const { b, played, clock } = board();
    b.setVolumes(0.5, 1);
    b.ui('hover');
    clock.t = 0.01;
    b.ui('hover');
    clock.t = 0.2;
    b.ui('hover');
    b.ui('click');
    expect(played.map((p) => p.name)).toEqual(['hover', 'hover', 'click']);
    expect(played[0].gain).toBeCloseTo(0.25);
    b.setVolumes(0, 1);
    b.ui('click');
    b.cue('grade');
    expect(played).toHaveLength(3);
    // The master scales everything.
    b.setVolumes(1, 1, 0.5);
    b.applause(1);
    expect(played[3]).toMatchObject({ name: 'applause', gain: 0.25 });
  });

  it('lets the room follow the crowd without flooding the engine', () => {
    const { b, beds } = board();
    b.setVolumes(1, 1);
    b.room(0.5);
    for (let k = 0; k < 60; k++) b.room(0.5 + k * 0.0002);
    expect(beds).toHaveLength(1);
    b.room(0.6);
    expect(beds).toHaveLength(2);
    expect(beds[1].gain).toBeCloseTo(0.15 + 0.85 * 0.6);
    // Clapping for an encore replaces the murmur, a quieter crowd slider lowers it at once.
    b.room(0.6, 'clapping');
    b.setVolumes(1, 0.5);
    expect(beds.slice(2).map((x) => x.name)).toEqual(['clapping', 'clapping']);
    expect(beds[3].gain).toBeCloseTo(0.25 * (0.15 + 0.85 * 0.6));
    b.room(null);
    b.room(null);
    expect(beds.slice(4)).toEqual([{ name: null, gain: 0 }]);
  });
});
