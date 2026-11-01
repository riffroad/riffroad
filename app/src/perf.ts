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
  /** Since the last frame: the time the page took to lay out and paint it, and the events'. */
  private since = { page: 0, events: 0 };

  constructor(doc: Document) {
    this.panel = doc.createElement('div');
    this.panel.className = 'perf-panel';
    this.panel.hidden = !this.saved();
    doc.body.append(this.panel);
    // On the window: an event sent to it (the tour's Escape) never reaches the document.
    const win = doc.defaultView ?? window;
    win.addEventListener('click', (e) => this.action(labelOf(e.target), e.timeStamp), true);
    win.addEventListener('keydown', (e) => this.action(`⌨ ${e.key}`, e.timeStamp), true);
    for (const type of ['click', 'keydown', 'pointerdown', 'pointerup']) win.addEventListener(type, () => this.handling(), true);
  }

  /** An event's handlers, from its first listener to the task after (what they cost the frame). */
  private handling(): void {
    const start = performance.now();
    const channel = new MessageChannel();
    channel.port1.onmessage = () => (this.since.events += performance.now() - start);
    channel.port2.postMessage(null);
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

  /** What the last frame's own work cost (ms), by part, and inside those parts: a hitch says whether it was ours. */
  private work: { parts: Record<string, number>; inside: Record<string, number> } = { parts: {}, inside: {} };

  /**
   * The parts of a frame's own work and their times, told at its end (`parts`: label → ms;
   * `inside`: shown, not added, being in a part already). The page's layout and paint of that
   * frame come after: timed up to the task that follows.
   */
  worked(parts: Record<string, number>, inside: Record<string, number> = {}): void {
    this.work = { parts, inside };
    const end = performance.now();
    const channel = new MessageChannel();
    channel.port1.onmessage = () => (this.since.page += performance.now() - end);
    channel.port2.postMessage(null);
  }

  /**
   * Each frame drawn (`ms`: its time): a late one is a hitch, put down to the last second's
   * action, with where its time went: the last frame's work, the page's layout and paint, the
   * events, and the rest (the main thread idle: the frame waited on the compositor or the GPU).
   */
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
      const parts = { ...this.work.parts, page: this.since.page, événements: this.since.events };
      const rest = gap - Object.values(parts).reduce((sum, v) => sum + v, 0);
      const split = Object.entries({ ...parts, ...this.work.inside, reste: rest })
        .map(([k, v]) => `${k} ${Math.round(v)}`)
        .join(', ');
      this.add({ label: `${label} [${split}]`, ms: gap, kind: 'hitch' });
    }
    this.since = { page: 0, events: 0 };
  }

  private add(e: Timing): void {
    this.entries.push(e);
    if (this.entries.length > KEEP) this.entries.shift();
    this.log(`${e.kind} ${Math.round(e.ms)} ms ${e.label}`);
    this.draw();
  }

  /** A line into the log, at its time (ms since the page opened). */
  log(line: string): void {
    const timed = `@${Math.round(performance.now())} ${line}`;
    console.debug(`[perf] ${timed}`);
    this.sink?.(timed);
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
export async function tour(doc: Document, only: readonly string[] = [], perf?: Perf): Promise<void> {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  /** Each step logged with what its handlers took (an event is handled at once). */
  const timed = (label: string, act: () => void) => {
    const start = performance.now();
    act();
    perf?.log(`tour ${label} ${Math.round(performance.now() - start)} ms`);
  };
  const back = () => timed('back', () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  const click = (selector: string) => timed(selector, () => doc.querySelector<HTMLElement>(selector)?.click());
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
