/**
 * What is said of the band: its hype (0 to 100: a crowd that already knows the band, more of it
 * won over), which great gigs, awards, posts and good causes raise and cold rooms lower, settling
 * back week after week; its followers on the networks, a post a week (behind the scenes for free,
 * a music video for a price); a communications manager who keeps all that up; and the moments
 * that ask the player to choose — an interview, a video that goes viral, a quarrel in the band, a
 * rival label's offer, a musician the rival wants, a good cause asking for help.
 */

import { lang, t } from '../i18n';
import { RIVAL } from './events';

/** Where hype settles back to (higher with a communications manager), and how fast. */
const SETTLE = 40;
const SETTLE_COMMS = 55;
const SETTLE_RATE = 0.2;

export const clampHype = (h: number): number => Math.min(100, Math.max(0, Math.round(h)));

/** Hype a week later: back toward its usual level. */
export const hypeWeek = (h: number, comms = false): number => clampHype(h + ((comms ? SETTLE_COMMS : SETTLE) - h) * SETTLE_RATE);

/** A rise in hype, smaller near the top (a band everyone talks of has less left to win). */
export const hypeGain = (h: number, gain: number): number => (gain > 0 ? gain * Math.min(1, Math.max(0, (100 - h) / 60)) : gain);

/** What a gig does to the hype: a crowd on fire talks, a cold one too. */
export function hypeAfterGig(h: number, satisfaction: number, booed: boolean): number {
  if (booed) return clampHype(h - 10);
  return clampHype(h + hypeGain(h, satisfaction >= 0.9 ? 3 : satisfaction >= 0.7 ? 1 : satisfaction < 0.4 ? -5 : 0));
}

/** Where a crowd starts with the band's hype (−0.1 forgotten, +0.15 everywhere), and the share
 * of it turned into fans (×0.95 to ×1.1). */
export const hypeWarmth = (h: number): number => (h - 40) / 400;
export const hypeFans = (h: number): number => 0.95 + (0.15 * h) / 100;

/** The communications manager's weekly wage, by act (from the clubs on). */
export const commsWage = (act: number): number => (act >= 3 ? 100 * act * act : 0);

/** Followers at most, against the fans (a following bigger than the audience it comes from). */
const FOLLOW_CAP = 3;

/** Followers a week later: some of the fans follow, more when the band is talked about. */
export const followersWeek = (followers: number, fans: number, hype: number): number => Math.round(Math.min(Math.max(followers, FOLLOW_CAP * fans + 1000), followers + fans * 0.01 * (hype / 40)));

export type PostKind = 'coulisses' | 'clip';

/** What a music video costs, by act. */
export const clipCost = (act: number): number => 150 * act * act;

/** A post of the week: what it brings (followers, fans, hype), stronger with a manager; the
 * followers it wins come from the band's audience (its fans), not from the followers already
 * there. */
export function postEffect(kind: PostKind, followers: number, fans: number, comms: boolean, hype = SETTLE): { followers: number; fans: number; hype: number } {
  const boost = comms ? 1.5 : 1;
  const room = Math.max(0, FOLLOW_CAP * fans + 1000 - followers);
  if (kind === 'clip') return { followers: Math.round(Math.min(room, (fans * 0.06 + 50) * boost)), fans: Math.round(fans * 0.005 * boost), hype: Math.round(hypeGain(hype, 4 * boost)) };
  return { followers: Math.round(Math.min(room, (fans * 0.015 + 20) * boost)), fans: 0, hype: Math.round(hypeGain(hype, 1 * boost)) };
}

/** Sponsors pay more to a band followed on the networks (up to +40 % when followers match fans). */
export const followersPay = (followers: number, fans: number): number => 1 + 0.4 * Math.min(1, followers / Math.max(1, fans));

/** Good causes that ask for help, by id. */
export const CAUSES: Record<string, string> = {
  hopital: t('le service pédiatrique de l’hôpital'),
  banque: t('la banque alimentaire du quartier'),
  refuge: t('le refuge pour animaux de la ville'),
  salle: t('une salle de concert inondée'),
  ecole: t('l’école de musique du coin'),
};

/** A donation and a charity gig's costs, by act. */
export const donation = (act: number): number => [100, 300, 1500, 5000, 10000][Math.min(Math.max(act, 1), 5) - 1];
export const charityCost = (act: number): number => [0, 200, 2000, 8000, 15000][Math.min(Math.max(act, 1), 5) - 1];

