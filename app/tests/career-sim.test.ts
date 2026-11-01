import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PROFILES, simulateCareer, type SimSong, type Strategy } from './career/sim';
import type { Difficulty } from '../src/career/difficulty';

/** Forty songs like a library's: 2 to 6 minutes, 80 to 340 notes a minute at the top, sparser
 * levels below, a few tunings. */
function library(): SimSong[] {
  const tunings = ['E Standard', 'E Standard', 'E Standard', 'Eb Standard', 'Drop D'];
  return Array.from({ length: 40 }, (_, i) => {
    const duration = 120 + ((i * 37) % 240);
    const full = Math.round(((80 + ((i * 53) % 260)) * duration) / 60);
    const levelNotes = Array.from({ length: 21 }, (_, l) => Math.round(full * (0.08 + 0.92 * (l / 20) ** 1.3)));
    return { id: `song-${i}`, title: `Song ${i}`, duration, tuning: tunings[i % tunings.length], notes: full, chords: 0, levelNotes };
  });
}

describe('a career played through by a simulated player', () => {
  it('takes a clean, diligent player to the Hall of Fame, the save sound all the way', () => {
    const r = simulateCareer({ songs: library(), profile: PROFILES[0], strategy: 'applique', difficulty: 'pro', seed: 1 });
    expect(r.anomalies).toEqual([]);
    expect(r.actWeek[6], `stuck in act ${r.finalAct} after ${r.weeks} weeks`).toBeDefined();
    expect(r.trophies).toContain('hall');
  });

  it('lets a beginner play on without breaking the save, however far they get', () => {
    const r = simulateCareer({ songs: library(), profile: PROFILES[2], strategy: 'fonceur', difficulty: 'legende', seed: 2, maxWeeks: 60 });
    expect(r.anomalies.filter((a) => !a.what.startsWith('aucune offre'))).toEqual([]);
    expect(r.gigs).toBeGreaterThan(20);
  });

  // The full study, on a real library (OPENSMITH_CAREER_SONGS: the app's library index as JSON).
  it.skipIf(!process.env.OPENSMITH_CAREER_SONGS)('runs every profile, strategy and difficulty on a library', () => {
    const raw = JSON.parse(readFileSync(process.env.OPENSMITH_CAREER_SONGS!, 'utf8')) as (SimSong & { hasAudio?: boolean })[];
    const songs = raw.filter((s) => s.hasAudio !== false && s.levelNotes?.length);
    const seeds = Number(process.env.OPENSMITH_CAREER_SEEDS ?? 3);
    const gamma = Number(process.env.OPENSMITH_CAREER_GAMMA ?? 0.3);
    const levelDown = Number(process.env.OPENSMITH_CAREER_LEVEL_DOWN ?? 0.5);
    const out = [];
    for (const profile of PROFILES)
      for (const strategy of ['fonceur', 'applique', 'occasionnel'] as Strategy[])
        for (const difficulty of ['rookie', 'pro', 'legende'] as Difficulty[])
          for (let seed = 1; seed <= seeds; seed++) out.push(simulateCareer({ songs, profile, strategy, difficulty, seed, gamma, levelDown }));
    writeFileSync(process.env.OPENSMITH_CAREER_OUT ?? 'career-sim.json', JSON.stringify(out));
    expect(out.length).toBe(PROFILES.length * 9 * seeds);
  }, 3_600_000);
});
