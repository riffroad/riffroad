import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { open } from '@tauri-apps/plugin-dialog';
import { lang, t, tn } from './i18n';

export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

/** A conversion by the pipeline (app/src-tauri/src/import.rs). */
export interface Job {
  id: number;
  source: string;
  name: string;
  state: JobState;
  stage: string | null;
  fraction: number;
  elapsed: number;
  song: string | null;
  /** Songs it made: one, or several for an archive of songs (a plugin's). */
  songs: number;
  title: string | null;
  error: string | null;
  /** Library folder of the song a tab is being placed on. */
  target: string | null;
  /** An MP3 song charted again with today's rules, in its folder (`source`). */
  refresh?: boolean;
  /** What the stage does now, in its tool's words (the converter being installed). */
  detail?: string | null;
}

export interface MusicFile {
  path: string;
  name: string;
  size: number;
  /** Library id of its chart, when already converted. */
  song: string | null;
  /** Songs made from it: one, or several for an archive of songs (a plugin's). */
  songs: number;
  /** Guitar Pro tab of the same song next to it: its notes are placed on the recording. */
  tab: string | null;
  /** The converted chart comes from that tab. */
  tabPlaced: boolean;
}

interface Dropped {
  jobs: Job[];
  folders: string[];
  ignored: string[];
}

/** The queue as the app keeps it: on disk, resumed at launch. */
interface ImportQueue {
  paused: boolean;
  jobs: Job[];
}

const STAGES: Record<string, string> = {
  install: t('Installation du convertisseur'),
  decode: t('Lecture du fichier'),
  separate: t('Séparation de la guitare'),
  stems: t('Écriture des pistes'),
  transcribe: t('Transcription des notes'),
  beats: t('Tempo et mesures'),
  chart: t('Tablature et niveaux'),
  done: t('Terminé'),
};

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')}`;
}

export function shortPath(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, '~');
}

export function formatSize(bytes: number): string {
  const mb = (bytes / 1e6).toFixed(1);
  return t('{size} Mo', { size: lang() === 'en' ? mb : mb.replace('.', ',') });
}

/** Where an import stands, in one line. */
export function jobStatus(job: Job): string {
  switch (job.state) {
    case 'queued':
      return t('En attente');
    case 'running':
      return `${STAGES[job.stage ?? ''] ?? t('Démarrage')} · ${t('{n} %', { n: Math.floor(job.fraction * 100) })}`;
    case 'done':
      return t('Prêt en {time}', { time: formatDuration(job.elapsed) });
    case 'failed':
      // The error is the pipeline's or the backend's own words.
      return t('Échec : {error}', { error: job.error ?? t('erreur inconnue') });
    case 'cancelled':
      return t('Annulé');
  }
}

const active = (job: Job) => job.state === 'queued' || job.state === 'running';

/** Where the whole queue stands, for its header and the hardware strip. */
export interface QueueSummary {
  total: number;
  /** Imports over (done, failed or cancelled). */
  finished: number;
  done: number;
  failed: number;
  waiting: number;
  running: Job | null;
  paused: boolean;
  /** 0..1 of the whole queue, the import under way counted as far as it got. */
  fraction: number;
}

export function queueSummary(jobs: readonly Job[], paused: boolean): QueueSummary {
  const running = jobs.find((j) => j.state === 'running') ?? null;
  const finished = jobs.filter((j) => !active(j)).length;
  return {
    total: jobs.length,
    finished,
    done: jobs.filter((j) => j.state === 'done').length,
    failed: jobs.filter((j) => j.state === 'failed').length,
    waiting: jobs.filter((j) => j.state === 'queued').length,
    running,
    paused,
    fraction: jobs.length ? (finished + (running?.fraction ?? 0)) / jobs.length : 0,
  };
}

/** Rows shown for a queue of hundreds: the import under way, the failures, the latest songs
 * landed; the imports waiting are listed apart, in order. */
export function visibleJobs(jobs: readonly Job[]): { rows: Job[]; waiting: Job[] } {
  const latest = (state: JobState, n: number) =>
    jobs
      .filter((j) => j.state === state)
      .sort((a, b) => b.id - a.id)
      .slice(0, n);
  return {
    rows: [...latest('running', 1), ...latest('failed', 12), ...latest('done', 5), ...latest('cancelled', 3)],
    waiting: jobs.filter((j) => j.state === 'queued').sort((a, b) => a.id - b.id),
  };
}