export type MomentKind = 'interview' | 'viral' | 'dispute' | 'offre' | 'debauchage' | 'cause';

/** A choice of a moment and what it changes. */
export interface Effect {
  hype?: number;
  /** Every member's morale; one member's (by name). */
  morale?: number;
  members?: { name: string; morale: number }[];
  money?: number;
  fans?: number;
  followers?: number;
  /** A slot of the week given to rest. */
  rest?: boolean;
  /** The named member's wage raised by this share. */
  raise?: { name: string; share: number };
  /** The named member leaves (a stand-in takes the part). */
  leaves?: string;
  /** Another label: this much more of the album sales, no label bonus this season. */
  betterDeal?: number;
  /** A charity gig for this cause among the week's offers. */
  charity?: string;
}

export interface Choice {
  id: string;
  label: string;
  /** What it will do, in a few words. */
  hint: string;
  effect: Effect;
}

/** A moment: what it is (its kind and the facts it was made from, written again in the interface
 * language when read), and its choices. */
export interface Moment {
  kind: MomentKind;
  args: Record<string, string | number>;
  title: string;
  text: string;
  choices: Choice[];
}

/** Euros as the interface language writes them. */
const euros = (x: number): string => `${x.toLocaleString(lang() === 'en' ? 'en-US' : 'fr-FR')} €`;

/** 0..1 from `text` (FNV-1a, its bits mixed again: keys that differ by a week spread evenly). */
function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const num = (x: string | number | undefined): number => (typeof x === 'number' ? x : Number(x) || 0);
const str = (x: string | number | undefined): string => String(x ?? '');

