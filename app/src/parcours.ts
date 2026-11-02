/**
 * The learning path: chapters of notions, each taught by three exercises that ask a little more
 * (step by step, the game waiting for each note; in time, slower, with the band; at tempo with
 * the band, twice as long). An exercise passes when the notion's own notes reach its goal; a
 * notion is learned at two stars, which opens the next one, and a chapter opens once the one
 * before is learned. The best of each exercise is kept with the lessons' records (synced online).
 */
import type { BackingStyle } from './backing';
import type { Chart, Techniques } from './chart';
import type { ViewItem } from './game/view';
import { t } from './i18n';
import { lessons, type Lesson, type LessonRecords, type Step } from './lessons';
import type { SymbolId } from './lexicon';

/** Which of an exercise's notes say whether its notion is played: all of them, its chords, its
 * palm-muted notes, its muted strums. */
export type Focus = 'all' | 'chords' | 'palmMute' | 'mute';

export interface Exercise {
  id: string;
  /** Step by step, in time, with the band. */
  kind: 'step' | 'time' | 'band';
  title: string;
  lesson: Lesson;
  /** The song stops on each note until it is played. */
  wait: boolean;
  /** Of the lesson's tempo. */
  pace: number;
  /** The band behind it (else the metronome), and the roots its bass plays per bar. */
  backing: BackingStyle | null;
  roots: readonly string[];
  /** Share of the notion's notes to play. */
  goal: number;
}

export interface Notion {
  id: string;
  title: string;
  /** What it teaches, why it matters. */
  learn: string;
  why: string;
  how: string[];
  /** The highway's symbol it teaches to read, if any. */
  symbol: SymbolId | null;
  focus: Focus;
  exercises: Exercise[];
}

export interface Chapter {
  id: string;
  title: string;
  blurb: string;
  notions: Notion[];
}

/** Notes of an exercise played at its tempo: the second exercise goes this much slower. */
const SLOWER = 0.75;
const GOALS = { step: 0.8, time: 0.75, band: 0.8 } as const;

interface Base {
  id: string;
  title: string;
  learn: string;
  why: string;
  how: string[];
  symbol: SymbolId | null;
  focus: Focus;
  bpm: number;
  steps: Step[];
  backing: BackingStyle;
  roots?: string[];
  /** The id of the lesson the first exercise was before the path (its best counts). */
  was?: string;
}

/** The three exercises of a notion. */
function notion(b: Base): Notion {
  const lesson = (id: string, title: string, steps: Step[], goal: number): Lesson => ({ id, title, learn: b.learn, how: b.how, goal, bpm: b.bpm, steps });
  const twice = [...b.steps, ...b.steps.map((s) => ({ ...s, beat: s.beat + span(b.steps) }))];
  const roots = b.roots ?? [];
  return {
    id: b.id,
    title: b.title,
    learn: b.learn,
    why: b.why,
    how: b.how,
    symbol: b.symbol,
    focus: b.focus,
    exercises: [
      { id: b.was ?? `p.${b.id}.1`, kind: 'step', title: t('Pas à pas'), lesson: lesson(b.was ?? `p.${b.id}.1`, b.title, b.steps, GOALS.step), wait: true, pace: 1, backing: null, roots, goal: GOALS.step },
      { id: `p.${b.id}.2`, kind: 'time', title: t('En rythme'), lesson: lesson(`p.${b.id}.2`, b.title, b.steps, GOALS.time), wait: false, pace: SLOWER, backing: b.backing, roots, goal: GOALS.time },
      { id: `p.${b.id}.3`, kind: 'band', title: t('Avec le groupe'), lesson: lesson(`p.${b.id}.3`, b.title, twice, GOALS.band), wait: false, pace: 1, backing: b.backing, roots: [...roots, ...roots], goal: GOALS.band },
    ],
  };
}

/** Beats from the first step to the end of the bar where the last one rings. */
function span(steps: readonly Step[]): number {
  const last = steps.reduce((m, s) => Math.max(m, s.beat + (s.hold ?? 1)), 0);
  return Math.max(4, Math.ceil(last / 4) * 4);
}

/** A lesson from before the path, by id: its tempo, steps and words. */
function old(id: string): Lesson {
  return lessons().find((l) => l.id === id)!;
}

/** From an old lesson: its steps, tempo, title and how-to. */
function from(id: string, extra: Omit<Base, 'id' | 'title' | 'learn' | 'how' | 'bpm' | 'steps' | 'was'> & { id?: string }): Base {
  const l = old(id);
  return { id: extra.id ?? id, title: l.title, learn: l.learn, how: l.how, bpm: l.bpm, steps: l.steps, was: id, ...extra };
}

