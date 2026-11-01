import { noteName } from './chart';
import type { GameEvent } from './game/types';
import { STRING_HEX } from './highway/highway';
import { lang, t, tn } from './i18n';

/** A string is in tune within this many cents… */
export const IN_TUNE_CENTS = 3;
/** …and stays so up to this many (no flicker at the edge)… */
const HOLD_CENTS = 4.5;
/** …held for this long. */
const HOLD_MS = 900;
/** Readings older than this no longer count (the string stopped ringing). */
const STALE_MS = 350;
/** The needle follows the readings with this time constant. */
const NEEDLE_MS = 90;
const COLORS = [t('rouge'), t('jaune'), t('bleue'), t('orange'), t('verte'), t('violette')];

/** Tunings offered when the tuner is opened on its own, low string first. */
export const TUNINGS: readonly { name: string; strings: readonly number[] }[] = [
  { name: 'E Standard', strings: [40, 45, 50, 55, 59, 64] },
  { name: 'Drop D', strings: [38, 45, 50, 55, 59, 64] },
  { name: 'Eb Standard', strings: [39, 44, 49, 54, 58, 63] },
  { name: 'D Standard', strings: [38, 43, 48, 53, 57, 62] },
  { name: 'Drop C#', strings: [37, 44, 49, 54, 58, 63] },
  { name: 'C# Standard', strings: [37, 42, 47, 52, 56, 61] },
  { name: 'Drop C', strings: [36, 43, 48, 53, 57, 62] },
  { name: 'C Standard', strings: [36, 41, 46, 51, 55, 60] },
  { name: 'Open G', strings: [38, 43, 50, 55, 59, 62] },
  { name: 'Open D', strings: [38, 45, 50, 54, 57, 62] },
];

/** A tuning the guitar is in: open strings, low first, and cents off A440 (a recording's pitch). */
export interface HeldTuning {
  name: string;
  strings: readonly number[];
  cents: number;
}

/** `guitarTuning` setting: songs moved to the tuning the guitar was last tuned to. */
export const LAST_TUNING = 'last';

/** The tuning songs are moved to, from the setting (null: each song in its own, the player retunes). */
export function guitarFor(setting: string, held: HeldTuning | null): { name: string; strings: readonly number[] } | null {
  if (setting === LAST_TUNING) return held && { name: held.name, strings: held.strings };
  return TUNINGS.find((x) => x.name === setting) ?? null;
}

/** Whether the guitar must be tuned before playing in `tuning`: it is not known to be in it. */
export function mustTune(tuning: HeldTuning, held: HeldTuning | null): boolean {
  return !held || held.strings.join() !== tuning.strings.join() || Math.abs(held.cents - tuning.cents) >= IN_TUNE_CENTS;
}

export const centsOff = (midi: number, target: number): number => (midi - target) * 100;

/**
 * Which string a reading is for: the one being tuned, unless the pitch is plainly another
 * string's (within a quarter tone of it, two semitones away from the selected one).
 */
export function pickString(midi: number, targets: readonly number[], selected: number, done: readonly boolean[]): number {
  if (Math.abs(midi - targets[selected]) <= 2) return selected;
  const other = targets.findIndex((t, s) => s !== selected && !done[s] && Math.abs(midi - t) < 0.5);
  return other >= 0 ? other : selected;
}

/** A reading an octave off the string being tuned is that string (its fundamental is weak
 * through some pickups): nobody tunes a string a whole octave away. */
export function foldOctave(midi: number, target: number): number {
  for (const shift of [-12, 12]) if (Math.abs(midi + shift - target) < 1) return midi + shift;
  return midi;
}

/** Where the needle stands across the meter, -1..1: spread out near the centre, where the
 * last cents are found, like a strobe tuner's. */
export function meterPosition(cents: number): number {
  const k = Math.min(1, Math.abs(cents) / 50) ** 0.55;
  return Math.sign(cents) * k;
}

