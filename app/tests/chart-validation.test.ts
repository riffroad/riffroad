import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseChart, type Chart } from '../src/chart';
const fixture = JSON.parse(readFileSync(new URL('../../engine-rt/game/tests/fixtures/demo_rock.json', import.meta.url), 'utf8')) as Chart;

describe('chart validation before rendering', () => {
  it.each([0, 3, 7, 8])('refuses %i strings with a useful error', (n) => {
    const c = structuredClone(fixture); c.arrangement.tuning.strings = Array(n).fill(40);
    expect(() => parseChart(c)).toThrow(/4 à 6 cordes/);
  });
  it.each([
    (c: Chart) => { c.chordTemplates[0].frets.push(0); },
    (c: Chart) => { c.handShapes = [{ template: 999, start: 1, end: 2 }]; },
    (c: Chart) => { c.notes[0].string = 6; },
    (c: Chart) => { c.notes[0].sustain = -1; },
    (c: Chart) => { c.notes[0].levels = [4, 0]; },
    (c: Chart) => { c.notes.reverse(); },
    (c: Chart) => { c.phrases[1].start = 0; },
    (c: Chart) => { c.tempo.bpm = 0; },
    (c: Chart) => { c.meta.duration = Infinity; },
  ])('refuses malformed content without reaching WebGL', (edit) => {
    const c = structuredClone(fixture); edit(c); expect(() => parseChart(c)).toThrow(/Partition invalide/);
  });
  it('accepts all shipped charts and preserves note indices', () => {
    const root = new URL('../demo/', import.meta.url);
    for (const folder of readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory())) {
      const dir = new URL(`${folder.name}/`, root);
      for (const file of readdirSync(dir).filter((n) => n.startsWith('song_chart') && n.endsWith('.json'))) {
        const raw = JSON.parse(readFileSync(new URL(file, dir), 'utf8'));
        expect(parseChart(raw).notes).toBe(raw.notes);
      }
    }
  });
});