/** A step of an import as the analysis view shows it. */
export interface PipelineStep {
  label: string;
  tech: string;
  state: 'done' | 'active' | 'pending' | 'failed';
  /** 0..1 of the step. */
  progress: number;
}

const AUDIO = /\.(mp3|wav|flac|ogg|m4a|aiff?)$/i;
const TAB = /\.(gp[345x]?)$/i;
/** Files the converter takes without plugins (the dialog adds the plugins' own). */
const BUILT_IN = ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aiff', 'gp', 'gp3', 'gp4', 'gp5', 'gpx', 'feedpak'];

/** The MP3 pipeline's steps over its overall progress (pipeline-ingest progress.py weights:
 * decode + separate + stems, transcribe + beats, chart). */
const AUDIO_STEPS = [
  { label: t('Séparation des pistes'), tech: 'Demucs htdemucs_6s', from: 0, to: 0.59 },
  { label: t('Tempo et notes'), tech: 'librosa · Basic Pitch', from: 0.59, to: 0.91 },
  { label: t('Doigté du manche'), tech: 'Viterbi', from: 0.91, to: 1 },
];

/** Where an import is in the pipeline, step by step, ending in the library. */
export function pipelineSteps(job: Job): PipelineStep[] {
  const steps = AUDIO.test(job.source)
    ? AUDIO_STEPS
    : [{ label: TAB.test(job.source) ? t('Lecture de la tablature') : t('Lecture du fichier'), tech: t('notes, accords, techniques'), from: 0, to: 1 }];
  const done = job.state === 'done';
  // A built app installs its converter before its first import: the fraction is the install's.
  const installing = job.stage === 'install' && !done;
  const fraction = installing ? 0 : job.fraction;
  const out: PipelineStep[] = steps.map((s) => {
    const progress = done ? 1 : Math.min(1, Math.max(0, (fraction - s.from) / (s.to - s.from)));
    const state = done || progress >= 1 ? 'done' : job.state === 'running' && !installing && fraction >= s.from ? 'active' : 'pending';
    return { label: s.label, tech: s.tech, state, progress };
  });
  if (installing) {
    const tech = [t('une seule fois · environ 2 Go'), job.detail].filter(Boolean).join(' · ');
    out.unshift({ label: STAGES.install, tech, state: job.state === 'running' ? 'active' : 'pending', progress: job.fraction });
  }
  if (job.state === 'failed' || job.state === 'cancelled') {
    const at = out.findIndex((s) => s.state !== 'done');
    if (at >= 0) out[at].state = 'failed';
  }
  out.push({ label: t('Bibliothèque'), tech: t('niveaux, sections, prêt à jouer'), state: done ? 'done' : 'pending', progress: done ? 1 : 0 });
  return out;
}

export interface ImportHooks {
  /** Drops are taken on the song list only. */
  accepting(): boolean;
  /** Files were dropped and are about to be converted (time to show the conversions). */
  received?(): void;
  play(song: string): void;
  /** Shows the library (the songs of an archive that held several). */
  library(): void;
  libraryChanged(): void;
  /** The queue moved: counts for the hardware strip. */
  queueChanged?(s: QueueSummary): void;
  folder: string | null;
  saveFolder(path: string | null): void;
}

/** Library refreshes while songs keep landing: at most one every few seconds. */
const LANDING_MS = 3000;
/** Waiting imports listed by name under the queue. */
const NEXT_SHOWN = 4;

