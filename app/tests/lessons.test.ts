import { afterEach, describe, expect, it, vi } from 'vitest';
import { pitch } from '../src/chart';
import { CHORDS, lessonChart, lessons, loadLessons, nextLesson, passed, recordLesson, STANDARD } from '../src/lessons';

/** A localStorage for the node test environment. */
function storage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  });
  return data;
}

afterEach(() => vi.unstubAllGlobals());

describe('lessons', () => {
  it('make charts the engine plays: a bar of clicks, then the notes, in order, inside the song', () => {
    const all = lessons();
    expect(new Set(all.map((l) => l.id)).size).toBe(all.length);
    const taught = all.filter((l) => !l.record);
    expect(taught.length).toBe(10);
    taught.forEach((lesson, i) => {
      const c = lessonChart(lesson, i);
      expect(c.format).toBe('opensmith-chart');
      expect(c.meta.title).toBe(`Leçon ${i + 1} · ${lesson.title}`);
      expect(c.arrangement.tuning.strings).toEqual(STANDARD);
      const spb = 60 / lesson.bpm;
      const times = [...c.notes.map((n) => n.time), ...c.chords.map((ch) => ch.time)].sort((a, b) => a - b);
      expect(times.length).toBe(lesson.steps.length);
      // The metronome counts one bar in before the first note.
      expect(times[0]).toBeCloseTo(4 * spb);
      expect(c.notes.map((n) => n.time)).toEqual([...c.notes.map((n) => n.time)].sort((a, b) => a - b));
      expect(times[times.length - 1]).toBeLessThan(c.meta.duration);
      // Under a minute and a half each, a few seconds of clicks after the last note.
      expect(c.meta.duration).toBeLessThan(90);
      expect(c.beats[0]).toEqual({ time: 0, bar: 1 });
      expect(c.beats.filter((b) => b.bar).length).toBe(Math.ceil(c.beats.length / 4));
      expect(c.beats[c.beats.length - 1].time).toBeGreaterThanOrEqual(c.meta.duration - 1e-9);
      // Every note in the first five frets of a standard guitar, every chord a known shape.
      for (const n of c.notes) {
        expect(n.fret).toBeGreaterThanOrEqual(0);
        expect(n.fret).toBeLessThanOrEqual(5);
        expect(pitch(c, n.string, n.fret)).toBeGreaterThanOrEqual(40);
      }
      for (const ch of c.chords) expect(CHORDS[c.chordTemplates[ch.template].name].frets).toEqual(c.chordTemplates[ch.template].frets);
      expect(c.handShapes.length).toBe(c.chords.length);
      expect(c.phrases).toHaveLength(1);
      expect(c.arrangement.maxDifficulty).toBe(0);
    });
  });

  it('keep the hand where the next fretted notes are', () => {
    lessons().forEach((lesson, i) => {
      const c = lessonChart(lesson, i);
      const pressed = [
        ...c.notes.filter((n) => n.fret > 0).map((n) => ({ time: n.time, frets: [n.fret] })),
        ...c.chords.map((ch) => ({ time: ch.time, frets: c.chordTemplates[ch.template].frets.filter((f) => f > 0) })),
      ];
      for (const p of pressed) {
        const anchor = [...c.anchors].reverse().find((a) => a.time <= p.time)!;
        for (const f of p.frets) {
          expect(f).toBeGreaterThanOrEqual(anchor.fret);
          expect(f).toBeLessThan(anchor.fret + anchor.width);
        }
      }
    });
  });

  it('play the melody as written: Au clair de la lune on the G and B strings', () => {
    const all = lessons();
    const i = all.findIndex((l) => l.id === 'melody');
    const c = lessonChart(all[i], i);
    const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    expect(c.notes.slice(0, 11).map((n) => names[pitch(c, n.string, n.fret) % 12]).join(' ')).toBe('G G G A B A G B A A G');
    // Long notes show their trail.
    expect(c.notes[4].sustain).toBeGreaterThan(0);
    expect(c.notes[0].sustain).toBe(0);
  });

  it('keep each lesson’s best and lead to the first one not passed', () => {
    const data = storage();
    const all = lessons();
    expect(nextLesson(all, {})).toBe(0);
    let records = recordLesson({}, all[0].id, 0.5);
    expect(passed(all[0], records)).toBe(false);
    expect(nextLesson(all, records)).toBe(0);
    records = recordLesson(records, all[0].id, 0.9);
    records = recordLesson(records, all[0].id, 0.6);
    expect(records[all[0].id]).toBe(0.9);
    expect(nextLesson(all, records)).toBe(1);
    expect(JSON.parse(data.get('opensmith.lessons')!)).toEqual({ [all[0].id]: 0.9 });
    expect(loadLessons()).toEqual(records);
    const everything = Object.fromEntries(all.map((l) => [l.id, 1]));
    // All passed: the last lesson, not a recording session after it.
    expect(all[nextLesson(all, everything)].id).toBe('first-riff');
  });

  it('ignore a damaged record, and work without storage', () => {
    storage({ 'opensmith.lessons': JSON.stringify({ 'open-strings': 0.8, 'in-time': 'oui', spider: 7 }) });
    expect(loadLessons()).toEqual({ 'open-strings': 0.8 });
    storage({ 'opensmith.lessons': '{nope' });
    expect(loadLessons()).toEqual({});
    vi.unstubAllGlobals();
    expect(recordLesson({}, 'open-strings', 0.7)).toEqual({ 'open-strings': 0.7 });
  });
});

describe('recording sessions', () => {
  it('ask for every string at every fret up to the 12th, then nine chords four times, after the lessons', () => {
    const all = lessons();
    const at = (id: string) => all.findIndex((l) => l.id === id);
    expect(at('record-notes')).toBeGreaterThan(at('first-riff'));
    const notes = lessonChart(all[at('record-notes')], at('record-notes'));
    expect(notes.meta.title).toBe('Ta guitare, note par note');
    const asked = new Set(notes.notes.map((n) => `${n.string}:${n.fret}`));
    expect(asked.size).toBe(6 * 13);
    // Two seconds apart: each note rings on its own.
    const times = notes.notes.map((n) => n.time);
    expect(Math.min(...times.slice(1).map((t, k) => t - times[k]))).toBeCloseTo(2);
    expect(notes.meta.duration).toBeLessThan(180);
    const chords = lessonChart(all[at('record-chords')], at('record-chords'));
    expect(chords.chords).toHaveLength(36);
    expect(chords.chordTemplates.map((c) => c.name)).toEqual(['E', 'Em', 'A', 'Am', 'C', 'D', 'G', 'E5', 'A5']);
    // A session is never passed, nor counted among the lessons.
    expect(passed(all[at('record-chords')], { 'record-chords': 1 })).toBe(false);
  });
});

describe('lesson pace', () => {
  it('stretches every step and the metronome, the notes staying on their beats', async () => {
    const { lessonChart, lessons, paceFactor } = await import('../src/lessons');
    const lesson = lessons().find((l) => l.id === 'record-notes')!;
    const normal = lessonChart(lesson, 0);
    const slow = lessonChart(lesson, 0, paceFactor('slow'));
    expect(slow.tempo.bpm).toBe(30);
    expect(slow.meta.duration).toBeCloseTo(2 * normal.meta.duration, 6);
    expect(slow.notes[1].time - slow.notes[0].time).toBeCloseTo(4, 6);
    expect(normal.notes[1].time - normal.notes[0].time).toBeCloseTo(2, 6);
    expect(slow.beats[8].time).toBeCloseTo(2 * normal.beats[8].time, 6);
  });
});
