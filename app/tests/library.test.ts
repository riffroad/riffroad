import { describe, expect, it } from 'vitest';
import { aboutSource, chordLabel, EVERY_SONG, FIRST_TILES, fold, parseChord, partLabel, partMoves, partsOf, phraseMastery, playedPart, preferredPart, selectSongs, SOURCES, sourceOf, tileBatches, tuningsOf } from '../src/library';
import { findSong, type SongEntry } from '../src/engine/types';
import { emptyProgress, type Progress } from '../src/progress';

const song = (id: string, title: string, artist: string, extra: Partial<SongEntry> = {}): SongEntry => ({
  id,
  title,
  artist,
  duration: 200,
  tuning: 'E Standard',
  arrangement: 'Lead',
  notes: 100,
  chords: 10,
  ...extra,
});

const SONGS = [
  song('a', 'Back Alley', 'Vautours', { tuning: 'Drop C', source: 'audio' }),
  song('b', 'Come Back Home', 'Larsen', { tuning: 'D Standard', source: 'guitarpro', hasAudio: true }),
  song('c', 'Électrique', 'Bande Test', { source: 'some-plugin', album: 'Démos' }),
  song('d', 'Tab Only', 'Someone', { source: 'guitarpro', hasAudio: false }),
];

const PROGRESS: Progress = {
  a: { ...emptyProgress(), plays: 3, mastery: 0.2, lastPlayed: '2026-10-01T10:00:00Z' },
  c: { ...emptyProgress(), plays: 1, mastery: 0.8, lastPlayed: '2026-10-20T10:00:00Z', mastered: { V: 4 } },
};

describe('library', () => {
  it('names chords as the converter does, to correct them', () => {
    expect([chordLabel(0, 'maj'), chordLabel(6, 'min'), chordLabel(10, '5')]).toEqual(['C', 'F#m', 'Bb5']);
    expect(parseChord('F#m')).toEqual({ root: 6, quality: 'min' });
    expect(parseChord('E5')).toEqual({ root: 4, quality: '5' });
    expect(parseChord('C/E')).toBeNull();
    expect(parseChord('Am7')).toBeNull();
  });

  it('opens an MP3 on its chords, its notes shown as a draft', () => {
    const lead = song('m', 'Riff', 'Band', { source: 'audio', arrangement: 'Lead', arrangementType: 'lead' });
    const chords = song('m2', 'Riff', 'Band', { source: 'audio', arrangement: 'Chords', arrangementType: 'rhythm' });
    const mp3 = { ...lead, others: [chords] };
    expect(preferredPart(mp3, 'lead').id).toBe('m2');
    expect(partLabel(lead)).toBe('Lead (brouillon)');
    expect(partLabel(chords)).toBe('Accords');
    expect(aboutSource(lead)).toContain('brouillon');
    // A tab's parts as before: the kind chosen last.
    const tab = { ...lead, source: 'guitarpro', hasAudio: true, others: [{ ...chords, source: 'guitarpro', arrangement: 'Rhythm' }] };
    expect(preferredPart(tab, 'lead').id).toBe('m');
    expect(partLabel(tab)).toBe('Lead');
    // Played without a choice (the career): the MP3 in its chords, the tab as itself.
    expect(playedPart(mp3).id).toBe('m2');
    expect(playedPart(tab).id).toBe('m');
    expect([...partMoves([mp3, tab])]).toEqual([['m', 'm2']]);
  });

  it('says the chords of an MP3 count major or minor', () => {
    const chords = song('e', 'Riff', 'Band', { source: 'audio', arrangement: 'Chords', arrangementType: 'rhythm' });
    expect(aboutSource(chords)).toContain('majeur ou mineur');
    expect(aboutSource({ ...chords, arrangement: 'Lead' })).toContain('brouillon');
    expect(aboutSource({ ...chords, source: 'guitarpro', hasAudio: true })).toBe(SOURCES.tab.about);
  });

  it('tells where the notes come from', () => {
    expect(SONGS.map(sourceOf)).toEqual(['ai', 'tab', 'chart', 'sheet']);
  });

  it('finds songs by any word, accents or not', () => {
    const find = (text: string) => selectSongs(SONGS, PROGRESS, { ...EVERY_SONG, text }).map((s) => s.id);
    expect(fold('Électrique')).toBe('electrique');
    expect(find('electrique')).toEqual(['c']);
    expect(find('larsen come')).toEqual(['b']);
    expect(find('demos')).toEqual(['c']);
    expect(find('zz')).toEqual([]);
  });

  it('sorts by last played, title, artist or mastery', () => {
    const order = (sort: (typeof EVERY_SONG)['sort']) => selectSongs(SONGS, PROGRESS, { ...EVERY_SONG, sort }).map((s) => s.id);
    expect(order('recent')).toEqual(['c', 'a', 'b', 'd']);
    expect(order('title')).toEqual(['a', 'b', 'c', 'd']);
    expect(order('artist')).toEqual(['c', 'b', 'd', 'a']);
    expect(order('mastery')).toEqual(['c', 'a', 'b', 'd']);
  });

  it('filters by source and tuning', () => {
    expect(selectSongs(SONGS, PROGRESS, { ...EVERY_SONG, source: 'tab' }).map((s) => s.id)).toEqual(['b']);
    expect(selectSongs(SONGS, PROGRESS, { ...EVERY_SONG, tuning: 'Drop C' }).map((s) => s.id)).toEqual(['a']);
    expect(tuningsOf(SONGS)).toEqual(['E Standard', 'D Standard', 'Drop C']);
  });

  it('shows each phrase with the level mastered', () => {
    const s = song('c', 'X', 'Y', { phrases: ['V', 'C', 'Z'], phraseSections: ['Verse 1', 'chorus', 'Section 3'], maxDifficulty: 4 });
    expect(phraseMastery(s, PROGRESS.c)).toEqual([
      { name: 'V', label: 'Couplet 1', level: 4, levels: 5 },
      { name: 'C', label: 'Refrain', level: -1, levels: 5 },
      { name: 'Z', label: 'Phrase Z', level: -1, levels: 5 },
    ]);
  });
});

