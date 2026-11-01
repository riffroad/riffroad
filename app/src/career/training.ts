/**
 * Training aimed at the card's weakest rating: a short drill made for it (chord changes,
 * notes across the strings, eighth notes on the beat, a fast pentatonic run, a long mixed set,
 * hammer-ons, pull-offs and slides), at a tempo set by the rating. Played like a lesson, it takes
 * a slot of the career's week; what it measures moves the card like any song.
 */

import { t } from '../i18n';
import type { Lesson, Step } from '../lessons';
import { SKILLS, type SkillId } from './skills';

/** Share of the notes a drill asks for. */
export const DRILL_GOAL = 0.75;

/** The tempo for a rating: 60 beats a minute at 40, about 105 at 99. */
const tempoFor = (rating: number | null, base = 60): number => Math.round(base + 0.75 * Math.max(0, (rating ?? 40) - 40));

/** A pattern repeated until `count` steps, every `every` beats. */
function repeat<T>(pattern: readonly T[], count: number): T[] {
  return Array.from({ length: count }, (_, i) => pattern[i % pattern.length]);
}

const notes = (frets: [number, number][], every: number, hold?: number): Step[] => frets.map(([string, fret], i) => ({ beat: i * every, string, fret, hold }));

/** The drill for `skill` at the card's `rating` of it (null: not measured yet). */
export function drillFor(skill: SkillId, rating: number | null): Lesson {
  const name = SKILLS.find((s) => s.id === skill)!.label;
  const base = { id: `drill-${skill}`, title: t('Entraînement · {skill}', { skill: name }), goal: DRILL_GOAL, drill: true } as const;
  switch (skill) {
    case 'precision': {
      // One finger per fret, 1-2-3-4 up each string then back down: the "spider".
      const up = [0, 1, 2, 3, 4, 5].flatMap((s) => [1, 2, 3, 4].map((f) => [s, f] as [number, number]));
      return {
        ...base,
        learn: t('Une note par temps, un doigt par case, d’une corde à l’autre.'),
        how: [t('Index case 1, majeur case 2, annulaire case 3, petit doigt case 4.'), t('Appuie juste derrière la frette : la note sonne nette.')],
        bpm: tempoFor(rating),
        steps: notes([...up, ...[...up].reverse()], 1),
      };
    }
    case 'accords': {
      const set = (rating ?? 40) < 55 ? ['Em', 'Am', 'E', 'A'] : (rating ?? 40) < 70 ? ['G', 'C', 'D', 'Em'] : ['G', 'D', 'Am', 'C', 'E', 'A'];
      const hold = (rating ?? 40) < 70 ? 2 : 1;
      return {
        ...base,
        learn: t('Des changements d’accords, sur le temps, toutes les cordes qui sonnent.'),
        how: [t('Prépare la forme suivante pendant que l’accord sonne.'), t('Gratte vers le bas, d’un seul geste.')],
        bpm: tempoFor(rating),
        steps: repeat(set, 24).map((chord, i) => ({ beat: i * hold, chord, hold })),
      };
    }
    case 'rythme': {
      // On the beat, then the off-beats too: the low strings open, all the attention on time.
      const pattern = [0, 1, 1.5, 2, 3, 3.5];
      const steps: Step[] = [];
      for (let bar = 0; bar < 8; bar++) for (const b of pattern) steps.push({ beat: bar * 4 + b, string: bar % 2, fret: 0 });
      return {
        ...base,
        learn: t('Des cordes à vide, sur les temps et les contretemps : seul le placement compte.'),
        how: [t('Tape du pied sur chaque clic.'), t('Les contretemps tombent pile entre deux clics.')],
        bpm: tempoFor(rating, 70),
        steps,
      };
    }
    case 'vitesse': {
      // The minor pentatonic box at the 5th fret, up and down in eighth notes.
      const box: [number, number][] = [
        [0, 5], [0, 8], [1, 5], [1, 7], [2, 5], [2, 7], [3, 5], [3, 7], [4, 5], [4, 8], [5, 5], [5, 8],
      ];
      return {
        ...base,
        learn: t('La gamme pentatonique en case 5, en croches : la main droite alterne bas-haut.'),
        how: [t('Médiator vers le bas puis vers le haut, sans s’arrêter.'), t('Commence propre : la vitesse vient avec.')],
        bpm: tempoFor(rating, 70),
        steps: notes(repeat([...box, ...[...box].reverse()], 48), 0.5),
      };
    }
    case 'endurance': {
      // A long set: a riff, the chords, the riff again, for about two and a half minutes.
      const riff: [number, number][] = [[0, 0], [0, 3], [0, 5], [1, 2], [1, 5], [0, 5], [0, 3], [0, 0]];
      const steps: Step[] = [];
      let beat = 0;
      for (let part = 0; part < 6; part++) {
        if (part % 2 === 0) for (const [string, fret] of riff) steps.push({ beat: beat++, string, fret });
        else for (const chord of ['E5', 'G5', 'A5', 'G5']) steps.push({ beat: (beat += 2) - 2, chord, hold: 2 });
      }
      const long = [...steps, ...steps.map((s) => ({ ...s, beat: s.beat + beat }))];
      return {
        ...base,
        learn: t('Un long morceau d’entraînement : tiens la justesse jusqu’au bout.'),
        how: [t('Garde les épaules et le poignet souples.'), t('Respire : la fin compte autant que le début.')],
        bpm: tempoFor(rating, 66),
        steps: long,
      };
    }
    case 'technique': {
      // Hammer-on 5→7, pull-off 7→5, slide 5→7, on each string from the high E down.
      const steps: Step[] = [];
      let beat = 0;
      for (const string of [5, 4, 3, 2, 1, 0]) {
        steps.push({ beat: beat, string, fret: 5 }, { beat: beat + 1, string, fret: 7, techniques: { hammerOn: true } });
        steps.push({ beat: beat + 2, string, fret: 7 }, { beat: beat + 3, string, fret: 5, techniques: { pullOff: true } });
        steps.push({ beat: beat + 4, string, fret: 5, hold: 2, techniques: { slideTo: 7 } });
        beat += 6;
      }
      return {
        ...base,
        learn: t('Hammer-on, pull-off et slide, case 5 et 7, sur chaque corde.'),
        how: [t('Hammer-on : frappe la case 7 avec l’annulaire sans regratter.'), t('Slide : glisse de la case 5 à la 7 sans lâcher la corde.')],
        bpm: tempoFor(rating),
        steps,
      };
    }
  }
}
