/**
 * The guitarist's card: six ratings from 40 to 99, measured on what the guitar actually plays
 * (songs, gigs, lessons, training), never earned otherwise. Each moves a little with every song
 * played, more with the notes it judged, and is kept through a new career, like the guitars.
 */

import type { Chart, Techniques } from '../chart';
import { t } from '../i18n';

export type SkillId = 'precision' | 'accords' | 'rythme' | 'vitesse' | 'endurance' | 'technique';

export const SKILLS: readonly { id: SkillId; short: string; label: string; blurb: string }[] = [
  { id: 'precision', short: t('JUS'), label: t('Justesse'), blurb: t('Les notes simples justes.') },
  { id: 'accords', short: t('ACC'), label: t('Accords'), blurb: t('Les accords complets, sans corde de trop.') },
  { id: 'rythme', short: t('RYT'), label: t('Rythme'), blurb: t('Près du temps : l’écart moyen de tes attaques.') },
  { id: 'vitesse', short: t('VIT'), label: t('Vitesse'), blurb: t('Les notes par minute que tu tiens proprement.') },
  { id: 'endurance', short: t('END'), label: t('Endurance'), blurb: t('La fin des longs morceaux, aussi juste que le début.') },
  { id: 'technique', short: t('TEC'), label: t('Technique'), blurb: t('Bends, slides, hammer-ons, pull-offs, harmoniques.') },
];

/** A rating as measured: 0..1 (shown 40 to 99), and the notes it was measured on. */
export interface Skill {
  value: number;
  notes: number;
}

export interface Skills {
  values: Partial<Record<SkillId, Skill>>;
  /** The overall rating as it went (newest last), one point a day at most. */
  history: { date: string; overall: number }[];
}

/** What one song played says of each rating: its measure and how many notes back it. */
export type SkillSample = Partial<Record<SkillId, { value: number; weight: number }>>;

/** Notes a rating needs before it shows. */
export const MEASURED = 40;
const HISTORY = 60;
/** A song moves a rating by its notes against this many (and never more than MAX_STEP). */
const INERTIA = 300;
const MAX_STEP = 0.35;
/** Notes a minute worth a full speed rating, at a clean accuracy. */
const FAST = 300;

export const emptySkills = (): Skills => ({ values: {}, history: [] });

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
/** Accuracy onto a rating's scale: 50 % (or less) is the bottom, 98 % the top. */
const scale = (accuracy: number): number => clamp01((accuracy - 0.5) / 0.48);

export const skillRating = (value: number): number => Math.round(40 + 59 * clamp01(value));

/** The techniques that make a note a technical one (a palm mute or a tie does not). */
const TECHNICAL: (keyof Techniques)[] = ['hammerOn', 'pullOff', 'slideTo', 'bend', 'vibrato', 'harmonic', 'pinchHarmonic', 'tremolo', 'tap'];

/** What the game judged of a song: each expected note or chord with its fate. */
export interface Judged {
  status: 'pending' | 'hit' | 'missed';
  /** Timing error of a hit (s). */
  error: number;
  time: number;
  event: number;
  target: { kind: 'note' | 'chord' };
}

/** What a song played says of each rating (`seconds`: how long it was played). */
export function sampleOf(items: readonly (Judged | undefined)[], chart: Pick<Chart, 'notes'>, seconds: number): SkillSample {
  const judged = items.filter((i): i is Judged => !!i && i.status !== 'pending');
  const out: SkillSample = {};
  if (!judged.length) return out;
  const hits = (xs: readonly Judged[]) => xs.filter((i) => i.status === 'hit').length;
  const technical = (i: Judged) => {
    const tech = i.target.kind === 'note' ? chart.notes[i.event]?.techniques : undefined;
    return !!tech && TECHNICAL.some((k) => !!tech[k]);
  };
  const plain = judged.filter((i) => i.target.kind === 'note' && !technical(i));
  const chords = judged.filter((i) => i.target.kind === 'chord');
  const tech = judged.filter(technical);
  if (plain.length) out.precision = { value: scale(hits(plain) / plain.length), weight: plain.length };
  if (chords.length) out.accords = { value: scale(hits(chords) / chords.length), weight: chords.length };
  if (tech.length) out.technique = { value: scale(hits(tech) / tech.length), weight: tech.length };
  // Rhythm: the median distance of the attacks to the beat, 15 ms (or less) the top, 100 ms the bottom.
  const errors = judged
    .filter((i) => i.status === 'hit')
    .map((i) => Math.abs(i.error) * 1000)
    .sort((a, b) => a - b);
  if (errors.length) out.rythme = { value: clamp01(1 - (errors[Math.floor(errors.length / 2)] - 15) / 85), weight: errors.length };
  // Speed: the notes a minute played, as clean as they were.
  const accuracy = hits(judged) / judged.length;
  if (seconds > 30) out.vitesse = { value: clamp01(judged.length / (seconds / 60) / FAST) * Math.min(1, scale(accuracy) / 0.65), weight: judged.length };
  // Stamina: the last third of a song of three minutes or more, the longer the song the more it says.
  if (seconds >= 180 && judged.length >= 60) {
    const from = Math.min(...judged.map((i) => i.time));
    const to = Math.max(...judged.map((i) => i.time));
    const last = judged.filter((i) => i.time >= from + ((to - from) * 2) / 3);
    if (last.length) out.endurance = { value: scale(hits(last) / last.length) * (0.6 + 0.4 * Math.min(1, seconds / 360)), weight: last.length };
  }
  return out;
}

