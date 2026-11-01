/**
 * Lessons for someone who has never played: the strings, the frets, a melody, the first chords
 * and a riff. Each is a short chart played over a metronome, with what to do and a goal (the
 * share of notes to play); passing one leads to the next. What each lesson's best was is kept
 * on this Mac. Two recording sessions come after them: every string at every fret up to the
 * 12th, then nine chords, the guitar recorded as it plays them (takes kept on this Mac) so that
 * the note detection can be tuned to the player's own guitar and cable.
 */
import type { Anchor, Chart, Chord, ChordTemplate, HandShape, Note, Techniques } from './chart';
import { t } from './i18n';

/** At `beat` (counted from the first note), a note (string from the low E, fret) or a chord;
 * `hold`: beats it rings. */
export type Step = { beat: number; string: number; fret: number; hold?: number; techniques?: Techniques } | { beat: number; chord: string; hold?: number };

export interface Lesson {
  id: string;
  title: string;
  /** What it teaches, in a sentence. */
  learn: string;
  /** How to do it, a few short lines. */
  how: string[];
  /** Share of the notes to play to pass. */
  goal: number;
  bpm: number;
  steps: Step[];
  /** A recording session: no goal, the guitar recorded. */
  record?: boolean;
  /** A career training drill (see career/training.ts): titled as it is. */
  drill?: boolean;
}

/** Chords the lessons use: fret per string from the low E (-1: not played), and the fingers
 * (1 index … 4 little finger, 0 open). */
export const CHORDS: Record<string, { frets: number[]; fingers: number[] }> = {
  E: { frets: [0, 2, 2, 1, 0, 0], fingers: [0, 2, 3, 1, 0, 0] },
  A: { frets: [-1, 0, 2, 2, 2, 0], fingers: [-1, 0, 1, 2, 3, 0] },
  C: { frets: [-1, 3, 2, 0, 1, 0], fingers: [-1, 3, 2, 0, 1, 0] },
  D: { frets: [-1, -1, 0, 2, 3, 2], fingers: [-1, -1, 0, 1, 3, 2] },
  G: { frets: [3, 2, 0, 0, 0, 3], fingers: [2, 1, 0, 0, 0, 3] },
  E5: { frets: [0, 2, 2, -1, -1, -1], fingers: [0, 1, 2, -1, -1, -1] },
  G5: { frets: [3, 5, 5, -1, -1, -1], fingers: [1, 3, 4, -1, -1, -1] },
  A5: { frets: [-1, 0, 2, 2, -1, -1], fingers: [-1, 0, 1, 2, -1, -1] },
  Em: { frets: [0, 2, 2, 0, 0, 0], fingers: [0, 2, 3, 0, 0, 0] },
  Am: { frets: [-1, 0, 2, 2, 1, 0], fingers: [-1, 0, 2, 3, 1, 0] },
};

export const STANDARD = [40, 45, 50, 55, 59, 64];
/** Beats of metronome before the first note, and after the last one rings. */
const LEAD = 4;
const TAIL = 4;

/** `notes` one after the other, every `every` beats from `from`. */
function line(notes: [number, number][], every = 1, from = 0, hold?: number): Step[] {
  return notes.map(([string, fret], i) => ({ beat: from + i * every, string, fret, hold }));
}

/** `chords` one after the other, each `hold` beats, from `from`. */
function strums(chords: string[], hold: number, from = 0): Step[] {
  return chords.map((chord, i) => ({ beat: from + i * hold, chord, hold }));
}

const repeat = <T>(n: number, items: T[]): T[] => Array.from({ length: n }, () => items).flat();
const OPEN: [number, number][] = [0, 1, 2, 3, 4, 5].map((s) => [s, 0]);
const FINGERS = [1, 2, 3, 4];

