/**
 * The backing band of the learning path's exercises: drums and a bass laid on the exercise's
 * beats, which the engine synthesizes as the lesson's backing track (engine-rt/session/src/band.rs).
 * Made here from the steps: the bass follows the chords played, else the roots the exercise gives
 * per bar.
 */
import { CHORDS, isChord, LEAD, type Lesson } from './lessons';

export type Drum = 'kick' | 'snare' | 'hat';

/** What the band plays: drum hits (song time, drum) and bass notes (song time, MIDI, seconds). */
export interface Backing {
  drums: [number, Drum][];
  bass: [number, number, number][];
}

/** `pulse`: a slow, light beat for the first steps; `rock`: straight eighths, kick and snare;
 * `ballad`: half time, room for open chords; `shuffle`: swung eighths, a blues. */
export type BackingStyle = 'pulse' | 'rock' | 'ballad' | 'shuffle';

const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'];

/** Pitch class of the root of a chord or note named `name` (E5, Am, G, F#m…); E when unknown. */
export function rootOf(name: string): number {
  const k = [...NAMES.keys()].sort((a, b) => NAMES[b].length - NAMES[a].length).find((i) => name.startsWith(NAMES[i]));
  return k ?? 4;
}

/** The bass's note for pitch class `pc`: from E1 (MIDI 28) to D#2, under the guitar. */
const bassNote = (pc: number): number => 28 + ((pc - 4 + 12) % 12);

/**
 * The backing for `lesson` at `pace` times its tempo (the chart's own timing: `lessonChart`), in
 * `style`, from its first step to the end of the bar where its last one rings. The bass plays the
 * root of the chord strummed last, else `roots[bar]` (names, one per bar of four beats), else E.
 */
export function backingFor(lesson: Lesson, pace: number, style: BackingStyle, roots: readonly string[] = []): Backing {
  const spb = 60 / (lesson.bpm * pace);
  const at = (beat: number) => (LEAD + beat) * spb;
  const steps = [...lesson.steps].sort((a, b) => a.beat - b.beat);
  const last = steps.reduce((m, s) => Math.max(m, s.beat + (s.hold ?? 1)), 0);
  const bars = Math.max(1, Math.ceil(last / 4));
  const drums: [number, Drum][] = [];
  const bass: [number, number, number][] = [];
  let chord: number | null = null;
  let next = 0;
  for (let beat = 0; beat < bars * 4; beat += 0.5) {
    while (next < steps.length && steps[next].beat <= beat + 1e-6) {
      const s = steps[next++];
      if (isChord(s) && CHORDS[s.chord]) chord = rootOf(s.chord);
    }
    const bar = Math.floor(beat / 4);
    const pos = beat - bar * 4;
    const root = chord ?? (roots[bar] !== undefined ? rootOf(roots[bar]) : 4);
    const t = at(beat);
    if (style === 'pulse') {
      if (pos % 1 !== 0) continue;
      drums.push([t, 'hat']);
      if (pos === 0) drums.push([t, 'kick']);
      if (pos === 2) drums.push([t, 'snare']);
      if (pos === 0 || pos === 2) bass.push([t, bassNote(root), 1.8 * spb]);
    } else if (style === 'ballad') {
      if (pos % 1 === 0) drums.push([t, 'hat']);
      if (pos === 0 || pos === 2.5) drums.push([t, 'kick']);
      if (pos === 2) drums.push([t, 'snare']);
      if (pos === 0 || pos === 2) bass.push([t, bassNote(root), 1.8 * spb]);
    } else if (style === 'shuffle') {
      // The off-beat eighth swung to the last third of the beat.
      const swung = pos % 1 === 0 ? t : at(beat + 1 / 6);
      drums.push([swung, 'hat']);
      if (pos === 0 || pos === 2) drums.push([t, 'kick']);
      if (pos === 1 || pos === 3) drums.push([t, 'snare']);
      // Root and fifth, a walking blues bass.
      bass.push([swung, bassNote(root) + (pos % 2 >= 1 ? 7 : 0), (pos % 1 === 0 ? 0.6 : 0.3) * spb]);
    } else {
      drums.push([t, 'hat']);
      if (pos === 0 || pos === 2 || pos === 2.5) drums.push([t, 'kick']);
      if (pos === 1 || pos === 3) drums.push([t, 'snare']);
      bass.push([t, bassNote(root), 0.45 * spb]);
    }
  }
  return { drums, bass };
}