const TEMPLATE = `
<div class="import-drop">
  <b>${t('Glisse ici un MP3, une tablature Guitar Pro, un feedpak ou tout un dossier')}</b>
  <span>${t('… n’importe où sur la fenêtre. Un dossier part en entier dans la file d’import : les morceaux arrivent un à un dans la bibliothèque pendant que tu joues, et la file reprend où elle en était si l’app est fermée.')}</span>
  <span class="drop-actions">
    <button class="action primary" data-action="pick-files">${t('Choisir des fichiers…')}</button>
    <button class="action" data-action="pick-import">${t('Importer un dossier…')}</button>
  </span>
</div>
<section class="queue" data-el="queue" hidden>
  <div class="queue-head">
    <b>${t('File d’import')}</b>
    <span class="queue-count" data-el="queueCount"></span>
    <span class="queue-actions">
      <button class="action small" data-action="pause-queue" data-el="pauseQueue"></button>
      <button class="action small" data-action="empty-queue" data-el="emptyQueue">${t('Vider la file')}</button>
      <button class="action small" data-action="clear-done" data-el="clearDone">${t('Effacer les terminés')}</button>
    </span>
  </div>
  <div class="bar queue-bar"><i data-el="queueBar"></i></div>
  <p class="queue-state" data-el="queueState"></p>
</section>
<div class="jobs" data-el="jobs"></div>
<div class="queue-next" data-el="queueNext" hidden></div>
<div class="folder">
  <div class="folder-head">
    <span class="folder-name" data-el="folderName"></span>
    <span class="folder-actions">
      <button class="action small primary" data-action="convert-all" data-el="convertAll" hidden></button>
      <button class="action small" data-action="pick">${t('Choisir un dossier…')}</button>
      <button class="action small" data-action="forget" data-el="forget" title="${t('Oublier ce dossier')}" hidden>×</button>
    </span>
  </div>
  <div class="folder-files" data-el="files"></div>
</div>`;

/** Converting songs from the app: files dropped on the window, a music folder of the Mac. */
export class Imports {
  private readonly jobs = new Map<number, Job>();
  private readonly rows = new Map<number, HTMLElement>();
  private readonly fileRows = new Map<string, HTMLElement>();
  /** Tab placements under way: job id → the song file whose tab it is. */
  private readonly placing = new Map<number, string>();
  private files: MusicFile[] = [];
  private folder: string | null;
  private folderError = '';
  private paused = false;
  private flushTimer = 0;
  /** A song landed since the library was last refreshed. */
  private landed = false;
  private lastLanding = 0;

  constructor(
    private readonly root: HTMLElement,
    private readonly overlay: HTMLElement,
    private readonly hooks: ImportHooks,
  ) {
    this.folder = hooks.folder;
    root.innerHTML = TEMPLATE;
    root.addEventListener('click', (e) => this.onClick(e));
    this.renderFolder();
  }

  async start(): Promise<void> {
    await listen<Job>('import', (e) => this.update(e.payload));
    // The queue left by the last run is already under way again.
    const queue = await invoke<ImportQueue>('imports');
    this.paused = queue.paused;
    for (const job of queue.jobs) this.jobs.set(job.id, job);
    this.schedule();
    await getCurrentWebview().onDragDropEvent((e) => {
      const p = e.payload;
      if (p.type === 'enter') this.overlay.hidden = !this.hooks.accepting();
      else if (p.type === 'leave') this.overlay.hidden = true;
      else if (p.type === 'drop') {
        this.overlay.hidden = true;
        if (this.hooks.accepting()) {
          this.hooks.received?.();
          void this.add(p.paths);
        }
      }
    });
    await this.scan();
  }

  /** Song files are queued for conversion; a folder is queued whole and becomes the music folder. */
  async add(paths: string[]): Promise<void> {
    if (!paths.length) return;
    const dropped = await invoke<Dropped>('import_paths', { paths });
    for (const job of dropped.jobs) this.update(job);
    for (const folder of dropped.folders) await this.importFolder(folder);
  }

  /** Every song file of `path` not yet in the library goes to the queue, in order. */
  async importFolder(path: string): Promise<void> {
    this.folder = path;
    this.hooks.saveFolder(path);
    this.folderError = '';
    try {
      for (const job of await invoke<Job[]>('import_folder', { path })) this.update(job);
    } catch (e) {
      this.folderError = String(e);
    }
    await this.scan();
  }

  async setFolder(path: string | null): Promise<void> {
    this.folder = path;
    this.hooks.saveFolder(path);
    await this.scan();
  }

  async scan(): Promise<void> {
    this.folderError = '';
    this.files = [];
    if (this.folder) {
      try {
        this.files = await invoke<MusicFile[]>('scan_folder', { path: this.folder });
      } catch (e) {
        this.folderError = String(e);
      }
    }
    this.renderFolder();
  }

