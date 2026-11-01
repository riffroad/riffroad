import type { CareerStore } from '../career/career';
import type { Chart } from '../chart';
import type { GameEvent } from '../game/types';
import type { ProgressStore } from '../progress';
import type { SoundName } from '../sounds';

export interface SongEntry {
  /** Chart path inside the library, e.g. "demo/chart/song_chart.json". */
  id: string;
  title: string;
  artist: string;
  duration: number;
  tuning: string;
  arrangement: string;
  /** What it plays: "lead", "rhythm", "combo", "bass". */
  arrangementType?: string;
  notes: number;
  chords: number;
  /** Library path of the song's picture, if any. */
  cover?: string | null;
  album?: string | null;
  year?: number | null;
  /** Where the notes come from: "audio" (transcribed), "guitarpro", "synth", a plugin's… */
  source?: string;
  /** A backing track to play along with. */
  hasAudio?: boolean;
  maxDifficulty?: number;
  /** Phrase names in order of first appearance (rests aside). */
  phrases?: string[];
  /** Notes and chords played at each level 0..maxDifficulty (how sparse the easy levels are). */
  levelNotes?: number[];
  /** The part of the song (section name, as written) where each of `phrases` is first played. */
  phraseSections?: string[];
  /** The song's other arrangements (rhythm, bass…), each with its own chart and progress. */
  others?: SongEntry[];
}

/** A song entry by id, its other arrangements included. */
export function findSong(songs: readonly SongEntry[], id: string): SongEntry | undefined {
  for (const s of songs) {
    if (s.id === id) return s;
    const other = s.others?.find((o) => o.id === id);
    if (other) return other;
  }
  return undefined;
}

export interface Frame {
  /** Song time heard now, seconds (negative during the count-in). */
  time: number;
  playing: boolean;
  events: GameEvent[];
  /** Loudest guitar sample since the last frame (live mode), linear. */
  peak: number;
}

/**
 * Loop Trainer loop, song seconds: the music loops over `start..end` and the notes from `from`
 * to `to` are judged again on every pass (`start` a little before `from` to get ready, `end`
 * long enough after `to` for the last notes to be judged).
 */
export interface RiffLoop {
  start: number;
  end: number;
  from: number;
  to: number;
}

/** Plays a song and judges the player: the native engine (Tauri) or the browser demo. */
export interface Engine {
  readonly kind: 'demo' | 'live';
  /** Where the career mode is saved. */
  readonly career: CareerStore;
  readonly playing: boolean;
  /** Called from a user gesture: lets the browser start audio. */
  unlock(): void;
  /** Where scores and learnt levels are kept. */
  readonly progress: ProgressStore;
  /** The songs; the same array as the last call's when nothing changed. */
  library(): Promise<SongEntry[]>;
  /** `levels`: the level each phrase (by name) starts at, from earlier sessions. */
  load(id: string, levels?: Record<string, number>): Promise<Chart>;
  /** A chart made in the app (a lesson), all its notes at once, over a metronome on its beats. */
  loadLesson(chart: Chart): Promise<Chart>;
  play(): void;
  pause(): void;
  /** Moves to `time` and starts judging from there. */
  seek(time: number): void;
  /** Playback speed (1 = as recorded); the native engine keeps the pitch. */
  setSpeed(rate: number): void;
  /** Loop Trainer: plays the loop from its start, a 'pass' event each time round; null: off. */
  setRiff(riff: RiffLoop | null): void;
  /** Difficulty changed during the song (pause menu), from the next phrase: dynamic from the
   * levels learnt, or every phrase at `level`. */
  setDifficulty(dynamic: boolean, level: number): void;
  /** State at `nowMs` (performance.now()) and the game events since the last frame. */
  frame(nowMs: number): Frame;
  /** An image URL for the song's picture, null without one. */
  coverUrl(song: SongEntry): Promise<string | null>;
  /** Keeps a sound to play later by name: mono samples at `rate` Hz. */
  addSound(name: SoundName, rate: number, samples: Float32Array): void;
  /** Plays a sound kept before at linear `gain`, now or at song time `at` (a count-in); a seek
   * or a load drops the ones still waiting. */
  sound(name: SoundName, gain: number, at?: number): void;
  /** The looping background sound (the crowd) glides to `gain`; null fades it out. */
  bed(name: SoundName | null, gain: number): void;
  /** The song `id` plays in the background as the background sound (its chorus, looping, at
   * `gain`), as when browsing songs; null fades it out. */
  preview?(id: string | null, gain: number): void;
}
