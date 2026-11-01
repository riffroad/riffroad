/**
 * The band around the player: a bassist, a drummer and a singer, rated out of 99 in precision,
 * energy and reliability, and their morale. A precise band brings more fans and fee, an energetic
 * one starts the crowd warmer; an unreliable member may miss a gig (a stand-in plays). Morale
 * rises with good gigs and rest, falls with bad ones and weeks on the road without rest; a member
 * left without any goes over to the rival band. Better musicians can be hired, for a fee, once the
 * band has the fans to attract them.
 */

import { t } from '../i18n';

export type Role = 'batterie' | 'basse' | 'chant';

export interface Musician {
  name: string;
  role: Role;
  precision: number;
  energy: number;
  reliability: number;
  /** 0..1. */
  morale: number;
  /** A wage raise won (share, see manager.ts). */
  raise?: number;
}

/** A musician on the market: what signing costs and the fans the band needs. */
export interface Candidate extends Musician {
  fee: number;
  fans: number;
}

export const ROLES: readonly { id: Role; label: string }[] = [
  { id: 'batterie', label: t('Batterie') },
  { id: 'basse', label: t('Basse') },
  { id: 'chant', label: t('Chant') },
];

/** Below this morale at the end of a week, a member leaves. */
export const LEAVE = 0.15;

/** The friends from the garage. */
export function startingBand(): Musician[] {
  return [
    { name: 'Max', role: 'batterie', precision: 48, energy: 58, reliability: 72, morale: 0.7 },
    { name: 'Karim', role: 'basse', precision: 46, energy: 50, reliability: 78, morale: 0.7 },
    { name: 'Léa', role: 'chant', precision: 52, energy: 56, reliability: 70, morale: 0.7 },
  ];
}

/** A stand-in for a missing member: steady, unremarkable. */
const standIn = (role: Role): Musician => ({ name: t('un remplaçant'), role, precision: 40, energy: 40, reliability: 90, morale: 0.5 });

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const average = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

/** What a member gives on stage: precision and energy, worn down by low morale. */
const onStage = (m: Musician, k: 'precision' | 'energy'): number => m[k] * (0.7 + 0.3 * m.morale);

/** The fans and fee factor of the band's precision: ×1 at 50, ×1.12 at 90. */
export const bandFactor = (members: readonly Musician[]): number => 1 + (average(members.map((m) => onStage(m, 'precision'))) - 50) * 0.003;

/** What the band's energy adds to the crowd at the start of a gig: +0.08 at 90, −0.04 at 30. */
export const crowdBoost = (members: readonly Musician[]): number => (average(members.map((m) => onStage(m, 'energy'))) - 50) / 500;

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

/**
 * Who misses the gig `key` (the same answer every time it is asked): each member with a chance of
 * half their unreliability. The line-up of the night, with stand-ins, and the names missing.
 */
export function lineUp(members: readonly Musician[], key: string): { members: Musician[]; missing: Musician[] } {
  const missing = members.filter((m) => hash(`${key}|${m.name}|${m.role}`) < ((100 - m.reliability) / 100) * 0.5);
  return { members: members.map((m) => (missing.includes(m) ? standIn(m.role) : m)), missing };
}

/** Morale after a gig: up after a crowd won over, down after a cold one, a booing or walking off. */
export function afterGig(members: readonly Musician[], satisfaction: number, outcome: 'played' | 'booed' | 'abandoned'): Musician[] {
  const delta = outcome === 'booed' ? -0.15 : outcome === 'abandoned' ? -0.1 : satisfaction >= 0.7 ? 0.05 : satisfaction < 0.4 ? -0.12 : 0.01;
  return members.map((m) => ({ ...m, morale: clamp(m.morale + delta, 0, 1) }));
}

/** Morale over a week: rest days lift it, a band rehearsal a little, every gig wears it by `wear`
 * (touring twice a week, week after week, needs rest weeks; less with a tour bus). */