/** What to do with the tuning peg. */
export function advice(cents: number, played: number, target: number): string {
  if (Math.abs(cents) <= IN_TUNE_CENTS) return t('Juste !');
  const semis = Math.round(Math.abs(cents) / 100);
  const way = cents < 0 ? t('tends la corde') : t('détends la corde');
  if (semis >= 1) {
    const notes = { played: noteName(Math.round(played)), target: noteName(target), way };
    return tn(semis, '{played} au lieu de {target} : {way} ({n} demi-ton)', '{played} au lieu de {target} : {way} ({n} demi-tons)', notes);
  }
  return cents < 0 ? t('Un peu grave : {way}', { way }) : t('Un peu aigu : {way}', { way });
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

const letter = (midi: number) => noteName(midi).replace(/-?\d+$/, '');
const octave = (midi: number) => noteName(midi).match(/-?\d+$/)?.[0] ?? '';

/** Ticks of the meter (cents), the labelled ones last. */
const TICKS = [1, 2, 4, 5, 7, 15, 20, 25, 35, 40, 45];
const LABELLED = [0, 3, 10, 30];

const TEMPLATE = `
<div class="panel tuner-panel">
  <header class="tuner-head">
    <div class="tuner-cover" data-el="cover"></div>
    <div>
      <h2>${t('Accordeur')}</h2>
      <p data-el="subtitle"></p>
    </div>
    <label class="tuner-tuning" data-el="tuningRow">${t('Accordage')} <select data-el="tuning"></select></label>
  </header>
  <div class="tuner-stage">
    <svg class="headstock" viewBox="0 0 170 340" data-el="headstock" aria-label="${t('Choisis la corde à accorder')}"></svg>
    <div class="tuner-main">
      <div class="tuner-note"><b data-el="note">—</b><sub data-el="octave"></sub><span data-el="hz"></span></div>
      <div class="tune-meter" data-el="meter">
        <div class="tune-meter-zone"></div>
        <div class="tune-meter-ticks" data-el="ticks"></div>
        <div class="tune-meter-needle" data-el="needle"><i></i></div>
      </div>
      <div class="tuner-turn">
        <span class="turn tighten" data-el="tighten"><b>↻</b> ${t('Tends')}</span>
        <strong data-el="cents"></strong>
        <span class="turn loosen" data-el="loosen">${t('Détends')} <b>↺</b></span>
      </div>
      <div class="tuner-hold"><i data-el="hold"></i></div>
      <p class="advice" data-el="advice"></p>
    </div>
  </div>
  <div class="buttons">
    <button class="action primary" data-action="tuned" data-el="play" disabled>${t('Jouer')}</button>
    <button class="action" data-action="skip-tuning" data-el="skip">${t('Passer l’accordage')}</button>
  </div>
</div>`;

/**
 * Tuner: the headstock and its pegs, string by string, a meter that spreads
 * out the last cents, which way to turn, and a string validated once it holds within ±3 cents
 * for a moment, with a chime. Shown before every song, with the song's tuning, or on its own.
 */
export class Tuner {
  visible = false;
  private targets: number[] = [];
  /** The song's tuning against A440 (semitones): the strings go that much sharp, like the recording. */
  private shift = 0;
  private done: boolean[] = [];
  private selected = 0;
  private readings: { midi: number; at: number }[] = [];
  private inTuneMs = 0;
  private holding = false;
  private lastMs = 0;
  /** The needle, in cents, easing towards the readings. */
  private shown = 0;
  private live = false;
  private forSong = false;
  private ctx: AudioContext | null = null;
  private readonly el: Record<string, HTMLElement> = {};

  constructor(
    private readonly root: HTMLElement,
    private readonly hooks: { finish(skipped: boolean): void },
  ) {
    root.innerHTML = TEMPLATE;
    root.querySelectorAll<HTMLElement>('[data-el]').forEach((e) => (this.el[e.dataset.el!] = e));
    const tick = (c: number, label: boolean) => {
      const t = document.createElement('i');
      t.className = label ? 'major' : '';
      t.style.left = `${50 + 50 * meterPosition(c)}%`;
      if (label) t.dataset.label = c === 0 ? '0' : String(Math.abs(c));
      return t;
    };
    const ticks: HTMLElement[] = [];
    for (const c of TICKS) ticks.push(tick(-c, false), tick(c, false));
    for (const c of LABELLED) ticks.push(...(c ? [tick(-c, true), tick(c, true)] : [tick(0, true)]));
    this.el.ticks.replaceChildren(...ticks);
    const zone = root.querySelector<HTMLElement>('.tune-meter-zone')!;
    zone.style.left = `${50 + 50 * meterPosition(-IN_TUNE_CENTS)}%`;
    zone.style.right = `${50 - 50 * meterPosition(IN_TUNE_CENTS)}%`;
    const tuning = this.el.tuning as HTMLSelectElement;
    tuning.replaceChildren(...TUNINGS.map((t, i) => new Option(t.name, String(i))));
    tuning.addEventListener('change', () => {
      const t = TUNINGS[Number(tuning.value)];
      if (t) this.open([...t.strings], t.name);
    });
    root.addEventListener('click', (e) => {
      const target = (e.target as Element).closest<HTMLElement | SVGElement>('[data-action],[data-string]');
      if (!target) return;
      if (target.dataset.string !== undefined) this.select(Number(target.dataset.string));
      else if (target.dataset.action === 'tuned' && this.allDone()) this.hooks.finish(false);
      else if (target.dataset.action === 'skip-tuning') this.hooks.finish(true);
    });
  }

  /** `targets`: MIDI pitch of each open string, low string first; `cents`: the recording's
   * pitch against A440, which the strings follow. */
  open(targets: number[], tuning: string, song?: string, cover: HTMLElement | null = null, cents = 0): void {
    this.el.cover.replaceChildren(...(cover ? [cover] : []));
    this.el.cover.hidden = !cover;
    this.targets = targets;
    this.shift = cents / 100;
    const name = tuning;
    if (cents) tuning = `${tuning} · ${t('{cents} cents, comme l’enregistrement', { cents: `${cents > 0 ? '+' : '−'}${Math.abs(Math.round(cents))}` })}`;
    this.done = targets.map(() => false);
    this.selected = 0;
    this.readings = [];
    this.inTuneMs = 0;
    this.holding = false;
    this.lastMs = 0;
    this.shown = 0;
    this.live = false;
    this.forSong = !!song;
    this.el.subtitle.textContent = song ? `${tuning} · ${song}` : tuning;
    this.el.skip.textContent = song ? t('Passer l’accordage') : t('Fermer');
    // On its own, any tuning; before a song, the song's.
    this.el.tuningRow.hidden = this.forSong;
    const preset = TUNINGS.findIndex((t) => t.name === name);
    if (preset >= 0) (this.el.tuning as HTMLSelectElement).value = String(preset);
    this.visible = true;
    this.root.hidden = false;
    this.renderHeadstock();
    this.renderButtons();
    this.showIdle();
  }

  close(): void {
    this.visible = false;
    this.root.hidden = true;
  }

  allDone(): boolean {
    return this.done.length > 0 && this.done.every(Boolean);
  }

  feed(events: readonly GameEvent[], nowMs: number): void {
    for (const e of events) if (e.type === 'pitch') this.readings.push({ midi: e.midi, at: nowMs });
    this.readings = this.readings.filter((r) => nowMs - r.at < STALE_MS).slice(-3);
    const dt = this.lastMs ? Math.min(100, nowMs - this.lastMs) : 0;
    this.lastMs = nowMs;
    if (!this.readings.length) {
      this.inTuneMs = 0;
      this.holding = false;
      if (this.live) this.showIdle();
      return;
    }
    let midi = median(this.readings.map((r) => r.midi)) - this.shift;
    const s = pickString(midi, this.targets, this.selected, this.done);
    if (s !== this.selected) this.select(s);
    const target = this.targets[this.selected];
    midi = foldOctave(midi, target);
    const cents = centsOff(midi, target);
    // The needle eases towards the reading (from where it stood, or straight there at first).
    this.shown = this.live ? this.shown + (cents - this.shown) * (1 - Math.exp(-dt / NEEDLE_MS)) : cents;
    this.live = true;
    this.holding = Math.abs(cents) <= (this.holding ? HOLD_CENTS : IN_TUNE_CENTS);
    this.inTuneMs = this.holding ? this.inTuneMs + dt : 0;
    this.showReading(midi, cents, target);
    if (this.inTuneMs < HOLD_MS || this.done[this.selected]) return;
    this.done[this.selected] = true;
    this.inTuneMs = 0;
    this.holding = false;
    this.chime(this.allDone());
    const next = this.done.findIndex((d, k) => !d && k > this.selected);
    const any = this.done.findIndex((d) => !d);
    if (next >= 0 || any >= 0) this.select(next >= 0 ? next : any);
    else {
      this.renderHeadstock();
      this.renderButtons();
    }
  }

  private select(s: number): void {
    this.selected = s;
    this.inTuneMs = 0;
    this.holding = false;
    this.readings = [];
    this.live = false;
    this.renderHeadstock();
    this.showIdle();
  }

  /** A six-in-line headstock: the low string's peg nearest the nut, each string in its colour. */
  private renderHeadstock(): void {
    const nut = 312;
    const pegY = (s: number) => nut - 46 - s * 44;
    const parts = [
      '<defs><linearGradient id="hs-grain" x1="0" x2="1"><stop offset="0" stop-color="#6b4526"/><stop offset="0.5" stop-color="#8a5a32"/><stop offset="1" stop-color="#5a391f"/></linearGradient></defs>',
      `<path class="hs-wood" d="M62 ${nut} L62 64 C62 26 92 6 124 8 C156 10 166 40 146 66 C134 82 130 100 130 126 L130 ${nut} Z" />`,
      `<rect class="hs-nut" x="60" y="${nut}" width="72" height="10" />`,
    ];
    this.targets.forEach((midi, s) => {
      const x = 70 + s * 11;
      const y = pegY(s);
      const color = STRING_HEX[s] ?? '#fff';
      const state = this.done[s] ? 'done' : s === this.selected && !this.allDone() ? 'selected' : '';
      parts.push(
        `<line class="hs-string ${state}" x1="${x}" y1="${nut + 28}" x2="${x}" y2="${nut}" stroke="${color}" />`,
        `<line class="hs-string ${state}" x1="${x}" y1="${nut}" x2="82" y2="${y}" stroke="${color}" />`,
        `<g class="hs-peg ${state}" data-string="${s}" style="--string:${color}">` +
          `<line class="hs-shaft" x1="44" y1="${y}" x2="78" y2="${y}" />` +
          `<circle class="hs-post" cx="82" cy="${y}" r="6" />` +
          `<rect class="hs-key" x="2" y="${y - 15}" width="44" height="30" rx="8" />` +
          `<text x="24" y="${y + 6}">${this.done[s] ? '✓' : letter(midi)}</text>` +
          `</g>`,
      );
    });
    this.el.headstock.innerHTML = parts.join('');
  }

  private renderButtons(): void {
    const ready = this.allDone();
    (this.el.play as HTMLButtonElement).disabled = !ready;
    this.el.play.hidden = !this.forSong;
    if (ready) {
      this.el.advice.textContent = t('Guitare accordée !');
      this.el.advice.className = 'advice ok';
      this.el.play.focus();
    }
  }

  private showIdle(): void {
    this.live = false;
    this.setMeter(0, false);
    const target = this.targets[this.selected];
    this.el.note.textContent = target === undefined ? '—' : letter(target);
    this.el.octave.textContent = target === undefined ? '' : octave(target);
    this.el.hz.textContent = target === undefined ? '' : t('{hz} visés', { hz: hz(target + this.shift) });
    this.el.cents.textContent = '';
    this.el.hold.style.width = '0';
    this.el.tighten.classList.remove('on');
    this.el.loosen.classList.remove('on');
    if (this.allDone()) return;
    this.el.advice.textContent = t('Joue la corde {color} à vide et laisse-la sonner', { color: COLORS[this.selected] ?? '' });
    this.el.advice.className = 'advice';
  }

  private showReading(midi: number, cents: number, target: number): void {
    const ok = this.holding;
    this.setMeter(this.shown, true, ok);
    this.el.note.textContent = letter(Math.round(midi));
    this.el.octave.textContent = octave(Math.round(midi));
    this.el.hz.textContent = hz(midi + this.shift);
    const shown = Math.abs(this.shown) < 100 ? decimal(this.shown.toFixed(1)).replace('-', '−') : String(Math.round(this.shown));
    this.el.cents.textContent = ok ? t('Juste') : `${this.shown > 0 ? '+' : ''}${shown} cents`;
    this.el.tighten.classList.toggle('on', !ok && cents < 0);
    this.el.loosen.classList.toggle('on', !ok && cents > 0);
    this.el.hold.style.width = `${Math.min(100, (this.inTuneMs / HOLD_MS) * 100)}%`;
    if (this.allDone()) return;
    this.el.advice.textContent = ok ? t('Juste : laisse sonner…') : advice(cents, midi, target);
    this.el.advice.className = `advice${ok ? ' ok' : Math.abs(cents) <= 10 ? ' close' : ''}`;
  }

  private setMeter(cents: number, live: boolean, ok = false): void {
    this.el.needle.style.left = `${50 + 50 * meterPosition(cents)}%`;
    this.el.meter.classList.toggle('live', live);
    this.el.meter.classList.toggle('ok', ok);
    this.el.meter.classList.toggle('flat', live && !ok && cents < 0);
    this.el.meter.classList.toggle('sharp', live && !ok && cents > 0);
  }

  /** A string validated: a bell; the whole guitar: a chord. */
  private chime(all: boolean): void {
    try {
      this.ctx ??= new AudioContext();
      const ctx = this.ctx;
      const notes = all ? [1318.5, 1661.2, 1975.5] : [1975.5];
      notes.forEach((f, i) => {
        const at = ctx.currentTime + i * 0.09;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = f;
        gain.gain.setValueAtTime(0, at);
        gain.gain.linearRampToValueAtTime(0.12, at + 0.005);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.6);
        osc.connect(gain).connect(ctx.destination);
        osc.start(at);
        osc.stop(at + 0.65);
      });
    } catch {
      // no audio output for the page: the tick on the peg says it anyway
    }
  }
}

/** A number written the interface language's way (decimal comma in French). */
function decimal(text: string): string {
  return lang() === 'en' ? text : text.replace('.', ',');
}

/** A frequency to the hundredth of a hertz. */
function hz(midi: number): string {
  return `${decimal((440 * 2 ** ((midi - 69) / 12)).toFixed(2))} Hz`;
}
