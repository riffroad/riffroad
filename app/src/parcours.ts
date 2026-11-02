/**
 * The learning path: chapters of notions, each taught by three exercises that ask a little more
 * (step by step, the game waiting for each note; in time, slower, with the band; at tempo with
 * the band, twice as long). An exercise passes when the notion's own notes reach its goal; a
 * notion is learned at two stars, which opens the next one, and a chapter opens once the one
 * before is learned. A challenge (`bonus`) can be played once the notion before it is learned,
 * but nothing waits for it. The best of each exercise is kept with the lessons' records (synced
 * online).
 */
import type { BackingStyle } from './backing';
import type { Chart, Techniques } from './chart';
import type { SongEntry } from './engine/types';
import type { ViewItem } from './game/view';
import { t } from './i18n';
import { CHORDS, isChord, lessons, type Lesson, type LessonRecords, type Step } from './lessons';
import type { SymbolId } from './lexicon';
import { isDraft, partsOf } from './library';

/** Which of an exercise's notes say whether its notion is played: all of them, its chords, or
 * its notes played with that technique. */
export type Focus = 'all' | 'chords' | 'palmMute' | 'mute' | 'hammerOn' | 'pullOff' | 'slide' | 'vibrato' | 'bend';

export interface Exercise {
  id: string;
  /** Step by step, in time, with the band; or a chapter's test. */
  kind: 'step' | 'time' | 'band' | 'test';
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
  /** Its chapter's id. */
  chapter: string;
  title: string;
  /** What it teaches, why it matters. */
  learn: string;
  why: string;
  how: string[];
  /** The highway's symbol it teaches to read, if any. */
  symbol: SymbolId | null;
  focus: Focus;
  exercises: Exercise[];
  /** A challenge: nothing after it waits for it, and the chapter's test leaves it out. */
  bonus?: boolean;
}

export interface Chapter {
  id: string;
  title: string;
  blurb: string;
  notions: Notion[];
  /** Its notions one after the other, at tempo with the band: passed, the chapter is learned
   * (a player who already knows it skips it). */
  test: Exercise;
}

/** Share of a chapter test's notes to play to skip the chapter. */
export const TEST_GOAL = 0.8;
export const testId = (chapter: string): string => `p.test.${chapter}`;

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
  bonus?: boolean;
}

