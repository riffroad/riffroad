import { formatTime } from './chart';
import { ATTACK_LEVELS, attackPicker, type AttackDifficulty } from './score-attack';
import { coverElement } from './cover';
import { lang, t, tn } from './i18n';
import type { SongChord, SongEntry } from './engine/types';
import type { Progress, SongProgress } from './progress';
import { partName } from './sections';

/** A song's arrangements: the one it is listed by, then the others. */
export const partsOf = (song: SongEntry): SongEntry[] => [song, ...(song.others ?? [])];

/** An arrangement's name for the player: the usual ones in their language, the others as written. */
export function arrangementLabel(name: string): string {
  const labels: Record<string, string> = { lead: 'Lead', rhythm: t('Rythmique'), combo: 'Combo', bass: t('Basse'), chords: t('Accords') };
  return labels[name.toLowerCase()] ?? name;
}

export const partLabel = (part: SongEntry): string => arrangementLabel(part.arrangement);

/** The arrangement of `song` to show first: the kind the player last chose, if it has one. */
export function preferredPart(song: SongEntry, kind: string | null): SongEntry {
  return partsOf(song).find((p) => kind && p.arrangementType === kind) ?? song;
}

/** Where a song's notes come from, which says how much to trust them. */
export type SongSource = 'tab' | 'chart' | 'ai' | 'sheet';

export function sourceOf(song: SongEntry): SongSource {
  const kind = song.source ?? 'audio';
  if (kind === 'guitarpro') return song.hasAudio === false ? 'sheet' : 'tab';
  if (kind === 'synth') return 'tab'; // the demo song: its exact notes
  if (kind === 'audio') return 'ai';
  return 'chart'; // a plugin's: written by hand for this recording
}

/** What the source badge says about where this song's notes come from. */
export function aboutSource(song: SongEntry): string {
  if (song.source === 'synth') return t('Morceau de démonstration généré par Riffroad : les notes exactes de sa guitare.');
  // The chords recognised from an MP3: the engine takes either third (`Chart::free_thirds`).
  if (sourceOf(song) === 'ai' && song.arrangement.toLowerCase() === 'chords') return t('Accords reconnus automatiquement depuis l’enregistrement, justes environ quatre temps sur cinq : majeur ou mineur, les deux comptent, tant que la fondamentale et la quinte sonnent.');
  return SOURCES[sourceOf(song)].about;
}

export const SOURCES: Record<SongSource, { label: string; about: string }> = {
  tab: { label: t('Tablature'), about: t('Notes d’une tablature Guitar Pro, calées sur l’enregistrement.') },
  chart: { label: t('Chart'), about: t('Notes écrites à la main pour cet enregistrement (feedpak ou plugin).') },
  ai: { label: t('IA'), about: t('Notes transcrites automatiquement depuis l’enregistrement : il peut y avoir des erreurs.') },
  sheet: { label: t('Tablature seule'), about: t('Une tablature sans enregistrement : on joue sans la musique.') },
};

export type SortKey = 'recent' | 'title' | 'artist' | 'mastery';

export const SORTS: readonly { key: SortKey; label: string }[] = [
  { key: 'recent', label: t('Joués récemment') },
  { key: 'title', label: t('Titre') },
  { key: 'artist', label: t('Artiste') },
  { key: 'mastery', label: t('Maîtrise') },
];

export interface SongQuery {
  text: string;
  sort: SortKey;
  source: SongSource | 'all';
  tuning: string;
}

export const EVERY_SONG: SongQuery = { text: '', sort: 'recent', source: 'all', tuning: 'all' };

/** Lower case, accents off: "Électrique" is found by "electrique". */
export const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** The songs matching `q` (every word of the text in title, artist or album), in its order. */
export function selectSongs(songs: readonly SongEntry[], progress: Progress, q: SongQuery): SongEntry[] {
  const words = fold(q.text).split(/\s+/).filter(Boolean);
  const kept = songs.filter((s) => {
    if (q.source !== 'all' && sourceOf(s) !== q.source) return false;
    if (q.tuning !== 'all' && s.tuning !== q.tuning) return false;
    const text = fold(`${s.title} ${s.artist} ${s.album ?? ''}`);
    return words.every((w) => text.includes(w));
  });
  const p = (s: SongEntry) => progress[s.id];
  const title = (a: SongEntry, b: SongEntry) => a.title.localeCompare(b.title, 'fr');
  const order: Record<SortKey, (a: SongEntry, b: SongEntry) => number> = {
    recent: (a, b) => (p(b)?.lastPlayed ?? '').localeCompare(p(a)?.lastPlayed ?? '') || title(a, b),
    title,
    artist: (a, b) => a.artist.localeCompare(b.artist, 'fr') || title(a, b),
    mastery: (a, b) => (p(b)?.mastery ?? 0) - (p(a)?.mastery ?? 0) || title(a, b),
  };
  return [...kept].sort(order[q.sort]);
}