/** Au clair de la lune (traditional): sol sol sol la si — la — sol si la la sol —, on the G and B strings. */
const MOON: Step[] = [
  [0, 3, 0, 1],
  [1, 3, 0, 1],
  [2, 3, 0, 1],
  [3, 3, 2, 1],
  [4, 4, 0, 2],
  [6, 3, 2, 2],
  [8, 3, 0, 1],
  [9, 4, 0, 1],
  [10, 3, 2, 1],
  [11, 3, 2, 1],
  [12, 3, 0, 4],
].map(([beat, string, fret, hold]) => ({ beat, string, fret, hold }));

/** Chords of the recording session, each strummed four times. */
const RECORDED_CHORDS = ['E', 'Em', 'A', 'Am', 'C', 'D', 'G', 'E5', 'A5'];

/** The lessons, in order, then the recording sessions, in the interface language. */
export function lessons(): Lesson[] {
  return [...teaching(), ...recordings()];
}

function recordings(): Lesson[] {
  return [
    {
      id: 'record-notes',
      record: true,
      title: t('Ta guitare, note par note'),
      learn: t('Chaque corde à vide, puis case après case jusqu’à la 12 : le jeu apprend comment sonne ta guitare.'),
      how: [
        t('Une note tous les deux clics : laisse-la sonner jusqu’à la suivante. Trop rapide ? Choisis « Lent ».'),
        t('Une corde après l’autre, de la rouge à la violette. Un seul doigt suffit : suis la lumière sur le manche.'),
        t('Une note ratée n’est pas grave : elle est simplement laissée de côté.'),
      ],
      goal: 0,
      bpm: 60,
      steps: [0, 1, 2, 3, 4, 5].flatMap((string) => Array.from({ length: 13 }, (_, fret) => ({ string, fret }))).map((n, k) => ({ ...n, beat: 2 * k, hold: 2 })),
    },
    {
      id: 'record-chords',
      record: true,
      title: t('Ta guitare, en accords'),
      learn: t('Neuf accords, quatre fois chacun : le jeu apprend comment sonnent tes accords.'),
      how: [
        t('Chaque accord est gratté quatre fois vers le bas, puis tu as deux temps pour changer.'),
        t('Les numéros sur le manche disent où poser chaque doigt ; un accord pas tout à fait propre sert aussi.'),
        t('Mi, Mi mineur, La, La mineur, Do, Ré, Sol, puis E5 et A5.'),
      ],
      goal: 0,
      bpm: 60,
      steps: RECORDED_CHORDS.flatMap((chord, k) => [0, 1, 2, 3].map((i) => ({ beat: 10 * k + 2 * i, chord, hold: 2 }))),
    },
  ];
}

