"""Transcribed notes → playable chart.

Grid quantization, fingering (Viterbi), chord shapes with names and fingers, phrases named by
their content, sections, anchors, hand shapes — and difficulty levels:

    level 0  first beat of each bar, phrase entries; chords reduced to their bass note
    level 1  + half-bar beats
    level 2  + every beat; big chords as two-string power shapes
    level 3  + eighth notes; full chords
    level 4  everything (sixteenths, triplets)

A slice may bring its own simpler forms (`Fingered.ladder`): the chord charts of an MP3 go
from the root to the power chord, a smaller chord, then the whole one.

Every phrase gets at least one event at level 0, so a beginner always has something to play.
"""

from __future__ import annotations

import bisect
from collections.abc import Callable
from dataclasses import dataclass

import numpy as np

from .chart import AnchorEvent, Beat, Chart, ChartChord, ChartNote, ChordTemplate, HandShape, Phrase, Span
from .consensus import consensus as vote_repeats
from .consensus import unify_fingering
from .fingering import Fingered, FingeringSolver, Note, Tuning, Weights
from .fingering import anchors as hand_anchors
from .fingering import chord_fingers
from .harmony import chord_core, chord_name

MAX_DIFFICULTY = 4
SNAP = 0.035
PHRASE_BARS = 4
PHRASE_SIMILARITY = 0.6
# Cosine similarity of audio features above which two phrases are the same phrase.
PHRASE_AUDIO_SIMILARITY = 0.94
SECTION_PHRASES = 4


@dataclass
class BeatGrid:
    """Beat times with the indices of the beats that start a bar."""

    beats: list[float]
    bars: list[int]
    beats_per_bar: int = 4

    @classmethod
    def regular(cls, bpm: float, duration: float, start: float = 0.0, beats_per_bar: int = 4) -> BeatGrid:
        period = 60.0 / bpm
        n = int((duration - start) / period) + 2
        return cls([start + k * period for k in range(n)], list(range(0, n, beats_per_bar)), beats_per_bar)

    @classmethod
    def from_downbeats(cls, beats: list[float], downbeats: list[float], beats_per_bar: int = 4) -> BeatGrid:
        arr = np.asarray(beats)
        bars = sorted({int(np.argmin(np.abs(arr - d))) for d in downbeats})
        return cls(list(beats), bars or [0], beats_per_bar)

    @property
    def bpm(self) -> float:
        if len(self.beats) < 2:
            return 120.0
        return 60.0 / float(np.median(np.diff(self.beats)))

    def period_at(self, t: float) -> float:
        i = min(max(bisect.bisect_right(self.beats, t) - 1, 0), len(self.beats) - 2)
        return self.beats[i + 1] - self.beats[i] if len(self.beats) > 1 else 0.5

    def _subdivisions(self) -> np.ndarray:
        if not hasattr(self, "_grid"):
            pts = [self.beats[-1]] if self.beats else []
            for a, b in zip(self.beats, self.beats[1:]):
                d = b - a
                pts += [a + k * d / 4 for k in range(4)] + [a + d / 3, a + 2 * d / 3]
            self._grid = np.unique(np.array(pts))
        return self._grid

    def quantize(self, t: float, tol: float = SNAP) -> float:
        grid = self._subdivisions()
        if len(grid) == 0 or t < grid[0] - tol or t > grid[-1] + tol:
            return t
        j = int(np.argmin(np.abs(grid - t)))
        return float(grid[j]) if abs(grid[j] - t) <= tol else t

    def metric_level(self, t: float) -> int:
        """0 = bar start, 1 = half-bar beat, 2 = beat, 3 = eighth, 4 = anything finer."""
        if len(self.beats) < 2 or t < self.beats[0] - 0.01:
            return 4
        i = min(bisect.bisect_right(self.beats, t + 1e-6) - 1, len(self.beats) - 2)
        frac = (t - self.beats[i]) / (self.beats[i + 1] - self.beats[i])
        if frac > 0.94:
            i, frac = i + 1, 0.0
        if frac < 0.06:
            j = bisect.bisect_right(self.bars, i) - 1
            pos = (i - self.bars[j]) % self.beats_per_bar if j >= 0 else i % self.beats_per_bar
            if pos == 0:
                return 0
            if self.beats_per_bar % 2 == 0 and pos == self.beats_per_bar // 2:
                return 1
            return 2
        if abs(frac - 0.5) < 0.06:
            return 3
        return 4

    def bar_times(self) -> list[float]:
        return [self.beats[i] for i in self.bars]

    def position(self, t: float) -> float:
        """Fractional beat index of time `t` (the edge tempo beyond the beats)."""
        b = self.beats
        if len(b) < 2:
            return t / 0.5
        if t <= b[0]:
            return (t - b[0]) / (b[1] - b[0])
        if t >= b[-1]:
            return len(b) - 1 + (t - b[-1]) / (b[-1] - b[-2])
        return float(np.interp(t, b, np.arange(len(b))))

    def time_at(self, position: float) -> float:
        """Inverse of `position`."""
        b = self.beats
        if len(b) < 2:
            return position * 0.5
        if position <= 0:
            return b[0] + position * (b[1] - b[0])
        if position >= len(b) - 1:
            return b[-1] + (position - len(b) + 1) * (b[-1] - b[-2])
        return float(np.interp(position, np.arange(len(b)), b))


