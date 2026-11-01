/**
 * The label, once the band has signed (the showcase of act 3): three objectives a season, paid at
 * its end, and the studio, where takes of the repertoire's songs make an album. An album of eight
 * songs sells by its quality and the band's fans.
 */

import { lang, t } from '../i18n';
import { WEEKS, type Career } from './career';

export const LABEL = t('Disques Sauvages');
export const ALBUM_TRACKS = 8;

/** A take recorded for the next album: its accuracy, the best one kept. */
export type Takes = Record<string, number>;

export interface Release {
  name: string;
  season: number;
  quality: number;
  copies: number;
  date: string;
}

export interface Album {
  takes: Takes;
  released: Release[];
  /** Takes still free in a studio session already paid (a slot of the week buys a few). */
  session?: number;
}

export interface Objective {
  id: string;
  text: string;
  done: number;
  target: number;
}

export const signed = (c: Pick<Career, 'act'>): boolean => c.act >= 4;

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

type Count = (c: Career, season: number) => number;

const POOL: { id: string; text: (n: number) => string; target: (act: number) => number; count: Count }[] = [
  {
    id: 'chaud',
    text: (n) => t('Conquérir {n} salles à 80 % ou plus', { n }),
    target: () => 3,
    count: (c, s) => c.history.filter((r) => r.season === s && r.outcome === 'played' && r.satisfaction >= 0.8).length,
  },
  {
    id: 'rappels',
    text: (n) => t('Jouer {n} rappels', { n }),
    target: () => 2,
    count: (c, s) => c.history.filter((r) => r.season === s && r.encore).length,
  },
  {
    id: 'complets',
    text: (n) => t('Jouer {n} concerts avec les morceaux à 90 % de leurs notes ou plus', { n }),
    target: () => 2,
    count: (c, s) => c.history.filter((r) => r.season === s && r.outcome === 'played' && (r.complete ?? 0) >= 0.9).length,
  },
  {
    id: 'propre',
    text: (n) => t('Jouer {n} concerts sans une seule pause', { n }),
    target: () => 3,
    count: (c, s) => c.history.filter((r) => r.season === s && r.outcome === 'played' && !r.pauses).length,
  },
  {
    id: 'fans',
    text: (n) => t('Gagner {n} fans cette saison', { n: n.toLocaleString(lang() === 'en' ? 'en-US' : 'fr-FR') }),
    target: (act) => (act >= 5 ? 200000 : 30000),
    count: (c, s) => c.history.filter((r) => r.season === s).reduce((t, r) => t + Math.max(0, r.fans), 0),
  },
  {
    id: 'appris',
    text: (n) => t('Apprendre {n} nouveaux morceaux', { n }),
    target: () => 2,
    count: (c, s) => Object.values(c.repertoire).filter((l) => Math.ceil(l.since / WEEKS) === s).length,
  },
  {
    id: 'album',
    text: () => t('Sortir un album'),
    target: () => 1,
    count: (c, s) => c.album.released.filter((r) => r.season === s).length,
  },
];

/** The label's three objectives for `season` (the current one by default), and where they stand. */
export function labelObjectives(c: Career, season = c.season): Objective[] {
  const h = hash(`label|${season}`);
  const picks: number[] = [];
  for (let k = 0; picks.length < 3; k++) {
    const i = (h + k * 2654435761) % POOL.length;
    if (!picks.includes(i)) picks.push(i);
  }
  return picks.map((i) => {
    const o = POOL[i];
    const target = o.target(c.act);
    return { id: o.id, text: o.text(target), done: Math.min(target, o.count(c, season)), target };
  });
}

/** What an objective met pays at the season's end. */
export const objectiveBonus = (act: number): number => 2000 * Math.max(1, Math.min(act, 5) - 2);

/** The label's word on `season`: objectives met and the bonus they pay. */
export function seasonLabel(c: Career, season: number): { met: number; bonus: number } {
  const met = labelObjectives(c, season).filter((o) => o.done >= o.target).length;
  return { met, bonus: met * objectiveBonus(c.act) };
}

/** A take of `id` at `quality` (0..1): the best one is kept for the album. */
export const recordTake = (a: Album, id: string, quality: number): Album => ({ ...a, takes: { ...a.takes, [id]: Math.max(a.takes[id] ?? 0, quality) } });

/** The next album's quality: the best takes of its eight songs. */
export function albumQuality(a: Album): number {
  const best = Object.values(a.takes)
    .sort((x, y) => y - x)
    .slice(0, ALBUM_TRACKS);
  return best.length ? best.reduce((t, q) => t + q, 0) / best.length : 0;
}

/** Copies an album sells: a share of the fans, much more for a clean record. */
export const albumSales = (fans: number, quality: number): number => Math.round((fans * 0.3 * quality * quality) / 100) * 100;

export const emptyAlbum = (): Album => ({ takes: {}, released: [] });

/** An album read back from a save. */
export function sanitizeAlbum(raw: unknown): Album {
  const a = (raw ?? {}) as Partial<Album>;
  const takes: Takes = {};
  if (a.takes && typeof a.takes === 'object') for (const [id, q] of Object.entries(a.takes)) if (typeof q === 'number') takes[id] = Math.min(1, Math.max(0, q));
  const released = Array.isArray(a.released) ? a.released.filter((r) => r && typeof r.name === 'string' && typeof r.copies === 'number') : [];
  const session = typeof a.session === 'number' && a.session > 0 ? Math.min(3, Math.round(a.session)) : 0;
  return { takes, released, ...(session ? { session } : {}) };
}
