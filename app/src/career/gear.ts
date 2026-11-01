/**
 * The band's gear, bought in the shop with the career's money and kept for the career (a new
 * one starts without): each piece changes the gigs.
 */

import { t } from '../i18n';

export type GearId = 'guitare2' | 'merch' | 'ampli' | 'sono' | 'van' | 'equipe' | 'ecrans' | 'pyro' | 'bus' | 'studio' | 'scene';

export interface Gear {
  id: GearId;
  name: string;
  blurb: string;
  price: number;
}

export const GEAR: readonly Gear[] = [
  {
    id: 'guitare2',
    name: t('Deuxième guitare'),
    blurb: t('Accordée d’avance : passer de l’une à l’autre entre deux morceaux ne refroidit plus la salle (deux accordages par concert).'),
    price: 350,
  },
  {
    id: 'merch',
    name: t('Stand de merch'),
    blurb: t('T-shirts et badges à chaque concert : de l’argent en plus, selon le public et sa satisfaction.'),
    price: 500,
  },
  {
    id: 'ampli',
    name: t('Ampli à lampes'),
    blurb: t('Un son qui claque dès la première note : le public démarre 8 points plus chaud.'),
    price: 700,
  },
  {
    id: 'sono',
    name: t('Sono de tournée'),
    blurb: t('Plus de puissance, plus de monde : 15 % de public en plus à chaque date.'),
    price: 1100,
  },
  {
    id: 'van',
    name: t('Le van'),
    blurb: t('Le groupe et le matos sur la route : deux concerts par semaine au lieu d’un.'),
    price: 1500,
  },
  {
    id: 'equipe',
    name: t('L’équipe de tournée'),
    blurb: t('Roadies, régisseur et camions à toi : les frais de tournée des grandes salles divisés par deux. L’équipe est payée chaque semaine (1 500 € aux festivals, 3 000 € dans les stades).'),
    price: 20000,
  },
  {
    id: 'ecrans',
    name: t('Les écrans géants'),
    blurb: t('Toi en grand au fond de la scène : jusqu’au dernier rang, le public démarre 5 points plus chaud.'),
    price: 45000,
  },
  {
    id: 'pyro',
    name: t('La pyrotechnie'),
    blurb: t('Flammes et étincelles sur le dernier accord : un rappel rapporte deux fois plus de fans et de cachet.'),
    price: 90000,
  },
  {
    id: 'bus',
    name: t('Le bus de tournée'),
    blurb: t('Couchettes, cuisine et console de jeux : enchaîner les dates fatigue deux fois moins le groupe.'),
    price: 60000,
  },
  {
    id: 'studio',
    name: t('Ton propre studio'),
    blurb: t('Trois prises par séance au lieu de deux, et chacune sonne 5 points mieux sur l’album.'),
    price: 150000,
  },
  {
    id: 'scene',
    name: t('La scène des stades'),
    blurb: t('Une scène géante en tournée : dans les stades, 10 % de public en plus, qui démarre 5 points plus chaud.'),
    price: 300000,
  },
];

export const isGear = (id: unknown): id is GearId => GEAR.some((g) => g.id === id);

/** What the tube amp adds to the crowd at the start of a gig. */
export const AMP_WARMTH = 0.08;
/** The audience the tour PA adds. */
export const PA_AUDIENCE = 1.15;
/** What the giant screens add to where a crowd starts; what the stadium stage adds there (and to
 * the stadiums' audiences). */
export const SCREENS_WARMTH = 0.05;
export const STAGE_WARMTH = 0.05;
export const STAGE_AUDIENCE = 1.1;
/** Takes a studio session buys (with the band's own studio), and how much better its takes are. */
export const SESSION_TAKES = 2;
export const OWN_STUDIO_TAKES = 3;
export const OWN_STUDIO_BONUS = 0.05;
/** What the touring crew is paid every week, by act (from the festivals on). */
export const crewWages = (act: number): number => (act >= 5 ? 3000 : act >= 4 ? 1500 : 0);

/** A gig's tour costs (crew, trucks, hotels) as a share of what it pays, by act: none in the
 * garage and the bars, more as the venues grow; halved with the band's own crew. */
const TOUR_COSTS = [0, 0, 0.15, 0.3, 0.4];
export function tourCosts(act: number, pay: number, crew: boolean): number {
  const share = TOUR_COSTS[Math.min(Math.max(act, 1), TOUR_COSTS.length) - 1] * (crew ? 0.5 : 1);
  return Math.round((pay * share) / 5) * 5;
}

/** Merch sold at a gig (€, by 5): about 60 cents a head in a room on fire. */
export const merchSales = (audience: number, satisfaction: number): number => Math.round((audience * satisfaction * 0.6) / 5) * 5;