/** A note (string, fret, techniques) on each of `beats`. */
const at = (beats: number[], note: { string: number; fret: number; hold?: number; techniques?: Techniques }): Step[] => beats.map((beat) => ({ ...note, beat }));
const range = (from: number, to: number, every: number): number[] => Array.from({ length: Math.round((to - from) / every) }, (_, i) => from + i * every);

/** The chapters, in order, in the interface language. */
export function chapters(): Chapter[] {
  return [
    {
      id: 'basics',
      title: t('Prise en main'),
      blurb: t('Les cordes, les cases, le rythme : de quoi jouer tes premières notes en mesure.'),
      notions: [
        notion(from('open-strings', { why: t('Tout part de là : savoir quelle corde est laquelle, au premier coup d’œil.'), symbol: 'open', focus: 'all', backing: 'pulse' })),
        notion(from('in-time', { why: t('Une note juste mais en retard sonne faux : le rythme compte autant que la note.'), symbol: null, focus: 'all', backing: 'pulse' })),
        notion(from('first-frets', { why: t('Appuyer derrière la bonne case, c’est la moitié de la guitare.'), symbol: 'fret', focus: 'all', backing: 'pulse' })),
        notion(from('spider', { why: t('Un doigt par case : la main reste en place et va plus vite.'), symbol: null, focus: 'all', backing: 'pulse' })),
        notion(from('melody', { why: t('Tenir une note jusqu’au bout, c’est ce qui fait chanter une mélodie.'), symbol: 'sustain', focus: 'all', backing: 'pulse', roots: ['G', 'G', 'D', 'G'] })),
      ],
    },
    {
      id: 'power',
      title: t('Power chords et palm mute'),
      blurb: t('Le son du rock : des accords à deux doigts, étouffés ou lâchés, sur un vrai groupe.'),
      notions: [
        notion(from('power-chord', { why: t('L’accord du rock : deux doigts, et tous les riffs s’ouvrent à toi.'), symbol: 'chord', focus: 'chords', backing: 'rock' })),
        notion(from('first-riff', { id: 'power-moves', why: t('Un riff, c’est une forme qui voyage sur le manche : la main bouge, la forme reste.'), symbol: 'chord', focus: 'chords', backing: 'rock' })),
        notion({
          id: 'palm-mute',
          title: t('Le palm mute'),
          learn: t('Étouffer la corde de Mi grave avec la paume : le « tchug » des riffs de rock et de metal.'),
          why: t('C’est lui qui donne la pêche aux couplets : le même riff, étouffé puis lâché.'),
          how: [
            t('Pose le tranchant de la main droite sur les cordes, juste devant le chevalet.'),
            t('Gratte la corde rouge à vide : le son doit rester sourd, mais la note doit s’entendre.'),
            t('Les notes marquées PM se jouent étouffées ; sans PM, lève la main.'),
          ],
          symbol: 'palmMute',
          focus: 'palmMute',
          bpm: 80,
          backing: 'rock',
          steps: [...at(range(0, 8, 1), { string: 0, fret: 0, techniques: { palmMute: true } }), ...at(range(8, 16, 0.5), { string: 0, fret: 0, techniques: { palmMute: true } })],
        }),
        notion({
          id: 'muted-strums',
          title: t('Les coups étouffés'),
          learn: t('Un « tchak » sans note entre deux accords : la main gauche relâche, la droite continue.'),
          why: t('Le rythme ne s’arrête jamais : les coups étouffés le tiennent entre les accords.'),
          how: [
            t('Garde la forme d’E5, mais relâche la pression : les doigts touchent les cordes sans appuyer.'),
            t('Gratte sur le ✕ : on doit entendre un coup sec, sans note.'),
            t('Appuie à nouveau pour l’accord suivant.'),
          ],
          symbol: 'mute',
          focus: 'mute',
          bpm: 75,
          backing: 'rock',
          steps: range(0, 16, 2).flatMap((beat) => [
            { beat, chord: 'E5' },
            { beat: beat + 1, string: 1, fret: 2, techniques: { mute: true } },
          ]),
        }),
        notion({
          id: 'garage-riff',
          title: t('Morceau d’étape : riff de garage'),
          learn: t('Tout le chapitre dans un riff : palm mute, power chords qui bougent, coups étouffés.'),
          why: t('Mettre les notions bout à bout, comme dans un vrai morceau.'),
          how: [
            t('Les PM sur la corde rouge, puis G5 et A5 lâchés.'),
            t('Le ✕ entre deux accords tient le rythme.'),
            t('Regarde où va la main avant chaque changement.'),
          ],
          symbol: null,
          focus: 'all',
          bpm: 90,
          backing: 'rock',
          steps: [0, 8].flatMap((bar) => [
            ...at([bar, bar + 0.5, bar + 1, bar + 1.5], { string: 0, fret: 0, techniques: { palmMute: true } }),
            { beat: bar + 2, chord: 'G5' },
            { beat: bar + 3, chord: 'A5' },
            ...at([bar + 4, bar + 4.5, bar + 5, bar + 5.5], { string: 0, fret: 0, techniques: { palmMute: true } }),
            { beat: bar + 6, string: 1, fret: 2, techniques: { mute: true } },
            { beat: bar + 7, chord: 'E5' },
          ]),
        }),
      ],
    },
    {
      id: 'open',
      title: t('Accords ouverts'),
      blurb: t('Les accords qui sonnent sur les six cordes, et passer de l’un à l’autre sans casser le rythme.'),
      notions: [
        notion(from('e-minor', { why: t('Le premier accord sur six cordes, avec deux doigts seulement.'), symbol: 'chord', focus: 'chords', backing: 'pulse' })),
        notion(from('a-minor', { why: t('Avec Mi mineur, il ouvre des centaines de chansons.'), symbol: 'chord', focus: 'chords', backing: 'pulse' })),
        notion(from('chord-change', { why: t('Changer d’accord à temps, c’est ce qui fait tenir une chanson.'), symbol: null, focus: 'chords', backing: 'pulse' })),
      ],
    },
  ];
}

