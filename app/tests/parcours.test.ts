import { describe, expect, it } from 'vitest';
import { backingFor, rootOf } from '../src/backing';
import type { Chart } from '../src/chart';
import type { ViewItem } from '../src/game/view';
import { LEAD, type Lesson } from '../src/lessons';
import { symbolsIn } from '../src/lexicon';
import { chapters, dueNotions, findNotion, focusScore, learned, nextNotion, open, reviewed, stars, testId, testOpen } from '../src/parcours';

describe('the learning path', () => {
  const all = chapters();

  it('teaches each notion in three exercises that ask a little more', () => {
    expect(all.map((c) => c.id)).toEqual(['basics', 'power', 'open', 'rhythm', 'left-hand']);
    expect(all.flatMap((c) => c.notions).length).toBe(27);
    for (const n of all.flatMap((c) => c.notions)) {
      const [step, time, band] = n.exercises;
      expect([step.kind, time.kind, band.kind]).toEqual(['step', 'time', 'band']);
      expect(step.wait && step.backing === null).toBe(true);
      expect(time.pace).toBeLessThan(1);
      expect(time.backing && band.backing).toBeTruthy();
      expect(band.pace).toBe(1);
      expect(band.lesson.steps.length).toBe(2 * step.lesson.steps.length);
    }
  });

  it('counts the lessons passed before the path as the first exercise', () => {
    expect(findNotion(all, 'power-moves')!.notion.exercises[0].id).toBe('first-riff');
    expect(findNotion(all, 'palm-mute')!.notion.exercises[0].id).toBe('p.palm-mute.1');
  });

  it('opens a notion once the one before is learned, a chapter once the one before is', () => {
    const first = all[0].notions[0];
    expect(open(all, 0, 0, {})).toBe(true);
    expect(open(all, 0, 1, {})).toBe(false);
    // One star: not learned yet. Two (step by step, then in time): the next notion opens.
    const one = { [first.exercises[0].id]: 0.9 };
    expect([stars(first, one), learned(first, one), open(all, 0, 1, one)]).toEqual([1, false, false]);
    const two = { ...one, [first.exercises[1].id]: 0.8 };
    expect([stars(first, two), learned(first, two), open(all, 0, 1, two)]).toEqual([2, true, true]);
    expect(nextNotion(all, two)).toEqual([0, 1]);
    // Chapter 2 waits for every notion of chapter 1.
    expect(open(all, 1, 0, two)).toBe(false);
    const basics = Object.fromEntries(all[0].notions.flatMap((n) => n.exercises.slice(0, 2).map((e) => [e.id, 1])));
    expect(open(all, 1, 0, basics)).toBe(true);
    expect(nextNotion(all, basics)).toEqual([1, 0]);
  });

  it('lets a player who knows a chapter pass its test and skip it', () => {
    const basics = all[0];
    // The test plays the chapter's notions one after the other, at tempo with the band.
    expect(basics.test.lesson.steps.length).toBe(basics.notions.reduce((sum, n) => sum + n.exercises[0].lesson.steps.length, 0));
    expect([basics.test.wait, basics.test.pace, basics.test.backing !== null]).toEqual([false, 1, true]);
    expect([testOpen(all, 0, {}), testOpen(all, 1, {})]).toEqual([true, false]);
    const tested = { [testId('basics')]: 0.85 };
    expect(basics.notions.every((n) => learned(n, tested))).toBe(true);
    expect([open(all, 1, 0, tested), testOpen(all, 1, tested)]).toEqual([true, true]);
    expect(learned(all[1].notions[0], tested)).toBe(false);
    expect(learned(basics.notions[0], { [testId('basics')]: 0.7 })).toBe(false);
  });

  it('brings a learned notion back to review, further away each time', () => {
    const first = all[0].notions[0];
    const records = { [first.exercises[0].id]: 1, [first.exercises[1].id]: 1 };
    // Learned on 1 March: due a week later, not before.
    let reviews = reviewed({}, first.id, '2026-03-01', true);
    expect(dueNotions(all, records, reviews, '2026-03-07')).toEqual([]);
    expect(dueNotions(all, records, reviews, '2026-03-08').map((n) => n.id)).toEqual([first.id]);
    // Reviewed then: next one two weeks later.
    reviews = reviewed(reviews, first.id, '2026-03-08', true);
    expect(reviews[first.id]).toEqual({ last: '2026-03-08', step: 1 });
    expect(dueNotions(all, records, reviews, '2026-03-21')).toEqual([]);
    expect(dueNotions(all, records, reviews, '2026-03-22').length).toBe(1);
    // Played again before it is due: the date moves, not the step.
    expect(reviewed(reviews, first.id, '2026-03-10', true)[first.id]).toEqual({ last: '2026-03-10', step: 1 });
    // A notion not learned yet has no reviews.
    expect(reviewed({}, first.id, '2026-03-01', false)).toEqual({});
  });

  it('judges a notion on its own notes', () => {
    const chart = {
      notes: [
        { time: 1, string: 0, fret: 0, sustain: 0, levels: [0, 0], techniques: { palmMute: true } },
        { time: 2, string: 0, fret: 0, sustain: 0, levels: [0, 0] },
        { time: 3, string: 0, fret: 0, sustain: 0, levels: [0, 0], techniques: { palmMute: true } },
      ],
      chords: [],
    } as unknown as Pick<Chart, 'notes' | 'chords'>;
    const item = (event: number, status: ViewItem['status']) => ({ index: event, event, time: event + 1, sustain: 0, target: { kind: 'note', string: 0, fret: 0, midi: 40 }, iteration: 0, level: 0, status, error: 0, perfect: false }) as ViewItem;
    const items = [item(0, 'hit'), item(1, 'missed'), item(2, 'missed')];
    expect(focusScore(items, chart, 'palmMute')).toEqual({ hits: 1, judged: 2 });
    expect(focusScore(items, chart, 'all')).toEqual({ hits: 1, judged: 3 });
    expect(focusScore([...items, item(1, 'pending')], chart, 'all').judged).toBe(3);
    // A technique of the left hand: its notes only (a slide by its target fret).
    const legato = {
      notes: [
        { time: 1, string: 3, fret: 0, sustain: 0, levels: [0, 0] },
        { time: 2, string: 3, fret: 2, sustain: 0, levels: [0, 0], techniques: { hammerOn: true } },
        { time: 3, string: 3, fret: 2, sustain: 1, levels: [0, 0], techniques: { slideTo: 4 } },
      ],
      chords: [],
    } as unknown as Pick<Chart, 'notes' | 'chords'>;
    expect(focusScore(items, legato, 'hammerOn')).toEqual({ hits: 0, judged: 1 });
    expect(focusScore(items, legato, 'slide')).toEqual({ hits: 0, judged: 1 });
  });

  it('judges each notion of chapters 3 to 5 on notes the exercises have', () => {
    for (const n of all.slice(2).flatMap((c) => c.notions)) {
      const chart = { notes: n.exercises[0].lesson.steps.filter((s) => !('chord' in s)), chords: n.exercises[0].lesson.steps.filter((s) => 'chord' in s) };
      const has = n.focus === 'all' || (n.focus === 'chords' ? chart.chords.length > 0 : chart.notes.some((x) => 'techniques' in x && x.techniques && (n.focus === 'slide' ? x.techniques.slideTo !== undefined : x.techniques[n.focus as 'bend'])));
      expect(has, n.id).toBe(true);
    }
  });
});