/** The card after a song: each rating measured moves toward what the song showed. Speed counts a
 * slower song less (a ballad played clean says little of how fast the hands go). */
export function learnSkills(s: Skills, sample: SkillSample, when = new Date()): Skills {
  const values = { ...s.values };
  for (const [id, m] of Object.entries(sample) as [SkillId, { value: number; weight: number }][]) {
    if (!m.weight) continue;
    const was = values[id];
    if (!was) {
      values[id] = { value: m.value, notes: m.weight };
      continue;
    }
    const slower = id === 'vitesse' && m.value < was.value ? 0.3 : 1;
    const step = Math.min(MAX_STEP, (m.weight * slower) / (m.weight * slower + INERTIA));
    values[id] = { value: was.value + (m.value - was.value) * step, notes: was.notes + m.weight };
  }
  const next: Skills = { values, history: s.history };
  const all = overall(next);
  if (all !== null) {
    const day = when.toISOString().slice(0, 10);
    const last = s.history[s.history.length - 1];
    next.history = last?.date.slice(0, 10) === day ? [...s.history.slice(0, -1), { date: when.toISOString(), overall: all }] : [...s.history, { date: when.toISOString(), overall: all }].slice(-HISTORY);
  }
  return next;
}

/** A rating shown, once measured on enough notes; null before. */
export function ratingOf(s: Skills, id: SkillId): number | null {
  const v = s.values[id];
  return v && v.notes >= MEASURED ? skillRating(v.value) : null;
}

/** The card's overall rating: the ratings measured, on average; null before any. */
export function overall(s: Skills): number | null {
  const known = SKILLS.map((k) => ratingOf(s, k.id)).filter((r): r is number => r !== null);
  return known.length ? Math.round(known.reduce((a, b) => a + b, 0) / known.length) : null;
}

/** The rating to work on: the lowest measured, else the first not measured yet. */
export function weakest(s: Skills): SkillId {
  const rated = SKILLS.map((k) => ({ id: k.id, r: ratingOf(s, k.id) }));
  const unknown = rated.find((x) => x.r === null);
  if (unknown && rated.every((x) => x.r === null)) return 'precision';
  const measured = rated.filter((x) => x.r !== null).sort((a, b) => a.r! - b.r!);
  return measured[0]?.id ?? unknown!.id;
}

/** Ratings that moved between two cards (whole points), for the results. */
export function changes(before: Skills, after: Skills): { id: SkillId; from: number; to: number }[] {
  const out: { id: SkillId; from: number; to: number }[] = [];
  for (const k of SKILLS) {
    const a = ratingOf(before, k.id);
    const b = ratingOf(after, k.id);
    if (b !== null && a !== b) out.push({ id: k.id, from: a ?? b, to: b });
  }
  return out;
}

/** The overall rating some weeks ago (the first one of the history within them), for "+3 this month". */
export function overallSince(s: Skills, days: number, now = new Date()): number | null {
  const since = now.getTime() - days * 86_400_000;
  return s.history.find((h) => Date.parse(h.date) >= since)?.overall ?? null;
}

export function sanitizeSkills(raw: unknown): Skills {
  const out = emptySkills();
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Partial<Skills>;
  if (r.values && typeof r.values === 'object') {
    for (const k of SKILLS) {
      const v = (r.values as Record<string, Partial<Skill>>)[k.id];
      if (v && typeof v.value === 'number' && Number.isFinite(v.value) && typeof v.notes === 'number') out.values[k.id] = { value: clamp01(v.value), notes: Math.max(0, Math.round(v.notes)) };
    }
  }
  if (Array.isArray(r.history)) {
    out.history = r.history
      .filter((h) => h && typeof h.date === 'string' && typeof h.overall === 'number')
      .map((h) => ({ date: h.date, overall: Math.round(h.overall) }))
      .slice(-HISTORY);
  }
  return out;
}