function teaching(): Lesson[] {
  return [
    {
      id: 'open-strings',
      title: t('Les six cordes'),
      learn: t('Chaque corde a sa couleur : la reconnaître et la jouer à vide, sans la main gauche.'),
      how: [
        t('Rouge = Mi grave, la plus grosse corde, la plus proche de ton visage. Puis jaune, bleu, orange, vert, et violet = Mi aigu, la plus fine.'),
        t('Une corde à vide s’affiche comme une barre : on la joue sans appuyer nulle part.'),
        t('Gratte une seule corde avec le médiator, vers le bas, quand la note touche la ligne.'),
      ],
      goal: 0.7,
      bpm: 60,
      steps: line(
        OPEN.flatMap((n) => [n, n]),
        2,
      ),
    },
    {
      id: 'in-time',
      title: t('En rythme'),
      learn: t('Jouer pile sur le clic du métronome, une corde à vide par temps.'),
      how: [
        t('Compte « 1, 2, 3, 4 » avec les clics avant la première note.'),
        t('Une note par clic : la note touche la ligne au moment du clic.'),
        t('Laisse le médiator tout près des cordes entre deux notes.'),
      ],
      goal: 0.7,
      bpm: 70,
      steps: line([...OPEN.flatMap((n) => [n, n]), ...OPEN.slice().reverse().flatMap((n) => [n, n])]),
    },
    {
      id: 'first-frets',
      title: t('Les premières cases'),
      learn: t('Appuyer sur une case avec la main gauche pour changer la note.'),
      how: [
        t('Appuie juste derrière la frette (la barre de métal), du bout du doigt, sans écraser.'),
        t('Un doigt par case : l’index sur la case 1, le majeur sur la 2, l’annulaire sur la 3, le petit doigt sur la 4.'),
        t('Le numéro sur la note est la case ; la lumière sur le manche montre où poser le doigt.'),
      ],
      goal: 0.65,
      bpm: 60,
      steps: line(
        [0, 1].flatMap((string) => FINGERS.flatMap((fret) => [[string, fret] as [number, number], [string, fret] as [number, number]])),
        2,
      ),
    },
    {
      id: 'spider',
      title: t('Le 1-2-3-4'),
      learn: t('Les quatre doigts l’un après l’autre, sur toutes les cordes : l’échauffement de tous les guitaristes.'),
      how: [
        t('Cases 1, 2, 3, 4 sur chaque corde, du Mi grave au Mi aigu.'),
        t('Laisse chaque doigt posé jusqu’à la note suivante.'),
        t('Lentement et proprement plutôt que vite.'),
      ],
      goal: 0.6,
      bpm: 60,
      steps: line([0, 1, 2, 3, 4, 5].flatMap((string) => FINGERS.map((fret) => [string, fret] as [number, number]))),
    },
    {
      id: 'melody',
      title: t('Ta première mélodie'),
      learn: t('« Au clair de la lune » sur deux cordes : la corde de Sol (orange) et celle de Si (verte).'),
      how: [
        t('Sol : la corde orange à vide. La : la même corde, case 2, avec le majeur. Si : la corde verte à vide.'),
        t('Les notes longues ont une traînée : laisse-les sonner jusqu’au bout.'),
        t('La mélodie passe deux fois.'),
      ],
      goal: 0.65,
      bpm: 80,
      steps: [...MOON, ...MOON.map((s) => ({ ...s, beat: s.beat + 16 }))],
    },
    {
      id: 'power-chord',
      title: t('Ton premier accord : E5'),
      learn: t('Trois cordes graves d’un coup : l’accord du rock, avec deux doigts.'),
      how: [
        t('Index sur la case 2 de la corde jaune (La), majeur sur la case 2 de la corde bleue (Ré). La corde rouge reste à vide.'),
        t('Gratte seulement les trois cordes du haut, d’un seul geste vers le bas.'),
        t('Un accord s’affiche dans un cadre, avec son nom.'),
      ],
      goal: 0.6,
      bpm: 70,
      steps: [...strums(repeat(6, ['E5']), 2), ...strums(repeat(8, ['E5']), 1, 12)],
    },
    {
      id: 'e-minor',
      title: t('Mi mineur (Em)'),
      learn: t('Le premier accord sur les six cordes, avec seulement deux doigts.'),
      how: [
        t('Majeur sur la case 2 de la corde jaune (La), annulaire sur la case 2 de la corde bleue (Ré).'),
        t('Gratte les six cordes vers le bas, de la rouge à la violette.'),
        t('Les numéros sur le manche disent quel doigt poser.'),
      ],
      goal: 0.6,
      bpm: 70,
      steps: [...strums(repeat(4, ['Em']), 4), ...strums(repeat(6, ['Em']), 2, 16)],
    },
    {
      id: 'a-minor',
      title: t('La mineur (Am)'),
      learn: t('Un accord à trois doigts, sans la corde de Mi grave.'),
      how: [
        t('Index case 1 de la corde verte (Si), majeur case 2 de la corde bleue (Ré), annulaire case 2 de la corde orange (Sol).'),
        t('Commence à gratter à la corde jaune (La) : la rouge ne sonne pas.'),
        t('Courbe les doigts pour ne pas toucher les cordes voisines.'),
      ],
      goal: 0.6,
      bpm: 70,
      steps: [...strums(repeat(4, ['Am']), 4), ...strums(repeat(6, ['Am']), 2, 16)],
    },
    {
      id: 'chord-change',
      title: t('Changer d’accord'),
      learn: t('Passer de Mi mineur à La mineur sans perdre le rythme.'),
      how: [
        t('Majeur et annulaire gardent leur forme : ils descendent ensemble d’une corde, puis l’index se pose case 1 de la corde verte.'),
        t('Prépare le changement pendant le dernier temps de l’accord.'),
        t('Trop rapide ? Ralentis avec la flèche ↓ pour t’entraîner, puis reviens à 100 % pour réussir la leçon.'),
      ],
      goal: 0.6,
      bpm: 60,
      steps: strums(repeat(4, ['Em', 'Am']), 4),
    },
    {
      id: 'first-riff',
      title: t('Ton premier riff'),
      learn: t('Trois power chords qui s’enchaînent : E5, G5 et A5, comme dans un vrai morceau de rock.'),
      how: [
        t('G5 : index case 3 sur la rouge, annulaire et petit doigt case 5 sur la jaune et la bleue. Même forme que E5, avec un doigt de plus.'),
        t('A5 : corde jaune à vide, index et majeur case 2 sur la bleue et l’orange.'),
        t('Le riff passe quatre fois : regarde où va la main avant le changement.'),
      ],
      goal: 0.6,
      bpm: 80,
      steps: [0, 8, 16, 24].flatMap((bar) => [
        { beat: bar, chord: 'E5', hold: 2 },
        { beat: bar + 2, chord: 'G5', hold: 2 },
        { beat: bar + 4, chord: 'A5', hold: 4 },
      ]),
    },
  ];
}

