import { t, tn } from './i18n';

/**
 * The days played: the seconds of music played on each day (this Mac's date), kept with the
 * progress (and online with it). A streak is a run of days with at least `STREAK_SECONDS` each,
 * up to today, or up to yesterday while today can still keep it going.
 */
export type PracticeLog = Record<string, number>;

/** What a day needs to count: five minutes of music. */
export const STREAK_SECONDS = 5 * 60;
/** Days kept (a little more than a year). */
const KEEP_DAYS = 400;

/** The day of a date, on this Mac's calendar: `YYYY-MM-DD`. */
export function dayKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function shift(d: Date, days: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + days);
  return out;
}

/** `seconds` more played on `day`; the oldest days beyond a year dropped. */
export function addPractice(log: PracticeLog, day: Date, seconds: number): PracticeLog {
  const key = dayKey(day);
  const out: PracticeLog = { ...log, [key]: (log[key] ?? 0) + seconds };
  const oldest = dayKey(shift(day, -KEEP_DAYS));
  for (const k of Object.keys(out)) if (k < oldest) delete out[k];
  return out;
}

export interface Streak {
  /** Days in a row, today included when it already counts. */
  days: number;
  /** Seconds played today. */
  today: number;
  /** A streak that ends yesterday: today still has to count to keep it. */
  atRisk: boolean;
  /** The longest run kept. */
  best: number;
}

export function streakOf(log: PracticeLog, today: Date): Streak {
  const counts = (d: Date) => (log[dayKey(d)] ?? 0) >= STREAK_SECONDS;
  const played = log[dayKey(today)] ?? 0;
  let days = 0;
  for (let d = counts(today) ? today : shift(today, -1); counts(d); d = shift(d, -1)) days++;
  let best = 0;
  let run = 0;
  let previous: string | null = null;
  for (const key of Object.keys(log).sort()) {
    if (log[key] < STREAK_SECONDS) continue;
    const [y, m, dd] = key.split('-').map(Number);
    run = previous === dayKey(shift(new Date(y, m - 1, dd), -1)) ? run + 1 : 1;
    previous = key;
    best = Math.max(best, run);
  }
  return { days, today: played, atRisk: days > 0 && !counts(today), best: Math.max(best, days) };
}

/** The last `weeks` weeks, a column per week from Monday, today's week last. */
export function calendar(log: PracticeLog, today: Date, weeks = 12): { day: string; seconds: number; future: boolean }[][] {
  const monday = shift(today, -((today.getDay() + 6) % 7));
  const first = shift(monday, -7 * (weeks - 1));
  const todayKey = dayKey(today);
  return Array.from({ length: weeks }, (_, w) =>
    Array.from({ length: 7 }, (_, i) => {
      const day = dayKey(shift(first, w * 7 + i));
      return { day, seconds: log[day] ?? 0, future: day > todayKey };
    }),
  );
}

const minutes = (s: number) => Math.round(s / 60);

/** The streak in a few words, for the menu. */
export function streakLine(s: Streak): string {
  if (s.atRisk) return tn(s.days, 'Série de {n} jour : joue 5 min aujourd’hui pour la garder', 'Série de {n} jours : joue 5 min aujourd’hui pour la garder');
  if (s.days) return `${tn(s.days, 'Série de {n} jour', 'Série de {n} jours')} · ${t('{m} min aujourd’hui', { m: minutes(s.today) })}`;
  return s.today ? t('{m} min aujourd’hui · 5 min pour lancer une série', { m: minutes(s.today) }) : t('5 min de guitare par jour lancent une série');
}

/** The streak and the last twelve weeks, a square per day (brighter, more played). */
export function practiceCard(log: PracticeLog, today: Date): HTMLElement {
  const s = streakOf(log, today);
  const card = document.createElement('section');
  card.className = 'practice-card';
  const head = document.createElement('div');
  head.className = 'practice-head';
  const big = document.createElement('b');
  big.textContent = tn(s.days, '{n} jour d’affilée', '{n} jours d’affilée');
  const sub = document.createElement('span');
  sub.textContent = `${t('{m} min aujourd’hui', { m: minutes(s.today) })} · ${tn(s.best, 'record : {n} jour', 'record : {n} jours')}`;
  head.append(big, sub);
  const grid = document.createElement('div');
  grid.className = 'practice-grid';
  for (const week of calendar(log, today)) {
    const column = document.createElement('div');
    for (const d of week) {
      const cell = document.createElement('i');
      const level = d.future ? 'future' : d.seconds >= 30 * 60 ? 'l3' : d.seconds >= 15 * 60 ? 'l2' : d.seconds >= STREAK_SECONDS ? 'l1' : d.seconds > 0 ? 'l0' : '';
      cell.className = level;
      if (!d.future) cell.title = `${d.day} · ${t('{m} min', { m: minutes(d.seconds) })}`;
      column.append(cell);
    }
    grid.append(column);
  }
  card.append(head, grid);
  return card;
}