/** The moment of `kind` made from its facts, in the interface language (null: unknown kind). */
export function buildMoment(kind: MomentKind, args: Record<string, string | number>): Moment | null {
  const m = (title: string, text: string, choices: Choice[]): Moment => ({ kind, args, title, text, choices });
  switch (kind) {
    case 'interview': {
      const questions = [
        t('« On dit que vous êtes le groupe qui monte. Ça vous fait quoi ? »'),
        t('« Qu’est-ce qui vous différencie des autres groupes de la scène ? »'),
        t('« Un mot sur {rival}, vos grands rivaux ? »', { rival: RIVAL }),
      ];
      const boost = num(args.boost) || 1;
      const h = (n: number) => Math.round(n * boost);
      return m(t('Interview au magazine Riffs'), questions[Math.floor(hash(`question|${args.season}|${args.week}`) * questions.length)], [
        { id: 'humble', label: t('« On bosse, on apprend, on verra. »'), hint: t('Hype +{n}, moral du groupe +5', { n: h(2) }), effect: { hype: h(2), morale: 0.05 } },
        { id: 'provoc', label: t('« On va tous les enterrer. »'), hint: t('Hype +{n}, moral du groupe −5', { n: h(8) }), effect: { hype: h(8), morale: -0.05 } },
        { id: 'drole', label: t('« On joue surtout pour les bières gratuites. »'), hint: t('Hype +{n}', { n: h(5) }), effect: { hype: h(5) } },
      ]);
    }
    case 'viral': {
      const gain = num(args.fans);
      return m(t('Ton live fait le tour des réseaux'), t('Une vidéo de ton dernier concert cartonne : des milliers de vues en une nuit.'), [
        { id: 'ok', label: t('Partager la vidéo'), hint: t('Hype +15, {n} nouveaux fans', { n: gain }), effect: { hype: 15, fans: gain, followers: gain * 2 } },
      ]);
    }
    case 'dispute': {
      const [a, b] = [str(args.a), str(args.b)];
      return m(t('Ça chauffe dans le groupe'), t('{a} et {b} se disputent : la fatigue des dates, les tensions de la route.', { a, b }), [
        { id: 'pause', label: t('Une pause pour tout le monde'), hint: t('Un créneau de repos cette semaine, moral +15'), effect: { rest: true, morale: 0.15 } },
        { id: 'a', label: t('Donner raison à {name}', { name: a }), hint: t('{a} +15, {b} −20', { a, b }), effect: { members: [{ name: a, morale: 0.15 }, { name: b, morale: -0.2 }] } },
        { id: 'b', label: t('Donner raison à {name}', { name: b }), hint: t('{b} +15, {a} −20', { a, b }), effect: { members: [{ name: b, morale: 0.15 }, { name: a, morale: -0.2 }] } },
        { id: 'rien', label: t('Laisser couler'), hint: t('Moral du groupe −5'), effect: { morale: -0.05 } },
      ]);
    }
    case 'offre': {
      const money = num(args.money);
      return m(t('Un label concurrent t’appelle'), t('Il te propose {money} et 5 points de plus sur les ventes pour rompre ton contrat et signer chez lui.', { money: euros(money) }), [
        { id: 'oui', label: t('Signer chez lui'), hint: t('{money} tout de suite, +5 points sur les ventes, pas de prime du label cette saison, hype −5', { money: euros(money) }), effect: { money, hype: -5, betterDeal: 0.05 } },
        { id: 'non', label: t('Rester fidèle'), hint: t('Hype +3'), effect: { hype: 3 } },
      ]);
    }
    case 'debauchage': {
      const name = str(args.name);
      const raise = num(args.raise);
      const transfer = num(args.transfer);
      return m(t('{rival} veulent {name}', { rival: RIVAL, name }), t('{rival} proposent un pont d’or à {name} pour rejoindre leur groupe.', { rival: RIVAL, name }), [
        { id: 'garder', label: t('Augmenter son salaire'), hint: t('Salaire +{pct} %, son moral +20', { pct: Math.round(raise * 100) }), effect: { raise: { name, share: raise }, members: [{ name, morale: 0.2 }] } },
        { id: 'partir', label: t('Le laisser partir'), hint: t('{money} d’indemnité, un remplaçant prend sa place', { money: euros(transfer) }), effect: { leaves: name, money: transfer } },
      ]);
    }
    case 'cause': {
      const cause = str(args.cause);
      const name = CAUSES[cause] ?? cause;
      const gift = num(args.gift);
      const cost = num(args.cost);
      return m(t('Un appel sur les réseaux'), t('Tes abonnés relaient un appel pour {cause} : ils comptent sur toi.', { cause: name }), [
        { id: 'don', label: t('Faire un don de {money}', { money: euros(gift) }), hint: t('Hype +6, des fans et des abonnés en plus'), effect: { money: -gift, hype: 6, fans: Math.round(gift / 4), followers: Math.round(gift / 2) } },
        {
          id: 'concert',
          label: t('Organiser un concert caritatif'),
          hint: cost
            ? t('Une date de plus cette semaine : pas de cachet, {money} de frais, beaucoup de fans', { money: euros(cost) })
            : t('Une date de plus cette semaine : pas de cachet, beaucoup de fans'),
          effect: { charity: cause, hype: 2 },
        },
        { id: 'relayer', label: t('Relayer l’appel'), hint: t('Hype +1, quelques abonnés'), effect: { hype: 1, followers: 30 } },
      ]);
    }
  }
  return null;
}

export const interview = (season: number, week: number, comms = false): Moment => buildMoment('interview', { season, week, boost: comms ? 1.5 : 1 })!;
export const viral = (fans: number): Moment => buildMoment('viral', { fans: Math.round(fans * 0.05 + 50) })!;
export const dispute = (a: string, b: string): Moment => buildMoment('dispute', { a, b })!;
export const rivalLabel = (money: number): Moment => buildMoment('offre', { money })!;
export const poaching = (name: string, raise: number, transfer: number): Moment => buildMoment('debauchage', { name, raise, transfer })!;
export function goodCause(season: number, week: number, act: number): Moment {
  const ids = Object.keys(CAUSES);
  return buildMoment('cause', { cause: ids[Math.floor(hash(`cause|${season}|${week}`) * ids.length)], gift: donation(act), cost: charityCost(act) })!;
}

/** Whether this week brings a moment of `kind` (a share of the weeks, set per kind). */
export const momentRoll = (kind: MomentKind, season: number, week: number, share: number): boolean => hash(`moment|${kind}|${season}|${week}`) < share;

/** A moment as saved, written again in the interface language. */
export function sanitizeMoment(raw: unknown): Moment | null {
  const m = raw as Partial<Moment> | null;
  if (!m || typeof m.kind !== 'string' || !m.args || typeof m.args !== 'object') return null;
  return buildMoment(m.kind as MomentKind, m.args);
}
