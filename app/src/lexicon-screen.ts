import { t } from './i18n';
import type { LessonRecords } from './lessons';
import { SYMBOLS, type SymbolEntry, type SymbolId } from './lexicon';
import { type Chapter, stars } from './parcours';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

/** A symbol as a card: its glyph, what it means, how to play it. */
export function symbolCard(s: SymbolEntry, footer?: string): HTMLElement {
  const card = el('div', 'symbol-card');
  const text = el('span', 'symbol-text');
  text.append(el('b', '', s.name), el('span', '', s.means), el('span', 'symbol-how', s.how));
  if (footer) text.append(el('small', '', footer));
  card.append(el('span', 'symbol-glyph', s.glyph), text);
  return card;
}

/** Every symbol of the highway, and where the path teaches it. */
export class LexiconScreen {
  constructor(
    private readonly root: HTMLElement,
    private readonly back: () => void,
  ) {
    root.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('[data-lexicon="back"]')) this.back();
    });
  }

  show(chapters: Chapter[], records: LessonRecords): void {
    const taught = new Map<SymbolId, { title: string; stars: number }>();
    for (const n of chapters.flatMap((c) => c.notions)) if (n.symbol && !taught.has(n.symbol)) taught.set(n.symbol, { title: n.title, stars: stars(n, records) });
    const panel = el('div', 'panel lessons-panel lexicon-panel');
    const head = el('header', 'screen-head');
    const back = el('button', 'action small', t('← Parcours'));
    back.type = 'button';
    back.dataset.lexicon = 'back';
    head.append(back, el('h2', '', t('Lexique des symboles')));
    const grid = el('div', 'symbol-grid');
    for (const s of SYMBOLS) {
      const where = taught.get(s.id);
      grid.append(symbolCard(s, where ? t('Appris dans « {title} » · {stars}', { title: where.title, stars: '★'.repeat(where.stars) + '☆'.repeat(3 - where.stars) }) : t('Plus loin dans le Parcours')));
    }
    panel.append(head, el('p', 'help', t('Ce que chaque symbole de l’autoroute te demande. Un symbole jamais vu s’explique aussi au début du morceau qui le montre.')), grid);
    this.root.replaceChildren(panel);
  }
}
