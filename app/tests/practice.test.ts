import { describe, expect, it } from 'vitest';
import { addPractice, calendar, dayKey, STREAK_SECONDS, streakOf, type PracticeLog } from '../src/practice';

const day = (s: string) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d, 20, 0);
};
const log = (days: Record<string, number>): PracticeLog => days;

describe('days played', () => {
  it('adds up a day and forgets beyond a year', () => {
    let l = addPractice({}, day('2026-11-01'), 120);
    l = addPractice(l, day('2026-11-01'), 200);
    expect(l).toEqual({ '2026-11-01': 320 });
    l = addPractice({ '2025-01-01': 600 }, day('2026-11-01'), 60);
    expect(Object.keys(l)).toEqual(['2026-11-01']);
    expect(dayKey(day('2026-03-09'))).toBe('2026-03-09');
  });

  it('counts a streak up to today, or up to yesterday while today can keep it', () => {
    const enough = STREAK_SECONDS;
    const l = log({ '2026-10-28': enough, '2026-10-29': enough, '2026-10-30': enough, '2026-10-31': enough });
    expect(streakOf(l, day('2026-11-01'))).toEqual({ days: 4, today: 0, atRisk: true, best: 4 });
    const kept = { ...l, '2026-11-01': enough + 60 };
    expect(streakOf(kept, day('2026-11-01'))).toEqual({ days: 5, today: enough + 60, atRisk: false, best: 5 });
    // A day missed: the streak starts over, the record stays.
    expect(streakOf(l, day('2026-11-02'))).toMatchObject({ days: 0, atRisk: false, best: 4 });
    // A few minutes only do not count.
    expect(streakOf({ '2026-11-01': enough - 1 }, day('2026-11-01'))).toMatchObject({ days: 0, today: enough - 1 });
  });

  it('lays out twelve weeks from Monday, today’s week last', () => {
    const weeks = calendar({ '2026-11-01': 600 }, day('2026-11-01'));
    expect(weeks).toHaveLength(12);
    const last = weeks[11];
    // 1 November 2026 is a Sunday: the last column ends on it.
    expect(last[0].day).toBe('2026-10-26');
    expect(last[6]).toEqual({ day: '2026-11-01', seconds: 600, future: false });
    expect(calendar({}, day('2026-10-28'))[11][6].future).toBe(true);
  });
});