/** Tunings in the library, the most common first. */
export function tuningsOf(songs: readonly SongEntry[]): string[] {
  const count = new Map<string, number>();
  for (const s of songs) count.set(s.tuning, (count.get(s.tuning) ?? 0) + 1);
  return [...count].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
}

/** Each phrase, called by the part of the song where it is first played, and the highest
 * level mastered (−1: not yet), out of `levels`. */
export function phraseMastery(
  song: SongEntry,
  p: SongProgress | undefined,
): { name: string; label: string; level: number; levels: number }[] {
  const levels = (song.maxDifficulty ?? 0) + 1;
  return (song.phrases ?? []).map((name, i) => {
    const part = partName(song.phraseSections?.[i] ?? '');
    const label = part ? `${part.name}${part.number ? ` ${part.number}` : ''}` : t('Phrase {name}', { name });
    return { name, label, level: p?.mastered[name] ?? -1, levels };
  });
}

export type LibraryPurpose = 'play' | 'riff';

export interface LibraryHooks {
  coverUrl(song: SongEntry): Promise<string | null>;
  play(id: string): void;
  riff(id: string): void;
  /** Score Attack at a difficulty (the card offers it when given). */
  scoreAttack?(id: string, difficulty: AttackDifficulty): void;
  back(): void;
  /** The song whose card is open plays in the background (null: none). */
  preview?(song: SongEntry | null): void;
  /** The chords of a song's MP3 chord chart, to correct them (the desktop app). */
  chords?(song: SongEntry): Promise<SongChord[]>;
  /** Replaces chords everywhere in it; resolves with how many beats changed, the library read again. */
  fixChords?(song: SongEntry, changes: string[]): Promise<number>;
  /** Writes the song as a .feedpak where the player chooses: the file, or null if they did not. */
  exportFeedpak?(song: SongEntry): Promise<string | null>;
}

/** Note names as the converter names chords (`harmony.NOTE_NAMES`). */
export const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'];
export type ChordQuality = 'maj' | 'min' | '5';
const SUFFIXES: Record<ChordQuality, string> = { maj: '', min: 'm', '5': '5' };

/** A chord's name as an MP3's chord chart writes it: C, F#m, Bb5. */
export function chordLabel(root: number, quality: ChordQuality): string {
  return NOTE_NAMES[root] + SUFFIXES[quality];
}

/** The root and quality of a chord named as `chordLabel` names it; null otherwise. */
export function parseChord(name: string): { root: number; quality: ChordQuality } | null {
  const root = [...NOTE_NAMES.keys()].sort((a, b) => NOTE_NAMES[b].length - NOTE_NAMES[a].length).find((r) => name.startsWith(NOTE_NAMES[r]));
  if (root === undefined) return null;
  const quality = (Object.keys(SUFFIXES) as ChordQuality[]).find((q) => SUFFIXES[q] === name.slice(NOTE_NAMES[root].length));
  return quality ? { root, quality } : null;
}

const ATTACK_CHOICE = 'opensmith.attackLevel';
/** The kind of arrangement (lead, rhythm…) the player last chose. */
const PART_CHOICE = 'opensmith.part';

/** Numbers as the interface language writes them (12 345 or 12,345). */
const number = (n: number): string => n.toLocaleString(lang() === 'en' ? 'en-US' : 'fr-FR');

const TEMPLATE = `
<div class="panel library-panel">
  <header class="library-head">
    <button class="action small" data-lib="back">← Menu</button>
    <h2 data-el="title">${t('Morceaux')}</h2>
    <input type="search" data-el="search" placeholder="${t('Titre, artiste, album…')}" spellcheck="false" autocomplete="off" />
    <select data-el="sort" aria-label="${t('Trier')}"></select>
    <button class="action small primary lib-import" data-action="open-imports">${t('Importer')}</button>
  </header>
  <div class="library-filters" data-el="filters"></div>
  <div class="songs" data-el="grid"></div>
  <p class="status" data-el="status"></p>
</div>
<aside class="song-card" data-el="card" hidden></aside>`;

