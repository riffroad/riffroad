import { lang } from './i18n';
import type { AttackDifficulty } from './score-attack';

/**
 * What is on for every player, told by the server (cloud/server/events.json): a festival that
 * pays the career's gigs more, a weekly challenge picked by hand. Dates in Unix seconds.
 */
export interface LiveEvent {
  id: string;
  starts: number;
  ends: number;
  title: { fr: string; en: string };
  text: { fr: string; en: string };
  career?: { fans: number; money: number };
  challenge?: { song: string; level: AttackDifficulty };
}

const at = (when: Date) => when.getTime() / 1000;

/** The events on at `when`. */
export const onAt = (events: readonly LiveEvent[], when: Date): LiveEvent[] => events.filter((e) => e.starts <= at(when) && at(when) < e.ends);

/** What a career gig brings at `when`, times (1: no festival). Two festivals at once: the biggest. */
export function careerBoost(events: readonly LiveEvent[], when: Date): { fans: number; money: number } {
  const on = onAt(events, when).flatMap((e) => (e.career ? [e.career] : []));
  return { fans: Math.max(1, ...on.map((b) => b.fans)), money: Math.max(1, ...on.map((b) => b.money)) };
}

/** An event's title and text, in the interface language. */
export const words = (e: LiveEvent): { title: string; text: string } => (lang() === 'en' ? { title: e.title.en, text: e.text.en } : { title: e.title.fr, text: e.text.fr });
