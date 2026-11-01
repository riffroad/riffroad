/**
 * Trophies: feats on stage (career) and on songs (every mode but the Loop Trainer). Earned for
 * good, kept with the guitars through a new career; some give a guitar the shop does not sell.
 */

import type { Career } from './career/career';
import type { Chart } from './chart';
import type { PhraseResult } from './game/view';
import { GUITARS } from './guitars';
import { t } from './i18n';
import type { AttackDifficulty } from './score-attack';
import { songParts } from './sections';

export interface Trophy {
  id: string;
  name: string;
  /** How it is earned. */
  blurb: string;
  scope: 'scene' | 'song';
}

export const TROPHIES: readonly Trophy[] = [
  { id: 'premiere', name: t('Première scène'), blurb: t('Jouer un concert jusqu’au bout.'), scope: 'scene' },
  { id: 'rappel', name: t('Une autre !'), blurb: t('Jouer un rappel réclamé par la salle.'), scope: 'scene' },
  { id: 'en-feu', name: t('Salle en feu'), blurb: t('Finir un concert devant un public conquis à 90 % ou plus.'), scope: 'scene' },
  { id: 'pro', name: t('Pro de la scène'), blurb: t('Jouer 10 concerts jusqu’au bout sans une seule pause.'), scope: 'scene' },
  { id: 'bars', name: t('Bienvenue dans les bars'), blurb: t('Gagner la fête de fin d’année du lycée.'), scope: 'scene' },
  { id: 'resident', name: t('Résident'), blurb: t('Gagner le Bistrot Rock.'), scope: 'scene' },
  { id: 'signe', name: t('Signé !'), blurb: t('Gagner le showcase du label.'), scope: 'scene' },
  { id: 'tremplin', name: t('Plus forts que les Vautours'), blurb: t('Battre Les Vautours au tremplin.'), scope: 'scene' },
  { id: 'album', name: t('Premier album'), blurb: t('Sortir un album avec le label.'), scope: 'scene' },
  { id: 'hall', name: t('Hall of Fame'), blurb: t('Gagner la dernière date de la tournée des stades.'), scope: 'scene' },
  { id: 'cachets', name: t('Premier millier'), blurb: t('Gagner 1 000 € de cachets en tout.'), scope: 'scene' },
  { id: 'hue', name: t('Ça arrive aux meilleurs'), blurb: t('Se faire sortir de scène par le public.'), scope: 'scene' },
  { id: 'defi', name: t('Défi en or'), blurb: t('Décrocher l’or au défi de la semaine.'), scope: 'scene' },
  { id: 'coeur', name: t('Cœur sur la main'), blurb: t('Jouer trois concerts caritatifs.'), scope: 'scene' },
  { id: 'sans-faute', name: t('Sans faute'), blurb: t('Finir un morceau d’au moins 150 notes sans en rater une.'), scope: 'song' },
  { id: 'centurion', name: t('Centurion'), blurb: t('Enchaîner 100 notes d’affilée.'), scope: 'song' },
  { id: 'legende', name: t('Légendaire'), blurb: t('Obtenir la note S sur un morceau d’au moins 50 notes.'), scope: 'song' },
  { id: 'solo', name: t('Solo parfait'), blurb: t('Jouer un solo entier sans rater une note.'), scope: 'song' },
  { id: 'maitrise', name: t('Maîtrise totale'), blurb: t('Atteindre 100 % de maîtrise sur un morceau.'), scope: 'song' },
  { id: 'sans-filet', name: t('Sans filet'), blurb: t('Finir un Score Attack Difficile ou Maître sans un seul échec.'), scope: 'song' },
];

export const isTrophy = (id: string): boolean => TROPHIES.some((t) => t.id === id);

/** The guitar a trophy gives, if any. */
export const guitarFor = (trophy: string) => GUITARS.find((g) => g.trophy === trophy) ?? null;

/** A song played to the end, as the trophies see it. */
export interface SongFeat {
  /** Notes and chords judged, and missed. */
  notes: number;
  misses: number;
  bestStreak: number;
  grade: string;
  /** The song's mastery after this play, 0..1. */
  mastery: number;
  /** A solo part played without a miss. */
  perfectSolo: boolean;
  /** Score Attack: the difficulty and how the run went. */
  attack: { level: AttackDifficulty; strikes: number; failed: boolean } | null;
}

/** Trophies a song earns. */
export function songTrophies(f: SongFeat): string[] {
  const won: string[] = [];
  if (f.notes >= 150 && f.misses === 0) won.push('sans-faute');
  if (f.bestStreak >= 100) won.push('centurion');
  if (f.grade === 'S' && f.notes >= 50) won.push('legende');
  if (f.perfectSolo) won.push('solo');
  if (f.mastery >= 0.999) won.push('maitrise');
  if (f.attack && !f.attack.failed && f.attack.strikes === 0 && (f.attack.level === 'hard' || f.attack.level === 'master')) won.push('sans-filet');
  return won;
}

/** A part named Solo whose phrases were all judged, every one without a miss. */
export function perfectSolo(chart: Pick<Chart, 'phrases' | 'sections'>, results: ReadonlyMap<number, PhraseResult>): boolean {
  const parts = songParts(chart) ?? [];
  return parts.some((part) => {
    if (!part.label.startsWith('Solo')) return false;
    const played: number[] = [];
    for (let i = part.first; i <= part.last; i++) if (!chart.phrases[i].name.startsWith('rest')) played.push(i);
    return played.length > 0 && played.every((i) => (results.get(i)?.accuracy ?? 0) >= 0.999);
  });
}

/** A gig just over, as the trophies see it. */
export interface GigFeat {
  outcome: 'played' | 'booed' | 'abandoned';
  satisfaction: number;
  /** An encore played to the end. */
  encore: boolean;
}

/** Trophies the career has earned: by the gig just over, and by where it stands. */
export function careerTrophies(c: Career, gig: GigFeat | null): string[] {
  const won: string[] = [];
  if (gig?.outcome === 'played') won.push('premiere');
  if (gig?.encore) won.push('rappel');
  if (gig?.outcome === 'played' && gig.satisfaction >= 0.9) won.push('en-feu');
  if (gig?.outcome === 'booed') won.push('hue');
  if (c.stats.cleanGigs >= 10) won.push('pro');
  if (c.act >= 2) won.push('bars');
  if (c.act >= 3) won.push('resident');
  if (c.act >= 4) won.push('signe');
  if (c.act >= 5) won.push('tremplin');
  if (c.album.released.length) won.push('album');
  if (c.hallOfFame.length) won.push('hall');
  if (c.stats.earned >= 1000) won.push('cachets');
  if (c.challenge?.tier === 3) won.push('defi');
  if ((c.stats.charity ?? 0) >= 3) won.push('coeur');
  return won;
}

/** The trophies `ids` earned on `when` (those not earned yet), and the guitars they give. */
export function award(c: Career, ids: readonly string[], when = new Date()): { career: Career; earned: Trophy[] } {
  const earned = TROPHIES.filter((t) => ids.includes(t.id) && !(t.id in c.trophies));
  if (!earned.length) return { career: c, earned };
  const trophies = { ...c.trophies };
  const guitars = [...c.guitars];
  for (const t of earned) {
    trophies[t.id] = when.toISOString();
    const g = guitarFor(t.id);
    if (g && !guitars.includes(g.id)) guitars.push(g.id);
  }
  return { career: { ...c, trophies, guitars }, earned };
}