/**
 * Tiles drawn at once: more than a screen holds. The others follow in batches once the screen
 * has come in: under its animated panel, a thousand tiles cost WebKit their first layout, and a
 * restyle of all of them when the animation ends (150 ms each, measured with 1 367 songs).
 */
export const FIRST_TILES = 60;
const TILE_BATCH = 150;
/** The screen's entrance (`dock-in`, 0.32 s), and a little more. */
const ENTRANCE_MS = 350;

/** The tiles drawn at once and then each batch, as [from, to) over `count` songs. */
export function tileBatches(count: number, first = FIRST_TILES, batch = TILE_BATCH): [number, number][] {
  const batches: [number, number][] = [[0, Math.min(count, first)]];
  for (let from = first; from < count; from += batch) batches.push([from, Math.min(count, from + batch)]);
  return batches;
}

/** The song library: search, sort and filters over a grid of covers; a card for the chosen song. */
let tileTemplate: HTMLElement | null = null;
function blankTile(): HTMLElement {
  if (tileTemplate) return tileTemplate;
  tileTemplate = document.createElement('div');
  tileTemplate.className = 'song-tile';
  tileTemplate.tabIndex = 0;
  tileTemplate.innerHTML = `
      <div class="tile-art"><span class="tile-source"></span></div>
      <div class="tile-body">
        <div class="t"></div>
        <div class="a"></div>
        <div class="tile-meta"><span class="badge"></span><span class="len"></span></div>
        <div class="tile-parts" hidden></div>
        <div class="mastery"><i></i></div>
        <div class="mastery-text"></div>
      </div>`;
  return tileTemplate;
}

export class Library {
  private readonly el: Record<string, HTMLElement> = {};
  private songs: SongEntry[] = [];
  private progress: Progress = {};
  private query: SongQuery = { ...EVERY_SONG };
  private purpose: LibraryPurpose = 'play';
  /** The song whose card is open, and the arrangement it shows. */
  private chosenSong: SongEntry | null = null;
  private chosen: SongEntry | null = null;
  /** The song playing in the background, its card open. */
  private previewing: string | null = null;
  private attackChoice: AttackDifficulty = savedAttackChoice();
  private partChoice: string | null = saved(PART_CHOICE);
  /** Counts the grids drawn: batches of an older one stop. */
  private drawn = 0;

