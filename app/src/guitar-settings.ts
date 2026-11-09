import { AMP_MODELS, GATE_DB, preset, type AmpModelName, type AmpSettings } from './amp';
import type { AudioStatus, InputDevice, InputSettings, OutputDevice } from './engine/tauri';
import type { Frame } from './engine/types';
import { lang, t } from './i18n';

export interface GuitarValues {
  /** Zero-based input channel; monitoring: -1 automatic, 0 off, 1 on. */
  inputChannel: number;
  monitoring: number;
  inputGainDb: number;
  /** Latency compensation: subtracted from every attack (ms). */
  inputOffsetMs: number;
  /** The highway runs this much ahead of the sound (ms). */
  visualOffsetMs: number;
  /** Slider positions 0..1; the gain is the square (perceptual). The master scales both. */
  masterVolume: number;
  backingVolume: number;
  monitorVolume: number;
  /** The song's own guitar, when its import kept it apart (MP3 imports): silent by default. */
  stemVolume: number;
  /** The interface's clicks and the game's cues; the crowd. */
  effectsVolume: number;
  crowdVolume: number;
}

export const DEFAULT_GUITAR: GuitarValues = {
  inputChannel: 0,
  monitoring: -1,
  inputGainDb: 0,
  inputOffsetMs: 0,
  visualOffsetMs: 0,
  masterVolume: 1,
  backingVolume: 0.85,
  monitorVolume: 0.9,
  stemVolume: 0,
  effectsVolume: 0.7,
  crowdVolume: 0.8,
};

export const toDb = (x: number): number => (x > 0 ? 20 * Math.log10(x) : -Infinity);
const fromDb = (db: number): number => 10 ** (db / 20);
/** A number with the interface language's decimal mark (0,5 or 0.5). */
const decimal = (x: number): string => (lang() === 'en' ? x.toString() : x.toString().replace('.', ','));

/** What the engine applies. */
export function engineSettings(v: GuitarValues): InputSettings {
  const master = v.masterVolume ?? 1;
  return {
    inputChannel: v.inputChannel ?? 0,
    monitor: (v.monitoring ?? -1) < 0 ? null : v.monitoring === 1,
    inputGainDb: v.inputGainDb,
    inputOffsetMs: v.inputOffsetMs,
    backingVolume: (v.backingVolume * master) ** 2,
    monitorVolume: (v.monitorVolume * master) ** 2,
    stemVolume: ((v.stemVolume ?? 0) * master) ** 2,
  };
}

/**
 * Input gain from a silence and a strong strum, both measured with gain `currentDb`: the strum
 * peaks at −12 dBFS, the noise floor stays under −50 dBFS (the gate and the onset detector
 * listen above −60).
 */
export function suggestGainDb(currentDb: number, noisePeak: number, playPeak: number): { gainDb: number; ok: boolean; message: string } {
  const g = fromDb(currentDb);
  const play = playPeak / g;
  const noise = noisePeak / g;
  if (play < 1e-4 || play < 2 * noise) {
    return { gainDb: currentDb, ok: false, message: t('Rien entendu de plus fort que le silence : vérifie le câble et le volume de la guitare.') };
  }
  let gainDb = toDb(0.25 / play);
  let message = '';
  if (gainDb > 30) message = t('Signal très faible : monte le volume de ta guitare.');
  const noiseLimit = noise > 0 ? toDb(0.00316 / noise) : Infinity;
  if (gainDb > noiseLimit) {
    gainDb = noiseLimit;
    message = t('Bruit de fond élevé : gain limité. Monte plutôt le volume de la guitare.');
  }
  gainDb = Math.round(Math.max(-12, Math.min(30, gainDb)) * 2) / 2;
  return { gainDb, ok: true, message: message || t('Gain réglé à {gain} dB.', { gain: `${gainDb > 0 ? '+' : ''}${decimal(gainDb)}` }) };
}

const signed = (x: number, unit: string) => `${x > 0 ? '+' : ''}${decimal(x)} ${unit}`;

