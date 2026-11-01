import { noteName } from './chart';
import type { AudioStatus, OutputDevice } from './engine/tauri';
import type { Frame } from './engine/types';
import { toDb } from './guitar-settings';
import { lang, t } from './i18n';

export type AmpModelName = 'clean' | 'crunch' | 'lead' | 'metal';

/** The amp as the player sets it (engine-rt/dsp `AmpKnobs`): knobs 0..1, tone knobs flat at ½. */
export interface AmpSettings {
  model: AmpModelName;
  gain: number;
  bass: number;
  mid: number;
  treble: number;
  volume: number;
  delay: number;
  reverb: number;
  gate: boolean;
  /** The noise gate's threshold (dBFS); null: the channel's own (GATE_DB). */
  gateDb: number | null;
}

type Knobs = Omit<AmpSettings, 'model' | 'gateDb'>;

/** Each channel's own gate threshold (engine-rt/dsp amp voicings): a dirtier one cuts higher. */
export const GATE_DB: Record<AmpModelName, number> = { clean: -66, crunch: -60, lead: -56, metal: -50 };

export const AMP_MODELS: readonly { name: AmpModelName; label: string; blurb: string; knobs: Knobs }[] = [
  {
    name: 'clean',
    label: t('Clair'),
    blurb: t('Cristallin, un peu de grain quand on attaque fort'),
    knobs: { gain: 0.5, bass: 0.5, mid: 0.5, treble: 0.55, volume: 0.8, delay: 0, reverb: 0.35, gate: true },
  },
  {
    name: 'crunch',
    label: 'Crunch',
    blurb: t('La saturation du rock classique'),
    knobs: { gain: 0.5, bass: 0.5, mid: 0.55, treble: 0.5, volume: 0.8, delay: 0, reverb: 0.2, gate: true },
  },
  {
    name: 'lead',
    label: 'Lead',
    blurb: t('Médiums en avant, du sustain pour les solos'),
    knobs: { gain: 0.6, bass: 0.5, mid: 0.6, treble: 0.5, volume: 0.8, delay: 0.35, reverb: 0.3, gate: true },
  },
  {
    name: 'metal',
    label: t('Métal'),
    blurb: t('Très saturé et serré, le bruit coupé entre les notes'),
    knobs: { gain: 0.7, bass: 0.6, mid: 0.35, treble: 0.6, volume: 0.8, delay: 0, reverb: 0.1, gate: true },
  },
];

/** A model with its own starting knobs (what choosing it does). */
export function preset(name: AmpModelName): AmpSettings {
  const model = AMP_MODELS.find((m) => m.name === name) ?? AMP_MODELS[0];
  return { model: model.name, ...model.knobs, gateDb: null };
}

export const DEFAULT_AMP: AmpSettings = preset('clean');

/** Saved settings from an older version, or tampered with: back into range. */
export function sanitizeAmp(v: Partial<AmpSettings> | undefined): AmpSettings {
  const base = preset(AMP_MODELS.some((m) => m.name === v?.model) ? (v!.model as AmpModelName) : 'clean');
  const knob = (x: unknown, d: number) => (typeof x === 'number' && Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : d);
  return {
    model: base.model,
    gain: knob(v?.gain, base.gain),
    bass: knob(v?.bass, base.bass),
    mid: knob(v?.mid, base.mid),
    treble: knob(v?.treble, base.treble),
    volume: knob(v?.volume, base.volume),
    delay: knob(v?.delay, base.delay),
    reverb: knob(v?.reverb, base.reverb),
    gate: typeof v?.gate === 'boolean' ? v.gate : base.gate,
    gateDb: typeof v?.gateDb === 'number' && Number.isFinite(v.gateDb) ? Math.min(-20, Math.max(-90, v.gateDb)) : null,
  };
}

type KnobField = Exclude<keyof Knobs, 'gate'>;

const KNOBS: readonly { field: KnobField; label: string }[] = [
  { field: 'gain', label: 'Gain' },
  { field: 'bass', label: t('Graves') },
  { field: 'mid', label: t('Médiums') },
  { field: 'treble', label: t('Aigus') },
  { field: 'volume', label: 'Volume' },
  { field: 'delay', label: t('Écho') },
  { field: 'reverb', label: t('Réverb') },
];