  constructor(
    private readonly root: HTMLElement,
    private readonly hooks: LibraryHooks,
  ) {
    root.innerHTML = TEMPLATE;
    root.querySelectorAll<HTMLElement>('[data-el]').forEach((e) => (this.el[e.dataset.el!] = e));
    const sort = this.el.sort as HTMLSelectElement;
    sort.replaceChildren(...SORTS.map((s) => new Option(s.label, s.key)));
    sort.addEventListener('change', () => this.set({ sort: sort.value as SortKey }));
    const search = this.el.search as HTMLInputElement;
    search.addEventListener('input', () => this.set({ text: search.value }));
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (search.value) this.set({ text: (search.value = '') });
        else search.blur();
      } else if (e.key === 'Enter') {
        this.grid().querySelector<HTMLElement>('.song-tile')?.focus();
      }
    });
    root.addEventListener('click', (e) => {
      const target = (e.target as HTMLElement).closest<HTMLElement>('[data-lib]');
      if (!target) return;
      const id = target.dataset.id;
      switch (target.dataset.lib) {
        case 'back':
          this.hooks.back();
          break;
        case 'source':
          this.set({ source: target.dataset.value as SongQuery['source'] });
          break;
        case 'tuning':
          this.set({ tuning: target.dataset.value! });
          break;
        case 'close':
          this.closeCard();
          break;
        case 'play':
          if (id) this.hooks.play(id);
          break;
        case 'riff':
          if (id) this.hooks.riff(id);
          break;
        case 'part':
          if (id) this.choosePart(id);
          break;
        case 'level':
          this.chooseLevel(target.dataset.value ?? 'auto');
          break;
        case 'attack-level':
          this.chooseAttack(target.dataset.value as AttackDifficulty);
          break;
        case 'attack':
          if (id) this.hooks.scoreAttack?.(id, target.dataset.value as AttackDifficulty);
          break;
      }
    });
  }

  get cardOpen(): boolean {
    return !this.el.card.hidden;
  }

  show(songs: SongEntry[], progress: Progress, purpose: LibraryPurpose): void {
    this.songs = songs;
    this.progress = progress;
    this.purpose = purpose;
    this.el.title.textContent = purpose === 'riff' ? t('Loop Trainer : quel morceau ?') : t('Morceaux');
    this.closeCard();
    this.render();
  }

  /** Songs landed while the library is open: same search, same card, same place in the grid. */
  refresh(songs: SongEntry[], progress: Progress): void {
    this.songs = songs;
    this.progress = progress;
    const scrolled: [HTMLElement, number][] = [];
    for (let e: HTMLElement | null = this.grid(); e && e !== this.root.parentElement; e = e.parentElement) scrolled.push([e, e.scrollTop]);
    // Every tile at once: the place in the grid is found again.
    this.render(true);
    for (const [e, top] of scrolled) e.scrollTop = top;
    if (this.chosenSong) this.tileOf(this.chosenSong)?.classList.add('chosen');
  }

  status(text: string, error = false): void {
    this.el.status.textContent = text;
    this.el.status.classList.toggle('error', error);
  }

  focusSearch(): void {
    (this.el.search as HTMLInputElement).focus();
  }

  closeCard(): void {
    if (this.previewing) this.hooks.preview?.(null);
    this.previewing = null;
    this.chosenSong = null;
    this.chosen = null;
    this.el.card.hidden = true;
    this.root.classList.remove('with-card');
    this.grid().querySelectorAll('.song-tile.chosen').forEach((t) => t.classList.remove('chosen'));
  }

  private grid(): HTMLElement {
    return this.el.grid;
  }

  private tileOf(song: SongEntry): HTMLElement | null {
    return this.grid().querySelector<HTMLElement>(`.song-tile[data-id="${CSS.escape(song.id)}"]`);
  }

  private set(change: Partial<SongQuery>): void {
    this.query = { ...this.query, ...change };
    this.render();
  }

  /** The grid for the query: the first tiles now, the others in batches (`all`: every one now). */
  private render(all = false): void {
    const drawing = ++this.drawn;
    (this.el.sort as HTMLSelectElement).value = this.query.sort;
    this.renderFilters();
    const list = selectSongs(this.songs, this.progress, this.query);
    if (!this.songs.length) {
      this.grid().innerHTML = `<p class="empty">${t('Aucun morceau pour l’instant : ajoute des MP3 ou des tablatures depuis le menu.')}</p>`;
      return;
    }
    if (!list.length) {
      this.grid().innerHTML = `<p class="empty">${t('Aucun morceau ne correspond.')}</p>`;
      return;
    }
    const [now, ...later] = tileBatches(list.length, all ? list.length : FIRST_TILES);
    this.grid().replaceChildren(...list.slice(...now).map((s) => this.tile(s)));
    const next = () => {
      const batch = later.shift();
      if (!batch || drawing !== this.drawn) return;
      this.grid().append(...list.slice(...batch).map((s) => this.tile(s)));
      requestAnimationFrame(next);
    };
    if (later.length) setTimeout(() => requestAnimationFrame(next), ENTRANCE_MS);
  }

  private renderFilters(): void {
    const chip = (kind: string, value: string, label: string, on: boolean, count?: number) => {
      const b = document.createElement('button');
      b.className = `chip${on ? ' on' : ''}`;
      b.dataset.lib = kind;
      b.dataset.value = value;
      b.textContent = count === undefined ? label : `${label} · ${count}`;
      return b;
    };
    const sources = (Object.keys(SOURCES) as SongSource[]).filter((k) => this.songs.some((s) => sourceOf(s) === k));
    const tunings = tuningsOf(this.songs);
    const row: HTMLElement[] = [chip('source', 'all', t('Tous'), this.query.source === 'all')];
    for (const k of sources) {
      const c = chip('source', k, SOURCES[k].label, this.query.source === k, this.songs.filter((s) => sourceOf(s) === k).length);
      c.classList.add(`source-${k}`);
      c.title = SOURCES[k].about;
      row.push(c);
    }
    if (tunings.length > 1) {
      const sep = document.createElement('span');
      sep.className = 'chip-sep';
      row.push(sep, chip('tuning', 'all', t('Tous accordages'), this.query.tuning === 'all'));
      for (const tuning of tunings) row.push(chip('tuning', tuning, tuning, this.query.tuning === tuning));
    }
    this.el.filters.replaceChildren(...row);
  }

  /** A song: picture, where its notes come from, mastery, best grade. */
  private tile(song: SongEntry): HTMLElement {
    const p = this.progress[song.id];
    const source = sourceOf(song);
    // A copy of the one tile parsed once: a big library has a thousand of them.
    const tile = blankTile().cloneNode(true) as HTMLElement;
    tile.dataset.id = song.id;
    const art = tile.querySelector('.tile-art')!;
    art.prepend(coverElement(song.title, song.artist, () => this.hooks.coverUrl(song), 'tile-cover'));
    const badge = tile.querySelector<HTMLElement>('.tile-source')!;
    badge.textContent = SOURCES[source].label;
    badge.className = `tile-source source-${source}`;
    badge.title = aboutSource(song);
    if (p?.bestGrade) {
      const grade = document.createElement('b');
      grade.className = 'tile-grade';
      grade.dataset.grade = p.bestGrade;
      grade.textContent = p.bestGrade;
      art.append(grade);
    }
    tile.querySelector('.t')!.textContent = song.title;
    tile.querySelector('.a')!.textContent = song.artist;
    tile.querySelector('.badge')!.textContent = song.tuning;
    tile.querySelector('.len')!.textContent = formatTime(song.duration);
    const parts = partsOf(song);
    const count = tile.querySelector<HTMLElement>('.tile-parts')!;
    count.hidden = parts.length < 2;
    if (parts.length > 1) {
      count.textContent = t('{n} arrangements', { n: parts.length });
      count.title = parts.map(partLabel).join(' · ');
    }
    const m = Math.round((p?.mastery ?? 0) * 100);
    tile.querySelector<HTMLElement>('.mastery i')!.style.width = `${m}%`;
    tile.querySelector('.mastery-text')!.textContent = p?.plays ? `${t('Maîtrise {pct} %', { pct: m })} · ${tn(p.plays, '{n} partie', '{n} parties')}` : t('Jamais joué');
    tile.addEventListener('click', () => this.openCard(song, tile));
    tile.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (this.chosenSong?.id === song.id && this.chosen) this.primary(this.chosen);
        else this.openCard(song, tile);
      }
    });
    return tile;
  }

  private primary(song: SongEntry): void {
    if (this.purpose === 'riff') this.hooks.riff(song.id);
    else this.hooks.play(song.id);
  }

  /** The chosen song in detail, in one of its arrangements: where its notes come from, records,
   * phrases, Play. */
  private openCard(main: SongEntry, tile: HTMLElement, part = preferredPart(main, this.partChoice)): void {
    this.chosenSong = main;
    this.chosen = part;
    // Its arrangements share the recording: the preview goes on from one to another.
    if (this.previewing !== main.id && main.hasAudio !== false) {
      this.previewing = main.id;
      this.hooks.preview?.(main);
    }
    const song = part;
    this.grid().querySelectorAll('.song-tile.chosen').forEach((t) => t.classList.remove('chosen'));
    tile.classList.add('chosen');
    const p = this.progress[song.id];
    const source = sourceOf(song);
    const card = this.el.card;
    card.innerHTML = `
      <button class="card-close" data-lib="close" aria-label="${t('Fermer')}">×</button>
      <div class="card-art"></div>
      <h3 class="card-title"></h3>
      <p class="card-artist"></p>
      <div class="segmented card-parts" role="group" aria-label="${t('Arrangement')}"></div>
      <div class="card-badges"><span class="badge tuning"></span><span class="badge len"></span><span class="badge source"></span></div>
      <p class="card-about"></p>
      <dl class="card-stats"></dl>
      <div class="card-mastery"><div class="mastery"><i></i></div><span></span></div>
      <section class="card-phrases"><h4>${t('Phrases maîtrisées')}</h4><div class="phrase-cells"></div></section>
      <div class="buttons"></div>`;
    card.querySelector('.card-art')!.append(coverElement(song.title, song.artist, this.hooks.coverUrl(song), 'card-cover'));
    card.querySelector('.card-title')!.textContent = song.title;
    const by = [song.artist, song.album, song.year ? String(song.year) : null].filter(Boolean).join(' · ');
    card.querySelector('.card-artist')!.textContent = by;
    const parts = partsOf(main);
    const picker = card.querySelector<HTMLElement>('.card-parts')!;
    picker.hidden = parts.length < 2;
    picker.replaceChildren(
      ...parts.map((p) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.lib = 'part';
        b.dataset.id = p.id;
        b.textContent = partLabel(p);
        b.classList.toggle('on', p.id === part.id);
        return b;
      }),
    );
    card.querySelector('.badge.tuning')!.textContent = song.tuning;
    card.querySelector('.badge.len')!.textContent = formatTime(song.duration);
    const sourceBadge = card.querySelector<HTMLElement>('.badge.source')!;
    sourceBadge.textContent = SOURCES[source].label;
    sourceBadge.classList.add(`source-${source}`);
    card.querySelector('.card-about')!.textContent = aboutSource(song);
    const stats: [string, string][] = [
      [t('Meilleure note'), p?.bestGrade ?? '—'],
      [t('Record'), p?.bestScore ? number(p.bestScore) : '—'],
      [t('Meilleure série'), p?.bestStreak ? String(p.bestStreak) : '—'],
      [t('Parties'), String(p?.plays ?? 0)],
    ];
    card.querySelector('.card-stats')!.replaceChildren(
      ...stats.map(([k, v]) => {
        const cell = document.createElement('div');
        const dt = document.createElement('dt');
        const dd = document.createElement('dd');
        dt.textContent = k;
        dd.textContent = v;
        cell.append(dt, dd);
        return cell;
      }),
    );
    const m = Math.round((p?.mastery ?? 0) * 100);
    card.querySelector<HTMLElement>('.card-mastery i')!.style.width = `${m}%`;
    card.querySelector('.card-mastery span')!.textContent = t('Maîtrise {pct} %', { pct: m });
    const phrases = phraseMastery(song, p);
    const cells = card.querySelector('.phrase-cells')!;
    cells.replaceChildren(
      ...phrases.map((ph) => {
        const cell = document.createElement('i');
        cell.style.setProperty('--h', String((ph.level + 1) / ph.levels));
        cell.className = ph.level + 1 >= ph.levels ? 'full' : ph.level >= 0 ? 'some' : 'none';
        cell.title =
          ph.level >= 0
            ? t('{phrase} · niveau {level}/{levels} maîtrisé', { phrase: ph.label, level: ph.level + 1, levels: ph.levels })
            : t('{phrase} · pas encore maîtrisée', { phrase: ph.label });
        return cell;
      }),
    );
    card.querySelector<HTMLElement>('.card-phrases')!.hidden = phrases.length === 0;
    const play = document.createElement('button');
    play.className = `action${this.purpose === 'play' ? ' primary' : ''}`;
    play.dataset.lib = 'play';
    play.dataset.id = song.id;
    play.textContent = t('Jouer');
    const riff = document.createElement('button');
    riff.className = `action${this.purpose === 'riff' ? ' primary' : ''}`;
    riff.dataset.lib = 'riff';
    riff.dataset.id = song.id;
    riff.textContent = 'Loop Trainer';
    card.querySelector('.buttons')!.replaceChildren(...(this.purpose === 'riff' ? [riff, play] : [play, riff]));
    card.querySelector('.buttons')!.before(this.levelSection(song));
    if (this.hooks.scoreAttack) card.querySelector('.buttons')!.after(this.attackSection(song));
    if (this.hooks.chords && sourceOf(song) === 'ai' && song.arrangement.toLowerCase() === 'chords') card.append(this.chordsSection(song));
    if (this.hooks.exportFeedpak && sourceOf(song) === 'ai') card.append(this.shareSection(song));
    card.hidden = false;
    this.root.classList.add('with-card');
  }

  /** Another arrangement of the open song: its card, and the kind remembered for the next songs. */
  private choosePart(id: string): void {
    const main = this.chosenSong;
    const part = main && partsOf(main).find((p) => p.id === id);
    const tile = main && this.tileOf(main);
    if (!main || !part || !tile) return;
    this.partChoice = part.arrangementType ?? null;
    store(PART_CHOICE, this.partChoice);
    this.openCard(main, tile, part);
  }

  /** The difficulty to play the song at: Auto, or a level for the whole song. */
  private levelSection(song: SongEntry): HTMLElement {
    const chosen = songLevel(song.id);
    const section = document.createElement('div');
    section.className = 'card-level';
    const head = document.createElement('span');
    head.className = 'card-level-head';
    head.textContent = t('Difficulté');
    const name = document.createElement('b');
    name.textContent = LEVEL_CHOICES.find((c) => c.value === (chosen === null ? 'auto' : String(chosen)))!.label;
    head.append(' · ', name);
    const picker = document.createElement('div');
    picker.className = 'segmented';
    picker.setAttribute('role', 'group');
    picker.setAttribute('aria-label', t('Difficulté'));
    for (const c of LEVEL_CHOICES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.lib = 'level';
      b.dataset.value = c.value;
      b.textContent = c.short;
      b.title = c.label;
      b.classList.toggle('on', c.value === (chosen === null ? 'auto' : String(chosen)));
      picker.append(b);
    }
    section.append(head, picker);
    return section;
  }

  /** The open card's difficulty drawn again (changed from the pause menu meanwhile). */
  refreshLevel(): void {
    const song = this.chosen;
    if (song) this.el.card.querySelector('.card-level')?.replaceWith(this.levelSection(song));
  }

  private chooseLevel(value: string): void {
    const song = this.chosen;
    if (!song) return;
    setSongLevel(song.id, value === 'auto' ? null : Number(value));
    this.el.card.querySelector('.card-level')?.replaceWith(this.levelSection(song));
  }

  /** An MP3's chord chart: its chords, and one to correct everywhere, as the player hears it. */
  private chordsSection(song: SongEntry): HTMLElement {
    const section = document.createElement('section');
    section.className = 'card-chords';
    section.hidden = true;
    const head = document.createElement('h4');
    head.textContent = t('Accords du morceau');
    const hint = document.createElement('p');
    hint.className = 'card-chords-hint';
    hint.textContent = t('Un accord faux ? Choisis-le, puis celui qu’on entend : il change partout.');
    const chips = document.createElement('div');
    chips.className = 'chord-chips';
    const fix = document.createElement('div');
    fix.className = 'chord-fix';
    fix.hidden = true;
    section.append(head, hint, chips, fix);
    this.hooks
      .chords?.(song)
      .then((chords) => {
        chips.replaceChildren(
          ...chords.map((c) => {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'chip';
            chip.textContent = `${c.name} · ${c.beats}`;
            chip.title = c.muted ? t('{n} temps, dont {m} étouffés : accord incertain', { n: c.beats, m: c.muted }) : tn(c.beats, '{n} temps', '{n} temps');
            chip.addEventListener('click', () => this.chordFix(song, c.name, fix, chip));
            return chip;
          }),
        );
        section.hidden = chords.length === 0;
      })
      .catch(() => (section.hidden = true));
    return section;
  }

  /** An MP3's song, its chords corrected or not, as a .feedpak for feedBack and the other games
   * that read the format. */
  private shareSection(song: SongEntry): HTMLElement {
    const section = document.createElement('div');
    section.className = 'card-share';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'action small';
    button.textContent = t('Exporter en .feedpak');
    button.title = t('Toutes ses parties, la musique et la pochette, pour feedBack et les autres jeux qui lisent ce format.');
    button.addEventListener('click', () => {
      button.disabled = true;
      this.hooks
        .exportFeedpak?.(song)
        .then((path) => path && this.status(t('Exporté : {path}', { path })))
        .catch((e: unknown) => this.status(String(e), true))
        .finally(() => (button.disabled = false));
    });
    section.append(button);
    return section;
  }

  /** Corrects chord `old` of the song everywhere: the chord heard instead, then the converter. */
  private chordFix(song: SongEntry, old: string, box: HTMLElement, chip: HTMLElement): void {
    chip.parentElement?.querySelectorAll('.chip.on').forEach((c) => c.classList.remove('on'));
    chip.classList.add('on');
    const choice = parseChord(old) ?? { root: 0, quality: 'maj' as ChordQuality };
    const roots = document.createElement('select');
    roots.setAttribute('aria-label', t('Fondamentale'));
    roots.replaceChildren(...NOTE_NAMES.map((n, r) => new Option(n, String(r), false, r === choice.root)));
    const qualities = document.createElement('div');
    qualities.className = 'segmented';
    const kinds: [ChordQuality, string][] = [
      ['maj', t('Majeur')],
      ['min', t('Mineur')],
      ['5', 'Power chord'],
    ];
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'action small primary';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'action small';
    cancel.textContent = t('Annuler');
    const label = () => chordLabel(choice.root, choice.quality);
    const draw = () => {
      qualities.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.value === choice.quality));
      go.textContent = t('{old} devient {new} partout', { old, new: label() });
      go.disabled = label() === old;
    };
    for (const [value, name] of kinds) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.value = value;
      b.textContent = name;
      b.addEventListener('click', () => {
        choice.quality = value;
        draw();
      });
      qualities.append(b);
    }
    roots.addEventListener('change', () => {
      choice.root = Number(roots.value);
      draw();
    });
    cancel.addEventListener('click', () => {
      box.hidden = true;
      chip.classList.remove('on');
    });
    go.addEventListener('click', () => {
      const now = label();
      go.disabled = cancel.disabled = true;
      go.textContent = t('Je refais la partition…');
      this.hooks
        .fixChords?.(song, [`${old}=${now}`])
        .then((n) => {
          this.status(tn(n, '{n} temps : {old} devient {new}.', '{n} temps : {old} devient {new}.', { old, new: now }));
          // The card again, on the chart made anew.
          const main = this.songs.find((s) => partsOf(s).some((p) => p.id === song.id));
          const fresh = main && partsOf(main).find((p) => p.id === song.id);
          const tile = main && this.tileOf(main);
          if (main && fresh && tile) this.openCard(main, tile, fresh);
        })
        .catch((e: unknown) => {
          this.status(String(e), true);
          cancel.disabled = false;
          draw();
        });
    });
    const row = document.createElement('div');
    row.className = 'chord-fix-row';
    row.append(roots, qualities);
    const buttons = document.createElement('div');
    buttons.className = 'chord-fix-row';
    buttons.append(go, cancel);
    box.replaceChildren(row, buttons);
    box.hidden = false;
    draw();
  }

  /** Score Attack in the card: the difficulties with their records, and the button. */
  private attackSection(song: SongEntry): HTMLElement {
    const scores = this.progress[song.id]?.attack;
    return attackPicker(song.id, this.attackChoice, (key) => scores?.[key]?.[0]);
  }

  private chooseAttack(key: AttackDifficulty): void {
    this.attackChoice = key;
    store(ATTACK_CHOICE, key);
    const song = this.chosen;
    const section = this.el.card.querySelector('.card-attack');
    if (song && section) section.replaceWith(this.attackSection(song));
  }
}