const TEMPLATE = `
  <p class="device" data-el="device"></p>
  <p class="help settings-demo" data-el="demo" hidden>${t('Dans le navigateur, ces réglages restent sans effet : c’est l’app de bureau qui écoute la guitare (CoreAudio).')}</p>
  <section data-part="devices" data-tabs="audio">
    <h3>${t('Périphériques CoreAudio')}</h3>
    <label class="row">${t('Entrée')} <select data-el="input"></select></label>
    <label class="row">${t('Canal d’entrée')} <select data-el="inputChannel" data-field="inputChannel"></select></label>
    <label class="row">${t('Sortie')} <select data-el="output"></select></label>
    <label class="row">${t('Retour de la guitare')} <select data-field="monitoring"><option value="-1">${t('Automatique')}</option><option value="0">${t('Coupé')}</option><option value="1">${t('Activé (casque ou interface)')}</option></select></label>
    <p class="help">${t('Changer de périphérique redémarre le moteur audio : un morceau en cours s’arrête.')}</p>
  </section>
  <section data-part="level" data-tabs="audio latency">
    <h3>${t('Niveau d’entrée')}</h3>
    <div class="meter"><i data-el="bar"></i><b data-el="hold"></b></div>
    <div class="meter-scale"><span>−60</span><span>−45</span><span>−30</span><span>−15</span><span>0 dB</span></div>
    <p class="meter-text" data-el="meterText">${t('Joue pour voir le niveau.')}</p>
    <label class="row">Gain <input type="range" min="-12" max="30" step="0.5" data-field="inputGainDb" /><output data-out="inputGainDb"></output></label>
    <div class="row-actions"><button class="action small" data-action="auto-level">${t('Calibrer le niveau des micros')}</button><span data-el="levelText"></span></div>
  </section>
  <section data-part="gate" data-tabs="audio">
    <h3>Noise gate</h3>
    <label class="row">${t('Seuil')} <input type="range" min="-90" max="-20" step="1" data-el="gate" /><output data-el="gateOut"></output></label>
    <div class="row-actions"><button class="action small" data-action="gate-auto">${t('Seuil du canal')}</button><span class="help" data-el="gateText"></span></div>
  </section>
  <section data-part="volumes" data-tabs="audio">
    <h3>${t('Mixage')}</h3>
    <label class="row">Master <input type="range" min="0" max="1" step="0.01" data-field="masterVolume" /><output data-out="masterVolume"></output></label>
    <label class="row">Backing track <input type="range" min="0" max="1" step="0.01" data-field="backingVolume" /><output data-out="backingVolume"></output></label>
    <label class="row" data-el="monitorRow">${t('Guitare')} <input type="range" min="0" max="1" step="0.01" data-field="monitorVolume" /><output data-out="monitorVolume"></output></label>
    <label class="row">${t('Effets sonores')} <input type="range" min="0" max="1" step="0.01" data-field="effectsVolume" /><output data-out="effectsVolume"></output></label>
    <label class="row">${t('Public')} <input type="range" min="0" max="1" step="0.01" data-field="crowdVolume" /><output data-out="crowdVolume"></output></label>
    <p class="help" data-el="monitorHelp" hidden>${t('Le retour est coupé. Active-le pour entendre ta guitare via ton interface ; utilise un casque avec une entrée micro.')}</p>
  </section>
  <section data-part="amp" data-tabs="audio">
    <h3>${t('Profil d’ampli')}</h3>
    <label class="row">${t('Canal')} <select data-el="ampModel"></select></label>
    <p class="help" data-el="ampBlurb"></p>
  </section>
  <section data-part="latency" data-tabs="latency">
    <h3>${t('Latence')}</h3>
    <p class="help">${t('Écoute les 4 clics d’annonce, puis gratte une corde étouffée pile sur chacun des 12 clics suivants.')}</p>
    <div class="clicks" data-el="clicks"></div>
    <div class="row-actions"><button class="action small primary" data-action="calibrate">${t('Calibrer')}</button><span data-el="latencyText"></span></div>
    <label class="row">Compensation <input type="range" min="-150" max="150" step="1" data-field="inputOffsetMs" /><output data-out="inputOffsetMs"></output></label>
    <label class="row">${t('Avance de l’affichage')} <input type="range" min="-150" max="150" step="1" data-field="visualOffsetMs" /><output data-out="visualOffsetMs"></output></label>
  </section>
  <section data-part="sync" data-tabs="latency">
    <h3>${t('Repère de synchro')}</h3>
    <p class="help">${t('Un clic et un éclair, ensemble : règle l’avance de l’affichage jusqu’à ce que l’éclair tombe pile sur le clic.')}</p>
    <div class="sync-box"><span class="sync-lamp" data-el="lamp"></span><span class="sync-track"><i data-el="sweep"></i></span></div>
    <div class="row-actions"><button class="action small" data-action="sync" data-el="syncButton">${t('Lancer le repère')}</button></div>
  </section>`;

