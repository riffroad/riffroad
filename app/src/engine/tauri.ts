import { invoke } from '@tauri-apps/api/core';
import { parseChart, type Chart } from '../chart';
import { ClockSync } from '../clock';
import type { GameEvent } from '../game/types';
import type { AmpSettings } from '../amp';
import type { CareerStore } from '../career/career';
import type { Progress, ProgressStore } from '../progress';
import type { Backing } from '../backing';
import type { Engine, Frame, RiffLoop, SongChord, SongEntry } from './types';
import type { SoundName } from '../sounds';

interface PollView {
  time: number;
  playing: boolean;
  events: GameEvent[];
  peak: number;
  rate: number;
}

/** An output device of the Mac (speakers, headphones, interface). */
export interface OutputDevice {
  name: string;
  current: boolean;
}

/** An input device of the Mac (the USB guitar cable, an interface, a microphone). */
export interface InputDevice {
  name: string;
  current: boolean;
  rocksmith: boolean;
}

/** Guitar settings the engine applies (app/src-tauri InputSettings). */
export interface InputSettings {
  inputGainDb: number;
  inputOffsetMs: number;
  /** Linear gains. */
  backingVolume: number;
  monitorVolume: number;
  /** The song's own guitar, when its import kept it as a stem. */
  stemVolume: number;
}

export interface AudioStatus {
  ready: boolean;
  error: string | null;
  input: string | null;
  rocksmith: boolean;
  output: string | null;
  monitor: boolean;
  /** Why the last change of output failed (the previous one still plays). */
  switchError: string | null;
  roundTripMs: number | null;
  library: string;
  autoplay: string | null;
  autoimport: string | null;
  /** Click through the menus and time them (`OPENSMITH_TOUR`: 1, or menu actions; development). */
  tour: string | null;
}

export const isTauri = (): boolean => '__TAURI_INTERNALS__' in window;

/**
 * The native engine (engine-rt/session in the Tauri process): it plays the backing track,
 * listens to the guitar and judges. Polled once per frame; the clock model smooths the IPC
 * jitter between polls.
 */
export class TauriEngine implements Engine {
  readonly kind = 'live' as const;
  readonly career: CareerStore = {
    load: async () => JSON.parse(await invoke<string>('read_career')) as unknown,
    save: (c) => invoke('write_career', { json: JSON.stringify(c) }),
  };
  readonly progress: ProgressStore = {
    load: async () => JSON.parse(await invoke<string>('read_progress')) as Progress,
    save: (all) => invoke('write_progress', { json: JSON.stringify(all) }),
  };
  private clock = new ClockSync();
  private pending: GameEvent[] = [];
  private inflight = false;
  private running = false;
  private peak = 0;
  private readonly covers = new Map<string, Promise<string | null>>();
  /** Level every phrase starts at (dynamic difficulty moves it from there). */
  startLevel = 0;
  /** Dynamic difficulty; off, the song stays at `startLevel` (Score Attack). */
  dynamic = true;

  get playing(): boolean {
    return this.running;
  }

  unlock(): void {}

  private index: { version: string | null; songs: SongEntry[] } = { version: null, songs: [] };

  async library(): Promise<SongEntry[]> {
    const read = await invoke<{ version: string; songs: SongEntry[] | null }>('library', { known: this.index.version });
    if (read.songs) this.index = { version: read.version, songs: read.songs };
    return this.index.songs;
  }

  /** A song Riffroad composes and records in `style`, put in the library: its id. */
  composeSong(style: string): Promise<string> {
    return invoke<string>('compose_song', { style });
  }

  /** The chords of an MP3's chord chart, to correct them (none for any other chart). */
  songChords(id: string): Promise<SongChord[]> {
    return invoke<SongChord[]>('song_chords', { id });
  }

  /** Replaces chords everywhere in an MP3's chord chart ("G=Em"…); how many beats changed. */
  fixChords(id: string, changes: string[]): Promise<number> {
    return invoke<number>('fix_chords', { id, changes });
  }

  /** Queues charting again the MP3 songs imported with older rules: how many. */
  refreshCharts(): Promise<number> {
    return invoke<number>('refresh_charts');
  }

  /** The song of chart `id` (every part, its audio and cover) as a .feedpak at `path`. */
  exportFeedpak(id: string, path: string): Promise<void> {
    return invoke<void>('export_feedpak', { id, path });
  }

