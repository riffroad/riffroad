"""Chord charts: the song's chords recognised beat by beat from its guitar's notes, strummed on
the beats in the shapes a beginner learns first (C, G, D, Am, E5…). Each level asks a little
more, as Rocksmith+ does with its chord charts: the root, the power chord on it, the chord on
its highest four strings (F without its barre), then the whole chord.

A whole note-by-note chart from a mixed recording is right for under half of its notes; the
chords played on each beat are right for about four beats in five (major, minor or power chord
on the right root, measured beat by beat against hand-written rhythm charts)."""

from __future__ import annotations

from collections.abc import Callable

import numpy as np

from .builder import MAX_DIFFICULTY, BeatGrid, build_chart
from .chart import Chart
from .fingering import Fingered, Note, Tuning
from .transcription import RawNote

QUALITIES = ("maj", "min", "5")
INTERVALS = {"maj": (0, 4, 7), "min": (0, 3, 7), "5": (0, 7)}
# Price of a chord change against the per-beat match (a cosine, 0 to 1): a passing note does not
# change the chord, a new chord held for a beat or two does.
CHANGE = 0.2
# A beat with less guitar than this share of the song's usual beat is a rest.
QUIET = 0.15
# A strum's notes last this share of the beat (no sustain trail: the next strum follows).
STRUM = 0.25
# A chord whose root margin (`root_margins`) is below this is strummed muted: the beat's own
# notes point to another chord, which the song's flow overruled. Measured on 97 hand-charted
# songs, such beats are wrong half the time; muted (8 % of the beats), wrong chords go from 19.5
# to 15.4 % of the beats, right ones from 80.5 to 76.8 %.
DOUBT = 0.0

# Shapes as intervals above the root, per string from the low E (None: not played), in
# standard tuning, from the string the root is on. Open shapes only where they are open.
OPEN_SHAPES: dict[str, list[tuple[int | None, ...]]] = {
    "maj": [
        (0, 7, 12, 16, 19, 24),  # E
        (None, 0, 7, 12, 16, 19),  # A
        (None, None, 0, 7, 12, 16),  # D
        (None, 0, 4, 7, 12, 16),  # C
        (0, 4, 7, 12, 16, 24),  # G
    ],
    "min": [
        (0, 7, 12, 15, 19, 24),  # Em
        (None, 0, 7, 12, 15, 19),  # Am
        (None, None, 0, 7, 12, 15),  # Dm
    ],
    "5": [
        (0, 7, 12, None, None, None),  # E5
        (None, 0, 7, 12, None, None),  # A5
        (None, None, 0, 7, 12, None),  # D5
    ],
}
# Moveable shapes: the barre chords on the low E and the A string, power chords.
BARRE_SHAPES: dict[str, list[tuple[int | None, ...]]] = {
    "maj": [(0, 7, 12, 16, 19, 24), (None, 0, 7, 12, 16, 19)],
    "min": [(0, 7, 12, 15, 19, 24), (None, 0, 7, 12, 15, 19)],
    "5": [(0, 7, 12, None, None, None), (None, 0, 7, 12, None, None)],
}
# Strings of the smaller chord (`ladder`): the highest of the whole shape.
SMALL = 4
# Highest fret of an open shape; a barre is harder than any open shape, more so up the neck.
OPEN_TOP = 3
BARRE_COST = 2.0
FRET_COST = 0.1


def pitch_classes(notes: list[RawNote], beats: list[float]) -> np.ndarray:
    """(beats - 1, 12): how much of each pitch class sounds in each beat (time × loudness)."""
    out = np.zeros((max(len(beats) - 1, 0), 12))
    if len(beats) < 2:
        return out
    edges = np.asarray(beats)
    for n in notes:
        first = max(int(np.searchsorted(edges, n.start, side="right")) - 1, 0)
        for i in range(first, len(edges) - 1):
            a, b = edges[i], edges[i + 1]
            if a >= n.end:
                break
            overlap = min(b, n.end) - max(a, n.start)
            if overlap > 0:
                out[i, n.pitch % 12] += overlap * n.amplitude
    return out