interface Plan {
  first: number;
  period: number;
  countIn: number;
  clicks: number;
}

type LevelStep = { phase: 'silence' | 'play'; until: number; noise: number; play: number };

export interface GuitarHooks {
  changed(v: GuitarValues): void;
  refreshAudio?(): void;
  calibrate(): void;
  /** The Mac's devices (empty in the browser) and the switch to one (null: automatic). */
  inputs(): Promise<InputDevice[]>;
  outputs(): Promise<OutputDevice[]>;
  setInput(name: string | null): void;
  setOutput(name: string | null): void;
  /** The amp as set, and a change to it (channel, gate threshold). */
  amp(): AmpSettings;
  setAmp(a: AmpSettings): void;
}

/** Input level, latency calibration and volumes: what makes the game hear the guitar right. */
export class GuitarSettings {
  visible = false;
  private readonly el: Record<string, HTMLElement> = {};
  private shown = -Infinity;
  private hold = { db: -Infinity, at: 0 };
  private level: LevelStep | null = null;
  private plan: Plan | null = null;
  private hits = new Map<number, number>();

  /** The synced click and flash (latency tab): the clicks' audio clock, the flashes due. */
  private marker: { ctx: AudioContext; timer: number; next: number; flashes: number[] } | null = null;
  private tabShown: 'audio' | 'latency' = 'audio';

  constructor(
    private readonly root: HTMLElement,
    private readonly values: GuitarValues,
    private readonly hooks: GuitarHooks,
  ) {
    root.innerHTML = TEMPLATE;
    root.querySelectorAll<HTMLElement>('[data-el]').forEach((e) => (this.el[e.dataset.el!] = e));
    (this.el.ampModel as HTMLSelectElement).replaceChildren(...AMP_MODELS.map((m) => new Option(m.label, m.name)));
    root.addEventListener('input', (e) => {
      const input = e.target as HTMLInputElement | HTMLSelectElement;
      const name = input.dataset.el;
      if (name === 'gate') {
        this.hooks.setAmp({ ...this.hooks.amp(), gateDb: Number(input.value) });
        this.syncAmp();
        return;
      }
      if (name === 'ampModel') {
        // A channel with its own knobs; the gate threshold chosen stays.
        this.hooks.setAmp({ ...preset(input.value as AmpModelName), gateDb: this.hooks.amp().gateDb });
        this.syncAmp();
        return;
      }
      if (name === 'input') {
        this.values.inputChannel = 0;
        this.hooks.setInput(input.value || null);
        this.hooks.changed(this.values);
        void this.listDevices();
        this.el.device.textContent = t('Changement d’entrée…');
        return;
      }
      if (name === 'output') {
        this.hooks.setOutput(input.value || null);
        this.el.device.textContent = t('Changement de sortie…');
        return;
      }
      const field = input.dataset.field as keyof GuitarValues | undefined;
      if (!field) return;
      this.values[field] = Number(input.value);
      this.sync();
      this.hooks.changed(this.values);
      if (field === 'inputChannel' || field === 'monitoring') this.hooks.refreshAudio?.();
    });
    root.addEventListener('click', (e) => {
      const action = (e.target as HTMLElement).closest<HTMLElement>('[data-action]')?.dataset.action;
      if (action === 'auto-level') this.startLevel();
      else if (action === 'calibrate') this.startLatency();
      else if (action === 'gate-auto') {
        this.hooks.setAmp({ ...this.hooks.amp(), gateDb: null });
        this.syncAmp();
      } else if (action === 'sync') {
        if (this.marker) this.stopMarker();
        else this.startMarker();
      }
    });
  }

