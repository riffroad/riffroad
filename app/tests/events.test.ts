import { describe, expect, it } from 'vitest';
import { careerBoost, onAt, type LiveEvent } from '../src/events';
import { challengeOf, weekStart } from '../src/world';

const text = { fr: 'x', en: 'x' };
const festival = (starts: string, ends: string, fans: number): LiveEvent => ({
  id: starts,
  starts: Date.parse(starts) / 1000,
  ends: Date.parse(ends) / 1000,
  title: text,
  text,
  career: { fans, money: fans },
});

describe('events', () => {
  it('boost the career’s gigs while they are on, the biggest festival winning', () => {
    const events = [festival('2026-11-06T17:00:00Z', '2026-11-09T05:00:00Z', 1.5), festival('2026-11-07T00:00:00Z', '2026-11-08T00:00:00Z', 2)];
    expect(careerBoost(events, new Date('2026-11-06T12:00:00Z'))).toEqual({ fans: 1, money: 1 });
    expect(careerBoost(events, new Date('2026-11-06T20:00:00Z'))).toEqual({ fans: 1.5, money: 1.5 });
    expect(careerBoost(events, new Date('2026-11-07T12:00:00Z'))).toEqual({ fans: 2, money: 2 });
    expect(onAt(events, new Date('2026-11-09T05:00:00Z'))).toEqual([]);
  });

  it('may pick the week’s challenge, for that week only', () => {
    const pick: LiveEvent = { id: 'special', starts: weekStart(2965), ends: weekStart(2966), title: text, text, challenge: { song: 'OpenSmith - First Riff/song_chart.json', level: 'master' } };
    expect(challengeOf(2965, [pick])).toEqual({ week: 2965, song: 'OpenSmith - First Riff/song_chart.json', level: 'master' });
    expect(challengeOf(2966, [pick])).toEqual(challengeOf(2966));
  });
});
