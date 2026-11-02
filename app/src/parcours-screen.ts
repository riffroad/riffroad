import { t } from './i18n';
import type { LessonRecords } from './lessons';
import { symbol } from './lexicon';
import { type Chapter, type Exercise, learned, nextNotion, open, passedExercise, stars } from './parcours';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

const pct = (x: number): string => t('{n} %', { n: Math.round(x * 100) });
const starText = (n: number): string => '★'.repeat(n) + '☆'.repeat(3 - n);

export interface ParcoursHooks {
  /** Plays exercise `step` of notion `notion` in chapter `chapter`. */
  play(chapter: number, notion: number, step: number): void;
  /** Plays recording session `index` (of `lessons()`). */
  record(index: number): void;
  lexicon(): void;
}

/** The learning path: its chapters and notions, the one picked (the next to learn at first)
 * open on what it teaches and its three exercises; the recording sessions below. */
export class ParcoursScreen {
  private all: Chapter[] = [];
  private records: LessonRecords = {};
  private recordings: { index: number; title: string; learn: string }[] = [];
  private picked: [number, number] = [0, 0];

  constructor(
    private readonly root: HTMLElement,
    private readonly hooks: ParcoursHooks,
  ) {
    root.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const play = target.closest<HTMLElement>('[data-exercise]');
      if (play) {
        const [c, n, k] = play.dataset.exercise!.split(':').map(Number);
        this.hooks.play(c, n, k);
        return;
      }
      const rec = target.closest<HTMLElement>('[data-record]');
      if (rec) {
        this.hooks.record(Number(rec.dataset.record));
        return;
      }
      if (target.closest('[data-parcours="lexicon"]')) {
        this.hooks.lexicon();
        return;
      }
      const card = target.closest<HTMLElement>('[data-notion]');
      if (card) {
        const [c, n] = card.dataset.notion!.split(':').map(Number);
        this.picked = [c, n];
        this.render();
      }
    });
  }

  /** The path with its records, `picked` opened (by default the next notion to learn). */
  show(all: Chapter[], records: LessonRecords, recordings: { index: number; title: string; learn: string }[], picked?: [number, number]): void {
    this.all = all;
    this.records = records;
    this.recordings = recordings;
    this.picked = picked ?? nextNotion(all, records);
    this.render();
  }

  /** Plays the opened notion's first exercise not passed yet (Enter). */
  startPicked(): void {
    const [c, n] = this.picked;
    if (!open(this.all, c, n, this.records)) return;
    const exercises = this.all[c].notions[n].exercises;
    const k = exercises.findIndex((e) => !passedExercise(e, this.records));
    this.hooks.play(c, n, k < 0 ? exercises.length - 1 : k);
  }

  private render(): void {
    const notions = this.all.flatMap((c) => c.notions);
    const earned = notions.reduce((sum, n) => sum + stars(n, this.records), 0);
    const [nc, nn] = nextNotion(this.all, this.records);
    const panel = el('div', 'panel lessons-panel parcours-panel');
    const head = el('header', 'screen-head');
    const back = el('button', 'action small', t('← Menu'));
    back.type = 'button';
    back.dataset.action = 'menu';
    const lexicon = el('button', 'action small', t('Lexique des symboles'));
    lexicon.type = 'button';
    lexicon.dataset.parcours = 'lexicon';
    head.append(back, el('h2', '', t('Parcours')), el('span', 'lessons-count', t('{n} étoiles sur {total}', { n: earned, total: notions.length * 3 })), lexicon);
    panel.append(
      head,
      el('p', 'help', t('Une notion à la fois : trois exercices, du pas à pas au morceau avec le groupe. Deux étoiles pour l’apprendre et ouvrir la suivante ; elles se gagnent sur les notes de la notion.')),
    );
    this.all.forEach((chapter, c) => {
      panel.append(el('h3', 'parcours-chapter', t('Chapitre {n} · {title}', { n: c + 1, title: chapter.title })), el('p', 'help', chapter.blurb));
      const list = el('ol', 'lesson-list');
      chapter.notions.forEach((notion, n) => {
        const playable = open(this.all, c, n, this.records);
        const done = learned(notion, this.records);
        const isNext = c === nc && n === nn && !done;
        const isOpen = c === this.picked[0] && n === this.picked[1];
        const item = el('li', `lesson notion${done ? ' passed' : ''}${isNext ? ' next' : ''}${isOpen ? ' open' : ''}${playable ? '' : ' locked'}`);
        const top = el('button', 'lesson-top');
        top.type = 'button';
        top.dataset.notion = `${c}:${n}`;
        const text = el('span', 'lesson-text');
        text.append(el('b', '', notion.title), el('span', '', notion.learn));
        const meta = el('small', 'notion-stars', starText(stars(notion, this.records)));
        if (notion.symbol) meta.append(el('span', 'notion-symbol', symbol(notion.symbol).glyph));
        text.append(meta);
        top.append(el('span', 'lesson-number', playable ? (done ? '✓' : String(n + 1)) : '🔒'), text);
        item.append(top);
        if (isOpen) item.append(this.detail(c, n, playable));
        list.append(item);
      });
      panel.append(list);
    });
    if (this.recordings.length) {
      panel.append(
        el('h3', 'lessons-record-head', t('Ta guitare, pour mieux t’écouter')),
        el('p', 'help', t('Deux séances de quelques minutes, sans objectif : ta guitare est enregistrée sur ce Mac pendant que tu joues, pour régler la détection des notes sur son son.')),
      );
      const row = el('div', 'buttons');
      for (const r of this.recordings) {
        const b = el('button', 'action', r.title);
        b.type = 'button';
        b.dataset.record = String(r.index);
        b.title = r.learn;
        row.append(b);
      }
      panel.append(row);
    }
    this.root.replaceChildren(panel);
    this.root.querySelector<HTMLElement>('.lesson.open')?.scrollIntoView({ block: 'nearest' });
  }

  /** The notion opened: why, how, its symbol, its exercises. */
  private detail(c: number, n: number, playable: boolean): HTMLElement {
    const notion = this.all[c].notions[n];
    const box = el('div', 'lesson-how notion-detail');
    box.append(el('p', 'notion-why', notion.why), el('h3', '', t('Comment faire')));
    const how = el('ul');
    how.append(...notion.how.map((h) => el('li', '', h)));
    box.append(how);
    if (notion.symbol) {
      const s = symbol(notion.symbol);
      const card = el('div', 'symbol-card');
      const text = el('span', 'symbol-text');
      text.append(el('b', '', t('Sur l’autoroute : {name}', { name: s.name })), el('span', '', `${s.means} ${s.how}`));
      card.append(el('span', 'symbol-glyph', s.glyph), text);
      box.append(card);
    }
    const before = n > 0 ? this.all[c].notions[n - 1] : null;
    if (!playable) box.append(el('p', 'notion-locked', before ? t('Apprends d’abord « {title} » (deux étoiles).', { title: before.title }) : t('Termine d’abord le chapitre précédent.')));
    const list = el('ol', 'exercise-list');
    notion.exercises.forEach((ex, k) => list.append(this.exercise(ex, c, n, k, playable)));
    box.append(list);
    return box;
  }

  private exercise(ex: Exercise, c: number, n: number, k: number, playable: boolean): HTMLElement {
    const ok = passedExercise(ex, this.records);
    const best = this.records[ex.id];
    const item = el('li', `exercise${ok ? ' passed' : ''}`);
    const text = el('span', 'lesson-text');
    const bpm = Math.round(ex.lesson.bpm * ex.pace);
    const how =
      ex.kind === 'step'
        ? t('Le jeu attend chaque note : prends le temps de placer les doigts.')
        : ex.kind === 'time'
          ? t('{bpm} battements par minute, avec le groupe.', { bpm })
          : t('{bpm} battements par minute, avec le groupe, deux fois plus long.', { bpm });
    const score = best === undefined ? t('Objectif {goal}', { goal: pct(ex.goal) }) : t('Objectif {goal} · ton meilleur {best}', { goal: pct(ex.goal), best: pct(best) });
    text.append(el('b', '', `${ok ? '★' : '☆'} ${ex.title}`), el('span', '', how), el('small', '', score));
    const go = el('button', `action small${ok ? '' : ' primary'}`, ok ? t('Rejouer') : t('Jouer'));
    go.type = 'button';
    go.dataset.exercise = `${c}:${n}:${k}`;
    go.disabled = !playable;
    item.append(text, go);
    return item;
  }
}