/** The three exercises of a notion (its chapter set by `chapter`). */
function notion(b: Base): Notion {
  const lesson = (id: string, title: string, steps: Step[], goal: number): Lesson => ({ id, title, learn: b.learn, how: b.how, goal, bpm: b.bpm, steps });
  const twice = [...b.steps, ...b.steps.map((s) => ({ ...s, beat: s.beat + span(b.steps) }))];
  const roots = b.roots ?? [];
  return {
    id: b.id,
    chapter: '',
    title: b.title,
    learn: b.learn,
    why: b.why,
    how: b.how,
    symbol: b.symbol,
    focus: b.focus,
    ...(b.bonus ? { bonus: true } : {}),
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

/** A chapter: its notions stamped with its id, and its test (their first exercises' steps one
 * after the other, at the chapter's usual tempo, over the band of its last notion). */
function chapter(id: string, title: string, blurb: string, notions: Notion[]): Chapter {
  const stamped = notions.map((n) => ({ ...n, chapter: id }));
  const steps: Step[] = [];
  let at = 0;
  for (const n of stamped.filter((n) => !n.bonus)) {
    const own = n.exercises[0].lesson.steps;
    steps.push(...own.map((s) => ({ ...s, beat: s.beat + at })));
    at += span(own);
  }
  const tempos = required(stamped).map((n) => n.exercises[0].lesson.bpm).sort((a, b) => a - b);
  const bpm = tempos[Math.floor(tempos.length / 2)];
  const kept = required(stamped);
  const last = kept[kept.length - 1].exercises[2];
  const name = t('Test du chapitre');
  const lesson: Lesson = { id: testId(id), title: name, learn: blurb, how: [], goal: TEST_GOAL, bpm, steps };
  return { id, title, blurb, notions: stamped, test: { id: testId(id), kind: 'test', title: name, lesson, wait: false, pace: 1, backing: last.backing, roots: [], goal: TEST_GOAL } };
}

/** The notions of a chapter that the ones after wait for: all but its challenges. */
export function required(notions: readonly Notion[]): Notion[] {
  return notions.filter((n) => !n.bonus);
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

/** `chords` one after the other, each `hold` beats, from beat `from`. */
const strumsOf = (chords: string[], hold: number, from = 0): Step[] => chords.map((chord, i) => ({ beat: from + i * hold, chord, hold }));
const repeatOf = <T>(n: number, items: T[]): T[] => Array.from({ length: n }, () => items).flat();

/** A note (string, fret, techniques) on each of `beats`. */
const at = (beats: number[], note: { string: number; fret: number; hold?: number; techniques?: Techniques }): Step[] => beats.map((beat) => ({ ...note, beat }));
const range = (from: number, to: number, every: number): number[] => Array.from({ length: Math.round((to - from) / every) }, (_, i) => from + i * every);

/** One note on `beat`, held `hold` beats, with `techniques`. */
const note = (beat: number, string: number, fret: number, hold?: number, techniques?: Techniques): Step => ({ beat, string, fret, ...(hold ? { hold } : {}), ...(techniques ? { techniques } : {}) });
/** Notes ([string, fret]) one after the other, every `every` beats from beat `from`. */
const line = (from: number, every: number, notes: readonly (readonly [number, number])[]): Step[] => notes.map(([string, fret], i) => note(from + i * every, string, fret));

/** The A minor pentatonic around fret 5, from the low string up: two notes per string. */
const BOX1 = [[0, 5], [0, 8], [1, 5], [1, 7], [2, 5], [2, 7], [3, 5], [3, 7], [4, 5], [4, 8], [5, 5], [5, 8]] as const;
/** The first four frets from 5 on each string, from the low string up: a finger per fret. */
const CHROMATIC = [0, 1, 2, 3, 4, 5].flatMap((string) => [5, 6, 7, 8].map((fret) => [string, fret] as const));
const PM: Techniques = { palmMute: true };
/** A gallop on the low E, muted: an eighth and two sixteenths on each beat of `beats`. */
const gallop = (beats: number[]): Step[] => beats.flatMap((b) => at([b, b + 0.5, b + 0.75], { string: 0, fret: 0, techniques: PM }));

/** The chapters, in order, in the interface language. */
export function chapters(): Chapter[] {
  return [
    chapter('basics', t('Prise en main'), t('Les cordes, les cases, le rythme : de quoi jouer tes premières notes en mesure.'), [
        notion(from('open-strings', { why: t('Tout part de là : savoir quelle corde est laquelle, au premier coup d’œil.'), symbol: 'open', focus: 'all', backing: 'pulse' })),
        notion(from('in-time', { why: t('Une note juste mais en retard sonne faux : le rythme compte autant que la note.'), symbol: null, focus: 'all', backing: 'pulse' })),
        notion(from('first-frets', { why: t('Appuyer derrière la bonne case, c’est la moitié de la guitare.'), symbol: 'fret', focus: 'all', backing: 'pulse' })),
        notion(from('spider', { why: t('Un doigt par case : la main reste en place et va plus vite.'), symbol: null, focus: 'all', backing: 'pulse' })),
        notion(from('melody', { why: t('Tenir une note jusqu’au bout, c’est ce qui fait chanter une mélodie.'), symbol: 'sustain', focus: 'all', backing: 'pulse', roots: ['G', 'G', 'D', 'G'] })),
    ]),
    chapter('power', t('Power chords et palm mute'), t('Le son du rock : des accords à deux doigts, étouffés ou lâchés, sur un vrai groupe.'), [
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
    ]),
    chapter('open', t('Accords ouverts'), t('Les accords qui sonnent sur les six cordes, et passer de l’un à l’autre sans casser le rythme.'), [
        notion(from('e-minor', { why: t('Le premier accord sur six cordes, avec deux doigts seulement.'), symbol: 'chord', focus: 'chords', backing: 'pulse' })),
        notion(from('a-minor', { why: t('Avec Mi mineur, il ouvre des centaines de chansons.'), symbol: 'chord', focus: 'chords', backing: 'pulse' })),
        notion(from('chord-change', { why: t('Changer d’accord à temps, c’est ce qui fait tenir une chanson.'), symbol: null, focus: 'chords', backing: 'ballad' })),
        notion({
          id: 'd-major',
          title: t('Ré majeur (D)'),
          learn: t('Un petit triangle de trois doigts sur les cordes aiguës : l’accord lumineux des chansons.'),
          why: t('Avec Sol et Do, il fait tourner la moitié des chansons populaires.'),
          how: [
            t('Index case 2 de la corde orange, majeur case 2 de la violette, annulaire case 3 de la verte.'),
            t('Gratte seulement les quatre cordes aiguës, à partir de la bleue (Ré à vide).'),
            t('Arrondis les doigts : chaque corde doit sonner nette.'),
          ],
          symbol: 'chord',
          focus: 'chords',
          bpm: 60,
          backing: 'ballad',
          steps: [...strumsOf(['D', 'D', 'D', 'D'], 4), ...strumsOf(['D', 'D', 'D', 'D', 'D', 'D', 'D', 'D'], 2, 16)],
        }),
        notion({
          id: 'g-and-c',
          title: t('Sol et Do (G, C)'),
          learn: t('Les deux accords qui reviennent partout, et le chemin de l’un à l’autre.'),
          why: t('Sol et Do s’enchaînent dans des milliers de chansons : ce changement-là vaut de l’or.'),
          how: [
            t('Sol : majeur case 3 de la rouge, index case 2 de la jaune, annulaire case 3 de la violette.'),
            t('Do : annulaire case 3 de la jaune, majeur case 2 de la bleue, index case 1 de la verte ; la rouge ne sonne pas.'),
            t('Pendant le changement, garde l’annulaire et le majeur près des cordes : ils n’ont qu’une corde à descendre.'),
          ],
          symbol: 'chord',
          focus: 'chords',
          bpm: 60,
          backing: 'ballad',
          steps: strumsOf(['G', 'G', 'C', 'C', 'G', 'G', 'C', 'C'], 2),
        }),
        notion({
          id: 'four-chords',
          title: t('Morceau d’étape : quatre accords'),
          learn: t('Sol, Ré, Mi mineur, Do : la grille qui porte des centaines de chansons.'),
          why: t('Quatre accords appris séparément deviennent une chanson quand ils s’enchaînent sans pause.'),
          how: [
            t('Un accord par mesure, deux coups par accord.'),
            t('Prépare le suivant pendant le dernier coup : la main part avant que l’accord change.'),
            t('Si un changement coince, rejoue l’exercice pas à pas.'),
          ],
          symbol: null,
          focus: 'chords',
          bpm: 70,
          backing: 'ballad',
          steps: strumsOf(['G', 'G', 'D', 'D', 'Em', 'Em', 'C', 'C', 'G', 'G', 'D', 'D', 'Em', 'Em', 'C', 'C'], 2),
        }),
        notion({
          id: 'chord-race',
          title: t('Défi : la course aux changements'),
          learn: t('Les mêmes quatre accords, de plus en plus serrés : toutes les mesures, puis tous les deux temps, puis à chaque temps.'),
          why: t('C’est la vitesse des changements qui fait passer de « je connais les accords » à « je joue la chanson ».'),
          how: [
            t('Quatre temps par accord, puis deux, puis un seul : la course accélère d’elle-même.'),
            t('Ne regarde pas tes doigts : regarde l’accord qui arrive sur l’autoroute.'),
            t('Un défi pour aller plus loin : la suite du Parcours ne l’attend pas.'),
          ],
          symbol: null,
          focus: 'chords',
          bpm: 70,
          backing: 'rock',
          bonus: true,
          steps: [
            ...strumsOf(['Em', 'Am', 'G', 'C'], 4),
            ...strumsOf(repeatOf(2, ['Em', 'Am', 'G', 'C']), 2, 16),
            ...strumsOf(repeatOf(4, ['Em', 'Am', 'G', 'C']), 1, 32),
          ],
        }),
    ]),
    chapter('rhythm', t('Rythmique'), t('La main droite qui fait danser un morceau : coups sur les temps, entre les temps, étouffés, en motif.'), [
        notion({
          id: 'quarter-strums',
          title: t('Un coup par temps'),
          learn: t('Gratter un accord sur chaque temps, régulier comme une horloge, en changeant d’accord sans s’arrêter.'),
          why: t('La base de tout accompagnement : un rythme qui ne bouge pas, quoi qu’il arrive.'),
          how: [
            t('Un coup vers le bas sur chaque temps, en comptant 1, 2, 3, 4.'),
            t('Le poignet reste souple : c’est lui qui bouge, pas le bras.'),
            t('Change d’accord sur le 1, sans retarder le coup.'),
          ],
          symbol: null,
          focus: 'chords',
          bpm: 75,
          backing: 'rock',
          steps: strumsOf(['G', 'G', 'G', 'G', 'C', 'C', 'C', 'C', 'G', 'G', 'G', 'G', 'C', 'C', 'C', 'C'], 1),
        }),
        notion({
          id: 'eighth-strums',
          title: t('Les croches : bas, haut'),
          learn: t('Deux coups par temps : vers le bas sur le temps, vers le haut entre les temps.'),
          why: t('Le va-et-vient de la main droite donne son élan à presque tous les morceaux.'),
          how: [
            t('La main descend sur le temps et remonte entre les temps, sans jamais s’arrêter.'),
            t('Vers le haut, il suffit de toucher les cordes aiguës.'),
            t('Compte « 1 et 2 et 3 et 4 et » : chaque syllabe est un coup.'),
          ],
          symbol: null,
          focus: 'chords',
          bpm: 65,
          backing: 'rock',
          steps: strumsOf([...repeatOf(8, ['Em']), ...repeatOf(8, ['Am'])], 0.5),
        }),
        notion({
          id: 'offbeat',
          title: t('Le contretemps'),
          learn: t('Gratter entre les temps seulement : la main bouge sur le temps sans toucher les cordes.'),
          why: t('Le contretemps fait sautiller un rythme : c’est le cœur du ska, du reggae et de bien des refrains.'),
          how: [
            t('La main continue son va-et-vient, mais ne touche les cordes qu’en remontant.'),
            t('Compte « 1 et 2 et » : les coups tombent sur les « et ».'),
            t('Écoute la caisse claire : ton coup tombe juste entre ses frappes.'),
          ],
          symbol: null,
          focus: 'chords',
          bpm: 80,
          backing: 'rock',
          steps: [...repeatOf(8, ['G']), ...repeatOf(8, ['D'])].map((chord, i) => ({ beat: i + 0.5, chord, hold: 0.5 })),
        }),
        notion({
          id: 'strum-mutes',
          title: t('Le « tchak » dans le rythme'),
          learn: t('Un accord sur les temps 1 et 3, un coup étouffé sur 2 et 4 : la caisse claire de la guitare.'),
          why: t('Les coups étouffés donnent du relief au rythme sans ajouter de notes.'),
          how: [
            t('Accord sur le 1 et le 3, puis relâche la main gauche pour le ✕ sur le 2 et le 4.'),
            t('Ne lève pas les doigts : ils restent sur les cordes, sans appuyer.'),
            t('Le ✕ doit claquer aussi fort que l’accord.'),
          ],
          symbol: 'mute',
          focus: 'all',
          bpm: 80,
          backing: 'rock',
          steps: range(0, 16, 2).flatMap((beat) => [
            { beat, chord: beat < 8 ? 'Am' : 'Em' },
            { beat: beat + 1, string: 2, fret: 2, techniques: { mute: true } },
          ]),
        }),
        notion({
          id: 'strum-pattern',
          title: t('Morceau d’étape : le motif universel'),
          learn: t('Bas, bas-haut, haut-bas-haut : le motif de grattage qui va sur presque toutes les chansons.'),
          why: t('Un seul motif, et tu peux accompagner des centaines de morceaux.'),
          how: [
            t('Sur une mesure : bas sur le 1, bas-haut sur le 2, haut sur le « et » du 3, puis bas-haut sur le 4.'),
            t('La main ne s’arrête jamais : sur le 3, elle descend dans le vide.'),
            t('Un accord par mesure : Sol, Do, Ré, Sol.'),
          ],
          symbol: null,
          focus: 'chords',
          bpm: 75,
          backing: 'ballad',
          steps: ['G', 'C', 'D', 'G'].flatMap((chord, bar) => [0, 1, 1.5, 2.5, 3, 3.5].map((b) => ({ beat: bar * 4 + b, chord, hold: 0.5 }))),
        }),
    ]),
    chapter('left-hand', t('Main gauche'), t('Les notes qui chantent sans regratter : liés, glissés, vibrato et bends, sur un groupe de blues.'), [
        notion({
          id: 'hammer-on',
          title: t('Le hammer-on (H)'),
          learn: t('Faire sonner une deuxième note en frappant la case, sans regratter.'),
          why: t('Les liés rendent un solo fluide : moins de coups de médiator, plus de chant.'),
          how: [
            t('Gratte la corde orange à vide, puis frappe la case 2 du bout du majeur, fort et net.'),
            t('Ne regratte pas : c’est le doigt qui fait sonner la note marquée H.'),
            t('Frappe près de la frette : plus la note est proche, plus elle sonne.'),
          ],
          symbol: 'hammerOn',
          focus: 'hammerOn',
          bpm: 70,
          backing: 'shuffle',
          roots: ['E', 'E', 'A', 'E'],
          steps: range(0, 16, 2).flatMap((beat) => {
            const string = beat < 8 ? 3 : 2;
            return [
              { beat, string, fret: 0 },
              { beat: beat + 1, string, fret: 2, techniques: { hammerOn: true } },
            ];
          }),
        }),
        notion({
          id: 'pull-off',
          title: t('Le pull-off (P)'),
          learn: t('L’inverse du hammer-on : retirer le doigt pour faire sonner la note plus grave.'),
          why: t('Hammer-on et pull-off ensemble : les trilles et les liés de tous les solos.'),
          how: [
            t('Case 2 de la corde orange, gratte, puis retire le doigt en tirant un peu la corde vers le sol.'),
            t('Ce petit coup de doigt fait sonner la corde à vide, marquée P.'),
            t('Garde la main posée : seul le doigt bouge.'),
          ],
          symbol: 'pullOff',
          focus: 'pullOff',
          bpm: 70,
          backing: 'shuffle',
          roots: ['E', 'E', 'A', 'E'],
          steps: range(0, 16, 2).flatMap((beat) => {
            const string = beat < 8 ? 3 : 2;
            return [
              { beat, string, fret: 2 },
              { beat: beat + 1, string, fret: 0, techniques: { pullOff: true } },
            ];
          }),
        }),
        notion({
          id: 'slide',
          title: t('Le glissé (/ et \\)'),
          learn: t('Glisser d’une case à une autre sans lever le doigt : la note voyage.'),
          why: t('Le glissé relie les positions du manche et donne une voix aux mélodies.'),
          how: [
            t('Case 2 de la corde orange, gratte, puis glisse jusqu’à la case 4 en gardant la pression.'),
            t('Le / monte vers l’aigu, le \\ redescend.'),
            t('Ne relâche pas en route, sinon la note s’éteint.'),
          ],
          symbol: 'slide',
          focus: 'slide',
          bpm: 65,
          backing: 'shuffle',
          roots: ['E', 'E', 'A', 'E'],
          steps: range(0, 16, 4).flatMap((beat) => [
            { beat, string: 3, fret: 2, hold: 2, techniques: { slideTo: 4 } },
            { beat: beat + 2, string: 3, fret: 4, hold: 2, techniques: { slideTo: 2 } },
          ]),
        }),
        notion({
          id: 'vibrato',
          title: t('Le vibrato (~)'),
          learn: t('Faire onduler une note tenue : la touche personnelle d’un guitariste.'),
          why: t('Une note longue sans vibrato est plate ; avec, elle chante.'),
          how: [
            t('Case 5 de la corde verte, tenue longtemps.'),
            t('Pousse et relâche la corde en rythme, du poignet, sans changer de case.'),
            t('Un vibrato régulier vaut mieux qu’un vibrato rapide.'),
          ],
          symbol: 'vibrato',
          focus: 'vibrato',
          bpm: 70,
          backing: 'shuffle',
          roots: ['E', 'E', 'A', 'E'],
          steps: range(0, 16, 4).map((beat, i) => ({ beat, string: 4, fret: i % 2 ? 7 : 5, hold: 3, techniques: { vibrato: true } })),
        }),
        notion({
          id: 'bend',
          title: t('Le bend'),
          learn: t('Pousser la corde pour faire monter la note d’un ton : le cri des solos de rock et de blues.'),
          why: t('Aucune autre technique ne fait autant chanter une guitare électrique.'),
          how: [
            t('Case 7 de la corde orange, trois doigts dessus : l’annulaire appuie, le majeur et l’index l’aident.'),
            t('Pousse la corde vers le haut jusqu’à entendre la note de la case 9, puis tiens-la.'),
            t('Vise la note : un bend trop court sonne faux.'),
          ],
          symbol: 'bend',
          focus: 'bend',
          bpm: 60,
          backing: 'shuffle',
          roots: ['E', 'E', 'A', 'E'],
          steps: range(0, 16, 4).map((beat) => ({ beat, string: 3, fret: 7, hold: 3, techniques: { bend: 2 } })),
        }),
        notion({
          id: 'blues-lick',
          title: t('Morceau d’étape : un lick de blues'),
          learn: t('Hammer-on, pull-off, glissé et vibrato dans une même phrase, sur la gamme pentatonique de Mi.'),
          why: t('Un lick, c’est une petite phrase toute faite : le vocabulaire de tous les solos.'),
          how: [
            t('Tout se joue cases 5 et 7, l’index sur la 5, l’annulaire sur la 7.'),
            t('Les H et P se jouent sans regratter, le glissé sans lever le doigt.'),
            t('La dernière note tient, avec du vibrato.'),
          ],
          symbol: null,
          focus: 'all',
          bpm: 70,
          backing: 'shuffle',
          roots: ['E', 'A', 'E', 'E'],
          steps: [0, 8].flatMap((bar) => [
            { beat: bar, string: 3, fret: 5 },
            { beat: bar + 0.5, string: 3, fret: 7, techniques: { hammerOn: true } },
            { beat: bar + 1, string: 2, fret: 7 },
            { beat: bar + 1.5, string: 2, fret: 5, techniques: { pullOff: true } },
            { beat: bar + 2, string: 1, fret: 7, hold: 1, techniques: { slideTo: 5 } },
            { beat: bar + 3, string: 2, fret: 5 },
            { beat: bar + 4, string: 3, fret: 5, hold: 3, techniques: { vibrato: true } },
          ]),
        }),
    ]),
    chapter('lead', t('Le solo'), t('La gamme de tous les solos de rock et de blues, deux positions sur le manche, et des phrases qui chantent.'), [
        notion({
          id: 'penta-box1',
          title: t('La pentatonique de La mineur'),
          learn: t('La gamme de presque tous les solos : deux notes par corde, la main posée case 5.'),
          why: t('Avec cette seule position, tu peux improviser sur des milliers de morceaux en La mineur.'),
          how: [
            t('Index case 5, annulaire case 7, auriculaire case 8 : la main ne bouge pas.'),
            t('Deux notes par corde, de la rouge à la violette, puis retour.'),
            t('Le La, case 5 de la rouge et case 7 de la bleue, est la maison de la gamme : les phrases s’y posent.'),
          ],
          symbol: null,
          focus: 'all',
          bpm: 72,
          backing: 'rock',
          roots: repeatOf(6, ['A']),
          steps: [...line(0, 1, BOX1), ...line(12, 1, [...BOX1].reverse())],
        }),
        notion({
          id: 'penta-runs',
          title: t('Les runs en croches'),
          learn: t('Dévaler la gamme deux notes par corde, en croches, et finir sur une note tenue.'),
          why: t('Un run bien en place, c’est la phrase rapide qui fait décoller un solo.'),
          how: [
            t('Une note par croche, en aller-retour du médiator : bas, haut, bas, haut.'),
            t('La main gauche reste case 5 ; seuls les doigts bougent.'),
            t('La note tenue à la fin de chaque phrase chante avec un peu de vibrato.'),
          ],
          symbol: null,
          focus: 'all',
          bpm: 80,
          backing: 'rock',
          roots: ['A', 'A', 'D', 'A'],
          steps: [
            ...line(0, 0.5, [[5, 8], [5, 5], [4, 8], [4, 5], [3, 7], [3, 5], [2, 7], [2, 5]]),
            ...line(4, 0.5, [[3, 5], [3, 7]]),
            note(5, 2, 7, 3, { vibrato: true }),
            ...line(8, 0.5, [[2, 5], [2, 7], [3, 5], [3, 7], [4, 5], [4, 8], [5, 5], [5, 8]]),
            ...line(12, 0.5, [[4, 8], [4, 5]]),
            note(13, 5, 5, 3, { vibrato: true }),
          ],
        }),
        notion({
          id: 'penta-box2',
          title: t('La deuxième position'),
          learn: t('Un glissé sur la corde orange emmène la main case 8 : la gamme continue plus haut.'),
          why: t('Rester case 5, c’est rejouer toujours les mêmes phrases ; deux positions, c’est deux fois plus d’idées.'),
          how: [
            t('Le glissé de la case 7 à la 9 sur la corde orange emmène toute la main.'),
            t('Là-haut, sur les cordes verte et violette : index case 8, annulaire case 10.'),
            t('Le glissé inverse, de la 9 à la 7, ramène la main case 5.'),
          ],
          symbol: 'slide',
          focus: 'all',
          bpm: 70,
          backing: 'rock',
          roots: ['A', 'A', 'D', 'A'],
          steps: [
            note(0, 3, 5),
            note(1, 3, 7, 1, { slideTo: 9 }),
            ...line(2, 1, [[4, 8], [4, 10], [5, 8], [5, 10]]),
            note(6, 4, 10, 2, { vibrato: true }),
            note(8, 4, 8),
            note(9, 3, 9, 1, { slideTo: 7 }),
            ...line(10, 1, [[3, 5], [2, 7], [2, 5]]),
            note(13, 2, 7, 3, { vibrato: true }),
          ],
        }),
        notion({
          id: 'phrasing',
          title: t('Le phrasé : question, réponse'),
          learn: t('Une phrase qui reste en l’air sur un bend, une autre qui lui répond et se pose sur le La.'),
          why: t('Un solo n’est pas une gamme jouée vite : ce sont des phrases qui respirent, comme une voix.'),
          how: [
            t('La question finit sur un bend tenu : elle attend une réponse.'),
            t('La réponse redescend et se pose sur le La, avec du vibrato.'),
            t('Les silences comptent : laisse la phrase respirer avant la suivante.'),
          ],
          symbol: null,
          focus: 'all',
          bpm: 70,
          backing: 'shuffle',
          roots: ['A', 'A', 'D', 'A'],
          steps: [
            ...line(0, 0.5, [[4, 5], [4, 8], [5, 5], [4, 8]]),
            note(2, 3, 7, 2, { bend: 2 }),
            ...line(4, 0.5, [[4, 8], [4, 5], [3, 7], [3, 5]]),
            note(6, 2, 7, 2, { vibrato: true }),
            ...line(8, 0.5, [[5, 8], [5, 5]]),
            note(9, 4, 8),
            note(10, 4, 8, 2, { bend: 2 }),
            ...line(12, 0.5, [[4, 5], [3, 7], [3, 5]]),
            note(14, 2, 7, 2, { vibrato: true }),
          ],
        }),
        notion({
          id: 'first-solo',
          title: t('Morceau d’étape : ton premier solo'),
          learn: t('Huit mesures : la gamme, un run, un bend, un glissé vers la deuxième position et retour, une dernière note qui chante.'),
          why: t('Tout le chapitre dans un vrai solo, sur le groupe.'),
          how: [
            t('Mesures 1 à 4 case 5, mesures 5 et 6 en deuxième position, retour case 5 pour finir.'),
            t('Les H et P sans regratter, les notes tenues avec vibrato.'),
            t('Si un passage coince, rejoue la notion qui le travaille.'),
          ],
          symbol: null,
          focus: 'all',
          bpm: 80,
          backing: 'rock',
          roots: ['A', 'A', 'D', 'A', 'E', 'D', 'A', 'A'],
          steps: [
            ...line(0, 0.5, [[2, 7], [3, 5], [3, 7], [4, 5]]),
            note(2, 4, 8, 2, { vibrato: true }),
            ...line(4, 0.5, [[4, 5], [3, 7], [3, 5], [2, 7], [2, 5]]),
            note(6.5, 2, 7, 1, { hammerOn: true }),
            ...line(8, 0.5, [[5, 5], [5, 8]]),
            note(9, 5, 5, 0, { pullOff: true }),
            note(9.5, 4, 8),
            note(10, 3, 7, 2, { bend: 2 }),
            ...line(12, 0.5, [[3, 5], [2, 7], [2, 5], [1, 7]]),
            note(14, 2, 7, 2, { vibrato: true }),
            note(16, 3, 7, 1, { slideTo: 9 }),
            ...line(17, 0.5, [[4, 8], [4, 10], [5, 8], [5, 10], [4, 10]]),
            note(20, 4, 10, 2, { bend: 2 }),
            ...line(22, 0.5, [[4, 8], [3, 9], [3, 7], [2, 10]]),
            note(24, 3, 9, 1, { slideTo: 7 }),
            ...line(25, 0.5, [[3, 5], [2, 7], [2, 5], [1, 7], [1, 5], [0, 8]]),
            note(28, 0, 5, 4, { vibrato: true }),
          ],
        }),
    ]),
    chapter('barre', t('Barrés et accords mobiles'), t('L’index couché sur le manche : le Fa, le Si mineur, et des formes qui voyagent pour jouer tous les accords.'), [
        notion({
          id: 'small-f',
          title: t('Le petit Fa (F)'),
          learn: t('Fa sur quatre cordes : l’index couche deux cordes, ton premier petit barré.'),
          why: t('Le Fa fait peur à tous les débutants : en commençant petit, la main s’y fait sans souffrir.'),
          how: [
            t('Index couché case 1 sur les cordes verte et violette.'),
            t('Majeur case 2 de la corde orange, annulaire case 3 de la bleue.'),
            t('Gratte seulement les quatre cordes aiguës ; roule un peu l’index sur sa tranche.'),
          ],
          symbol: 'chord',
          focus: 'chords',
          bpm: 60,
          backing: 'ballad',
          steps: [...strumsOf(['F-small', 'F-small'], 4), ...strumsOf(['C', 'F-small', 'C', 'F-small'], 2, 8)],
        }),
        notion({
          id: 'f-barre',
          title: t('Le Fa barré (F)'),
          learn: t('L’index couché sur les six cordes case 1 : le premier vrai barré.'),
          why: t('Une fois cette forme en main, elle se déplace partout : un seul doigté pour douze accords.'),
          how: [
            t('Index couché sur toute la case 1, tout près de la frette, appuyé sur sa tranche.'),
            t('Par-dessus, la forme de Mi : majeur case 2 de la corde orange, annulaire case 3 de la jaune, auriculaire case 3 de la bleue.'),
            t('Le pouce au milieu, derrière le manche : la main serre comme une pince, sans tirer avec le bras.'),
          ],
          symbol: 'chord',
          focus: 'chords',
          bpm: 60,
          backing: 'ballad',
          steps: [...strumsOf(['F', 'F', 'F', 'F'], 4), ...strumsOf(['C', 'C', 'F', 'F', 'Am', 'Am', 'F', 'F'], 2, 16)],
        }),
        notion({
          id: 'moving-barre',
          title: t('Le barré qui voyage (F, G, A)'),
          learn: t('La forme du Fa glissée case 3 puis case 5 : Fa, Sol, La, et La mineur.'),
          why: t('Le secret des barrés : une seule forme, et c’est la case qui donne le nom de l’accord.'),
          how: [
            t('Garde la forme, relâche un peu la pression et glisse toute la main.'),
            t('La note sous l’index, sur la corde rouge, donne le nom : case 1 Fa, case 3 Sol, case 5 La.'),
            t('Pour La mineur, lève le majeur : l’index barre aussi la corde orange.'),
          ],
          symbol: 'chord',
          focus: 'chords',
          bpm: 60,
          backing: 'rock',
          steps: strumsOf(['F', 'F', 'G-barre', 'G-barre', 'A-barre', 'A-barre', 'Am-barre', 'Am-barre'], 2),
        }),
        notion({
          id: 'b-minor',
          title: t('Si mineur (Bm)'),
          learn: t('Le barré sur cinq cordes, index case 2, la forme de La mineur au-dessus.'),
          why: t('Si mineur est l’accord qui bloque dans des centaines de chansons en Ré et en Sol.'),
          how: [
            t('Index couché case 2, de la corde jaune à la violette ; la rouge ne sonne pas.'),
            t('Annulaire case 4 de la bleue, auriculaire case 4 de la corde orange, majeur case 3 de la verte.'),
            t('Gratte à partir de la corde jaune.'),
          ],
          symbol: 'chord',
          focus: 'chords',
          bpm: 60,
          backing: 'ballad',
          steps: strumsOf(['Bm', 'Bm', 'G', 'G', 'D', 'D', 'A', 'A'], 2),
        }),
        notion({
          id: 'a-shape',
          title: t('La forme de La (C, D)'),
          learn: t('Do case 3, Ré case 5 : le barré en forme de La majeur, qui voyage lui aussi.'),
          why: t('Avec la forme de Mi et celle de La, tu as tous les accords, partout sur le manche.'),
          how: [
            t('Index couché case 3, de la corde jaune à la violette.'),
            t('Majeur, annulaire et auriculaire case 5 des cordes bleue, orange et verte.'),
            t('La note sous l’index, sur la corde jaune, donne le nom : case 3 Do, case 5 Ré.'),
          ],
          symbol: 'chord',
          focus: 'chords',
          bpm: 60,
          backing: 'rock',
          steps: strumsOf(['C-barre', 'C-barre', 'D-barre', 'D-barre', 'G-barre', 'G-barre', 'C-barre', 'C-barre'], 2),
        }),
        notion({
          id: 'barre-song',
          title: t('Morceau d’étape : la grille barrée'),
          learn: t('Do, Sol, La mineur, Fa, puis Si mineur, Sol, Ré, La : les barrés au milieu des accords ouverts.'),
          why: t('Dans les vraies chansons, le barré arrive entre deux accords ouverts : c’est ce passage qu’il faut rendre fluide.'),
          how: [
            t('Deux coups par accord, un accord par mesure.'),
            t('Pose l’index en barré pendant le dernier coup de l’accord d’avant.'),
            t('Si le Fa ne sonne pas encore partout, continue quand même : le rythme d’abord.'),
          ],
          symbol: null,
          focus: 'chords',
          bpm: 70,
          backing: 'ballad',
          steps: strumsOf(['C', 'C', 'G', 'G', 'Am', 'Am', 'F', 'F', 'Bm', 'Bm', 'G', 'G', 'D', 'D', 'A', 'A'], 2),
        }),
    ]),
    chapter('speed', t('Vitesse et précision'), t('Une main droite qui alterne sans y penser, une main gauche qui suit : plus vite, mais propre.'), [
        notion({
          id: 'alternate',
          title: t('L’aller-retour du médiator'),
          learn: t('Bas sur le temps, haut entre les temps, même quand la note change.'),
          why: t('Tout jouer vers le bas épuise la main ; l’aller-retour double la vitesse sans effort.'),
          how: [
            t('Le médiator descend sur le temps et remonte sur le « et », sans jamais s’arrêter.'),
            t('Des petits mouvements du poignet : le médiator reste près de la corde.'),
            t('Lentement et régulier d’abord : la vitesse vient toute seule.'),
          ],
          symbol: null,
          focus: 'all',
          bpm: 80,
          backing: 'rock',
          roots: ['A', 'A', 'D', 'A'],
          steps: [
            ...at(range(0, 4, 0.5), { string: 3, fret: 5 }),
            ...at(range(4, 8, 0.5), { string: 3, fret: 7 }),
            ...at(range(8, 12, 0.5), { string: 4, fret: 5 }),
            ...at(range(12, 16, 0.5), { string: 4, fret: 8 }),
          ],
        }),
        notion({
          id: 'sixteenths',
          title: t('Les doubles croches'),
          learn: t('Quatre notes par temps en aller-retour : le moteur des riffs rapides.'),
          why: t('Sans l’aller-retour, impossible de tenir les doubles croches des solos et des riffs de metal.'),
          how: [
            t('Quatre coups par temps, bas-haut-bas-haut, réguliers comme une machine à coudre.'),
            t('La main gauche change de note à chaque temps ; la droite ne s’arrête pas.'),
            t('Joue près du chevalet : des petits coups, propres et réguliers.'),
          ],
          symbol: null,
          focus: 'all',
          bpm: 60,
          backing: 'rock',
          roots: ['A', 'A'],
          steps: ([[5, 5], [5, 8], [4, 8], [4, 5], [3, 7], [3, 5], [2, 7], [2, 7]] as const).flatMap(([string, fret], beat) => at(range(beat, beat + 1, 0.25), { string, fret })),
        }),
        notion({
          id: 'string-crossing',
          title: t('Changer de corde sans accroc'),
          learn: t('L’accord égrené, une note par corde, de la grave à l’aiguë et retour.'),
          why: t('Passer d’une corde à l’autre sans rater ni accrocher la voisine : la précision de la main droite.'),
          how: [
            t('Pose l’accord en entier, puis joue ses cordes une à une.'),
            t('Bas en allant vers l’aigu, haut en revenant.'),
            t('Les doigts restent posés : chaque note sonne jusqu’à la suivante.'),
          ],
          symbol: null,
          focus: 'all',
          bpm: 70,
          backing: 'ballad',
          roots: ['A', 'E', 'A', 'E'],
          steps: [0, 8].flatMap((bar) => [
            ...line(bar, 0.5, [[1, 0], [2, 2], [3, 2], [4, 1], [5, 0], [4, 1], [3, 2], [2, 2]]),
            ...line(bar + 4, 0.5, [[0, 0], [1, 2], [2, 2], [3, 0], [4, 0], [3, 0], [2, 2], [1, 2]]),
          ]),
        }),
        notion({
          id: 'chromatic',
          title: t('Le chromatique, plus vite'),
          learn: t('Les quatre doigts, cases 5 à 8, sur chaque corde, en croches : la précision et la vitesse ensemble.'),
          why: t('Le grand classique de l’échauffement : il réveille chaque doigt et l’aller-retour du médiator.'),
          how: [
            t('Un doigt par case : index 5, majeur 6, annulaire 7, auriculaire 8.'),
            t('En montant, laisse les doigts posés ; ne lève que celui qu’il faut.'),
            t('Aller-retour du médiator sur chaque note, même en changeant de corde.'),
          ],
          symbol: null,
          focus: 'all',
          bpm: 80,
          backing: 'pulse',
          roots: repeatOf(6, ['A']),
          steps: [...line(0, 0.5, CHROMATIC), ...line(12, 0.5, [...CHROMATIC].reverse())],
        }),
        notion({
          id: 'gallop',
          title: t('Le galop'),
          learn: t('Une croche et deux doubles croches étouffées, en boucle : le riff au galop.'),
          why: t('Le galop fait avancer un riff comme une cavalerie : le palm mute à pleine vitesse.'),
          how: [
            t('Bas, puis bas-haut : un coup sur le temps, deux coups rapides sur sa deuxième moitié.'),
            t('La paume reste posée près du chevalet : toutes les notes PM restent sourdes.'),
            t('Les accords de fin de phrase se jouent lâchés, sans PM.'),
          ],
          symbol: 'palmMute',
          focus: 'palmMute',
          bpm: 75,
          backing: 'rock',
          roots: ['E', 'E', 'E', 'E'],
          steps: [...gallop(range(0, 12, 1)), { beat: 12, chord: 'G5', hold: 2 }, { beat: 14, chord: 'A5', hold: 2 }],
        }),
        notion({
          id: 'speed-riff',
          title: t('Morceau d’étape : le riff qui file'),
          learn: t('Palm mute en croches, des notes qui s’échappent, le galop et des power chords : un riff de rock rapide.'),
          why: t('La vitesse et la précision dans un vrai riff, sur le groupe.'),
          how: [
            t('La paume reste posée sur les PM et se lève pour les notes et les accords lâchés.'),
            t('Aller-retour du médiator d’un bout à l’autre.'),
            t('Commence pas à pas : la vitesse vient aux exercices suivants.'),
          ],
          symbol: null,
          focus: 'all',
          bpm: 95,
          backing: 'rock',
          roots: ['E', 'E', 'E', 'E'],
          steps: [0, 8].flatMap((bar) => [
            ...[0, 0, 3, 0, 0, 5, 0, 3].map((fret, i) => note(bar + i * 0.5, 0, fret, 0, fret ? undefined : PM)),
            ...gallop([bar + 4, bar + 5]),
            ...(bar ? [{ beat: bar + 6, chord: 'E5', hold: 2 }] : [{ beat: bar + 6, chord: 'G5' }, { beat: bar + 7, chord: 'A5' }]),
          ]),
        }),
    ]),
  ];
}

export const passedExercise = (e: Exercise, records: LessonRecords): boolean => (records[e.id] ?? 0) >= e.goal;

/** Exercises of `n` passed: its stars, 0 to 3. */
export const stars = (n: Notion, records: LessonRecords): number => n.exercises.filter((e) => passedExercise(e, records)).length;

/** Learned: in time with the band at least (two stars, the first two exercises), or its
 * chapter's test passed. */
export const learned = (n: Notion, records: LessonRecords): boolean =>
  (passedExercise(n.exercises[0], records) && passedExercise(n.exercises[1], records)) || (records[testId(n.chapter)] ?? 0) >= TEST_GOAL;

/** Whether chapter `c` is learned: its notions, its challenges aside. */
export const chapterLearned = (ch: Chapter, records: LessonRecords): boolean => required(ch.notions).every((n) => learned(n, records));

/** Whether chapter `c`'s test can be taken: every chapter before is learned. */
export const testOpen = (all: readonly Chapter[], c: number, records: LessonRecords): boolean => all.slice(0, c).every((ch) => chapterLearned(ch, records));

/** Days before a learned notion comes back to be reviewed, by the reviews it has passed. */
export const REVIEW_DAYS = [7, 14, 30, 60];

/** For each learned notion: the day (YYYY-MM-DD) of its last exercise passed, the reviews passed. */
export type Reviews = Record<string, { last: string; step: number }>;

const dayOf = (iso: string): number => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86_400_000);
export const today = (now = new Date()): string => now.toISOString().slice(0, 10);

/** Whether notion `id` is to be reviewed on day `on`. */
export function due(reviews: Reviews, id: string, on: string): boolean {
  const r = reviews[id];
  return !!r && dayOf(on) - dayOf(r.last) >= REVIEW_DAYS[Math.min(r.step, REVIEW_DAYS.length - 1)];
}

/** The learned notions to review on day `on`, the longest overdue first. */
export function dueNotions(all: readonly Chapter[], records: LessonRecords, reviews: Reviews, on: string): Notion[] {
  return all
    .flatMap((c) => c.notions)
    .filter((n) => learned(n, records) && due(reviews, n.id, on))
    .sort((a, b) => dayOf(reviews[a.id].last) - dayOf(reviews[b.id].last));
}

/** After an exercise of notion `id` passed on day `on` (`isLearned`: the notion now learned): its
 * reviews start once it is learned; a review passed when due sets the next one further away. */
export function reviewed(reviews: Reviews, id: string, on: string, isLearned: boolean): Reviews {
  const r = reviews[id];
  if (!r) return isLearned ? { ...reviews, [id]: { last: on, step: 0 } } : reviews;
  const step = due(reviews, id, on) ? Math.min(r.step + 1, REVIEW_DAYS.length - 1) : r.step;
  return { ...reviews, [id]: { last: on, step } };
}

/** Where the reviews are kept (synced online with the progress). */
export const REVIEWS = 'opensmith.parcoursReviews';

export function loadReviews(): Reviews {
  try {
    const raw = JSON.parse(localStorage.getItem(REVIEWS) ?? '{}') as unknown;
    if (!raw || typeof raw !== 'object') return {};
    return Object.fromEntries(
      Object.entries(raw as Record<string, unknown>).filter(
        ([, v]) => !!v && typeof v === 'object' && typeof (v as { last?: unknown }).last === 'string' && typeof (v as { step?: unknown }).step === 'number',
      ),
    ) as Reviews;
  } catch {
    return {};
  }
}

export function saveReviews(reviews: Reviews): void {
  try {
    localStorage.setItem(REVIEWS, JSON.stringify(reviews));
  } catch {
    // no storage: the reviews start again next time
  }
}

/** Whether notion `k` of chapter `c` can be played: the one before learned (challenges aside),
 * and the chapters before. */
export function open(all: readonly Chapter[], c: number, k: number, records: LessonRecords): boolean {
  if (!testOpen(all, c, records)) return false;
  const before = required(all[c].notions.slice(0, k)).pop();
  return !before || learned(before, records);
}

/** The first notion open and not learned yet ([chapter, notion]), challenges aside; the last one
 * once all are. */
export function nextNotion(all: readonly Chapter[], records: LessonRecords): [number, number] {
  for (let c = 0; c < all.length; c++) {
    const k = all[c].notions.findIndex((n) => !n.bonus && !learned(n, records));
    if (k >= 0) return [c, k];
  }
  const c = all.length - 1;
  return [c, all[c].notions.length - 1];
}

/** The notion to play after notion `k` of chapter `c`, challenges aside, if it is open. */
export function notionAfter(all: readonly Chapter[], c: number, k: number, records: LessonRecords): [number, number] | null {
  const later = all[c].notions.findIndex((n, i) => i > k && !n.bonus);
  const [nc, nk] = later >= 0 ? [c, later] : [c + 1, 0];
  return nc < all.length && open(all, nc, nk, records) ? [nc, nk] : null;
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
  if (!techniques) return false;
  return focus === 'slide' ? techniques.slideTo !== undefined : !!techniques[focus];
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

/** Notes or chords with a technique a song must play for it to put that technique in practice. */
const USES = 4;
const POWER = /^[A-G][#b]?5$/;

/** What a song must play to put notion `n` in practice: its chords (by the name a chart gives
 * them; `power` for any power chord) and the techniques of its notes. */
export function needs(n: Notion): { chords: string[]; power: boolean; techniques: string[] } {
  const steps = n.exercises[0].lesson.steps;
  const names = [...new Set(steps.filter(isChord).map((s) => CHORDS[s.chord]?.name ?? s.chord))];
  const techniques = new Set<string>();
  for (const s of steps) {
    if (isChord(s) || !s.techniques) continue;
    for (const [k, v] of Object.entries(s.techniques)) if (v !== undefined && v !== false && k !== 'accent' && k !== 'linkNext') techniques.add(k === 'slideTo' ? 'slide' : k);
  }
  return { chords: names.filter((c) => !POWER.test(c)), power: names.some((c) => POWER.test(c)), techniques: [...techniques] };
}

/** Whether `part` plays what notion `n` teaches (nothing does for a notion with no chord nor
 * technique). */
export function puts(n: Notion, part: SongEntry): boolean {
  const need = needs(n);
  if (!need.chords.length && !need.power && !need.techniques.length) return false;
  // A chord over another bass (G/B) or marked unsure (A*) is still that chord.
  const played = (part.chordNames ?? []).map((c) => c.replace(/\*$/, '').replace(/\/.*$/, ''));
  return (
    need.chords.every((c) => played.includes(c)) &&
    (!need.power || played.some((c) => POWER.test(c))) &&
    need.techniques.every((k) => (part.techniques?.[k] ?? 0) >= USES)
  );
}

/** Notes and chords a second at the part's hardest level: the easier songs come first. */
const density = (part: SongEntry): number => (part.levelNotes?.at(-1) ?? part.notes + part.chords) / Math.max(part.duration, 1);

/** Up to `max` songs of the library that put notion `n` in practice, the easiest first (bass
 * parts and drafts aside), each with its easiest part that does. */
export function practiceSongs(n: Notion, songs: readonly SongEntry[], max = 3): { song: SongEntry; part: SongEntry }[] {
  const found: { song: SongEntry; part: SongEntry }[] = [];
  for (const song of songs) {
    const parts = partsOf(song).filter((p) => p.arrangementType !== 'bass' && !isDraft(p) && puts(n, p));
    if (parts.length) found.push({ song, part: parts.reduce((a, b) => (density(b) < density(a) ? b : a)) });
  }
  return found.sort((a, b) => density(a.part) - density(b.part)).slice(0, max);
}

/** The day's session on the path: a warm-up, the notion to learn, a review, a song. */
export type SessionItem = 'warmup' | 'notion' | 'review' | 'song';
export type Played = { chapter: number; notion: number; step: number };
export interface Session {
  warmup: Played | null;
  notion: Played | null;
  review: Played | null;
  /** A song putting in practice the last notion learned that one of the library's songs plays. */
  song: { song: SongEntry; part: SongEntry; notion: Notion } | null;
}

/** Warm-ups, the most demanding first: the first one open is played. */
const WARMUPS = ['chromatic', 'spider', 'open-strings'];

/** The session of day `on`: each item, if there is one to play. */
export function session(all: readonly Chapter[], records: LessonRecords, reviews: Reviews, songs: readonly SongEntry[], on: string): Session {
  const where = (id: string) => findNotion(all, id);
  const [nc, nn] = nextNotion(all, records);
  const next = all[nc].notions[nn];
  const notion = learned(next, records) ? null : { chapter: nc, notion: nn, step: Math.max(0, next.exercises.findIndex((e) => !passedExercise(e, records))) };
  const warm = WARMUPS.map(where).find((w) => w && open(all, w.chapter, w.index, records) && !(w.chapter === nc && w.index === nn && notion));
  const warmup = warm ? { chapter: warm.chapter, notion: warm.index, step: learned(warm.notion, records) ? 1 : Math.max(0, warm.notion.exercises.findIndex((e) => !passedExercise(e, records))) } : null;
  const due = dueNotions(all, records, reviews, on)[0];
  const r = due && where(due.id);
  const review = r ? { chapter: r.chapter, notion: r.index, step: passedExercise(due.exercises[2], records) ? 2 : 1 } : null;
  let song: Session['song'] = null;
  for (const n of all.flatMap((c) => c.notions).reverse()) {
    if (!learned(n, records)) continue;
    const [first] = practiceSongs(n, songs, 1);
    if (first) {
      song = { ...first, notion: n };
      break;
    }
  }
  return { warmup, notion, review, song };
}

/** Where the day's items played are kept: the day, and the items. */
export const TODAY = 'opensmith.parcoursToday';

/** The items of the session played through on day `on`. */
export function doneToday(on: string): Set<SessionItem> {
  try {
    const raw = JSON.parse(localStorage.getItem(TODAY) ?? 'null') as { day?: unknown; done?: unknown } | null;
    if (!raw || raw.day !== on || !Array.isArray(raw.done)) return new Set();
    return new Set(raw.done.filter((x): x is SessionItem => ['warmup', 'notion', 'review', 'song'].includes(x as string)));
  } catch {
    return new Set();
  }
}

/** Marks `item` played through on day `on`. */
export function markDone(item: SessionItem, on: string): void {
  try {
    localStorage.setItem(TODAY, JSON.stringify({ day: on, done: [...new Set([...doneToday(on), item])] }));
  } catch {
    // no storage: the session starts again
  }
}
