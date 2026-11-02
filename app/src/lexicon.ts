/**
 * The highway's symbols: what each one asks of the player. The lexicon screen lists them all, and
 * a song whose chart shows one the player has never met opens on a card that explains it (the
 * ones met are kept on this Mac).
 */
import type { Chart, Techniques } from './chart';
import { t } from './i18n';

export type SymbolId =
  | 'open'
  | 'fret'
  | 'sustain'
  | 'chord'
  | 'hammerOn'
  | 'pullOff'
  | 'slide'
  | 'vibrato'
  | 'bend'
  | 'palmMute'
  | 'mute'
  | 'harmonic'
  | 'pinchHarmonic'
  | 'tremolo'
  | 'accent'
  | 'tap';

export interface SymbolEntry {
  id: SymbolId;
  /** As the highway writes it (a word for the shapes it draws). */
  glyph: string;
  name: string;
  /** What it means, in a sentence. */
  means: string;
  /** How to play it, in a sentence. */
  how: string;
}

export const SYMBOLS: readonly SymbolEntry[] = [
  { id: 'open', glyph: '▬', name: t('Corde à vide'), means: t('Une barre en travers de la corde : la corde sonne seule.'), how: t('Gratte-la sans appuyer nulle part de la main gauche.') },
  { id: 'fret', glyph: '3', name: t('Case'), means: t('Le chiffre sur la note : la case où poser le doigt.'), how: t('Appuie juste derrière la frette de cette case, du bout du doigt.') },
  { id: 'sustain', glyph: '━', name: t('Note tenue'), means: t('La traînée derrière la note : elle dure jusqu’au bout de la traînée.'), how: t('Garde le doigt appuyé, sans regratter, jusqu’à la fin de la traînée.') },
  { id: 'chord', glyph: '▢', name: t('Accord'), means: t('Un cadre avec un nom : plusieurs cordes jouées ensemble.'), how: t('Pose tous les doigts de la forme, puis gratte les cordes du cadre d’un seul geste.') },
  { id: 'palmMute', glyph: 'PM', name: t('Palm mute'), means: t('Un son étouffé et sec, le « tchug » du rock.'), how: t('Pose le tranchant de la main droite sur les cordes, tout près du chevalet, et gratte.') },
  { id: 'mute', glyph: '✕', name: t('Coup étouffé'), means: t('Un coup sans note : un « tchak » pour le rythme.'), how: t('Effleure les cordes de la main gauche sans appuyer, puis gratte.') },
  { id: 'hammerOn', glyph: 'H', name: t('Hammer-on'), means: t('La note suivante sans regratter.'), how: t('Frappe la case d’un doigt de la main gauche, fort et net, pendant que la corde sonne.') },
  { id: 'pullOff', glyph: 'P', name: t('Pull-off'), means: t('La note plus grave suivante sans regratter.'), how: t('Retire le doigt en tirant un peu la corde vers le bas, l’autre doigt déjà en place.') },
  { id: 'slide', glyph: '/', name: t('Glissé'), means: t('Une flèche vers une autre case : la note glisse jusqu’à elle (/ vers l’aigu, \\ vers le grave).'), how: t('Glisse le doigt sur la corde sans le lever, en gardant la pression.') },
  { id: 'vibrato', glyph: '~', name: t('Vibrato'), means: t('Une vague : la note ondule.'), how: t('Fais osciller la corde de haut en bas avec le doigt qui appuie.') },
  { id: 'bend', glyph: '↑', name: t('Bend'), means: t('Une flèche vers le haut : la note monte d’un demi-ton ou d’un ton.'), how: t('Pousse la corde vers le haut avec deux ou trois doigts, jusqu’à la note voulue.') },
  { id: 'harmonic', glyph: '◇', name: t('Harmonique'), means: t('Un losange : un son cristallin.'), how: t('Effleure la corde juste au-dessus de la frette, sans appuyer, et gratte.') },
  { id: 'pinchHarmonic', glyph: 'PH', name: t('Harmonique pincée'), means: t('Un sifflement aigu, celui du métal.'), how: t('Gratte en laissant le pouce effleurer la corde juste après le médiator.') },
  { id: 'tremolo', glyph: '≈', name: t('Trémolo'), means: t('La note répétée très vite.'), how: t('Gratte en aller-retour rapides et réguliers, poignet souple.') },
  { id: 'accent', glyph: '>', name: t('Accent'), means: t('La note à faire ressortir.'), how: t('Gratte-la plus fort que celles autour.') },
  { id: 'tap', glyph: 'T', name: t('Tapping'), means: t('Une note frappée de la main droite.'), how: t('Frappe la case du bout d’un doigt de la main droite, puis retire-le.') },
];

export const symbol = (id: SymbolId): SymbolEntry => SYMBOLS.find((s) => s.id === id)!;

/** The symbols a note's techniques show. */
function techniqueSymbols(x: Techniques | undefined, fret: number): SymbolId[] {
  if (!x) return [];
  const out: SymbolId[] = [];
  if (x.hammerOn) out.push('hammerOn');
  if (x.pullOff) out.push('pullOff');
  if (x.slideTo !== undefined && x.slideTo !== fret) out.push('slide');
  if (x.vibrato) out.push('vibrato');
  if (x.bend) out.push('bend');
  if (x.palmMute) out.push('palmMute');
  if (x.mute) out.push('mute');
  if (x.harmonic) out.push('harmonic');
  if (x.pinchHarmonic) out.push('pinchHarmonic');
  if (x.tremolo) out.push('tremolo');
  if (x.accent) out.push('accent');
  if (x.tap) out.push('tap');
  return out;
}

/** The symbols `chart` shows, in the order of the lexicon. */
export function symbolsIn(chart: Pick<Chart, 'notes' | 'chords'>): SymbolId[] {
  const found = new Set<SymbolId>();
  for (const n of chart.notes) {
    found.add(n.fret === 0 ? 'open' : 'fret');
    if (n.sustain > 0) found.add('sustain');
    for (const s of techniqueSymbols(n.techniques, n.fret)) found.add(s);
  }
  if (chart.chords.length) found.add('chord');
  return SYMBOLS.map((s) => s.id).filter((id) => found.has(id));
}

const SEEN = 'opensmith.seenSymbols';

/** The symbols the player has met (explained to them once). */
export function seenSymbols(): Set<SymbolId> {
  try {
    const raw = JSON.parse(localStorage.getItem(SEEN) ?? '[]') as unknown;
    return new Set(Array.isArray(raw) ? (raw.filter((x) => SYMBOLS.some((s) => s.id === x)) as SymbolId[]) : []);
  } catch {
    return new Set();
  }
}

/** `ids` met: not explained again. */
export function markSeen(ids: readonly SymbolId[]): void {
  const all = seenSymbols();
  for (const id of ids) all.add(id);
  try {
    localStorage.setItem(SEEN, JSON.stringify([...all]));
  } catch {
    // no storage: explained again next time
  }
}
