import type { Chart } from '../chart';
import { t } from '../i18n';
import { emptyScore, type Expected, type GameEvent, type MissReason, type Score, type Status } from './types';

export interface ViewItem extends Expected {
  status: Status;
  error: number;
  perfect: boolean;
  /** Missed: why. */
  reason?: MissReason;
}

export interface Effect {
  /** `late`: a missed note played after all (its reason is now timing). */
  kind: 'hit' | 'miss' | 'late';
  item: ViewItem;
}

/** What to tell the player about a miss; nothing when nothing was played. */
export function missText(reason: MissReason | undefined): string | null {
  if (reason?.kind === 'technique') return t('Technique non réalisée');
  switch (reason?.kind) {
    case 'timing':
      return reason.error < 0 ? t('Trop tôt') : t('Trop tard');
    case 'pitch':
      return reason.semitones > 0 ? t('Trop haut') : t('Trop bas');
    case 'wrongChord':
      return t('Mauvais accord');
    default:
      return null;
  }
}

export interface Toast {
  kind: 'up' | 'down' | 'mastered' | 'perfect' | 'phrase' | 'streak' | 'lost';
  title: string;
  detail?: string;
  /** A toast with the same key replaces the one on screen (a setting being changed). */
  key?: string;
}

export interface PhraseResult {
  accuracy: number;
  level: number;
  nextLevel: number;
}

/** A phrase iteration just judged. */
export interface PhraseDone extends PhraseResult {
  iteration: number;
  name: string;
}

/** Loop Trainer: one time round the loop. */
export interface Pass {
  score: Score;
  /** Phrase results of this pass, by iteration. */
  results: Map<number, PhraseResult>;
}

const MILESTONES = [10, 25, 50, 75, 100, 150, 200, 300, 400, 500];
const MASTERY = 0.85;

/** What the screen shows of the game: expected notes with their fate, score, phrase results. */
export class GameView {
  items: ViewItem[] = [];
  score: Score = emptyScore();
  maxSustain = 0;
  ended = false;
  heard: { midi: number; cents: number; at: number } | null = null;
  /** Timing errors judged since the last reset (s, positive when late): hits, and misses out of time. */
  timing: number[] = [];
  /** Level of each phrase iteration made visible so far. */
  readonly levels = new Map<number, number>();
  readonly results = new Map<number, PhraseResult>();
  private effects: Effect[] = [];
  private toasts: Toast[] = [];
  private passes: Pass[] = [];
  private phrases: PhraseDone[] = [];

  constructor(readonly chart: Chart) {}

  apply(events: readonly GameEvent[], now: number): void {
    for (const e of events) {
      switch (e.type) {
        case 'reset':
          this.items = [];
          this.score = emptyScore();
          this.maxSustain = 0;
          this.ended = false;
          this.timing = [];
          this.levels.clear();
          this.results.clear();
          this.effects = [];
          this.phrases = [];
          break;
        case 'expected':
          this.levels.set(e.iteration, e.level);
          for (const x of e.items) {
            this.items[x.index] = { ...x, status: 'pending', error: 0, perfect: false };
            this.maxSustain = Math.max(this.maxSustain, x.sustain);
          }
          break;
        case 'hit':
        case 'miss': {
          const it = this.items[e.index];
          if (!it || it.status !== 'pending') break;
          it.status = e.type === 'hit' ? 'hit' : 'missed';
          if (e.type === 'hit') {
            it.error = e.error;
            it.perfect = e.perfect;
            this.timing.push(e.error);
          } else {
            it.reason = e.reason;
            if (e.reason.kind === 'timing') this.timing.push(e.reason.error);
          }
          this.effects.push({ kind: e.type, item: it });
          break;
        }
        case 'late': {
          const it = this.items[e.index];
          if (!it || it.status !== 'missed') break;
          it.reason = { kind: 'timing', error: e.error };
          this.timing.push(e.error);
          this.effects.push({ kind: 'late', item: it });
          break;
        }
        case 'phrase':
          this.results.set(e.iteration, { accuracy: e.accuracy, level: e.level, nextLevel: e.nextLevel });
          this.phrases.push({ iteration: e.iteration, name: e.name, accuracy: e.accuracy, level: e.level, nextLevel: e.nextLevel });
          this.toasts.push(this.phraseToast(e.name, e.accuracy, e.level, e.nextLevel));
          break;
        case 'score': {
          const before = this.score.streak;
          const after = e.score.streak;
          const reached = MILESTONES.filter((m) => before < m && after >= m).pop();
          if (reached) this.toasts.push({ kind: 'streak', title: t('Série de {n} !', { n: reached }) });
          if (before >= 10 && after < before && after <= 1) {
            this.toasts.push({ kind: 'lost', title: t('Série perdue'), detail: t('{n} notes d\'affilée', { n: before }) });
          }
          this.score = e.score;
          break;
        }
        case 'pass':
          this.passes.push({ score: e.score, results: new Map(this.results) });
          break;
        case 'heard':
          this.heard = { midi: e.midi, cents: e.cents, at: now };
          break;
        case 'end':
          this.ended = true;
          break;
      }
    }
  }

  /** First item that can still be on screen at `t`, sustains included (items in time order). */
  firstVisible(t: number): number {
    const from = t - this.maxSustain;
    let lo = 0;
    let hi = this.items.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.items[mid]?.time ?? -Infinity) < from) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  drainEffects(): Effect[] {
    const out = this.effects;
    this.effects = [];
    return out;
  }

  /** Phrases judged since the last call, in order. */
  drainPhrases(): PhraseDone[] {
    const out = this.phrases;
    this.phrases = [];
    return out;
  }

  drainPasses(): Pass[] {
    const out = this.passes;
    this.passes = [];
    return out;
  }

  drainToasts(): Toast[] {
    const out = this.toasts;
    this.toasts = [];
    return out;
  }

  private phraseToast(name: string, accuracy: number, level: number, next: number): Toast {
    const pct = Math.round(accuracy * 100);
    const levels = this.chart.arrangement.maxDifficulty + 1;
    const where = (l: number) => t('{phrase} · {pct} % · niveau {level}/{levels}', { phrase: name, pct, level: l + 1, levels });
    if (next > level) return { kind: 'up', title: t('Niveau supérieur !'), detail: where(next) };
    if (next < level) return { kind: 'down', title: t('On simplifie un peu'), detail: where(next) };
    if (level + 1 === levels && accuracy >= MASTERY) return { kind: 'mastered', title: t('Phrase maîtrisée !'), detail: where(level) };
    if (accuracy >= 1) return { kind: 'perfect', title: t('Phrase parfaite !'), detail: where(level) };
    return { kind: 'phrase', title: `${name} · ${pct} %`, detail: t('niveau {level}/{levels}', { level: level + 1, levels }) };
  }
}