describe('the backing band', () => {
  const lesson = (steps: Lesson['steps']): Lesson => ({ id: 'x', title: 'x', learn: '', how: [], goal: 0.8, bpm: 60, steps });

  it('plays from the first step, in time with the chart', () => {
    const b = backingFor(lesson([{ beat: 0, chord: 'E5', hold: 4 }]), 1, 'rock');
    expect(b.drums[0][0]).toBeCloseTo(LEAD);
    // A bar of rock: hats on the eighths, kick on 1, 3 and the "and" of 3, snare on 2 and 4.
    expect(b.drums.filter(([, d]) => d === 'hat')).toHaveLength(8);
    expect(b.drums.filter(([, d]) => d === 'kick').map(([t]) => t - LEAD)).toEqual([0, 2, 2.5]);
    expect(b.drums.filter(([, d]) => d === 'snare').map(([t]) => t - LEAD)).toEqual([1, 3]);
    // Half the tempo: twice the seconds (the first snare, on beat 2 after the count-in).
    const slow = backingFor(lesson([{ beat: 0, chord: 'E5', hold: 4 }]), 0.5, 'rock');
    expect(slow.drums.find(([, d]) => d === 'snare')![0]).toBeCloseTo(2 * (LEAD + 1));
  });

  it('swings the shuffle and lays the ballad in half time', () => {
    const one = lesson([{ beat: 0, string: 0, fret: 0, hold: 4 }]);
    const shuffle = backingFor(one, 1, 'shuffle');
    // The off-beat hat two thirds of the way through the beat, the bass on root and fifth.
    expect(shuffle.drums.filter(([, d]) => d === 'hat').map(([t]) => +(t - LEAD).toFixed(3))).toEqual([0, 0.667, 1, 1.667, 2, 2.667, 3, 3.667]);
    expect([...new Set(shuffle.bass.map(([, m]) => m))]).toEqual([28, 35]);
    const ballad = backingFor(one, 1, 'ballad');
    expect(ballad.drums.filter(([, d]) => d === 'snare').map(([t]) => t - LEAD)).toEqual([2]);
    expect(ballad.drums.filter(([, d]) => d === 'hat')).toHaveLength(4);
  });

  it('follows the chords strummed, else the roots given', () => {
    const b = backingFor(lesson([{ beat: 0, chord: 'E5', hold: 4 }, { beat: 4, chord: 'G5', hold: 4 }]), 1, 'pulse');
    expect([...new Set(b.bass.map(([, m]) => m))]).toEqual([28, 31]);
    const melody = backingFor(lesson([{ beat: 0, string: 3, fret: 0, hold: 8 }]), 1, 'pulse', ['G', 'D']);
    expect(melody.bass.map(([, m]) => m)).toEqual([31, 31, 38, 38]);
    expect([rootOf('F#m'), rootOf('Bb5'), rootOf('?')]).toEqual([6, 10, 4]);
  });
});

describe('the lexicon', () => {
  it('finds the symbols a chart shows', () => {
    const chart = {
      notes: [
        { time: 1, string: 0, fret: 0, sustain: 0, levels: [0, 0], techniques: { palmMute: true } },
        { time: 2, string: 1, fret: 2, sustain: 1, levels: [0, 0], techniques: { mute: true } },
      ],
      chords: [{ time: 3, template: 0, sustain: 0, levels: [0, 0] }],
    } as unknown as Pick<Chart, 'notes' | 'chords'>;
    expect(symbolsIn(chart)).toEqual(['open', 'fret', 'sustain', 'chord', 'palmMute', 'mute']);
  });
});
