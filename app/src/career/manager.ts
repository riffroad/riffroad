/**
 * The band as a business: the musicians' wages once they are professionals (the friends of the
 * garage and the bars play for nothing), sponsors who pay by the week for an objective, and the
 * label contract chosen when the showcase is won — a big advance or a better share of the albums.
 */

import { lang, t } from '../i18n';
import type { Musician } from './musicians';
import { followersPay } from './press';

/** Weekly wage per point of a musician's level (precision and energy, on average), by act: the
 * friends play for nothing until the clubs. */
const WAGE = [0, 0, 3, 8, 22];

export function wageOf(m: Pick<Musician, 'precision' | 'energy'> & { raise?: number }, act: number): number {
  const level = (m.precision + m.energy) / 2;
  return Math.round((level * WAGE[Math.min(Math.max(act, 1), WAGE.length) - 1] * (1 + (m.raise ?? 0))) / 10) * 10;
}

export const payroll = (members: readonly (Musician & { raise?: number })[], act: number): number => members.reduce((t, m) => t + wageOf(m, act), 0);

export type SponsorGoal = 'gigs' | 'rank' | 'card' | 'fans';

export interface SponsorOffer {
  brand: string;
  /** Paid every week of the deal (€). */
  pay: number;
  weeks: number;
  goal: SponsorGoal;
  /** Gigs with the crowd at `crowd` at least, a place in the chart, a card's rating, new fans. */
  target: number;
  crowd?: number;
  /** Paid on top when the goal is met at the end. */
  bonus: number;
}

export interface Sponsorship extends SponsorOffer {
  weeksLeft: number;
  /** Gigs counted so far, and the fans when it began. */
  done: number;
  fansAtStart: number;
}

const BRANDS = ['Fender', 'Gibson', 'Marshall', 'Orange', 'Ernie Ball', 'Dunlop', 'Boss', 'Vox'];

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

/** Weekly sponsor pay by act. */
const PAY = [0, 60, 300, 1200, 4000];

/** This week's sponsor offers: two brands every fourth week from the bars on (`rank`: the band's
 * place in the scene, a chart goal asks two places more). */
export function sponsorOffers(act: number, season: number, week: number, fans: number, rank = 10, followers = 0): SponsorOffer[] {
  if (act < 2 || week % 4 !== 1) return [];
  const a = Math.min(act, PAY.length);
  return [0, 1].map((k) => {
    const r = (i: number) => hash(`sponsor|${season}|${week}|${k}|${i}`);
    const brand = BRANDS[Math.floor(r(1) * BRANDS.length + k * 3) % BRANDS.length];
    // Brands pay more to a band followed on the networks.
    const pay = Math.round((PAY[a - 1] * (0.8 + 0.4 * r(2)) * followersPay(followers, fans)) / 10) * 10;
    const weeks = 6;
    const goals: SponsorGoal[] = ['gigs', 'rank', 'card', 'fans'];
    const goal = goals[Math.floor(r(3) * goals.length + k * 2) % goals.length];
    const target = goal === 'gigs' ? 4 : goal === 'rank' ? Math.max(1, rank - 2) : goal === 'card' ? 55 + 5 * a : Math.round((fans * 0.6 + 200 * a * a) / 100) * 100;
    return { brand, pay, weeks, goal, target, ...(goal === 'gigs' ? { crowd: 0.7 } : {}), bonus: Math.round((pay * weeks * 0.6) / 10) * 10 };
  });
}

/** What a sponsor asks, in words. */
export function sponsorGoal(o: Pick<SponsorOffer, 'goal' | 'target' | 'crowd' | 'weeks'>): string {
  switch (o.goal) {
    case 'gigs':
      return t('{n} concerts avec le public à {pct} % ou plus en {weeks} semaines', { n: o.target, pct: Math.round((o.crowd ?? 0.7) * 100), weeks: o.weeks });
    case 'rank':
      return t('Être dans le top {n} du classement au bout de {weeks} semaines', { n: o.target, weeks: o.weeks });
    case 'card':
      return t('Une note générale de {n} sur ta fiche au bout de {weeks} semaines', { n: o.target, weeks: o.weeks });
    case 'fans':
      return t('{n} nouveaux fans en {weeks} semaines', { n: o.target.toLocaleString(lang() === 'en' ? 'en-US' : 'fr-FR'), weeks: o.weeks });
  }
}