def _template_for(sl: Fingered, keep: list[int], tuning: Tuning) -> tuple[tuple[int, ...], tuple[int, ...], str]:
    """Frets/fingers/name of the shape made of the slice's notes at indices `keep`: the fingers
    as a guitarist would put them, with the index where the hand is (above a capo, as from the nut)."""
    frets = [-1] * len(tuning.strings)
    for k in keep:
        s, f = sl.placements[k]
        frets[s] = f
    above = tuple(-1 if f < 0 else 0 if tuning.is_open(f) else f - tuning.capo for f in frets)
    fingers = chord_fingers(above, max(0, sl.anchor - tuning.capo))
    name = chord_name([sl.notes[k].pitch for k in keep])
    return tuple(frets), tuple(fingers), name


def _reductions(sl: Fingered) -> list[tuple[int, Fingered]]:
    """A chord's forms for the easy levels, as (highest level, slice): its bass note, its two
    lowest strings for a chord of four or more, then the whole chord."""
    n = len(sl.notes)
    by_string = sorted(range(n), key=lambda k: sl.placements[k][0])

    def part(keep: list[int]) -> Fingered:
        techs = [sl.techniques[k] for k in keep] if sl.techniques else None
        return Fingered(sl.time, [sl.notes[k] for k in keep], [sl.placements[k] for k in keep], sl.anchor, techs)

    tiers = [(0 if n == 2 else 1, part(by_string[:1]))]
    if n >= 4:
        tiers.append((2, part(by_string[:2])))
    tiers.append((MAX_DIFFICULTY, sl))
    return tiers


def _clean_chords(notes: list[Note]) -> tuple[list[Note], int]:
    """Simultaneous notes reduced to what a guitarist plays (`harmony.chord_core`); returns the
    notes and how many were dropped."""
    out: list[Note] = []
    dropped = 0
    by_time: dict[float, list[Note]] = {}
    for n in notes:
        by_time.setdefault(round(n.time, 4), []).append(n)
    for group in by_time.values():
        keep = chord_core([n.pitch for n in group], [n.velocity for n in group])
        dropped += len(group) - len(keep)
        out += [group[i] for i in keep]
    out.sort(key=lambda n: (n.time, n.pitch))
    return out, dropped


def _nearest(times: list[float], t: float) -> int:
    """Index of the time in sorted `times` closest to `t`."""
    i = bisect.bisect_left(times, t)
    return min((k for k in (i - 1, i) if 0 <= k < len(times)), key=lambda k: abs(times[k] - t))


def _phrase_bounds(grid: BeatGrid, duration: float, sections: list[float] = ()) -> list[tuple[float, float]]:
    """Every PHRASE_BARS bars, covering the whole song. The count starts again on the bar
    nearest each of `sections` (their start times), so no phrase straddles two sections."""
    bar_times = grid.bar_times()
    firsts = {_nearest(bar_times, t) for t in sections} if bar_times else set()
    starts = [0.0]
    since = 0
    for i, t in enumerate(bar_times):
        if i in firsts:
            since = 0
        if since % PHRASE_BARS == 0 and 0.0 < t < duration:
            starts.append(t)
        since += 1
    return list(zip(starts, starts[1:] + [duration]))


def _phrase_names(
    bounds: list[tuple[float, float]],
    events: list[tuple[float, list[int]]],
    grid: BeatGrid,
    phrase_features: Callable[[float, float], np.ndarray] | None,
) -> list[str]:
    """Iterations of the same phrase share a name. With audio features, phrases that sound
    alike; otherwise phrases sharing most of their notes (same pitch on the same sixteenth).
    `events`: (time, pitches) in time order."""
    named: list[tuple[object, str]] = []
    names = []
    for a, b in bounds:
        period = grid.period_at(a)
        signature = {(round((t - a) / period * 4), p) for t, pitches in events if a <= t < b for p in pitches}
        if not signature:
            names.append("rest")
            continue
        if phrase_features is not None:
            v = np.asarray(phrase_features(a, b), dtype=float)
            key: object = v / (np.linalg.norm(v) + 1e-12)
            similarity = [(float(key @ other), nm) for other, nm in named]
            threshold = PHRASE_AUDIO_SIMILARITY
        else:
            key = signature
            similarity = [(len(signature & other) / len(signature | other), nm) for other, nm in named]
            threshold = PHRASE_SIMILARITY
        best = max(similarity, default=(0.0, ""))
        if best[0] >= threshold:
            names.append(best[1])
        else:
            name = chr(ord("A") + len(named)) if len(named) < 26 else f"P{len(named) + 1}"
            named.append((key, name))
            names.append(name)
    return names


