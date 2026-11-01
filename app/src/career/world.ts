/**
 * The scene around the band: a dozen other bands whose fans move week after week, a chart of
 * them all (the band and Les Vautours among them), the season's awards, and the headliners who
 * invite a band close behind them to open their show.
 */

import { t } from '../i18n';
import { rivalFans, RIVAL } from './events';

export interface Band {
  name: string;
  fans: number;
}

export type AwardId = 'groupe' | 'live' | 'revelation' | 'album';

export const AWARDS: Record<AwardId, string> = {
  groupe: t('Groupe de l’année'),
  live: t('Meilleur live'),
  revelation: t('Révélation de l’année'),
  album: t('Album de l’année'),
};

export interface World {
  bands: Band[];
  /** Awards won, the newest first. */
  awards: { season: number; id: AwardId }[];
  /** The band's fans when the season began (for the revelation). */
  seasonStart: number;
}

/** The scene's bands at the start, from a garage band to the stars. */
const SCENE: readonly [string, number][] = [
  ['Les Parpaings', 60],
  ['Moustique Électrique', 250],
  ['Neon Wolves', 900],
  ['Sombre Dimanche', 2500],
  ['Les Orages', 7000],
  ['Velvet Static', 18000],
  ['The Blue Riders', 45000],
  ['Kaïman', 110000],
  ['Les Machines Molles', 260000],
  ['Glass Atlas', 520000],
  ['Orbital Saints', 950000],
];

/** 0..1 from `text` (FNV-1a, its bits mixed again: keys that differ by a week spread evenly). */
function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** A band's name in the interface language (the scene keeps them in French). */
export const bandName = (name: string): string => t(name);

export const newWorld = (): World => ({ bands: SCENE.map(([name, fans]) => ({ name, fans })), awards: [], seasonStart: 0 });

/** The scene a week later: each band gains or loses a few percent (the small ones move more). */
export function worldWeek(w: World, season: number, week: number): World {
  return {
    ...w,
    bands: w.bands.map((b) => {
      const r = hash(`${b.name}|${season}|${week}`);
      const pace = b.fans < 5000 ? 0.09 : b.fans < 100000 ? 0.05 : 0.025;
      return { ...b, fans: Math.max(20, Math.round(b.fans * (1 + pace * (r * 1.6 - 0.5)))) };
    }),
  };
}

export interface ChartLine {
  name: string;
  fans: number;
  /** The player's band. */
  you?: boolean;
  rival?: boolean;
}

/** Every band of the scene by fans, the player's (`name`) and the rival among them. */
export function sceneChart(w: World, name: string, fans: number, weekIndex: number): ChartLine[] {
  const lines: ChartLine[] = [...w.bands.map((b) => ({ ...b })), { name, fans, you: true }, { name: RIVAL, fans: rivalFans(fans, weekIndex), rival: true }];
  return lines.sort((a, b) => b.fans - a.fans || (a.you ? -1 : 1));
}

/** The band's place in the scene (1: the top). */
export const rankOf = (chart: readonly ChartLine[]): number => chart.findIndex((l) => l.you) + 1;

/** A headliner just above in the chart who asks the band to open their show this week, now and
 * then; null otherwise. */
export function invitation(w: World, fans: number, season: number, week: number): string | null {
  if (hash(`invite|${season}|${week}`) >= 0.3) return null;
  const above = w.bands.filter((b) => b.fans > fans * 1.5 && b.fans < fans * 12).sort((a, b) => a.fans - b.fans);
  return above[0]?.name ?? null;
}

/** What the season's awards weigh: the band's place, its best gig, its growth, its album. */
export interface SeasonFacts {
  rank: number;
  bestSatisfaction: number;
  fans: number;
  /** The best album quality released this season (0: none). */
  album: number;
}

/** The awards the season won. */
export function seasonAwards(w: World, f: SeasonFacts): AwardId[] {
  const won: AwardId[] = [];
  if (f.rank === 1) won.push('groupe');
  if (f.bestSatisfaction >= 0.95) won.push('live');
  if (w.seasonStart > 0 && f.fans >= w.seasonStart * 3 && f.fans < 200000) won.push('revelation');
  if (f.album >= 0.9) won.push('album');
  return won;
}

export function sanitizeWorld(raw: unknown): World {
  const fresh = newWorld();
  if (!raw || typeof raw !== 'object') return fresh;
  const r = raw as Partial<World>;
  const bands = Array.isArray(r.bands) ? r.bands.filter((b) => b && typeof b.name === 'string' && typeof b.fans === 'number' && Number.isFinite(b.fans)) : [];
  return {
    bands: bands.length ? bands.map((b) => ({ name: b.name, fans: Math.max(0, Math.round(b.fans)) })) : fresh.bands,
    awards: Array.isArray(r.awards) ? r.awards.filter((a) => a && typeof a.season === 'number' && a.id in AWARDS) : [],
    seasonStart: typeof r.seasonStart === 'number' && Number.isFinite(r.seasonStart) ? Math.max(0, Math.round(r.seasonStart)) : 0,
  };
}