  /** One of the settings' tabs: the audio chain, or latency and calibration. */
  tab(which: 'audio' | 'latency'): void {
    this.tabShown = which;
    this.root.querySelectorAll<HTMLElement>('section[data-part]').forEach((s) => (s.hidden = !(s.dataset.tabs ?? '').split(' ').includes(which)));
    if (which !== 'latency') this.stopMarker();
  }

  /** The devices of the Mac in the selectors, the current ones chosen. */
  private async listDevices(): Promise<void> {
    const [inputs, outputs] = await Promise.all([this.hooks.inputs().catch(() => []), this.hooks.outputs().catch(() => [])]);
    const fill = (select: HTMLSelectElement, auto: string, list: (InputDevice | OutputDevice)[]) => {
      select.replaceChildren(new Option(auto, ''), ...list.map((d) => new Option(d.name + ('rocksmith' in d && d.rocksmith ? ` (${t('câble guitare')})` : ''), d.name)));
      select.value = list.find((d) => d.current)?.name ?? '';
      select.disabled = !list.length;
    };
    fill(this.el.input as HTMLSelectElement, t('Automatique : câble guitare USB, sinon l’entrée du Mac'), inputs);
    const selected = inputs.find((d) => d.name === (this.el.input as HTMLSelectElement).value) ?? inputs.find((d) => d.current);
    const channels = Math.max(1, selected?.channels ?? 1);
    const channel = this.el.inputChannel as HTMLSelectElement;
    channel.replaceChildren(...Array.from({ length: channels }, (_, k) => new Option(String(k + 1), String(k))));
    channel.value = String(this.values.inputChannel ?? 0);
    channel.disabled = channels < 2;
    fill(this.el.output as HTMLSelectElement, t('Sortie du Mac par défaut'), outputs);
  }

  private syncAmp(): void {
    const amp = this.hooks.amp();
    const model = AMP_MODELS.find((m) => m.name === amp.model) ?? AMP_MODELS[0];
    (this.el.ampModel as HTMLSelectElement).value = amp.model;
    this.el.ampBlurb.textContent = model.blurb;
    const db = amp.gateDb ?? GATE_DB[amp.model];
    (this.el.gate as HTMLInputElement).value = String(db);
    this.el.gateOut.textContent = `${db} dB`;
    this.el.gateText.textContent = amp.gateDb === null ? t('Seuil du canal {channel}.', { channel: model.label }) : amp.gate ? '' : t('Le gate est coupé dans l’ampli.');
  }

