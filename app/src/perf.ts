import { t } from './i18n';

/**
 * How fast the interface answers, measured in the game itself (Shift+P shows it): each click or
 * key, from the event to the frame that shows its result; the steps of a song's start; the frames
 * that came late, put down to the action just before. The last ones are kept, and logged.
 */

export interface Timing {
  label: string;
  ms: number;
  kind: 'action' | 'step' | 'hitch';
}

const KEEP = 40;
const SHOWN = 14;
/** A frame this late (ms) is a hitch (60 fps: 17 ms). */
const HITCH = 50;
/** Past this gap the window was hidden, not slow. */
const ASLEEP = 2000;
const STORE = 'opensmith.perf';

/** What the event was about, in a few words: the button's text, else the element's name. */
function labelOf(target: EventTarget | null): string {
  if (!(target instanceof Element)) return '?';
  const el = target.closest('button, a, [role="button"], [data-id], label, li') ?? target;
  const text = (el.getAttribute('aria-label') ?? el.textContent ?? '').replace(/\s+/g, ' ').trim();
  return (text || el.id || el.className.toString() || el.tagName.toLowerCase()).slice(0, 36);
}

export class Perf {
  readonly entries: Timing[] = [];
  /** Where each timing also goes, as a line (the desktop app: its log). */
  sink: ((line: string) => void) | null = null;
  private readonly panel: HTMLElement;
  private current = { label: '', at: -Infinity };
  private last = 0;
  private fps = { frames: 0, since: 0, value: 0 };

  constructor(doc: Document) {
    this.panel = doc.createElement('div');
    this.panel.className = 'perf-panel';
    this.panel.hidden = !this.saved();
    doc.body.append(this.panel);
    doc.addEventListener('click', (e) => this.action(labelOf(e.target), e.timeStamp), true);
    doc.addEventListener('keydown', (e) => this.action(`⌨ ${e.key}`, e.timeStamp), true);
  }

  get visible(): boolean {
    return !this.panel.hidden;
  }

  toggle(): void {
    this.panel.hidden = !this.panel.hidden;
    try {
      localStorage.setItem(STORE, this.panel.hidden ? '0' : '1');
    } catch {
      // no storage
    }
    this.draw();
  }

  /** From the event (at `start`, ms) to the next frame shown: what the player waits. */
  private action(label: string, start: number): void {
    this.current = { label, at: start };
    requestAnimationFrame(() => {
      // Past the frame's paint: a message runs after it.
      const channel = new MessageChannel();
      channel.port1.onmessage = () => this.add({ label, ms: performance.now() - start, kind: 'action' });
      channel.port2.postMessage(null);
    });
  }

  /** A step of a longer action (a song's start), from now to the call of what it returns. */
  step(label: string): () => void {
    const start = performance.now();
    return () => this.add({ label, ms: performance.now() - start, kind: 'step' });
  }

  /** What the last frame's own work cost (ms), by part: a hitch says whether it was ours. */
  private work = '';

  /** The parts of a frame's own work and their times, told after it (`parts`: label → ms). */
  worked(parts: Record<string, number>): void {
    this.work = Object.entries(parts)
      .map(([k, v]) => `${k} ${Math.round(v)}`)
      .join(', ');
  }

  /** Each frame drawn (`ms`: its time): a late one is a hitch, put down to the last second's action. */
  frame(ms: number): void {
    const gap = ms - this.last;
    this.last = ms;
    this.fps.frames++;
    if (ms - this.fps.since >= 1000) {
      this.fps = { frames: 0, since: ms, value: Math.round((this.fps.frames * 1000) / (ms - this.fps.since)) };
      this.draw();
    }
    if (gap > HITCH && gap < ASLEEP) {
      const label = ms - this.current.at < 1000 ? this.current.label : '';
      this.add({ label: `${label} [${this.work}]`, ms: gap, kind: 'hitch' });
    }
  }

  private add(e: Timing): void {
    this.entries.push(e);
    if (this.entries.length > KEEP) this.entries.shift();
    const line = `${e.kind} ${Math.round(e.ms)} ms ${e.label}`;
    console.debug(`[perf] ${line}`);
    this.sink?.(line);
    this.draw();
  }

  private draw(): void {
    if (this.panel.hidden) return;
    const rows = this.entries.slice(-SHOWN).reverse().map((e) => {
      const row = document.createElement('div');
      row.className = `perf-row ${e.ms < 100 ? 'ok' : e.ms < 300 ? 'slow' : 'bad'}`;
      const kind = e.kind === 'hitch' ? t('saccade') : e.kind === 'step' ? t('étape') : '';
      row.textContent = `${String(Math.round(e.ms)).padStart(5)} ms  ${kind ? `${kind} · ` : ''}${e.label}`;
      return row;
    });
    const head = document.createElement('div');
    head.className = 'perf-head';
    head.textContent = t('Temps de réponse · {fps} images/s · Maj+P', { fps: this.fps.value });
    this.panel.replaceChildren(head, ...rows);
  }

  private saved(): boolean {
    try {
      return localStorage.getItem(STORE) === '1' || new URLSearchParams(location.search).has('perf');
    } catch {
      return false;
    }
  }
}

/** The menu entries the tour opens, and back (not the import's file picker: no dialog). */
const TOUR = ['open-lessons', 'open-career', 'open-trophies', 'open-library', 'open-riff-library', 'open-amp', 'open-tuner', 'open-settings'];

/**
 * Clicks through the menus as a player would, twice, then starts the library's first song: the
 * timings of the app itself (`OPENSMITH_TOUR=1`, or a list of menu actions, development), in its log.
 */
export async function tour(doc: Document, only: readonly string[] = []): Promise<void> {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const back = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  const click = (selector: string) => doc.querySelector<HTMLElement>(selector)?.click();
  await wait(3000);
  for (let round = 0; round < 2; round++) {
    for (const action of only.length ? only : TOUR) {
      click(`button.menu-item[data-action="${action}"]`);
      await wait(2500);
      back();
      await wait(1500);
    }
  }
  click('button.menu-item[data-action="open-library"]');
  await wait(3000);
  click('.song-tile');
  await wait(1500);
  click('#library button[data-lib="play"]');
}