export function afterWeek(members: readonly Musician[], slots: readonly string[], wear = 0.05): Musician[] {
  const rest = slots.filter((s) => s === 'rest').length;
  const rehearsal = slots.filter((s) => s === 'rehearsal').length;
  const gigs = slots.filter((s) => s.startsWith('gig')).length;
  const delta = 0.1 * rest + 0.03 * rehearsal - wear * gigs;
  return members.map((m) => ({ ...m, morale: clamp(m.morale + delta, 0, 1) }));
}

/** Members too unhappy to stay go over to the rival, a stand-in takes their place. */
export function departures(members: readonly Musician[]): { members: Musician[]; gone: Musician[] } {
  const gone = members.filter((m) => m.morale < LEAVE);
  return { members: members.map((m) => (gone.includes(m) ? { ...standIn(m.role), name: t('Remplaçant ({name} parti)', { name: m.name }) } : m)), gone };
}

/** The fans a band of each act has, about, at most: what the best musicians of its market ask. */
const ACT_FANS = [60, 500, 4000, 15000, 120000];

const NAMES = ['Sam', 'Nina', 'Hugo', 'Inès', 'Théo', 'Jade', 'Malik', 'Chloé', 'Lucas', 'Zoé', 'Yanis', 'Clara', 'Nathan', 'Lina', 'Enzo', 'Manon', 'Rayan', 'Lou', 'Tom', 'Sarah'];

/** The week's market: a musician per role, better as the act goes on, dearer the better. */
export function market(act: number, week: number): Candidate[] {
  return ROLES.map(({ id }, i) => {
    const r = (k: number) => hash(`${week}|${id}|${k}`);
    const level = 46 + 11 * act + (r(1) - 0.5) * 16;
    const stat = (k: number) => Math.round(clamp(level + (r(k) - 0.5) * 18, 30, 99));
    const precision = stat(2);
    const energy = stat(3);
    const reliability = Math.round(clamp(60 + r(4) * 38, 30, 99));
    const value = (precision + energy + reliability) / 3;
    return {
      name: NAMES[Math.floor(r(5) * NAMES.length + i * 7) % NAMES.length],
      role: id,
      precision,
      energy,
      reliability,
      morale: 0.8,
      fee: Math.max(50, Math.round(((value - 45) * (6 + 5 * act)) / 10) * 10),
      fans: Math.round((ACT_FANS[Math.min(act, ACT_FANS.length) - 1] * clamp((value - 45) / 40, 0, 1.2)) / 10) * 10,
    };
  });
}

/** The band with `c` hired in place of the member who plays the same part. */
export function hire(members: readonly Musician[], c: Candidate): Musician[] {
  const { fee: _fee, fans: _fans, ...m } = c;
  return members.map((x) => (x.role === c.role ? m : x));
}

/** The band read back from a save: one member per role, the garage friends where missing. */
export function sanitizeMembers(raw: unknown): Musician[] {
  const start = startingBand();
  if (!Array.isArray(raw)) return start;
  return start.map((d) => {
    const m = raw.find((x) => x && typeof x === 'object' && (x as Musician).role === d.role) as Partial<Musician> | undefined;
    if (!m || typeof m.name !== 'string') return d;
    const n = (x: unknown, fallback: number) => (typeof x === 'number' && Number.isFinite(x) ? clamp(Math.round(x), 1, 99) : fallback);
    return {
      name: m.name.slice(0, 40),
      role: d.role,
      precision: n(m.precision, d.precision),
      energy: n(m.energy, d.energy),
      reliability: n(m.reliability, d.reliability),
      morale: typeof m.morale === 'number' ? clamp(m.morale, 0, 1) : d.morale,
      ...(typeof m.raise === 'number' && m.raise > 0 ? { raise: Math.min(3, m.raise) } : {}),
    };
  });
}

/** Morale in words. */
export const moraleLabel = (m: number): string => (m >= 0.75 ? t('motivé') : m >= 0.45 ? t('correct') : m >= LEAVE + 0.1 ? t('démotivé') : t('prêt à partir'));
