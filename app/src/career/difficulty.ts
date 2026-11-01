/**
 * How demanding a career is, chosen when it starts: a patient crowd for a Rookie, the base rules
 * for a Pro, a merciless room for a Legend, who earns more for it.
 */

import { t } from '../i18n';

export type Difficulty = 'rookie' | 'pro' | 'legende';

export interface Level {
  id: Difficulty;
  label: string;
  blurb: string;
  /** What a pause and a retuning on stage cost the crowd; pauses free each gig. */
  pause: number;
  retune: number;
  freePauses: number;
  /** Seconds of a cold room before the band is booed off. */
  patience: number;
  /** Factor on the fees (not the fans: a harder career is not a shorter one). */
  reward: number;
  /** Added to the crowd a decisive gig asks for: a Rookie gets through a little colder room. */
  decisive: number;
}

export const DIFFICULTIES: readonly Level[] = [
  {
    id: 'rookie',
    label: 'Rookie',
    blurb: t('Un public patient : la première pause de chaque concert est gratuite, un accordage refroidit deux fois moins, les sifflets attendent 30 s, les dates décisives demandent 8 points de public en moins. Cachets ×0,8.'),
    pause: 0.08,
    retune: 0.06,
    freePauses: 1,
    patience: 30,
    reward: 0.8,
    decisive: -0.08,
  },
  {
    id: 'pro',
    label: 'Pro',
    blurb: t('Les règles de base : chaque pause et chaque accordage refroidissent la salle, les sifflets au bout de 20 s.'),
    pause: 0.08,
    retune: 0.12,
    freePauses: 0,
    patience: 20,
    reward: 1,
    decisive: 0,
  },
  {
    id: 'legende',
    label: t('Légende'),
    blurb: t('Un public impitoyable : pauses et accordages coûtent plus cher, la salle siffle au bout de 12 s, les dates décisives demandent 5 points de public en plus. Cachets ×1,25.'),
    pause: 0.12,
    retune: 0.18,
    freePauses: 0,
    patience: 12,
    reward: 1.25,
    decisive: 0.05,
  },
];

export const isDifficulty = (x: unknown): x is Difficulty => DIFFICULTIES.some((d) => d.id === x);

export const levelOf = (d: Difficulty): Level => DIFFICULTIES.find((x) => x.id === d) ?? DIFFICULTIES[1];