  /** Clicks on the audio clock, a flash on the screen when each one is heard, moved by the
   * display advance: they meet when the advance is right. */
  private startMarker(): void {
    const ctx = new AudioContext();
    const period = 0.6;
    const marker = { ctx, timer: 0, next: ctx.currentTime + 0.3, flashes: [] as number[] };
    const schedule = () => {
      while (marker.next < ctx.currentTime + 0.4) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = 1760;
        gain.gain.setValueAtTime(0.0001, marker.next);
        gain.gain.exponentialRampToValueAtTime(0.5, marker.next + 0.002);
        gain.gain.exponentialRampToValueAtTime(0.0001, marker.next + 0.05);
        osc.connect(gain).connect(ctx.destination);
        osc.start(marker.next);
        osc.stop(marker.next + 0.06);
        const heard = marker.next + (ctx.outputLatency || ctx.baseLatency || 0);
        marker.flashes.push(performance.now() + (heard - ctx.currentTime) * 1000 - this.values.visualOffsetMs);
        marker.next += period;
      }
    };
    schedule();
    marker.timer = window.setInterval(schedule, 100);
    this.marker = marker;
    this.el.syncButton.textContent = t('Arrêter le repère');
  }

  private stopMarker(): void {
    if (!this.marker) return;
    window.clearInterval(this.marker.timer);
    void this.marker.ctx.close();
    this.marker = null;
    this.el.syncButton.textContent = t('Lancer le repère');
    this.el.lamp.classList.remove('on');
  }

  private pulseMarker(nowMs: number): void {
    const m = this.marker;
    if (!m) return;
    m.flashes = m.flashes.filter((t) => t > nowMs - 200);
    const on = m.flashes.some((t) => nowMs >= t && nowMs < t + 90);
    this.el.lamp.classList.toggle('on', on);
    const due = m.flashes.find((t) => t > nowMs);
    this.el.sweep.style.width = due === undefined ? '0%' : `${Math.max(0, Math.min(100, 100 - ((due - nowMs) / 600) * 100))}%`;
  }

  open(status: AudioStatus | null, live = true): void {
    const monitor = status?.monitor ?? false;
    this.el.demo.hidden = live;
    this.el.device.textContent = !live
      ? t('Démo du navigateur')
      : status?.ready
        ? t('{source} : {input} → {output}', { source: status.rocksmith ? t('Câble guitare USB') : t('Entrée'), input: String(status.input), output: String(status.output) }) +
          (status.roundTripMs !== null ? ` · ${t('{ms} ms aller-retour', { ms: Math.round(status.roundTripMs) })}` : '')
        : t('Moteur audio en cours de démarrage…');
    void this.listDevices();
    this.syncAmp();
    this.el.monitorRow.classList.toggle('disabled', !monitor);
    this.root.querySelector<HTMLInputElement>('[data-field="monitorVolume"]')!.disabled = !monitor;
    this.el.monitorHelp.hidden = monitor;
    this.renderClicks();
    this.sync();
    this.visible = true;
    this.root.hidden = false;
  }

  close(): void {
    this.visible = false;
    this.root.hidden = true;
    this.level = null;
    this.stopMarker();
  }

  /** One part of the settings alone (the first-launch guide), or the tab's. */
  only(part: 'level' | 'latency' | null): void {
    if (part === null) {
      this.tab(this.tabShown);
      return;
    }
    this.root.querySelectorAll<HTMLElement>('section[data-part]').forEach((s) => (s.hidden = s.dataset.part !== part));
  }

  feed(f: Frame, nowMs: number): void {
    this.pulseMarker(nowMs);
    this.meter(f.peak, nowMs);
    this.levelStep(f.peak, nowMs);
    for (const e of f.events) {
      if (e.type === 'calibrationStart') {
        this.plan = { first: e.first, period: e.period, countIn: e.countIn, clicks: e.clicks };
        this.hits.clear();
        this.renderClicks();
        this.el.latencyText.textContent = t('Écoute…');
      } else if (e.type === 'calibrationHit') {
        this.hits.set(e.index, e.error);
        this.renderClicks();
      } else if (e.type === 'calibrated') {
        this.finishLatency(e.offset, e.spread, e.hits, e.total);
      }
    }
    if (this.plan) this.pulse(f.time);
  }

  private sync(): void {
    const v = this.values;
    (this.el.inputChannel as HTMLSelectElement).value = String(v.inputChannel ?? 0);
    this.root.querySelector<HTMLSelectElement>('[data-field="monitoring"]')!.value = String(v.monitoring ?? -1);
    const out = (name: keyof GuitarValues, text: string) => {
      this.root.querySelector<HTMLInputElement>(`[data-field="${name}"]`)!.value = String(v[name]);
      this.root.querySelector(`[data-out="${name}"]`)!.textContent = text;
    };
    out('inputGainDb', signed(v.inputGainDb, 'dB'));
    out('inputOffsetMs', signed(v.inputOffsetMs, 'ms'));
    out('visualOffsetMs', signed(v.visualOffsetMs, 'ms'));
    out('masterVolume', t('{n} %', { n: Math.round((v.masterVolume ?? 1) * 100) }));
    out('backingVolume', t('{n} %', { n: Math.round(v.backingVolume * 100) }));
    out('monitorVolume', t('{n} %', { n: Math.round(v.monitorVolume * 100) }));
    out('effectsVolume', t('{n} %', { n: Math.round(v.effectsVolume * 100) }));
    out('crowdVolume', t('{n} %', { n: Math.round(v.crowdVolume * 100) }));
  }

  private meter(peak: number, nowMs: number): void {
    const db = toDb(peak);
    // Falls back at 30 dB/s, rises at once.
    this.shown = Math.max(db, this.shown - 0.03 * 16);
    if (db >= this.hold.db || nowMs - this.hold.at > 1500) this.hold = { db, at: nowMs };
    const pos = (x: number) => `${Math.max(0, Math.min(1, (x + 60) / 60)) * 100}%`;
    this.el.bar.style.width = pos(this.shown);
    this.el.hold.style.left = pos(this.hold.db);
    const h = this.hold.db;
    const [text, cls] =
      h < -55
        ? [t('Joue pour voir le niveau.'), '']
        : h < -40
          ? [t('Niveau faible : monte le gain.'), 'low']
          : h < -3
            ? [t('Bon niveau.'), 'good']
            : [t('Ça sature : baisse le gain.'), 'hot'];
    this.el.meterText.textContent = text;
    this.el.meterText.className = `meter-text ${cls}`;
    this.el.bar.className = cls;
  }

  private startLevel(): void {
    this.level = { phase: 'silence', until: performance.now() + 2000, noise: 0, play: 0 };
    this.el.levelText.textContent = t('Ne joue pas…');
  }

  private levelStep(peak: number, nowMs: number): void {
    const step = this.level;
    if (!step) return;
    if (step.phase === 'silence') {
      step.noise = Math.max(step.noise, peak);
      if (nowMs >= step.until) {
        Object.assign(step, { phase: 'play', until: nowMs + 4000 });
        this.el.levelText.textContent = t('Gratte fort, comme quand tu joues !');
      }
      return;
    }
    step.play = Math.max(step.play, peak);
    if (nowMs < step.until) return;
    this.level = null;
    const s = suggestGainDb(this.values.inputGainDb, step.noise, step.play);
    this.el.levelText.textContent = s.message;
    if (!s.ok) return;
    this.values.inputGainDb = s.gainDb;
    this.sync();
    this.hooks.changed(this.values);
  }

  private startLatency(): void {
    this.plan = null;
    this.hits.clear();
    this.el.latencyText.textContent = t('Lancement…');
    if (this.values.backingVolume < 0.2) this.el.latencyText.textContent = t('Monte le volume de l’accompagnement pour entendre les clics.');
    this.hooks.calibrate();
  }

  private finishLatency(offset: number, spread: number, hits: number, total: number): void {
    this.plan = null;
    this.renderClicks();
    if (hits < 6) {
      this.el.latencyText.textContent = t('Pas assez de coups entendus ({hits}/{total}) : vérifie le niveau d’entrée et recommence.', { hits, total });
      return;
    }
    const ms = Math.round(offset * 1000);
    this.values.inputOffsetMs = Math.max(-150, Math.min(150, ms));
    this.sync();
    this.hooks.changed(this.values);
    this.el.latencyText.textContent = t('Tes coups arrivent {offset} après le clic (régularité ±{spread} ms, {hits}/{total}) : compensation réglée.', {
      offset: signed(ms, 'ms'),
      spread: Math.round(spread * 1000),
      hits,
      total,
    });
  }

  private renderClicks(): void {
    const plan = this.plan ?? { first: 0, period: 0, countIn: 4, clicks: 12 };
    const dots = [];
    for (let k = 0; k < plan.countIn + plan.clicks; k++) {
      const dot = document.createElement('i');
      dot.className = k < plan.countIn ? 'count-in' : 'click';
      const hit = this.hits.get(k - plan.countIn);
      if (hit !== undefined) {
        dot.classList.add('hit');
        dot.title = signed(Math.round(hit * 1000), 'ms');
      }
      dots.push(dot);
    }
    this.el.clicks.replaceChildren(...dots);
  }

  /** Lights the dot of the click being heard. */
  private pulse(time: number): void {
    const plan = this.plan!;
    const k = Math.round((time - plan.first) / plan.period);
    const near = Math.abs(time - (plan.first + k * plan.period)) < 0.09;
    this.el.clicks.querySelectorAll('i').forEach((dot, i) => dot.classList.toggle('now', near && i === k));
  }
}
