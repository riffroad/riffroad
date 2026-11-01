import type { Chart } from './chart';
import type { Score } from './game/types';
import type { PhraseResult } from './game/view';

/** A phrase counts as mastered at a level when played at that level with this accuracy. */
export const MASTERY = 0.85;
const GRADES = ['D', 'C', 'B', 'A', 'S'];

/** What the game remembers of a song between sessions. */
export interface SongProgress {
  plays: number;
  bestScore: number;
  bestAccuracy: number;
  bestStreak: number;
  bestGrade: string | null;
  lastPlayed: string | null;
  /** Dynamic difficulty: the level each phrase (by name) starts at next time. */
  levels: Record<string, number>;
  /** Highest level each phrase was played at with at least MASTERY accuracy. */
  mastered: Record<string, number>;
  /** 0..1, see `mastery`. */
  mastery: number;
  /** Score Attack: best runs by difficulty (key of ATTACK_LEVELS), best first. */
  attack?: Record<string, AttackScore[]>;
  /** The best Score Attack run of each level, its points at each second (ghost.ts). */
  ghosts?: Record<string, number[]>;
}

/** A finished Score Attack run, as kept in the song's high scores. */
export interface AttackScore {
  score: number;
  accuracy: number;
  grade: string;
  streak: number;
  /** ISO date. */
  date: string;
}

/** High scores kept per song and difficulty. */
export const ATTACK_TOP = 5;

/** Song id → progress. */
export type Progress = Record<string, SongProgress>;

export interface ProgressStore {
  load(): Promise<Progress>;
  save(all: Progress): Promise<void>;
}

export const emptyProgress = (): SongProgress => ({
  plays: 0,
  bestScore: 0,
  bestAccuracy: 0,
  bestStreak: 0,
  bestGrade: null,
  lastPlayed: null,
  levels: {},
  mastered: {},
  mastery: 0,
});

/**
 * How much of the song the player masters, 0..1: each phrase weighs its length and counts by
 * the highest level mastered out of the top level (100 % = every phrase at full difficulty).
 */
export function mastery(chart: Chart, p: SongProgress | undefined): number {
  const levels = chart.arrangement.maxDifficulty + 1;
  let total = 0;
  let got = 0;
  for (const phrase of chart.phrases) {
    if (phrase.name.startsWith('rest')) continue;
    const length = phrase.end - phrase.start;
    total += length;
    const level = p?.mastered[phrase.name];
    if (level !== undefined) got += (length * (level + 1)) / levels;
  }
  return total > 0 ? got / total : 0;
}

/** S to D from the share of notes played, '—' when none was judged. */
export function gradeFor(accuracy: number, judged: number): string {
  return judged === 0 ? '—' : accuracy >= 0.98 ? 'S' : accuracy >= 0.92 ? 'A' : accuracy >= 0.8 ? 'B' : accuracy >= 0.6 ? 'C' : 'D';
}

/** `grade` is `least` or better. */
export const gradeAtLeast = (grade: string, least: string): boolean => GRADES.indexOf(grade) >= GRADES.indexOf(least);

export const betterGrade = (a: string | null, b: string | null): string | null =>
  !a ? b : !b ? a : GRADES.indexOf(b) > GRADES.indexOf(a) ? b : a;

export interface Outcome {
  progress: SongProgress;
  /** What this play beat: 'score', 'streak', 'grade', 'mastery' (none on a first play). */
  records: string[];
  masteryBefore: number;
  masteryAfter: number;
}

/** A finished play folded into the song's progress. */
export function record(
  previous: SongProgress | undefined,
  chart: Chart,
  score: Score,
  results: ReadonlyMap<number, PhraseResult>,
  grade: string,
  when = new Date(),
  /** False when the difficulty was forced during the song: the levels learnt stay as they were. */
  learn = true,
): Outcome {
  const before = previous ?? emptyProgress();
  const p: SongProgress = { ...before, levels: { ...before.levels }, mastered: { ...before.mastered } };
  const judged = score.hits + score.misses;
  const accuracy = judged ? score.hits / judged : 0;
  const first = before.plays === 0;
  const records: string[] = [];
  p.plays += 1;
  if (score.points > before.bestScore) {
    if (!first) records.push('score');
    p.bestScore = score.points;
  }
  if (score.bestStreak > before.bestStreak) {
    if (!first) records.push('streak');
    p.bestStreak = score.bestStreak;
  }
  p.bestAccuracy = Math.max(before.bestAccuracy, accuracy);
  if (judged) {
    const best = betterGrade(before.bestGrade, grade);
    if (!first && best !== before.bestGrade) records.push('grade');
    p.bestGrade = best;
  }
  foldPhrases(p, chart, results, learn);
  if (!first && p.mastery > before.mastery + 1e-9) records.push('mastery');
  p.lastPlayed = when.toISOString();
  return { progress: p, records, masteryBefore: before.mastery, masteryAfter: p.mastery };
}

