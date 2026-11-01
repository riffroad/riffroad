import { formatTime, noteName, phraseIndexAt, type Chart } from './chart';
import { accuracy, multiplier } from './game/types';
import type { GameView, Toast } from './game/view';
import { lang, t } from './i18n';
import { phraseLabels } from './sections';

/** Numbers grouped the way the interface language writes them. */
const NUMBERS = lang() === 'en' ? 'en-US' : 'fr-FR';

const TEMPLATE = `
<header class="top">
  <div class="song">
    <div data-el="cover"></div>
    <div class="song-text">
      <div class="title" data-el="title"></div>
      <div class="meta"><span data-el="artist"></span><span class="badge" data-el="tuning"></span></div>
    </div>
  </div>
  <div class="map">
    <div class="phrases" data-el="phrases"></div>
    <div class="cursor" data-el="cursor"></div>
    <div class="phrase-now"><span data-el="phrase"></span><span class="pips" data-el="pips"></span><span class="master-tag" data-el="master"></span><span class="time" data-el="time"></span></div>
    <div class="riff-badge" data-el="riff" hidden><b>LOOP TRAINER</b><span data-el="riffText"></span><span class="passes" data-el="passes"></span></div>
  </div>
  <div class="score">
    <div class="points" data-el="points">0</div>
    <div class="row"><span class="acc" data-el="acc">—</span><span class="mult" data-el="mult">×1</span></div>
  </div>
</header>
<div class="streak" data-el="streak"><b data-el="streakNum">0</b><span>${t('notes d\'affilée')}</span></div>
<div class="crowd-meter" data-el="crowd" hidden>
  <small data-el="gig"></small>
  <div class="crowd-row"><span>${t('Public')}</span><b data-el="crowdText"></b></div>
  <div class="crowd-bar"><i data-el="crowdBar"></i></div>
</div>
<div class="toasts" data-el="toasts"></div>
<div class="countdown" data-el="countdown"></div>
<div class="heard" data-el="heard"></div>
<footer class="hint" data-el="hint">${t('Espace pause · R recommencer · ← → ±5 s · ↑ ↓ vitesse · L Loop Trainer · ? raccourcis')}</footer>`;

/** Loop Trainer state shown over the highway. */
export interface RiffInfo {
  first: number;
  last: number;
  speed: number;
  /** Accuracy of each pass so far. */
  passes: number[];
}

/** Score, streak, phrase map with the level of each phrase, messages: the HTML layer over the highway. */
export class Hud {
  private readonly el: Record<string, HTMLElement> = {};
  private readonly last = new Map<string, string>();
  private chart: Chart | null = null;
  private blocks: HTMLElement[] = [];
  private labels: string[] = [];
  private streak = 0;
  private shownAt = 0;
  private master: ReadonlySet<number> | null = null;

  constructor(private readonly root: HTMLElement) {
    root.innerHTML = TEMPLATE;
    root.querySelectorAll<HTMLElement>('[data-el]').forEach((e) => (this.el[e.dataset.el!] = e));
  }

  show(on: boolean): void {
    this.root.hidden = !on;
  }

  /** A career gig: where and which song (null: none), and the crowd meter (0..1). */
  setGig(text: string | null): void {
    this.el.crowd.hidden = text === null;
    this.el.gig.textContent = text ?? '';
  }

  setCrowd(value: number): void {
    const v = Math.min(1, Math.max(0, value));
    this.set('crowdText', `${Math.round(v * 100)} %`);
    this.el.crowdBar.style.width = `${(v * 100).toFixed(1)}%`;
    this.el.crowd.dataset.mood = v >= 0.7 ? 'hot' : v >= 0.35 ? 'warm' : 'cold';
  }

  /** Master mode: the phrase iterations whose notes fade out (see Highway.setMaster). */
  setMaster(iterations: ReadonlySet<number> | null): void {
    this.master = iterations;
  }

  /** Loop Trainer badge (speed, passes) and its phrases on the map; null: off. */
  setRiff(info: RiffInfo | null): void {
    this.el.riff.hidden = !info;
    this.blocks.forEach((b, i) => {
      b.classList.toggle('riff-in', !!info && i >= info.first && i <= info.last);
      b.classList.toggle('riff-out', !!info && (i < info.first || i > info.last));
    });
    if (!info) return;
    const pct = (x: number) => `${Math.round(x * 100)} %`;
    this.el.riffText.textContent = t('Vitesse {speed} · Passe {n}', { speed: pct(info.speed), n: info.passes.length + 1 });
    this.el.passes.replaceChildren(
      ...info.passes.slice(-8).map((a) => {
        const bar = document.createElement('i');
        bar.style.setProperty('--h', String(Math.max(0.08, a)));
        bar.className = a >= 0.9 ? 'good' : a >= 0.5 ? 'fair' : 'poor';
        bar.title = pct(a);
        return bar;
      }),
    );
  }