describe('the grid of a big library', () => {
  it('draws a screenful at once, then every other tile once, in order', () => {
    expect(tileBatches(12)).toEqual([[0, 12]]);
    const batches = tileBatches(1367);
    expect(batches[0]).toEqual([0, FIRST_TILES]);
    expect(batches.flatMap(([from, to]) => Array.from({ length: to - from }, (_, i) => from + i))).toEqual(Array.from({ length: 1367 }, (_, i) => i));
    expect(tileBatches(500, 500)).toEqual([[0, 500]]);
  });
});

describe('arrangements of a song', () => {
  const part = (id: string, arrangement: string, arrangementType: string): SongEntry => ({
    id,
    title: 'Night Drive',
    artist: 'A',
    duration: 200,
    tuning: 'E Standard',
    arrangement,
    arrangementType,
    notes: 10,
    chords: 0,
    // A tab's parts (an MP3's notes would be drafts).
    source: 'guitarpro',
    hasAudio: true,
  });
  const song = { ...part('nd/song_chart.json', 'Lead', 'lead'), others: [part('nd/song_chart.bass.json', 'Bass', 'bass'), part('nd/song_chart.rhythm.json', 'Rhythm', 'rhythm')] };

  it('lists the song first, then its other arrangements', () => {
    expect(partsOf(song).map(partLabel)).toEqual(['Lead', 'Basse', 'Rythmique']);
    expect(partLabel(part('nd/song_chart.chords.json', 'Chords', 'rhythm'))).toBe('Accords');
    expect(partsOf(part('x', 'Lead', 'lead'))).toHaveLength(1);
  });

  it('opens on the kind of arrangement chosen last, when the song has it', () => {
    expect(preferredPart(song, 'rhythm').id).toBe('nd/song_chart.rhythm.json');
    expect(preferredPart(song, 'combo').id).toBe(song.id);
    expect(preferredPart(song, null).id).toBe(song.id);
  });

  it('finds an arrangement by its chart id', () => {
    expect(findSong([song], 'nd/song_chart.bass.json')?.arrangement).toBe('Bass');
    expect(findSong([song], song.id)).toBe(song);
    expect(findSong([song], 'nope')).toBeUndefined();
  });
});
