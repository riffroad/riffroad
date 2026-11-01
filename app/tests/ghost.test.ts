import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseChart } from '../src/chart';
import { ghostAt, Trace } from '../src/ghost';
import { recordAttack } from '../src/progress';

const chart = parseChart(JSON.parse(readFileSync(new URL('../../engine-rt/game/tests/fixtures/demo_rock.json', import.meta.url), 'utf8')));

describe('the ghost', () => {
  it('writes the points of each second as the song goes', () => {
    const trace = new Trace();
    trace.note(-1.5, 0);
    trace.note(0.2, 0);
    trace.note(1.1, 300);
    trace.note(3.4, 900);
    expect(trace.samples).toEqual([0, 300, 900, 900]);
    trace.reset();
    expect(trace.samples).toEqual([]);
  });

  it('reads a trace between its seconds, and its last points past its end', () => {
    expect(ghostAt([0, 100, 300], 1.5)).toBe(200);
    expect(ghostAt([0, 100, 300], 9)).toBe(300);
    expect(ghostAt([0, 100, 300], -2)).toBe(0);
    expect(ghostAt([], 4)).toBe(0);
  });

  it('keeps the best run’s trace as the ghost of its level', () => {
    const run = { score: 5000, accuracy: 0.9, grade: 'A', streak: 20 };
    const first = recordAttack(undefined, chart, 'hard', run, new Map(), false, new Date(), [0, 2000, 5000]);
    expect(first.progress.ghosts).toEqual({ hard: [0, 2000, 5000] });
    const worse = recordAttack(first.progress, chart, 'hard', { ...run, score: 4000 }, new Map(), false, new Date(), [0, 1000, 4000]);
    expect(worse.progress.ghosts).toEqual({ hard: [0, 2000, 5000] });
  });
});