export const passedExercise = (e: Exercise, records: LessonRecords): boolean => (records[e.id] ?? 0) >= e.goal;

/** Exercises of `n` passed: its stars, 0 to 3. */
export const stars = (n: Notion, records: LessonRecords): number => n.exercises.filter((e) => passedExercise(e, records)).length;

/** Learned: in time with the band at least (two stars, the first two exercises). */
export const learned = (n: Notion, records: LessonRecords): boolean => passedExercise(n.exercises[0], records) && passedExercise(n.exercises[1], records);

/** Whether notion `k` of chapter `c` can be played: the one before learned, and every notion of
 * the chapters before. */
export function open(all: readonly Chapter[], c: number, k: number, records: LessonRecords): boolean {
  if (all.slice(0, c).some((ch) => ch.notions.some((n) => !learned(n, records)))) return false;
  return k === 0 || learned(all[c].notions[k - 1], records);
}

/** The first notion open and not learned yet ([chapter, notion]); the last one once all are. */
export function nextNotion(all: readonly Chapter[], records: LessonRecords): [number, number] {
  for (let c = 0; c < all.length; c++) {
    const k = all[c].notions.findIndex((n) => !learned(n, records));
    if (k >= 0) return [c, k];
  }
  const c = all.length - 1;
  return [c, all[c].notions.length - 1];
}

/** The notion `id` and its place, if any. */
export function findNotion(all: readonly Chapter[], id: string): { chapter: number; index: number; notion: Notion } | null {
  for (let c = 0; c < all.length; c++) {
    const index = all[c].notions.findIndex((n) => n.id === id);
    if (index >= 0) return { chapter: c, index, notion: all[c].notions[index] };
  }
  return null;
}

/** Whether `item` is one the notion is judged on. */
function inFocus(item: ViewItem, chart: Pick<Chart, 'notes' | 'chords'>, focus: Focus): boolean {
  if (focus === 'all') return true;
  if (focus === 'chords') return item.target.kind === 'chord';
  if (item.target.kind !== 'note') return false;
  const techniques = chart.notes[item.event]?.techniques;
  return focus === 'palmMute' ? !!techniques?.palmMute : !!techniques?.mute;
}

/** Hits and judged items among those the notion is judged on. */
export function focusScore(items: readonly ViewItem[], chart: Pick<Chart, 'notes' | 'chords'>, focus: Focus): { hits: number; judged: number } {
  let hits = 0;
  let judged = 0;
  for (const it of items) {
    if (!it || it.status === 'pending' || !inFocus(it, chart, focus)) continue;
    judged++;
    if (it.status === 'hit') hits++;
  }
  return { hits, judged };
}