  setSong(chart: Chart, cover: HTMLElement | null = null): void {
    this.chart = chart;
    this.el.cover.replaceChildren(...(cover ? [cover] : []));
    this.last.clear();
    this.el.title.textContent = chart.meta.title;
    this.el.artist.textContent = chart.meta.artist;
    this.el.tuning.textContent = chart.arrangement.tuning.name;
    const total = Math.max(chart.meta.duration, 1);
    this.labels = phraseLabels(chart);
    this.blocks = chart.phrases.map((p, i) => {
      const b = document.createElement('div');
      b.className = 'phrase-block';
      b.style.flexGrow = String(Math.max(p.end - p.start, 0.01) / total);
      b.title = this.labels[i];
      b.append(document.createElement('i'));
      return b;
    });
    this.el.phrases.replaceChildren(...this.blocks);
    this.streak = 0;
    this.el.toasts.replaceChildren();
    this.el.hint.classList.remove('gone');
    this.shownAt = performance.now();
  }

  update(view: GameView, now: number): void {
    const chart = this.chart;
    if (!chart) return;
    const s = view.score;
    const mult = multiplier(s.streak);
    this.set('points', s.points.toLocaleString(NUMBERS));
    this.set('mult', `×${mult}`);
    this.el.mult.style.setProperty('--p', String(mult === 4 ? 1 : (s.streak % 10) / 10));
    this.set('acc', s.hits + s.misses ? `${Math.round(accuracy(s) * 100)} %` : '—');
    this.set('streakNum', String(s.streak));
    if (s.streak !== this.streak) {
      const el = this.el.streak;
      el.classList.remove('pop', 'lost');
      void el.offsetWidth;
      el.classList.add(s.streak > this.streak ? 'pop' : 'lost');
      this.streak = s.streak;
    }

    const k = phraseIndexAt(chart, now);
    const phrase = chart.phrases[k];
    const level = view.levels.get(k);
    const levels = chart.arrangement.maxDifficulty + 1;
    const playing = phrase && !phrase.name.startsWith('rest');
    this.set('phrase', playing ? this.labels[k] : '');
    this.set('pips', playing && level !== undefined ? '●'.repeat(level + 1) + '○'.repeat(Math.max(0, levels - level - 1)) : '');
    this.set('master', playing && level === levels - 1 && this.master?.has(k) ? t('MAÎTRE') : '');
    this.set('time', `${formatTime(now)} / ${formatTime(chart.meta.duration)}`);
    this.el.cursor.style.left = `${Math.min(1, Math.max(0, now / chart.meta.duration)) * 100}%`;
    this.blocks.forEach((b, i) => {
      const lv = view.levels.get(i);
      const res = view.results.get(i);
      const state = `${lv ?? -1}|${res ? Math.round(res.accuracy * 100) : -1}|${i === k}`;
      if (b.dataset.state === state) return;
      b.dataset.state = state;
      (b.firstElementChild as HTMLElement).style.height = lv === undefined ? '0%' : `${((lv + 1) / levels) * 100}%`;
      b.classList.toggle('current', i === k);
      b.classList.toggle('done', !!res);
      b.classList.toggle('good', !!res && res.accuracy >= 0.85);
      b.classList.toggle('poor', !!res && res.accuracy < 0.5);
    });

    const count = now < 0 && now > -3.5 ? String(Math.ceil(-now)) : '';
    if (this.set('countdown', count) && count) {
      const el = this.el.countdown;
      el.classList.remove('tick');
      void el.offsetWidth;
      el.classList.add('tick');
    }
    const heard = view.heard && now - view.heard.at < 1.2 ? view.heard : null;
    this.set('heard', heard ? `${noteName(heard.midi)} ${heard.cents >= 0 ? '+' : ''}${Math.round(heard.cents)} ¢` : '');
    if (performance.now() - this.shownAt > 6000) this.el.hint.classList.add('gone');
  }

  toast(t: Toast): void {
    if (t.key) this.el.toasts.querySelector(`[data-key="${CSS.escape(t.key)}"]`)?.remove();
    const div = document.createElement('div');
    div.className = `toast ${t.kind}`;
    if (t.key) div.dataset.key = t.key;
    const title = document.createElement('b');
    title.textContent = t.title;
    div.append(title);
    if (t.detail) {
      const detail = document.createElement('span');
      detail.textContent = t.detail;
      div.append(detail);
    }
    this.el.toasts.append(div);
    // Over three, the oldest leave (their exit plays) instead of vanishing.
    const shown = [...this.el.toasts.children].filter((c) => !c.classList.contains('leaving'));
    for (const old of shown.slice(0, Math.max(0, shown.length - 3))) this.dismiss(old as HTMLElement);
    setTimeout(() => this.dismiss(div), 2400);
  }

  /** A toast leaves: its exit transition (0.2 s) plays, then it is removed. */
  private dismiss(toast: HTMLElement): void {
    if (toast.classList.contains('leaving')) return;
    toast.classList.add('leaving');
    setTimeout(() => toast.remove(), 200);
  }

  /** Updates a text node only when it changes; true if it did. */
  private set(key: string, text: string): boolean {
    if (this.last.get(key) === text) return false;
    this.last.set(key, text);
    this.el[key].textContent = text;
    return true;
  }
}