const isChord = (s: Step): s is Extract<Step, { chord: string }> => 'chord' in s;

/** Where the index finger goes for `step`, the hand at `hand` before it (frets `hand` to
 * `hand + 3`, one finger each): a note inside stays there; a chord puts the index where its own
 * fingering says. */
function indexFret(step: Step, hand: number): number {
  if (isChord(step)) {
    const { frets, fingers } = CHORDS[step.chord];
    const pressed = frets.map((fret, s) => ({ fret, finger: fingers[s] })).filter((x) => x.fret > 0 && x.finger > 0);
    if (!pressed.length) return hand;
    const first = pressed.reduce((a, b) => (b.finger < a.finger ? b : a));
    return Math.max(1, first.fret - first.finger + 1);
  }
  if (step.fret === 0 || (step.fret >= hand && step.fret < hand + 4)) return hand;
  return step.fret < hand ? step.fret : Math.max(1, step.fret - 3);
}

/** The lesson as a chart the engine plays: a bar of metronome, then the steps, standard tuning. */
/** How fast a lesson goes, against its own tempo: slower while the fingers look for the frets. */
export const LESSON_PACES = [
  // The song stops on each note or chord and goes on once it is played: time to place the fingers.
  { id: 'wait', label: t('Attente'), factor: 1 },
  { id: 'slow', label: t('Lent'), factor: 0.5 },
  { id: 'normal', label: t('Normal'), factor: 1 },
  { id: 'fast', label: t('Rapide'), factor: 1.25 },
] as const;
export type LessonPace = (typeof LESSON_PACES)[number]['id'];
export const paceFactor = (pace: LessonPace): number => LESSON_PACES.find((p) => p.id === pace)?.factor ?? 1;

