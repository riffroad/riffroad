import { describe, expect, it } from 'vitest';
import { concludeGig, newCareer, VENUES, weekIndex, type Career, type GigSong } from '../src/career/career';
import { density, FADE, formFactor, formOf, learn, moved, NEW_FORM, rating, rehearse, sanitizeRepertoire, scout, starter, type Scouted } from '../src/career/repertoire';

// Ten songs of 4 minutes, from 30 to 300 notes a minute.
const library: Scouted[] = Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, notes: (i + 1) * 120, chords: 0, duration: 240 }));

describe('repertoire', () => {
  it('moves what it knew of an MP3 by its draft notes to its chords part', () => {
    const moves = new Map([['song/song_chart.json', 'song/song_chart.chords.json']]);
    const learned = { form: 0.8, played: 3, since: 1 };
    expect(moved({ 'song/song_chart.json': learned, other: learned }, moves)).toEqual({ 'song/song_chart.chords.json': learned, other: learned });
    // Already there under its chords: that one is kept, the draft's dropped.
    const fresh = { form: 1, played: 4, since: 4 };
    expect(moved({ 'song/song_chart.json': learned, 'song/song_chart.chords.json': fresh }, moves)).toEqual({ 'song/song_chart.chords.json': fresh });
    // Nothing to move: said so, nothing copied.
    expect(moved({ other: learned }, moves)).toBeNull();
  });

  it('rates a song out of 99 from its mastery and form', () => {
    expect(rating(0, 0)).toBe(40);
    expect(rating(0, NEW_FORM)).toBe(47);
    expect(rating(1, 1)).toBe(99);
    expect(rating(0.5, 1)).toBe(81);
  });

  it('keeps a song in form two weeks unplayed, then lets it fade', () => {
    const r = learn({}, 's1', 10);
    expect(r.s1).toEqual({ form: NEW_FORM, played: 10, since: 10 });
    const fit = rehearse(rehearse(r, 's1', 10), 's1', 10);
    expect(formOf(fit.s1, 10)).toBeCloseTo(1);
    expect(formOf(fit.s1, 12)).toBeCloseTo(1);
    expect(formOf(fit.s1, 13)).toBeCloseTo(1 - FADE);
    expect(formOf(fit.s1, 30)).toBe(0);
    // A rehearsal starts from the faded form.
    expect(rehearse(fit, 's1', 15, 0.2).s1.form).toBeCloseTo(1 - 3 * FADE + 0.2);
    expect(rehearse(fit, 'unknown', 15)).toBe(fit);
    expect(learn(fit, 's1', 20)).toBe(fit);
  });

  it('turns a setlist’s form into a factor on fans and fee', () => {
    expect(formFactor([0, 0])).toBeCloseTo(0.85);
    expect(formFactor([0.6])).toBeCloseTo(1);
    expect(formFactor([1, 1])).toBeCloseTo(1.1);
    expect(formFactor([])).toBe(1);
  });

  it('starts with what the band played on stage, else the easiest songs long enough', () => {
    const short = { id: 'short', notes: 10, chords: 0, duration: 60 };
    expect(Object.keys(starter([...library, short], [], 1, 150))).toEqual(['s0', 's1', 's2']);
    expect(Object.keys(starter(library, ['s7', 's7', 'gone'], 1, 150))).toEqual(['s7', 's0', 's1']);
  });

  it('scouts songs not learned yet, near the act’s difficulty, changing with the week', () => {
    expect(density(library[0])).toBe(30);
    const known = starter(library, [], 1);
    const garage = scout(library, known, 1, 5);
    expect(garage).toHaveLength(3);
    expect(garage.every((s) => !(s.id in known))).toBe(true);
    expect(garage.every((s) => density(s) <= 240)).toBe(true);
    const clubs = scout(library, known, 3, 5);
    expect(clubs.every((s) => density(s) >= 150)).toBe(true);
    const weeks = new Set(Array.from({ length: 6 }, (_, w) => scout(library, known, 2, w).map((s) => s.id).join()));
    expect(weeks.size).toBeGreaterThan(1);
    expect(scout(library, Object.fromEntries(library.map((s) => [s.id, known.s0])), 1, 5)).toEqual([]);
  });

  it('pays a rehearsed setlist more and brings its songs back in form', () => {
    const c: Career = { ...newCareer(), act: 2, fans: 200, week: 6 };
    const now = weekIndex(c);
    const song = (id: string): GigSong => ({ id, title: id, grade: 'B', accuracy: 0.85, crowd: 0.8, notes: 480, seconds: 240 });
    const offer = { venue: VENUES.find((v) => v.id === 'zinc')!, audience: 100, songs: 2 };
    const fit: Career = { ...c, repertoire: { a: { form: 1, played: now, since: 1 }, b: { form: 1, played: now, since: 1 } } };
    const rusty: Career = { ...c, repertoire: { a: { form: 0, played: now, since: 1 }, b: { form: 0, played: now, since: 1 } } };
    const good = concludeGig(fit, offer, [song('a'), song('b')], 'played');
    const bad = concludeGig(rusty, offer, [song('a'), song('b')], 'played');
    expect(good.record.form).toBeCloseTo(1.1);
    expect(bad.record.form).toBeCloseTo(0.85);
    expect(good.record.money).toBeGreaterThan(bad.record.money);
    expect(good.record.fans).toBeGreaterThan(bad.record.fans);
    expect(bad.career.repertoire.a.form).toBeCloseTo(0.25);
    expect(bad.career.repertoire.a.played).toBe(now);
  });

  it('reads a repertoire back from a save, dropping what makes no sense', () => {
    expect(sanitizeRepertoire({ a: { form: 3, played: 4.4 }, b: { form: 'x' }, c: null })).toEqual({ a: { form: 1, played: 4, since: 4 } });
    expect(sanitizeRepertoire('nope')).toEqual({});
  });
});

describe('the first songs', () => {
  it('share the library’s usual tuning: no retuning on stage at the first gig', () => {
    const songs = [
      { id: 'drop', notes: 50, chords: 0, duration: 200, tuning: 'Drop C#' },
      ...['a', 'b', 'c', 'd'].map((id, i) => ({ id, notes: 100 + i * 50, chords: 0, duration: 200, tuning: 'E Standard' })),
    ];
    expect(Object.keys(starter(songs, [], 1, 150))).toEqual(['a', 'b', 'c']);
  });
});