export const startSponsor = (o: SponsorOffer, fans: number): Sponsorship => ({ ...o, weeksLeft: o.weeks, done: 0, fansAtStart: fans });

/** The goal met, from where the band stands (its chart place, card rating, fans). */
export function sponsorMet(s: Sponsorship, now: { rank: number; card: number | null; fans: number }): boolean {
  switch (s.goal) {
    case 'gigs':
      return s.done >= s.target;
    case 'rank':
      return now.rank <= s.target;
    case 'card':
      return (now.card ?? 0) >= s.target;
    case 'fans':
      return now.fans - s.fansAtStart >= s.target;
  }
}

export type LabelId = 'major' | 'independant' | 'autoprod';

/** A label contract: the advance paid on signing, the band's share of each album sold (at
 * PRICE € a copy), how much its promotion multiplies the copies and the new fans, and whether
 * the label's yearly objectives (and bonus) come with it. */
export interface Contract {
  id: LabelId;
  advance: number;
  royalty: number;
  promotion: number;
  objectives: boolean;
  /** Signed with another label this season (no objectives' bonus for it). */
  from?: number;
}

export const PRICE = 10;

export const CONTRACTS: readonly (Contract & { name: string; blurb: string })[] = [
  {
    id: 'major',
    name: t('Une major'),
    blurb: t('Grosse avance et grosse promotion, mais 12 % des ventes pour le groupe.'),
    advance: 15000,
    royalty: 0.12,
    promotion: 1.5,
    objectives: true,
  },
  {
    id: 'independant',
    name: t('Un label indépendant'),
    blurb: t('Une avance modeste, 30 % des ventes, la promotion habituelle.'),
    advance: 5000,
    royalty: 0.3,
    promotion: 1,
    objectives: true,
  },
  {
    id: 'autoprod',
    name: t('L’autoproduction'),
    blurb: t('Pas d’avance ni d’objectifs, 60 % des ventes, mais moitié moins de disques vendus.'),
    advance: 0,
    royalty: 0.6,
    promotion: 0.5,
    objectives: false,
  },
];

export const contractOf = (id: LabelId): Contract => {
  const { name: _n, blurb: _b, ...c } = CONTRACTS.find((x) => x.id === id)!;
  return c;
};

export function sanitizeSponsor(raw: unknown): Sponsorship | null {
  const s = raw as Partial<Sponsorship> | null;
  if (!s || typeof s.brand !== 'string' || typeof s.pay !== 'number' || typeof s.weeksLeft !== 'number' || !['gigs', 'rank', 'card', 'fans'].includes(s.goal as string)) return null;
  return {
    brand: s.brand,
    pay: Math.max(0, Math.round(s.pay)),
    weeks: Math.max(1, Math.round(s.weeks ?? 6)),
    goal: s.goal as SponsorGoal,
    target: Number(s.target) || 0,
    ...(typeof s.crowd === 'number' ? { crowd: s.crowd } : {}),
    bonus: Math.max(0, Math.round(Number(s.bonus) || 0)),
    weeksLeft: Math.max(0, Math.round(s.weeksLeft)),
    done: Math.max(0, Math.round(Number(s.done) || 0)),
    fansAtStart: Math.max(0, Math.round(Number(s.fansAtStart) || 0)),
  };
}

export const sanitizeContract = (raw: unknown): Contract | null => {
  const r = raw as Partial<Contract> | null;
  if (!r?.id || !CONTRACTS.some((c) => c.id === r.id)) return null;
  const base = contractOf(r.id);
  const royalty = typeof r.royalty === 'number' && r.royalty >= base.royalty && r.royalty <= 0.7 ? r.royalty : base.royalty;
  return { ...base, royalty, ...(typeof r.from === 'number' ? { from: Math.round(r.from) } : {}) };
};