def _templates() -> np.ndarray:
    t = np.zeros((12 * len(QUALITIES), 12))
    for r in range(12):
        for q, quality in enumerate(QUALITIES):
            for i in INTERVALS[quality]:
                t[r * len(QUALITIES) + q, (r + i) % 12] = 1.0
    return t / np.linalg.norm(t, axis=1, keepdims=True)


def _smooth(scores: np.ndarray, change: float) -> list[int]:
    """The best template per beat (Viterbi), every change of template costing `change`."""
    n, k = scores.shape
    best = scores[0].copy()
    back = np.zeros((n, k), dtype=int)
    for t in range(1, n):
        jump = best.max() - change
        back[t] = np.where(best >= jump, np.arange(k), int(best.argmax()))
        best = np.maximum(best, jump) + scores[t]
    path = [int(best.argmax())]
    for t in range(n - 1, 0, -1):
        path.append(int(back[t][path[-1]]))
    return path[::-1]


def recognise(notes: list[RawNote], beats: list[float], change: float = CHANGE, quiet: float = QUIET) -> list[tuple[int, str] | None]:
    """The chord of each beat (between `beats[i]` and `beats[i + 1]`) as (root pitch class,
    quality), None for a rest: major, minor and power-chord templates matched to the beat's
    pitch classes, then smoothed over the song."""
    weights = pitch_classes(notes, beats)
    if not len(weights):
        return []
    loud = weights.sum(1)
    usual = float(np.median(loud[loud > 0])) if (loud > 0).any() else 0.0
    unit = weights / (np.linalg.norm(weights, axis=1, keepdims=True) + 1e-9)
    path = _smooth(unit @ _templates().T, change)
    return [None if loud[i] <= quiet * usual else (k // len(QUALITIES), QUALITIES[k % len(QUALITIES)]) for i, k in enumerate(path)]


def root_margins(notes: list[RawNote], beats: list[float], chords: list[tuple[int, str] | None]) -> list[float]:
    """For each beat's chord (`recognise`), how much better its template matches the beat's own
    notes than the best template on another root (cosines, -1 to 1); 0 for a rest."""
    weights = pitch_classes(notes, beats)
    scores = (weights / (np.linalg.norm(weights, axis=1, keepdims=True) + 1e-9)) @ _templates().T
    out = []
    for s, chord in zip(scores, chords):
        if chord is None:
            out.append(0.0)
            continue
        root, quality = chord
        own = s[root * len(QUALITIES) + QUALITIES.index(quality)]
        out.append(float(own - max(v for k, v in enumerate(s) if k // len(QUALITIES) != root)))
    return out


def _place(intervals: tuple[int | None, ...], root: int, tuning: Tuning, lowest: int) -> tuple[int, ...] | None:
    """Frets of `intervals` with the root pitch class `root` at fret `lowest` or above on its
    string (the shape's first played string), in `tuning` above its capo; None off the neck."""
    strings = [p + tuning.capo for p in tuning.strings]
    if len(strings) != len(intervals):
        return None
    s0 = next(s for s, i in enumerate(intervals) if i is not None)
    fret = (root - strings[s0]) % 12
    while fret < lowest:
        fret += 12
    bass = strings[s0] + fret
    frets = [None if i is None else bass + i - strings[s] for s, i in enumerate(intervals)]
    played = [f for f in frets if f is not None]
    if min(played) < 0 or max(played) + tuning.capo > tuning.frets:
        return None
    return tuple(-1 if f is None else f + tuning.capo for f in frets)


def shape(root: int, quality: str, tuning: Tuning = Tuning()) -> tuple[int, ...]:
    """The shape a beginner plays for the chord (fret per string, low string first, -1 not
    played): the open chord where there is one, else the lowest barre or power chord."""
    best: tuple[float, tuple[int, ...]] | None = None
    open_fret = tuning.capo
    for intervals in OPEN_SHAPES[quality]:
        frets = _place(intervals, root, tuning, 0)
        if frets is None:
            continue
        played = [f for f in frets if f >= 0]
        if open_fret in played and max(played) - open_fret <= OPEN_TOP:
            cost = sum(1 for f in played if f > open_fret) * 0.01
            if best is None or cost < best[0]:
                best = (cost, frets)
    if best is not None:
        return best[1]
    for intervals in BARRE_SHAPES[quality]:
        frets = _place(intervals, root, tuning, 1)
        if frets is None:
            continue
        played = [f for f in frets if f > open_fret]
        if not played or max(played) - min(played) > 3:
            continue
        cost = BARRE_COST * (quality != "5") + FRET_COST * min(played)
        if best is None or cost < best[0]:
            best = (cost, frets)
    if best is None:
        raise ValueError(f"no shape for {root} {quality} in {tuning.name}")
    return best[1]


def _strum(t: float, length: float, frets: tuple[int, ...], tuning: Tuning, muted: bool = False) -> Fingered:
    """The notes of `frets` (low string first, -1 not played) struck at `t`, or muted by the
    fretting hand (a strum that sounds no chord)."""
    played = sorted(((tuning.strings[s] + f, s, f) for s, f in enumerate(frets) if f >= 0))
    fretted = [f for f in frets if f > tuning.capo]
    techniques = [{"mute": True} for _ in played] if muted else None
    return Fingered(
        t, [Note(t, p, length) for p, _, _ in played], [(s, f) for _, s, f in played], min(fretted) if fretted else tuning.capo + 1, techniques
    )


def ladder(root: int, quality: str, tuning: Tuning = Tuning()) -> list[tuple[int, tuple[int, ...]]]:
    """The chord's forms from the easiest level up, as (highest level, frets): its root on its
    own (levels 0-1), the power chord on it (2), its highest four strings (3), the whole shape.
    A form that is the same as the next one is left to it (a power chord is all of them)."""
    full = shape(root, quality, tuning)
    power = shape(root, "5", tuning)
    played = [s for s, f in enumerate(full) if f >= 0]
    small = tuple(f if s in played[-SMALL:] else -1 for s, f in enumerate(full))
    bass = next(s for s, f in enumerate(power) if f >= 0)
    alone = tuple(f if s == bass else -1 for s, f in enumerate(power))
    forms = [(1, alone), (2, power), (3, small), (MAX_DIFFICULTY, full)]
    return [form for k, form in enumerate(forms) if k + 1 == len(forms) or forms[k + 1][1] != form[1]]


def strums(chords: list[tuple[int, str] | None], beats: list[float], tuning: Tuning = Tuning(), muted: list[bool] | None = None) -> list[Fingered]:
    """A strum of each beat's chord on the beat, fingered as `shape` says, with its easier forms
    (`ladder`) for the easy levels; muted on the beats `muted` says."""
    out = []
    for i, chord in enumerate(chords):
        if chord is None:
            continue
        t, length = beats[i], (beats[i + 1] - beats[i]) * STRUM
        mute = bool(muted and muted[i])
        forms = [(top, _strum(t, length, frets, tuning, mute)) for top, frets in ladder(*chord, tuning)]
        whole = forms[-1][1]
        whole.ladder = forms
        out.append(whole)
    return out


def build_chord_chart(
    notes: list[RawNote],
    grid: BeatGrid,
    *,
    title: str,
    artist: str,
    duration: float,
    tuning: Tuning = Tuning(),
    source_kind: str = "audio",
    source_file: str = "",
    phrase_features: Callable[[float, float], np.ndarray] | None = None,
) -> Chart:
    """The "Chords" arrangement of a recording, from the notes heard on its guitar stem."""
    beats = [t for t in grid.beats if t <= duration]
    chords = recognise(notes, beats)
    tab = strums(chords, beats, tuning, [m < DOUBT for m in root_margins(notes, beats, chords)])
    return build_chart(
        None,
        grid,
        title=title,
        artist=artist,
        duration=duration,
        tuning=tuning,
        source_kind=source_kind,
        source_file=source_file,
        arrangement_name="Chords",
        tab=tab,
        phrase_features=phrase_features,
    )