  private async pickFiles(): Promise<void> {
    const files = await open({
      multiple: true,
      title: t('Morceaux à importer'),
      filters: [{ name: t('Morceaux et tablatures'), extensions: [...BUILT_IN, ...(await invoke<string[]>('import_formats').catch(() => []))] }],
    });
    if (Array.isArray(files)) await this.add(files);
    else if (typeof files === 'string') await this.add([files]);
  }

  private async pick(importAll = false): Promise<void> {
    const dir = await open({ directory: true, multiple: false, title: importAll ? t('Dossier à importer') : t('Dossier de musique'), defaultPath: this.folder ?? undefined });
    if (typeof dir !== 'string') return;
    if (importAll) await this.importFolder(dir);
    else await this.setFolder(dir);
  }

  /** A job reported: its progress is drawn at once, a change of state with the next batch. */
  private update(job: Job): void {
    const before = this.jobs.get(job.id);
    this.jobs.set(job.id, job);
    if (before?.state === job.state) {
      const row = this.rows.get(job.id);
      if (row) this.fillJob(row, job);
      this.refreshFileRow(this.placing.get(job.id) ?? job.source);
      this.renderSummary();
      return;
    }
    if (job.state === 'done') this.landed = true;
    this.schedule();
  }

  /** State changes come by the hundred when a folder is queued: drawn together. */
  private schedule(delay = 120): void {
    if (this.flushTimer) return;
    this.flushTimer = window.setTimeout(() => this.flush(), delay);
  }

  private flush(): void {
    this.flushTimer = 0;
    this.renderJobs();
    if (!this.landed) {
      this.renderFolder();
      return;
    }
    // Songs landing one after another refresh the library every few seconds, not each time.
    const wait = this.lastLanding + LANDING_MS - Date.now();
    if (wait > 0) {
      this.renderFolder();
      this.schedule(wait);
      return;
    }
    this.landed = false;
    this.lastLanding = Date.now();
    this.hooks.libraryChanged();
    void this.scan();
  }

  private forget(id: number): void {
    void invoke('dismiss_import', { id });
    this.jobs.delete(id);
    this.rows.get(id)?.remove();
    this.rows.delete(id);
  }

  private togglePause(): void {
    this.paused = !this.paused;
    void invoke('set_import_paused', { on: this.paused });
    this.renderSummary();
  }

  private onClick(e: MouseEvent): void {
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (!target) return;
    const id = Number(target.dataset.id);
    const job = this.jobs.get(id);
    switch (target.dataset.action) {
      case 'cancel':
        void invoke('cancel_import', { id });
        break;
      case 'dismiss':
        this.forget(id);
        this.schedule();
        break;
      case 'retry':
        if (job) {
          this.forget(id);
          void this.add([job.source]);
        }
        break;
      case 'pause-queue':
        this.togglePause();
        break;
      case 'empty-queue':
        void invoke('cancel_queued_imports');
        break;
      case 'clear-done':
        for (const j of [...this.jobs.values()]) if (j.state === 'done' || j.state === 'cancelled') this.forget(j.id);
        this.schedule();
        break;
      case 'pick-import':
        void this.pick(true);
        break;
      case 'play':
        if (target.dataset.song) this.hooks.play(target.dataset.song);
        break;
      case 'library':
        this.hooks.library();
        break;
      case 'convert':
        if (target.dataset.path) void this.add([target.dataset.path]);
        break;
      case 'convert-all':
        void this.add(this.pending().map((f) => f.path));
        break;
      case 'place-tab':
        if (target.dataset.path) void this.placeTab(target.dataset.path);
        break;
      case 'pick':
        void this.pick();
        break;
      case 'pick-files':
        void this.pickFiles();
        break;
      case 'forget':
        void this.setFolder(null);
        break;
    }
  }

  /** The tab next to an already converted song file goes onto its chart. */
  private async placeTab(path: string): Promise<void> {
    try {
      const job = await invoke<Job>('place_tab', { path });
      this.placing.set(job.id, path);
      this.update(job);
    } catch (e) {
      this.folderError = String(e);
      this.renderFolder();
    }
  }

  private el(name: string): HTMLElement {
    return this.root.querySelector<HTMLElement>(`[data-el="${name}"]`)!;
  }

  private activeJob(path: string): Job | undefined {
    for (const job of this.jobs.values()) {
      if ((job.source === path || this.placing.get(job.id) === path) && active(job)) return job;
    }
    return undefined;
  }