  coverUrl(song: SongEntry): Promise<string | null> {
    const path = song.cover;
    if (!path) return Promise.resolve(null);
    let url = this.covers.get(path);
    if (!url) {
      url = invoke<ArrayBuffer>('song_cover', { path })
        .then((bytes) => URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' })))
        .catch(() => null);
      this.covers.set(path, url);
    }
    return url;
  }

  status(): Promise<AudioStatus> {
    return invoke<AudioStatus>('audio_status');
  }

  /** A timing of the interface (Shift+P), into the app's log. */
  perfLog(line: string): void {
    void invoke('perf_log', { line });
  }

  /** How the guitar stays tuned between songs (null: retuned for each song). */
  guitar: { name: string; strings: readonly number[] } | null = null;
  /** Semitones the last song loaded was transposed by, to fit the guitar (0: as recorded). */
  transposed = 0;

  async load(id: string, levels: Record<string, number> = {}): Promise<Chart> {
    const raw = await invoke<{ transposed?: number }>('load_song', { id, startLevel: this.startLevel, levels, dynamic: this.dynamic, guitar: this.guitar });
    this.transposed = raw.transposed ?? 0;
    const chart = parseChart(raw);
    this.clock = new ClockSync();
    this.running = false;
    return chart;
  }

  async loadLesson(lesson: Chart, backing?: Backing): Promise<Chart> {
    const raw = await invoke<unknown>('load_lesson', { json: JSON.stringify(lesson), band: backing ?? null });
    this.transposed = 0;
    const chart = parseChart(raw);
    this.clock = new ClockSync();
    this.running = false;
    return chart;
  }

  addSound(name: SoundName, rate: number, samples: Float32Array): void {
    const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
    invoke('add_sound', bytes, { headers: { name, rate: String(rate) } }).catch((e) => console.error('son', name, e));
  }

  sound(name: SoundName, gain: number, at?: number): void {
    void invoke('play_sound', { name, gain, at: at ?? null });
  }

  bed(name: SoundName | null, gain: number): void {
    void invoke('set_bed', { name, gain });
  }

  preview(id: string | null, gain: number): void {
    invoke('preview_song', { id, gain }).catch((e) => console.warn('extrait indisponible', e));
  }

  play(): void {
    this.running = true;
    void invoke('play');
  }

  pause(): void {
    this.running = false;
    void invoke('pause');
  }

  seek(time: number): void {
    void invoke('seek', { time });
  }

  setSpeed(rate: number): void {
    void invoke('set_speed', { rate });
  }

  setRiff(riff: RiffLoop | null): void {
    void invoke('set_riff', { riff });
  }

  setDifficulty(dynamic: boolean, level: number): void {
    this.dynamic = dynamic;
    this.startLevel = level;
    void invoke('set_difficulty', { dynamic, level });
  }

  configure(settings: InputSettings): void {
    void invoke('configure_input', { settings });
  }

  configureAmp(amp: AmpSettings): void {
    invoke('configure_amp', { amp }).catch((e) => console.error('ampli', e));
  }

  outputs(): Promise<OutputDevice[]> {
    return invoke<OutputDevice[]>('audio_outputs');
  }

  /** Plays through another output device (null: the Mac's default); a song in progress stops. */
  setOutput(name: string | null): void {
    void invoke('set_output', { name });
  }

  inputs(): Promise<InputDevice[]> {
    return invoke<InputDevice[]>('audio_inputs');
  }

  /** Listens to another input (null: the USB guitar cable, else the Mac's default input); a song
   * in progress stops. */
  setInput(name: string | null): void {
    void invoke('set_input', { name });
  }

  /** Demo mode: the game plays every note itself, no guitar needed. */
  setAutopilot(on: boolean): void {
    void invoke('set_autopilot', { on });
  }

  /** How forgiving the judge is (lenient, normal, strict), from the next song. */
  setJudging(name: string): void {
    void invoke('set_judging', { name });
  }

  /** Wait mode (lessons): the song stops on each note or chord until the guitar plays it. */
  setWait(on: boolean): void {
    void invoke('set_wait', { on });
  }

  /** Records what the guitar plays during songs (takes, to tune the detection offline). */
  setRecording(on: boolean): void {
    void invoke('set_recording', { on });
  }

  setTuner(on: boolean): void {
    void invoke('set_tuner', { on });
  }

  calibrate(): void {
    void invoke('calibrate_latency');
  }

  frame(nowMs: number): Frame {
    if (!this.inflight) {
      this.inflight = true;
      const sent = performance.now();
      invoke<PollView>('poll')
        .then((p) => {
          this.clock.sample((sent + performance.now()) / 2, p.time, p.playing, p.rate);
          this.pending.push(...p.events);
          this.peak = Math.max(this.peak, p.peak);
        })
        .catch((e) => console.error('poll', e))
        .finally(() => (this.inflight = false));
    }
    const events = this.pending;
    const peak = this.peak;
    this.pending = [];
    this.peak = 0;
    return { time: this.clock.at(nowMs), playing: this.running, events, peak };
  }
}