/** What a knob position reads on the amp: 0 to 10, with the interface language's decimal mark. */
export const knobText = (v: number): string => {
  const text = (Math.round(v * 100) / 10).toFixed(1);
  return lang() === 'en' ? text : text.replace('.', ',');
};

const TEMPLATE = `
<div class="panel amp-panel">
  <div class="amp-head">
    <div class="amp-top">
      <div class="amp-brand">Riff<span>road</span><small>${t('Ampli')}</small></div>
      <div class="amp-channels" data-el="channels"></div>
    </div>
    <div class="amp-knobs" data-el="knobs"></div>
    <label class="amp-gate"><input type="checkbox" data-field="gate" /> Noise gate</label>
  </div>
  <p class="amp-blurb" data-el="blurb"></p>
  <div class="amp-live">
    <div class="amp-note"><b data-el="note">–</b><span data-el="cents"></span></div>
    <div class="amp-level">
      <div class="meter"><i data-el="bar"></i></div>
      <p class="help" data-el="hint"></p>
    </div>
  </div>
  <label class="row amp-output">${t('Sortie')} <select data-el="output"></select></label>
  <p class="help error" data-el="outputError" hidden></p>
  <div class="buttons">
    <button class="action primary" data-action="close-amp">${t('Terminé')}</button>
  </div>
</div>`;

export interface AmpHooks {
  changed(v: AmpSettings): void;
  outputs(): Promise<OutputDevice[]>;
  setOutput(name: string | null): void;
  status(): Promise<AudioStatus | null>;
}

/** Free play: the guitar through the amp, no song; the tone stays for the songs. */
export class AmpPanel {
  private readonly el: Record<string, HTMLElement> = {};
  private readonly knobs = new Map<KnobField, HTMLElement>();
  private level = 0;
  private heardAt = 0;