  /** Folder files neither converted nor being converted. */
  private pending(): MusicFile[] {
    return this.files.filter((f) => !f.song && !this.activeJob(f.path));
  }

  /** The rows worth showing, the imports waiting by name, the queue's header. */
  private renderJobs(): void {
    const { rows, waiting } = visibleJobs([...this.jobs.values()]);
    const shown = new Set(rows.map((j) => j.id));
    for (const [id, row] of this.rows) {
      if (!shown.has(id)) {
        row.remove();
        this.rows.delete(id);
      }
    }
    this.el('jobs').replaceChildren(
      ...rows.map((job) => {
        let row = this.rows.get(job.id);
        if (!row) {
          row = document.createElement('div');
          row.className = 'job';
          row.innerHTML = '<div class="job-line"><b></b><span class="job-status"></span><span class="job-actions"></span></div><div class="bar"><i></i></div><ol class="pipeline"></ol>';
          this.rows.set(job.id, row);
        }
        this.fillJob(row, job);
        return row;
      }),
    );
    const next = this.el('queueNext');
    next.hidden = !waiting.length;
    if (waiting.length) {
      const list = document.createElement('ol');
      for (const j of waiting.slice(0, NEXT_SHOWN)) {
        const li = document.createElement('li');
        li.textContent = j.name;
        li.title = j.source;
        list.append(li);
      }
      const head = document.createElement('b');
      head.textContent = t('Ensuite');
      next.replaceChildren(head, list);
      if (waiting.length > NEXT_SHOWN) {
        const more = document.createElement('span');
        more.textContent = tn(waiting.length - NEXT_SHOWN, '… et {n} autre en file', '… et {n} autres en file');
        next.append(more);
      }
    }
    this.renderSummary();
  }

  private renderSummary(): void {
    const s = queueSummary([...this.jobs.values()], this.paused);
    this.el('queue').hidden = s.total === 0;
    this.el('queueCount').textContent = `${s.finished} / ${s.total}`;
    this.el('queueBar').style.width = `${Math.round(s.fraction * 100)}%`;
    const now = s.running ? t('En cours : {title}', { title: s.running.title ?? s.running.name }) : s.paused && s.waiting ? t('En pause') : s.waiting ? t('Démarrage…') : t('File terminée');
    const parts = [now, s.waiting ? t('{n} en file', { n: s.waiting }) : '', tn(s.done, '{n} importé', '{n} importés'), s.failed ? tn(s.failed, '{n} échoué', '{n} échoués') : ''];
    this.el('queueState').textContent = parts.filter(Boolean).join(' · ');
    const pause = this.el('pauseQueue');
    pause.textContent = this.paused ? t('Reprendre') : t('Pause');
    pause.hidden = !this.paused && !s.waiting;
    this.el('emptyQueue').hidden = !s.waiting;
    this.el('clearDone').hidden = s.finished === s.failed;
    this.root.classList.toggle('queue-paused', this.paused);
    this.hooks.queueChanged?.(s);
  }

  private fillJob(row: HTMLElement, job: Job): void {
    row.dataset.state = job.state;
    row.title = job.source;
    row.querySelector('b')!.textContent = job.refresh ? t('Mise à jour des accords · {song}', { song: job.title ?? job.name }) : (job.title ?? job.name);
    row.querySelector('.job-status')!.textContent = jobStatus(job);
    row.querySelector<HTMLElement>('.bar i')!.style.width = `${Math.round(job.fraction * 100)}%`;
    // The analysis view: each step of the pipeline, the one at work lit, its own progress.
    row.querySelector('.pipeline')!.replaceChildren(
      ...pipelineSteps(job).map((s, i) => {
        const li = document.createElement('li');
        li.className = s.state;
        li.style.setProperty('--p', String(s.progress));
        li.innerHTML = `<i>${s.state === 'done' ? '✓' : i + 1}</i><b></b><small></small><span class="step-bar"></span>`;
        li.querySelector('b')!.textContent = s.label;
        li.querySelector('small')!.textContent = s.tech;
        return li;
      }),
    );
    const actions = row.querySelector<HTMLElement>('.job-actions')!;
    const key = `${job.state}|${job.song ?? ''}`;
    if (actions.dataset.key === key) return;
    actions.dataset.key = key;
    const button = (label: string, action: string, extra: Record<string, string> = {}, primary = false) => {
      const b = document.createElement('button');
      b.className = `action small${primary ? ' primary' : ''}`;
      b.textContent = label;
      Object.assign(b.dataset, { action, id: String(job.id), ...extra });
      return b;
    };
    if (active(job)) actions.replaceChildren(button(t('Annuler'), 'cancel'));
    else if (job.state === 'done' && job.songs > 1) actions.replaceChildren(button(t('Voir les morceaux'), 'library', {}, true), button('×', 'dismiss'));
    else if (job.state === 'done' && job.song) actions.replaceChildren(button(t('Jouer'), 'play', { song: job.song }, true), button('×', 'dismiss'));
    else actions.replaceChildren(button(t('Réessayer'), 'retry'), button('×', 'dismiss'));
  }