def build_chart(
    notes: list[Note] | None,
    grid: BeatGrid,
    *,
    title: str,
    artist: str,
    duration: float,
    tuning: Tuning = Tuning(),
    source_kind: str = "audio",
    source_file: str = "",
    weights: Weights | None = None,
    arrangement_name: str | None = None,
    tab: list[Fingered] | None = None,
    phrase_features: Callable[[float, float], np.ndarray] | None = None,
    consensus: bool = True,
    report: dict | None = None,
    check: Callable[[list[Note]], list[Note]] | None = None,
    sections: list[tuple[float, str]] | None = None,
) -> Chart:
    """Builds a chart from transcribed `notes` (quantized, chords cleaned, repeats voted, then
    fingered by the Viterbi solver) or from a `tab` fingered by a human (Guitar Pro), which is
    kept as is.

    `phrase_features(start, end)` (audio of the guitar, see the pipeline) makes phrases that
    sound alike share a name; without it, phrases are compared by their notes, which is
    reliable for tabs but not for transcriptions of distorted guitars. `report`, if given,
    receives what the cleaning and the vote changed. `check(notes)` holds the notes up to the
    audio once the vote copied notes between repeats (see `transcription.recheck`).
    `sections` (start, name), from a tab's markers, name the song's parts; without them,
    sections group up to SECTION_PHRASES phrases."""
    bounds = _phrase_bounds(grid, duration, [t for t, _ in sections or []])
    if tab is None:
        quantized = []
        for n in notes or []:
            t = grid.quantize(n.time)
            end = grid.quantize(n.time + n.duration)
            quantized.append(Note(t, n.pitch, max(end - t, 0.0), n.velocity))
        quantized, trimmed = _clean_chords(quantized)
        by_time: dict[float, list[int]] = {}
        for n in quantized:
            by_time.setdefault(n.time, []).append(n.pitch)
        names = _phrase_names(bounds, sorted(by_time.items()), grid, phrase_features)
        phrases = [(a, b, name) for (a, b), name in zip(bounds, names)]
        if consensus:
            quantized, vote = vote_repeats(quantized, phrases, grid.position, grid.time_at)
        checked = 0
        if check is not None:
            heard = check(quantized)
            checked, quantized = len(quantized) - len(heard), heard
        solver = FingeringSolver(tuning, weights or Weights())
        tab = solver.solve(quantized, strict=False)
        unified = unify_fingering(tab, phrases, grid.position) if consensus else 0
        if report is not None:
            report.update(chord_notes_dropped=trimmed, unified_slices=unified, notes_dropped_by_audio_check=checked)
            if consensus:
                report.update(repeated_phrases=vote.groups, notes_dropped=vote.dropped, notes_restored=vote.added)
    else:
        names = _phrase_names(bounds, [(sl.time, [n.pitch for n in sl.notes]) for sl in tab], grid, phrase_features)

    # Base level of each slice: metric weight, eased for long notes and phrase entries.
    levels: list[int] = []
    sustains: list[float] = []
    for k, sl in enumerate(tab):
        period = grid.period_at(sl.time)
        held = max(n.duration for n in sl.notes)
        sustains.append(held if held >= 0.5 * period else 0.0)
        lvl = grid.metric_level(sl.time)
        if held >= period:
            lvl = max(lvl - 1, 0)
        if k == 0 or sl.time - tab[k - 1].time >= grid.beats_per_bar * period:
            lvl = 0
        levels.append(lvl)

    starts = [a for a, _ in bounds]
    members: list[list[int]] = [[] for _ in bounds]
    for k, sl in enumerate(tab):
        p = bisect.bisect_right(starts, sl.time) - 1
        members[max(p, 0)].append(k)
    for m in members:
        if m and min(levels[k] for k in m) > 0:
            first = min(m, key=lambda k: (levels[k], tab[k].time))
            levels[first] = 0

    chart = Chart(
        title=title,
        artist=artist,
        duration=duration,
        source_kind=source_kind,
        source_file=source_file,
        tuning=tuning,
        max_difficulty=MAX_DIFFICULTY,
        bpm=grid.bpm,
        time_signature=(grid.beats_per_bar, 4),
    )
    template_ids: dict[tuple, int] = {}

    def template(frets: tuple[int, ...], fingers: tuple[int, ...], name: str) -> int:
        if frets not in template_ids:
            template_ids[frets] = len(chart.templates)
            chart.templates.append(ChordTemplate(name, list(frets), list(fingers)))
        return template_ids[frets]

    full_chords: list[tuple[float, int, float]] = []
    for sl, lvl, sus in zip(tab, levels, sustains):
        techs = sl.techniques or [{} for _ in sl.placements]
        if not sl.is_chord:
            s, f = sl.placements[0]
            chart.notes.append(ChartNote(sl.time, s, f, sus, (lvl, MAX_DIFFICULTY), dict(techs[0])))
            continue
        start = lvl
        for top, part in sl.ladder or _reductions(sl):
            if start > top:
                continue
            span = (start, top)
            start = top + 1
            ptechs = part.techniques or [{} for _ in part.placements]
            if not part.is_chord:
                s, f = part.placements[0]
                chart.notes.append(ChartNote(sl.time, s, f, sus, span, dict(ptechs[0])))
                continue
            shared = {k: v for k, v in ptechs[0].items() if all(t.get(k) == v for t in ptechs)}
            tid = template(*_template_for(part, list(range(len(part.notes))), tuning))
            chart.chords.append(ChartChord(sl.time, tid, sus, span, None, dict(shared)))
            if top == MAX_DIFFICULTY:
                full_chords.append((sl.time, tid, sus))

    # Hand shapes: runs of the same full shape.
    slice_times = [sl.time for sl in tab]
    run: list[tuple[float, int, float]] = []
    for item in full_chords + [(float("inf"), -1, 0.0)]:
        if run and (item[1] != run[-1][1] or item[0] - run[-1][0] > grid.beats_per_bar * grid.period_at(run[-1][0])):
            last_t, tid, sus = run[-1]
            nxt = bisect.bisect_right(slice_times, last_t + 1e-6)
            end = slice_times[nxt] if nxt < len(slice_times) else last_t + max(sus, grid.period_at(last_t))
            end = min(end, last_t + max(sus, grid.period_at(last_t)) * 4)
            chart.hand_shapes.append(HandShape(tid, run[0][0], end))
            run = []
        run.append(item)

    for (a, b), name in zip(bounds, names):
        # The phrase is complete from the level at which its last event appears.
        top = max((e.levels[0] for e in chart.notes + chart.chords if a <= e.time < b), default=0)
        if not any(a <= sl.time < b for sl in tab):
            name = "rest"
        chart.phrases.append(Phrase(name, a, b, top))

    # The tab's parts, from the phrase each starts; what is played before the first is the intro.
    starts = [a for a, _ in bounds]
    named: dict[float, str] = {}
    for t, name in sorted(sections or []):
        if t < duration:
            named[starts[_nearest(starts, t)]] = name
    if named:
        first = min(named)
        if any(sl.time < first for sl in tab):
            named[starts[0]] = "Intro"
        elif first > starts[0]:
            named[starts[0]] = named.pop(first)
        # A marker played again by a repeat goes on with the same part.
        order = sorted(named)
        at = [a for k, a in enumerate(order) if k == 0 or named[a] != named[order[k - 1]]]
        chart.sections = [Span(named[a], a, b) for a, b in zip(at, at[1:] + [duration])]
    else:
        # Sections: up to SECTION_PHRASES phrases, broken at rests.
        group: list[Phrase] = []
        for p in chart.phrases + [None]:
            if group and (p is None or p.name == "rest" or len(group) == SECTION_PHRASES or group[-1].name == "rest"):
                chart.sections.append(Span(f"Section {len(chart.sections) + 1}", group[0].start, group[-1].end))
                group = []
            if p is not None:
                group.append(p)

    chart.beats = [Beat(t, None) for t in grid.beats if t <= duration]
    for number, i in enumerate(grid.bars, start=1):
        if i < len(chart.beats):
            chart.beats[i].bar = number
    chart.anchors = [AnchorEvent(a.time, a.fret, a.width) for a in hand_anchors(tab, tuning)]
    chart.notes.sort(key=lambda n: (n.time, n.string))
    chart.chords.sort(key=lambda c: c.time)
    chord_slices = sum(1 for sl in tab if sl.is_chord)
    chart.arrangement_type = "rhythm" if tab and chord_slices / len(tab) >= 0.4 else "lead"
    chart.arrangement_name = arrangement_name or chart.arrangement_type.capitalize()
    return chart