const SONG_LEVELS = 'opensmith.songLevels';

/** The difficulty chosen for a song on its card (a step of `startLevelFor`, 0 to 4); null: dynamic,
 * following the player. Kept on this Mac, per song. */
export function songLevel(id: string): number | null {
  try {
    const step = (JSON.parse(saved(SONG_LEVELS) ?? '{}') as Record<string, number>)[id];
    return typeof step === 'number' && step >= 0 && step <= 4 ? step : null;
  } catch {
    return null;
  }
}

export function setSongLevel(id: string, step: number | null): void {
  let all: Record<string, number> = {};
  try {
    all = JSON.parse(saved(SONG_LEVELS) ?? '{}') as Record<string, number>;
  } catch {
    all = {};
  }
  if (step === null) delete all[id];
  else all[id] = step;
  store(SONG_LEVELS, JSON.stringify(all));
}

/** The card's difficulties: dynamic, or a level for the whole song (as the pause menu offers). */
export const LEVEL_CHOICES: readonly { value: string; short: string; label: string }[] = [
  { value: 'auto', short: t('Auto'), label: t('Auto · suit ton jeu') },
  { value: '0', short: '1', label: t('1 · Débutant') },
  { value: '1', short: '2', label: t('2 · Facile') },
  { value: '2', short: '3', label: t('3 · Moyen') },
  { value: '3', short: '4', label: t('4 · Difficile') },
  { value: '4', short: '5', label: t('5 · Toutes les notes') },
];

function saved(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // no storage
  }
}

function store(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // storage unavailable: the choice lasts for this session
  }
}

function savedAttackChoice(): AttackDifficulty {
  try {
    const key = localStorage.getItem(ATTACK_CHOICE);
    if (ATTACK_LEVELS.some((l) => l.key === key)) return key as AttackDifficulty;
  } catch {
    // no storage
  }
  return 'medium';
}
