import { lang, t } from './i18n';

/**
 * A ghost to race in Score Attack: another run's points at each second of the song (its trace),
 * set against the player's as the song goes. The player's own best run of that song and level,
 * or on the weekly challenge the run just above theirs on the board (cloud/: `/v1/challenge/rival`).
 * Points before the level's bonus: both runs are at the same level.
 */
export interface Ghost {
  name: string;
  trace: readonly number[];
}

/** The longest trace kept (cloud/api MAX_TRACE): half an hour of song. */
const MAX = 1800;

/** The points of a run at each whole second of the song, written as it is played. */
export class Trace {
  private points: number[] = [];

  /** Song time `time` (s) reached with `points`: each second passed since, written down. */
  note(time: number, points: number): void {
    while (this.points.length <= Math.floor(time) && this.points.length < MAX) this.points.push(points);
  }

  reset(): void {
    this.points = [];
  }

  get samples(): number[] {
    return [...this.points];
  }
}

/** A trace's points at song time `time`, between its seconds; its last ones once it is over. */
export function ghostAt(trace: readonly number[], time: number): number {
  if (!trace.length || time <= 0) return 0;
  const i = Math.floor(time);
  if (i >= trace.length - 1) return trace[trace.length - 1];
  return trace[i] + (trace[i + 1] - trace[i]) * (time - i);
}

/** The ghost under the Score Attack badge: whose run, its points, the gap. */
export class GhostHud {
  private readonly el: HTMLElement;
  private shown = '';

  constructor(hud: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'ghost-badge';
    this.el.hidden = true;
    (hud.querySelector('.map') ?? hud).append(this.el);
  }

  show(ghost: Ghost | null): void {
    this.el.hidden = !ghost;
    this.shown = '';
    if (ghost) this.el.dataset.name = ghost.name;
  }

  /** The player's points against the ghost's, now. */
  update(mine: number, theirs: number): void {
    if (this.el.hidden) return;
    const gap = Math.round((mine - theirs) / 10) * 10;
    const key = `${Math.round(theirs / 10)}:${gap}`;
    if (key === this.shown) return;
    this.shown = key;
    const n = (v: number) => Math.abs(v).toLocaleString(lang() === 'en' ? 'en-US' : 'fr-FR');
    const who = document.createElement('span');
    who.textContent = t('Fantôme : {name}', { name: this.el.dataset.name ?? '' });
    const score = document.createElement('span');
    score.textContent = n(Math.round(theirs));
    const lead = document.createElement('b');
    lead.textContent = gap === 0 ? t('à égalité') : `${gap > 0 ? '+' : '−'}${n(gap)}`;
    this.el.replaceChildren(who, score, lead);
    this.el.classList.toggle('ahead', gap > 0);
    this.el.classList.toggle('behind', gap < 0);
  }
}