/**
 * A Loop Trainer pass at full speed: its phrases count like in the song (level to start at
 * next time, mastery); plays and records stay the song's.
 */
export function recordPass(
  previous: SongProgress | undefined,
  chart: Chart,
  results: ReadonlyMap<number, PhraseResult>,
  when = new Date(),
  learn = true,
): Outcome {
  const before = previous ?? emptyProgress();
  const p: SongProgress = { ...before, levels: { ...before.levels }, mastered: { ...before.mastered } };
  foldPhrases(p, chart, results, learn);
  p.lastPlayed = when.toISOString();
  const records = p.mastery > before.mastery + 1e-9 ? ['mastery'] : [];
  return { progress: p, records, masteryBefore: before.mastery, masteryAfter: p.mastery };
}

/** Phrase results into `p`: the level each phrase starts at next time (unless `levels` is
 * false), the highest mastered. */
function foldPhrases(p: SongProgress, chart: Chart, results: ReadonlyMap<number, PhraseResult>, levels = true): void {
  for (const [k, r] of [...results].sort((a, b) => a[0] - b[0])) {
    const name = chart.phrases[k]?.name;
    if (!name || name.startsWith('rest')) continue;
    if (levels) p.levels[name] = r.nextLevel;
    if (r.accuracy >= MASTERY) p.mastered[name] = Math.max(p.mastered[name] ?? -1, r.level);
  }
  p.mastery = mastery(chart, p);
}

export interface AttackOutcome {
  progress: SongProgress;
  /** Place of this run in the difficulty's high scores (1 = new record), null if not ranked. */
  rank: number | null;
  /** The difficulty's high scores after this run, best first. */
  scores: AttackScore[];
  masteryBefore: number;
  masteryAfter: number;
}

/**
 * A Score Attack run into the song's progress: a play, its place in the high scores of
 * `difficulty` (a failed run is not ranked) and the phrases mastered on the way. The levels of
 * the dynamic difficulty stay as they were: the run was played at a fixed level.
 */
export function recordAttack(
  previous: SongProgress | undefined,
  chart: Chart,
  difficulty: string,
  run: Omit<AttackScore, 'date'>,
  results: ReadonlyMap<number, PhraseResult>,
  failed: boolean,
  when = new Date(),
  /** The run's points at each second: kept, as the ghost to race, when it is the best. */
  trace?: readonly number[],
): AttackOutcome {
  const before = previous ?? emptyProgress();
  const p: SongProgress = {
    ...before,
    levels: { ...before.levels },
    mastered: { ...before.mastered },
    attack: { ...before.attack },
  };
  p.plays += 1;
  p.lastPlayed = when.toISOString();
  foldPhrases(p, chart, results, false);
  const scores = [...(p.attack![difficulty] ?? [])];
  let rank: number | null = null;
  if (!failed && run.score > 0) {
    const entry: AttackScore = { ...run, date: when.toISOString() };
    const at = scores.findIndex((s) => run.score > s.score);
    const index = at < 0 ? scores.length : at;
    if (index < ATTACK_TOP) {
      scores.splice(index, 0, entry);
      scores.length = Math.min(scores.length, ATTACK_TOP);
      rank = index + 1;
    }
  }
  if (rank === 1 && trace?.length) p.ghosts = { ...before.ghosts, [difficulty]: [...trace] };
  p.attack![difficulty] = scores;
  return { progress: p, rank, scores, masteryBefore: before.mastery, masteryAfter: p.mastery };
}

const KEY = 'opensmith.progress';

/** Browser storage (demo mode). */
export const localProgress: ProgressStore = {
  async load() {
    try {
      return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Progress;
    } catch {
      return {};
    }
  },
  async save(all) {
    try {
      localStorage.setItem(KEY, JSON.stringify(all));
    } catch {
      // storage unavailable: progress lasts for this session
    }
  },
};
