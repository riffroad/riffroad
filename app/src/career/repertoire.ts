/**
 * The band's repertoire: the songs it knows, each rated out of 99 like a player's card, from the
 * song's mastery and its form of the moment. Form holds two weeks without playing the song, then
 * fades; rehearsing (playing the song, in any mode) and playing it on stage bring it back. Every
 * week a scout proposes songs to learn, as hard as the act asks; only learned songs go on stage.
 */

/** A song the band knows. */
export interface Learned {
  /** Form when last played, 0..1 (see `formOf`). */
  form: number;
  /** Career week (see `weekIndex`) it was last played, and learned. */
  played: number;
  since: number;
}

/** Song id → what the band knows of it. */
export type Repertoire = Record<string, Learned>;

/** What the scout reads of a song. */
export interface Scouted {
  id: string;
  notes: number;
  chords: number;
  duration: number;
  tuning?: string;
}

/** Weeks a song keeps its form unplayed, and the form it loses each week after. */
export const IDLE = 2;
export const FADE = 0.12;
/** Form of a song just learned; what a rehearsal and a gig bring. */
export const NEW_FORM = 0.3;
export const REHEARSAL = 0.35;
export const STAGE = 0.25;
/** Songs a new career starts with, songs the scout proposes a week. */
export const STARTERS = 3;
export const PROPOSALS = 3;

/** A song's form at career week `now`. */
export function formOf(l: Learned, now: number): number {
  return Math.max(0, Math.min(1, l.form - FADE * Math.max(0, now - l.played - IDLE)));
}

/** The song's rating out of 99: 40 for a song barely known, 99 mastered and in form. */
export function rating(mastery: number, form: number): number {
  return Math.round(40 + 59 * (0.6 * Math.min(1, Math.max(0, mastery)) + 0.4 * Math.min(1, Math.max(0, form))));
}

/** `id` learned at week `now` (kept as it is when known already). */
export function learn(r: Repertoire, id: string, now: number): Repertoire {
  return id in r ? r : { ...r, [id]: { form: NEW_FORM, played: now, since: now } };
}

/** `id` played at week `now`: its form back up by `gain`. Songs not learned stay out. */
export function rehearse(r: Repertoire, id: string, now: number, gain = REHEARSAL): Repertoire {
  const l = r[id];
  if (!l) return r;
  return { ...r, [id]: { ...l, form: Math.min(1, formOf(l, now) + gain), played: now } };
}

/** A band rehearsal at week `now`: every song a little more in form. */
export function rehearseAll(r: Repertoire, now: number, gain: number): Repertoire {
  return Object.fromEntries(Object.entries(r).map(([id, l]) => [id, { ...l, form: Math.min(1, formOf(l, now) + gain), played: now }]));
}

/** What a setlist's form does to fans and fee: ×0.85 rusty, ×1 at 60 %, ×1.1 in full form. */
export function formFactor(forms: readonly number[]): number {
  if (!forms.length) return 1;
  return 0.85 + 0.25 * (forms.reduce((a, b) => a + b, 0) / forms.length);
}

/** Notes and chords a minute at the song's hardest level. */
export const density = (s: Pick<Scouted, 'notes' | 'chords' | 'duration'>): number => (s.duration > 0 ? ((s.notes + s.chords) / s.duration) * 60 : 0);

/** Where in the library's difficulty the scout looks, by act (0 easiest, 1 hardest). */
const AIM = [0.15, 0.45, 0.75];

/**
 * The scout's songs for week `now`: not learned yet, long enough for a gig (`minLength` s), the
 * closest to the act's difficulty, a few of them each week.
 */
export function scout<T extends Scouted>(songs: readonly T[], r: Repertoire, act: number, now: number, minLength = 0, n = PROPOSALS): T[] {
  const ranked = songs.filter((s) => s.duration >= minLength).sort((a, b) => density(a) - density(b) || a.id.localeCompare(b.id));
  const aim = AIM[Math.min(act, AIM.length) - 1];
  const place = new Map(ranked.map((s, i) => [s.id, ranked.length > 1 ? i / (ranked.length - 1) : 0]));
  const near = ranked.filter((s) => !(s.id in r)).sort((a, b) => Math.abs(place.get(a.id)! - aim) - Math.abs(place.get(b.id)! - aim) || a.id.localeCompare(b.id));
  // The nearest few, in an order that changes with the week.
  const pool = near.slice(0, n + 2);
  const seed = (now * 2654435761) >>> 0;
  return pool
    .map((s, i) => ({ s, k: ((seed ^ (i * 40503)) * 2246822519) >>> 0 }))
    .sort((a, b) => a.k - b.k)
    .slice(0, n)
    .map((x) => x.s)
    .sort((a, b) => density(a) - density(b));
}

/** A first repertoire at week `now`: the songs a career already played on stage, else the
 * easiest songs long enough for a gig. */
export function starter(songs: readonly Scouted[], played: readonly string[], now: number, minLength = 0): Repertoire {
  const known = new Set(songs.map((s) => s.id));
  const ids = [...new Set(played.filter((id) => known.has(id)))];
  const fit = songs.filter((s) => s.duration >= minLength && !ids.includes(s.id));
  // In the library's most common tuning: a first setlist without retuning on stage.
  const counts = new Map<string, number>();
  for (const s of fit) counts.set(s.tuning ?? '', (counts.get(s.tuning ?? '') ?? 0) + 1);
  const usual = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  const easiest = fit
    .filter((s) => (s.tuning ?? '') === usual || (counts.get(usual ?? '') ?? 0) < STARTERS)
    .sort((a, b) => density(a) - density(b) || a.id.localeCompare(b.id));
  for (const s of easiest) {
    if (ids.length >= STARTERS) break;
    ids.push(s.id);
  }
  return Object.fromEntries(ids.map((id) => [id, { form: 0.6, played: now, since: now }]));
}

/** A repertoire read back from a save. */
export function sanitizeRepertoire(raw: unknown): Repertoire {
  const r: Repertoire = {};
  if (!raw || typeof raw !== 'object') return r;
  for (const [id, l] of Object.entries(raw as Record<string, Partial<Learned>>)) {
    if (!l || typeof l.form !== 'number' || typeof l.played !== 'number') continue;
    r[id] = { form: Math.min(1, Math.max(0, l.form)), played: Math.round(l.played), since: typeof l.since === 'number' ? Math.round(l.since) : Math.round(l.played) };
  }
  return r;
}
