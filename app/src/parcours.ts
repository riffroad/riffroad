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

/** Which of an exercise's notes say whether its notion is played: all of them, its chords, or
 * its notes played with that technique. */
export type Focus = 'all' | 'chords' | 'palmMute' | 'mute' | 'hammerOn' | 'pullOff' | 'slide' | 'vibrato' | 'bend';

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

/** `chords` one after the other, each `hold` beats, from beat `from`. */
const strumsOf = (chords: string[], hold: number, from = 0): Step[] => chords.map((chord, i) => ({ beat: from + i * hold, chord, hold }));
const repeatOf = <T>(n: number, items: T[]): T[] => Array.from({ length: n }, () => items).flat();

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
      ],
    },
    {
      id: 'rhythm',
      title: t('Rythmique'),
      blurb: t('La main droite qui fait danser un morceau : coups sur les temps, entre les temps, étouffés, en motif.'),
      notions: [
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
      ],
    },
    {
      id: 'left-hand',
      title: t('Main gauche'),
      blurb: t('Les notes qui chantent sans regratter : liés, glissés, vibrato et bends, sur un groupe de blues.'),
      notions: [
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