/** Lesson `index` as a chart, at `pace` times its tempo. */
export function lessonChart(lesson: Lesson, index: number, pace = 1): Chart {
  const spb = 60 / (lesson.bpm * pace);
  const at = (beat: number) => (LEAD + beat) * spb;
  const steps = [...lesson.steps].sort((a, b) => a.beat - b.beat);
  const names = [...new Set(steps.filter(isChord).map((s) => s.chord))];
  const templates: ChordTemplate[] = names.map((name) => ({ name, ...CHORDS[name] }));
  const notes: Note[] = [];
  const chords: Chord[] = [];
  const handShapes: HandShape[] = [];
  // The hand starts in first position and moves when a step needs it, a beat ahead (at most
  // halfway from the step before).
  const anchors: Anchor[] = [{ time: 0, fret: 1, width: 4 }];
  let hand = 1;
  let before = 0;
  for (const s of steps) {
    const time = at(s.beat);
    const hold = s.hold ?? 1;
    // A note held for more than a beat shows its trail.
    const sustain = hold > 1 ? (hold - 0.5) * spb : 0;
    const fret = indexFret(s, hand);
    if (fret !== hand) {
      const move = Math.max(before + (time - before) / 2, time - spb);
      if (move <= anchors[anchors.length - 1].time) anchors[anchors.length - 1].fret = fret;
      else anchors.push({ time: move, fret, width: 4 });
      hand = fret;
    }
    before = time;
    if (isChord(s)) {
      const template = names.indexOf(s.chord);
      chords.push({ time, template, sustain, levels: [0, 0], strum: 'down' });
      handShapes.push({ template, start: time, end: time + hold * spb * 0.9 });
    } else notes.push({ time, string: s.string, fret: s.fret, sustain, levels: [0, 0], ...(s.techniques ? { techniques: s.techniques } : {}) });
  }
  const last = steps.reduce((m, s) => Math.max(m, s.beat + (s.hold ?? 1)), 0);
  const beats = LEAD + Math.ceil(last / 4) * 4 + TAIL;
  const duration = beats * spb;
  const title = lesson.record || lesson.drill ? lesson.title : t('Leçon {n} · {title}', { n: index + 1, title: lesson.title });
  return {
    format: 'opensmith-chart',
    version: 1,
    meta: { title, artist: t('Leçons OpenSmith'), album: null, year: null, duration, source: { kind: 'lesson', file: lesson.id }, generator: 'opensmith-lessons' },
    audio: { backing: null, guitar: null, mix: null, offset: 0 },
    arrangement: { name: 'Lead', type: 'lead', tuning: { name: 'E Standard', strings: [...STANDARD] }, capo: 0, maxDifficulty: 0 },
    tempo: { bpm: lesson.bpm * pace, timeSignature: [4, 4] },
    beats: Array.from({ length: beats + 1 }, (_, k) => (k % 4 === 0 ? { time: k * spb, bar: k / 4 + 1 } : { time: k * spb })),
    sections: [{ name: lesson.title, start: 0, end: duration }],
    phrases: [{ name: lesson.title, start: 0, end: duration, maxDifficulty: 0 }],
    chordTemplates: templates,
    notes,
    chords,
    anchors,
    handShapes,
  };
}

/** The best share of notes played in each lesson, by id. */
export type LessonRecords = Record<string, number>;

const KEY = 'opensmith.lessons';

export function loadLessons(): LessonRecords {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown;
    if (!raw || typeof raw !== 'object') return {};
    return Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === 'number' && v >= 0 && v <= 1)) as LessonRecords;
  } catch {
    return {};
  }
}

/** Keeps `accuracy` if it beats the lesson's best; the records as they now are. */
export function recordLesson(records: LessonRecords, id: string, accuracy: number): LessonRecords {
  if ((records[id] ?? -1) >= accuracy) return records;
  const next = { ...records, [id]: accuracy };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // storage unavailable: the best is kept until the app closes
  }
  return next;
}

export const passed = (lesson: Lesson, records: LessonRecords): boolean => !lesson.record && (records[lesson.id] ?? 0) >= lesson.goal;

/** The first lesson not passed yet (the last one once all are); recording sessions aside. */
export function nextLesson(list: readonly Lesson[], records: LessonRecords): number {
  const i = list.findIndex((l) => !l.record && !passed(l, records));
  if (i >= 0) return i;
  return list.reduce((last, l, k) => (l.record ? last : k), 0);
}