  constructor(
    private readonly root: HTMLElement,
    private values: AmpSettings,
    private readonly hooks: AmpHooks,
  ) {
    root.innerHTML = TEMPLATE;
    root.querySelectorAll<HTMLElement>('[data-el]').forEach((e) => (this.el[e.dataset.el!] = e));
    this.el.channels.replaceChildren(
      ...AMP_MODELS.map((m) => {
        const b = document.createElement('button');
        b.className = 'amp-channel';
        b.dataset.model = m.name;
        b.innerHTML = '<i class="led"></i><span></span>';
        b.querySelector('span')!.textContent = m.label;
        b.title = m.blurb;
        b.addEventListener('click', () => this.choose(m.name));
        return b;
      }),
    );
    this.el.knobs.replaceChildren(...KNOBS.map((k) => this.knob(k.field, k.label)));
    const gate = root.querySelector<HTMLInputElement>('[data-field="gate"]')!;
    gate.addEventListener('change', () => this.set({ gate: gate.checked }));
    const output = this.el.output as HTMLSelectElement;
    output.addEventListener('change', () => {
      this.hooks.setOutput(output.value || null);
      this.el.hint.textContent = t('Changement de sortie…');
      window.setTimeout(() => void this.refreshOutputs(), 700);
    });
    this.render();
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  open(status: AudioStatus | null): void {
    this.root.hidden = false;
    this.render();
    this.hint(status);
    void this.refreshOutputs();
  }

  close(): void {
    this.root.hidden = true;
  }

  /** Settings changed elsewhere (the pause's quick settings). */
  update(values: AmpSettings): void {
    this.values = values;
    this.render();
  }

  /** Input level and the note being played (tuner events). */
  feed(f: Frame, nowMs: number): void {
    const db = toDb(f.peak);
    this.level = Math.max(Number.isFinite(db) ? Math.min(1, Math.max(0, (db + 60) / 60)) : 0, this.level * 0.92);
    this.el.bar.style.width = `${(this.level * 100).toFixed(1)}%`;
    for (const e of f.events) {
      if (e.type !== 'pitch' || e.clarity < 0.85) continue;
      const midi = Math.round(e.midi);
      const cents = Math.round((e.midi - midi) * 100);
      this.el.note.textContent = noteName(midi);
      this.el.cents.textContent = `${cents >= 0 ? '+' : ''}${cents} ¢`;
      this.heardAt = nowMs;
    }
    if (nowMs - this.heardAt > 1500) {
      this.el.note.textContent = '–';
      this.el.cents.textContent = '';
    }
  }

  private choose(model: AmpModelName): void {
    this.values = preset(model);
    this.render();
    this.hooks.changed(this.values);
  }

  private set(change: Partial<AmpSettings>): void {
    this.values = { ...this.values, ...change };
    this.render();
    this.hooks.changed(this.values);
  }

  /** A rotary knob: drag up or down, the wheel, the arrow keys; double click back to ½. */
  private knob(field: KnobField, label: string): HTMLElement {
    const box = document.createElement('div');
    box.className = 'amp-knob';
    box.innerHTML = '<div class="dial" tabindex="0" role="slider" aria-valuemin="0" aria-valuemax="10"><i></i></div><span class="value"></span><span class="label"></span>';
    box.querySelector('.label')!.textContent = label;
    const dial = box.querySelector<HTMLElement>('.dial')!;
    dial.setAttribute('aria-label', label);
    const move = (to: number) => this.set({ [field]: Math.min(1, Math.max(0, Math.round(to * 100) / 100)) } as Partial<AmpSettings>);
    let drag: { y: number; v: number } | null = null;
    dial.addEventListener('pointerdown', (e) => {
      drag = { y: e.clientY, v: this.values[field] };
      dial.setPointerCapture(e.pointerId);
    });
    dial.addEventListener('pointermove', (e) => {
      if (drag) move(drag.v + (drag.y - e.clientY) / 160);
    });
    dial.addEventListener('pointerup', () => (drag = null));
    dial.addEventListener('wheel', (e) => {
      e.preventDefault();
      move(this.values[field] - Math.sign(e.deltaY) * 0.05);
    });
    dial.addEventListener('keydown', (e) => {
      const step = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? 0.05 : e.key === 'ArrowDown' || e.key === 'ArrowLeft' ? -0.05 : 0;
      if (step) {
        e.preventDefault();
        e.stopPropagation();
        move(this.values[field] + step);
      }
    });
    dial.addEventListener('dblclick', () => move(field === 'volume' ? 0.8 : 0.5));
    this.knobs.set(field, box);
    return box;
  }

  private render(): void {
    const model = AMP_MODELS.find((m) => m.name === this.values.model) ?? AMP_MODELS[0];
    this.el.channels.querySelectorAll<HTMLElement>('.amp-channel').forEach((b) => b.classList.toggle('on', b.dataset.model === model.name));
    this.el.blurb.textContent = t('{channel} : {blurb}.', { channel: model.label, blurb: model.blurb });
    this.root.querySelector<HTMLElement>('.amp-head')!.dataset.model = model.name;
    for (const [field, box] of this.knobs) {
      const v = this.values[field];
      box.style.setProperty('--v', String(v));
      box.querySelector('.value')!.textContent = knobText(v);
      box.querySelector('.dial')!.setAttribute('aria-valuenow', knobText(v));
    }
    this.root.querySelector<HTMLInputElement>('[data-field="gate"]')!.checked = this.values.gate;
  }

  /** Whether the guitar is heard, and where. */
  hint(status: AudioStatus | null): void {
    if (!status) {
      this.el.hint.textContent = t('Mode démo : pas d’entrée guitare ici. Lance l’application Riffroad avec le câble guitare USB.');
    } else if (!status.rocksmith) {
      this.el.hint.textContent = t('Branche le câble guitare USB pour t’entendre : le micro du Mac dans ses enceintes ferait un larsen.');
    } else {
      this.el.hint.textContent = t('Joue : ta guitare sort sur {output}.', { output: status.output ?? t('la sortie du Mac') });
    }
  }

  private async refreshOutputs(): Promise<void> {
    const select = this.el.output as HTMLSelectElement;
    let outputs: OutputDevice[] = [];
    try {
      outputs = await this.hooks.outputs();
    } catch {
      outputs = [];
    }
    select.replaceChildren(
      ...outputs.map((o) => {
        const opt = document.createElement('option');
        opt.value = o.name;
        opt.textContent = o.name;
        opt.selected = o.current;
        return opt;
      }),
    );
    select.disabled = outputs.length === 0;
    const status = await this.hooks.status().catch(() => null);
    this.hint(status);
    const error = status?.switchError ?? null;
    this.el.outputError.hidden = !error;
    this.el.outputError.textContent = error ? t('Impossible d’utiliser cette sortie : {error}', { error }) : '';
  }
}
