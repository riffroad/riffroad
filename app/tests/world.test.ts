import { describe, expect, it } from 'vitest';
import { battle, challengeOf, SHIPPED, weekOf, weekStart } from '../src/world';

describe('the weekly challenge', () => {
  it('works out the same week and song as the server (cloud/api)', () => {
    // Monday 2 November 2026, 00:00 UTC: week 2965 (cloud/api's test uses the same moment).
    const monday = 1_793_577_600;
    expect(weekOf(monday)).toBe(2965);
    expect(weekOf(monday - 1)).toBe(2964);
    expect(weekStart(2965)).toBe(monday);
    expect(challengeOf(2965)).toEqual({ week: 2965, song: 'Shane Ivers - Hard Sell Hotel/song_chart.json', level: 'easy' });
    expect(challengeOf(2966).song).toBe(SHIPPED[1]);
  });

  it('only ever picks a song shipped with the game', () => {
    for (let w = 2900; w < 3000; w++) expect(SHIPPED).toContain(challengeOf(w).song);
  });
});

describe('the battle of the bands', () => {
  it('ranks the player and their friends by fans won this week; last week counts for nothing', () => {
    const card = (band: string, week: number, weekFans: number) => ({ band, act: 2, fans: 500, week, weekFans });
    const rows = battle(
      {
        code: 'MYCODE',
        me: card('Les Miens', 10, 40),
        friends: [
          { code: 'AAAAAA', name: 'Zoé', card: card('Les Z', 10, 90) },
          { code: 'BBBBBB', name: null, card: card('Les Anciens', 9, 500) },
          { code: 'CCCCCC', name: 'Max', card: null },
        ],
      },
      10,
      'Julien',
    );
    expect(rows.map((r) => [r.name, r.weekFans])).toEqual([
      ['Zoé', 90],
      ['Julien', 40],
      ['BBBBBB', 0],
      ['Max', 0],
    ]);
    expect(rows[1].code).toBeNull();
  });
});