  private renderFolder(): void {
    const name = this.el('folderName');
    const list = this.el('files');
    const all = this.el('convertAll');
    this.el('forget').hidden = !this.folder;
    this.fileRows.clear();
    if (!this.folder) {
      name.textContent = t('Aucun dossier de musique choisi');
      all.hidden = true;
      list.replaceChildren();
      return;
    }
    const converted = this.files.filter((f) => f.song).length;
    const n = this.files.length;
    name.textContent = this.folderError || `${shortPath(this.folder)} · ${tn(n, '{n} morceau', '{n} morceaux')}, ${tn(converted, '{n} converti', '{n} convertis')}`;
    name.title = this.folder;
    const pending = this.pending().length;
    all.hidden = pending === 0;
    all.textContent = t('Tout convertir ({n})', { n: pending });
    if (!n && !this.folderError) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = t('Aucun fichier audio dans ce dossier.');
      list.replaceChildren(empty);
      return;
    }
    list.replaceChildren(
      ...this.files.map((f) => {
        const row = document.createElement('div');
        row.className = 'file';
        row.innerHTML = '<span class="file-name"></span><span class="file-status"></span><span class="file-action"></span>';
        row.querySelector('.file-name')!.textContent = f.name;
        row.title = f.tab ? `${f.path}\n${t('Tablature : {tab}', { tab: f.tab })}` : f.path;
        this.fileRows.set(f.path, row);
        this.fillFileRow(row, f);
        return row;
      }),
    );
  }

  private refreshFileRow(path: string): void {
    const row = this.fileRows.get(path);
    const file = this.files.find((f) => f.path === path);
    if (row && file) this.fillFileRow(row, file);
  }

  private fillFileRow(row: HTMLElement, f: MusicFile): void {
    const job = this.activeJob(f.path);
    const status = row.querySelector('.file-status')!;
    const action = row.querySelector('.file-action')!;
    const button = (label: string, data: Record<string, string>, primary = false) => {
      const b = document.createElement('button');
      b.className = `action small${primary ? ' primary' : ''}`;
      b.textContent = label;
      Object.assign(b.dataset, data);
      return b;
    };
    row.dataset.state = job ? 'running' : f.song ? 'done' : 'new';
    if (job) {
      status.textContent = jobStatus(job);
      if (action.firstElementChild?.getAttribute('data-action') !== 'cancel') {
        action.replaceChildren(button(t('Annuler'), { action: 'cancel', id: String(job.id) }));
      }
    } else if (f.songs > 1) {
      status.textContent = t('{n} morceaux convertis', { n: f.songs });
      action.replaceChildren(button(t('Voir'), { action: 'library' }, true));
    } else if (f.song) {
      status.textContent = !f.tab ? t('Converti') : f.tabPlaced ? t('Converti · tablature') : t('Converti · tablature trouvée');
      const play = button(t('Jouer'), { action: 'play', song: f.song }, true);
      action.replaceChildren(...(f.tab && !f.tabPlaced ? [button(t('Appliquer la tablature'), { action: 'place-tab', path: f.path }), play] : [play]));
    } else {
      status.textContent = f.tab ? t('{size} · avec tablature', { size: formatSize(f.size) }) : formatSize(f.size);
      action.replaceChildren(button(t('Convertir'), { action: 'convert', path: f.path }));
    }
  }
}
