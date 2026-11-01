"""Biomechanical fingering solver: notes (time, pitch) → playable (string, fret) tablature.

Viterbi over hand states. A state is a placement of a slice's notes (one onset: a single note or
a chord) on distinct strings, plus the fret under the index finger — the *anchor*, which is
also what the game uses to move the camera and highlight frets. The costs model what makes a
part hard to play:

* moving the hand, proportionally to the hand speed it requires (frets / time available), with
  a fixed cost per position shift and a steep extra cost beyond four frets — no 12-fret jumps
  between sixteenth notes;
* stretching beyond the four-fret box of one finger per fret;
* fretting instead of letting open strings ring, playing high on the neck;
* unidiomatic chord voicings (strings out of pitch order, muted strings inside a strum) and
  chords needing more than four fingers; changing string set between consecutive chords
  (parallel shapes such as power chords or fourths keep their strings);
* in lines: skipping strings, crossing back to a lower string while the melody rises (or the
  reverse), grabbing open strings while the hand plays up the neck.
"""

from __future__ import annotations

import itertools
from dataclasses import dataclass, field
from functools import lru_cache

import numpy as np

STANDARD = (40, 45, 50, 55, 59, 64)
NUM_FINGERS = 4


@dataclass(frozen=True)
class Tuning:
    """Open-string MIDI pitches, low string first (string 0 = low E)."""

    strings: tuple[int, ...] = STANDARD
    name: str = "E Standard"
    capo: int = 0
    frets: int = 24
    # The recording's pitch against A440, in cents: tune the guitar
    # this much up to play along.
    cents: float = 0.0

    def positions(self, pitch: int) -> tuple[tuple[int, int], ...]:
        """Every (string, fret) producing `pitch`, from the highest string down."""
        out = []
        for s in reversed(range(len(self.strings))):
            fret = pitch - self.strings[s]
            if self.capo <= fret <= self.frets:
                out.append((s, fret))
        return tuple(out)

    def is_open(self, fret: int) -> bool:
        return fret == self.capo

    def playable(self, pitch: int) -> bool:
        return bool(self.positions(pitch))

    def pitch(self, string: int, fret: int) -> int:
        return self.strings[string] + fret


@dataclass(frozen=True)
class Note:
    time: float
    pitch: int
    duration: float = 0.0
    velocity: float = 1.0


@dataclass(frozen=True)
class Weights:
    """Cost model. Hand speed is measured in frets per `tempo` seconds."""

    move: float = 1.0
    shift: float = 1.5
    tempo: float = 0.15
    jump: float = 0.5
    stretch: float = 2.0
    # Chords: open shapes near the nut are the easy ones.
    fretted: float = 0.3
    height: float = 0.04
    # Single-note lines: lead players fret their notes (vibrato, bends, muting) once up the neck
    # and sit in a position around the middle of the neck rather than at the nut. Fitted on
    # GuitarSet players 00-02, validated on players 03-05 (see `benchmark.py`).
    open_single: float = 0.6
    single_center: float = 5.0
    single_center_weight: float = 2.0
    # With no context at all, an open string is the easiest way to play its pitch.
    fretted_single: float = 0.05
    skip: float = 0.15
    contrary: float = 0.5
    open_high: float = 0.4
    open_position: int = 4
    crossing: float = 1.5
    gap: float = 0.8
    reshape: float = 0.8
    max_span: int = 5


@dataclass
class Fingered:
    """One slice of the solved tablature: notes sorted by pitch and where they are played.

    `techniques` (optional, parallel to `placements`) carries playing techniques from tabs.
    `ladder` (optional) gives a chord its simpler forms for the easy levels, as (highest level,
    slice), easiest first, the slice itself last; without it the chart builder makes them.
    """

    time: float
    notes: list[Note]
    placements: list[tuple[int, int]]
    anchor: int
    techniques: list[dict] | None = None
    ladder: list[tuple[int, Fingered]] | None = None

    @property
    def is_chord(self) -> bool:
        return len(self.notes) > 1


@dataclass(frozen=True)
class _State:
    placements: tuple[tuple[int, int], ...]
    anchor: int
    cost: float
    string: int  # string of a single note, -1 for chords
    pitch: int  # pitch of a single note, -1 for chords
    mask: int  # strings used, one bit each


def group_slices(notes: list[Note], window: float = 0.035, max_notes: int = 6) -> list[list[Note]]:
    """Groups notes whose onsets fall within `window` of the first one into a slice (chord).

    Duplicate pitches merge (longest, loudest wins); slices keep at most `max_notes` notes,
    dropping the quietest.
    """
    slices: list[list[Note]] = []
    for n in sorted(notes, key=lambda n: (n.time, n.pitch)):
        if slices and n.time - slices[-1][0].time <= window:
            slices[-1].append(n)
        else:
            slices.append([n])
    out = []
    for sl in slices:
        by_pitch: dict[int, Note] = {}
        for n in sl:
            o = by_pitch.get(n.pitch)
            if o is None:
                by_pitch[n.pitch] = n
            else:
                by_pitch[n.pitch] = Note(o.time, n.pitch, max(o.duration, n.duration), max(o.velocity, n.velocity))
        kept = sorted(by_pitch.values(), key=lambda n: -n.velocity)[:max_notes]
        out.append(sorted(kept, key=lambda n: n.pitch))
    return out


def _fingers_needed(frets: list[int]) -> int:
    """Fingers for the fretted notes: one per note above the lowest fret, one (barre) for it."""
    if not frets:
        return 0
    lo = min(frets)
    return sum(1 for f in frets if f != lo) + 1


# What makes a way of fingering a chord shape unnatural, and how much: weighted to agree with
# the fingers guitarists write in tabs, the hand placed as `infer_anchors` places it. They
# agree on 79 % of the chords played, on shapes the weights were not set on (guitarists agree
# among themselves on 90 %; one finger per fret from that hand, as before: 44 %).
_HAND_COSTS = {
    "deviation": 0.76,  # each finger away from one finger per fret from the index
    "shift": 1.54,  # the index below the lowest fretted note
    "open_first": -2.12,  # first position in a chord with open strings
    "first_pos": -0.71,  # first position, every note within the first four frets
    "index_barre2": 0.49,  # the index across two strings
    "index_barre3": -3.61,  # ... across three or more
    "other_barre2": 9.25,  # another finger across two strings
    "other_barre3": 9.88,  # ... across three or more (the A-shape's ring finger)
    "barre_below_open": 7.79,  # a barre under an open string that must ring above it
    "pinky": 3.93,
    "fingers": 1.77,  # fingers used
    "no_index": -0.24,  # the index left free (the rest of a barre shape)
    "same_fret": -0.42,  # two fingers side by side on one fret
    "stretch": 11.14,  # frets between two fingers beyond one per finger
    "off_hand": 1.65,  # the index away from where the hand is
    "gap_barre": 2.20,  # a barre with a string between fretted by another finger
    "other_barre2_open": -0.99,  # another finger across two strings, open strings ringing
}


@lru_cache(maxsize=8192)
def chord_fingers(frets: tuple[int, ...], hand: int = 0) -> tuple[int, ...]:
    """Fingers for a chord shape (fret per string, low string first; 0 open, -1 not played):
    0 open, -1 not played, 1 index to 4 little finger. Every way of putting four fingers on the
    fretted notes that a hand can make (a finger on several strings only on one fret, as a barre
    over strings it can press; fingers in fret order; a stretch of at most one fret more than one
    finger per fret) is weighed by what makes it unnatural, the index placed anywhere from three
    frets below the lowest note to on it; `hand`: the fret the index is at around the chord (0:
    unknown)."""
    notes = [(s, f) for s, f in enumerate(frets) if f > 0]
    out = [0 if f == 0 else -1 for f in frets]
    if not notes:
        return tuple(out)
    lo = min(f for _, f in notes)
    hi = max(f for _, f in notes)
    open_played = any(f == 0 for f in frets)
    best: tuple[float, tuple[int, ...]] | None = None
    for fingers in itertools.product(range(1, NUM_FINGERS + 1), repeat=len(notes)):
        by: dict[int, list[tuple[int, int]]] = {}
        for note, k in zip(notes, fingers):
            by.setdefault(k, []).append(note)
        if not _hand_can(by, frets):
            continue
        used = sorted(by)
        fret_of = {k: by[k][0][1] for k in used}
        barres = [(k, v) for k, v in by.items() if len(v) > 1]
        shape = {
            "index_barre2": sum(1 for k, v in barres if k == 1 and len(v) == 2),
            "index_barre3": sum(1 for k, v in barres if k == 1 and len(v) > 2),
            "other_barre2": sum(1 for k, v in barres if k != 1 and len(v) == 2),
            "other_barre3": sum(1 for k, v in barres if k != 1 and len(v) > 2),
            "barre_below_open": sum(1 for _, v in barres if any(frets[t] == 0 for t in range(max(s for s, _ in v) + 1, len(frets)))),
            "pinky": len(by.get(4, [])),
            "fingers": len(by),
            "no_index": 0 if 1 in by else 1,
            "same_fret": sum(1 for i, a in enumerate(used) for b in used[i + 1 :] if fret_of[a] == fret_of[b]),
            "stretch": sum(max(0, (fret_of[b] - fret_of[a]) - (b - a)) for a, b in zip(used, used[1:])),
            "gap_barre": sum(1 for _, v in barres if max(s for s, _ in v) - min(s for s, _ in v) + 1 > len(v)),
            "other_barre2_open": sum(1 for k, v in barres if k != 1 and len(v) == 2 and open_played),
        }
        for index in range(max(1, lo - 3), lo + 1):
            costs = {
                **shape,
                "deviation": sum(abs(k - (f - index + 1)) for (_, f), k in zip(notes, fingers)),
                "shift": lo - index,
                "open_first": 1 if open_played and index == 1 else 0,
                "first_pos": 1 if index == 1 and hi <= 4 else 0,
                "off_hand": abs(index - hand) if hand > 0 else 0,
            }
            cost = sum(_HAND_COSTS[name] * v for name, v in costs.items())
            if best is None or cost < best[0] - 1e-9:
                best = (cost, fingers)
    if best is None:
        # Wider than a hand: one finger per fret from the lowest, the little finger beyond.
        return tuple(min(max(f - lo + 1, 1), NUM_FINGERS) if f > 0 else o for f, o in zip(frets, out))
    for (s, _), k in zip(notes, best[1]):
        out[s] = k
    return tuple(out)


def _hand_can(by: dict[int, list[tuple[int, int]]], frets: tuple[int, ...]) -> bool:
    """Whether a hand can put each finger on its notes (`by`: notes of each finger)."""
    for notes in by.values():
        if len({f for _, f in notes}) > 1:
            return False
        if len(notes) > 1:
            # A barre presses every string it lies across: none ringing open, none fretted lower.
            fret = notes[0][1]
            a, b = min(s for s, _ in notes), max(s for s, _ in notes)
            if any(frets[s] == 0 or 0 < frets[s] < fret for s in range(a + 1, b)):
                return False
    used = sorted(by)
    for i, a in enumerate(used):
        for b in used[i + 1 :]:
            fa, fb = by[a][0][1], by[b][0][1]
            if fa > fb or fb - fa > (b - a) + 1:
                return False
            # Two fingers on one fret: the lower string takes the lower finger.
            if fa == fb and max(s for s, _ in by[a]) > min(s for s, _ in by[b]):
                return False
    return True


@lru_cache(maxsize=4096)
def _placements(pitches: tuple[int, ...], tuning: Tuning, max_span: int) -> tuple[tuple[tuple[int, int], ...], ...]:
    """All assignments of `pitches` (ascending) to distinct strings within the stretch limit."""
    per_note = [tuning.positions(p) for p in pitches]
    out: list[tuple[tuple[int, int], ...]] = []

    def dfs(i: int, used: int, chosen: list[tuple[int, int]], lo: int, hi: int) -> None:
        if i == len(pitches):
            fretted = [f for _, f in chosen if not tuning.is_open(f)]
            if _fingers_needed(fretted) <= NUM_FINGERS:
                out.append(tuple(chosen))
            return
        for s, f in per_note[i]:
            if used >> s & 1:
                continue
            nlo, nhi = lo, hi
            if not tuning.is_open(f):
                nlo, nhi = min(lo, f), max(hi, f)
                if nhi - nlo > max_span:
                    continue
            chosen.append((s, f))
            dfs(i + 1, used | 1 << s, chosen, nlo, nhi)
            chosen.pop()

    dfs(0, 0, [], 10_000, -10_000)
    return tuple(out)


class FingeringSolver:
    def __init__(self, tuning: Tuning = Tuning(), weights: Weights = Weights()):
        self.tuning = tuning
        self.w = weights
        self._free_anchors = tuple(range(tuning.capo + 1, tuning.frets - 2))

    def _states(self, notes: list[Note]) -> list[_State]:
        w, t = self.w, self.tuning
        pitches = tuple(n.pitch for n in notes)
        states = []
        for placement in _placements(pitches, t, w.max_span):
            fretted = [f for _, f in placement if not t.is_open(f)]
            cost = w.fretted * len(fretted) if len(placement) > 1 else w.fretted_single * len(fretted)
            if len(placement) > 1:
                strings = [s for s, _ in placement]
                inversions = sum(1 for i in range(len(strings)) for j in range(i + 1, len(strings)) if strings[i] > strings[j])
                gaps = max(strings) - min(strings) + 1 - len(strings)
                cost += w.crossing * inversions + w.gap * gaps
            single = placement[0][0] if len(placement) == 1 else -1
            pitch = pitches[0] if len(placement) == 1 else -1
            mask = sum(1 << s for s, _ in placement)
            opens = len(placement) - len(fretted)

            def state(a: int, extra: float) -> _State:
                # Open strings are free in open position; up the neck they cost (more so in lines).
                per_open = w.open_high + (w.open_single if single >= 0 else 0.0)
                high = per_open * opens if a > w.open_position else 0.0
                if single >= 0 and fretted:
                    high += w.single_center_weight * ((a - w.single_center) / 12.0) ** 2
                return _State(placement, a, cost + extra + high, single, pitch, mask)

            if not fretted:
                states.extend(state(a, 0.0) for a in self._free_anchors)
                continue
            lo, hi = min(fretted), max(fretted)
            if hi - lo <= NUM_FINGERS - 1:
                anchors = range(max(t.capo + 1, hi - NUM_FINGERS + 1), lo + 1)
                stretch = 0
            else:
                anchors = range(lo, lo + 1)
                stretch = hi - lo - (NUM_FINGERS - 1)
            states.extend(state(a, w.stretch * stretch**2 + (w.height * a if len(placement) > 1 else 0.0)) for a in anchors)
        return states

    def _transition(self, prev: list[_State], nxt: list[_State], dt: float) -> np.ndarray:
        w = self.w
        pa = np.array([s.anchor for s in prev], dtype=np.float64)[:, None]
        na = np.array([s.anchor for s in nxt], dtype=np.float64)[None, :]
        speed = w.tempo / max(dt, 0.02)
        d = np.abs(na - pa)
        cost = w.move * d * speed + w.shift * (d > 0) + w.jump * np.maximum(d - 4, 0) ** 2 * speed
        ps = np.array([s.string for s in prev])[:, None]
        ns = np.array([s.string for s in nxt])[None, :]
        single = (ps >= 0) & (ns >= 0)
        skip = np.maximum(np.abs(ns - ps) - 1, 0)
        pp = np.array([s.pitch for s in prev])[:, None]
        npitch = np.array([s.pitch for s in nxt])[None, :]
        contrary = (npitch - pp) * (ns - ps) < 0
        cost += np.where(single, w.skip * skip * min(speed, 3.0) + w.contrary * contrary * min(speed, 2.0), 0.0)
        pm = np.array([s.mask for s in prev])[:, None]
        nm = np.array([s.mask for s in nxt])[None, :]
        chords = (ps < 0) & (ns < 0)
        cost += np.where(chords & (pm != nm), w.reshape, 0.0)
        return cost

    def _playable_subset(self, sl: list[Note]) -> list[Note]:
        """Loudest notes first, each kept only if the chord stays playable."""
        kept: list[Note] = []
        for n in sorted(sl, key=lambda n: -n.velocity):
            if not self.tuning.playable(n.pitch):
                continue
            trial = sorted(kept + [n], key=lambda n: n.pitch)
            if _placements(tuple(m.pitch for m in trial), self.tuning, self.w.max_span):
                kept = trial
        return kept

    def solve(self, notes: list[Note], window: float = 0.035, strict: bool = True) -> list[Fingered]:
        """Fingers `notes`.

        `strict` raises on a pitch the instrument cannot produce or a chord no hand can play;
        otherwise such notes are left out (loudest notes kept first) and listed in
        `self.dropped`, which is what transcriptions need.
        """
        self.dropped: list[Note] = []
        self.path_cost = 0.0
        slices = []
        for sl in group_slices(notes, window):
            playable = self._playable_subset(sl)
            if len(playable) < len(sl):
                if strict:
                    bad = [n.pitch for n in sl if not self.tuning.playable(n.pitch)]
                    what = f"pitch {bad[0]} is outside {self.tuning.name}" if bad else f"chord {[n.pitch for n in sl]} has no playable voicing"
                    raise ValueError(what)
                self.dropped.extend(n for n in sl if n not in playable)
            if playable:
                slices.append(playable)
        if not slices:
            return []
        layers = [self._states(sl) for sl in slices]
        cost = np.array([s.cost for s in layers[0]])
        back: list[np.ndarray] = []
        for k in range(1, len(layers)):
            dt = slices[k][0].time - slices[k - 1][0].time
            total = cost[:, None] + self._transition(layers[k - 1], layers[k], dt)
            best = np.argmin(total, axis=0)
            back.append(best)
            cost = total[best, np.arange(total.shape[1])] + np.array([s.cost for s in layers[k]])
        j = int(np.argmin(cost))
        self.path_cost = float(cost[j])
        path = [j]
        for best in reversed(back):
            j = int(best[j])
            path.append(j)
        path.reverse()
        return [
            Fingered(sl[0].time, sl, list(layers[k][j].placements), layers[k][j].anchor)
            for k, (sl, j) in enumerate(zip(slices, path))
        ]


def infer_anchors(tab: list[Fingered], tuning: Tuning = Tuning()) -> None:
    """Sets the anchor of slices fingered by a human (tabs): the hand stays put while the frets
    fit in its four-fret box, and moves to the lowest fretted note otherwise."""
    current = tuning.capo + 1
    for sl in tab:
        fretted = [f for _, f in sl.placements if not tuning.is_open(f)]
        if fretted:
            lo, hi = min(fretted), max(fretted)
            if hi - lo > NUM_FINGERS - 1:
                current = lo
            else:
                # Smallest move that brings every fretted note into the box.
                current = min(max(current, max(hi - NUM_FINGERS + 1, tuning.capo + 1)), lo)
        sl.anchor = current


@dataclass
class Anchor:
    time: float
    fret: int
    width: int = 4


# A hand position held less than this between two equal ones is absorbed by them (s).
MIN_DWELL = 0.6
# Widest zone (frets) shown to keep the hand still through a short excursion.
MAX_WIDTH = 6


def anchors(tab: list[Fingered], tuning: Tuning = Tuning()) -> list[Anchor]:
    """Hand positions for the game camera, as few as the notes allow.

    A position holds while every fretted note fits in its box (four frets, more for a stretch);
    the next one is chosen to last as long as possible — on a tie, where the fingering put the
    index finger, then nearest the previous position (greedy covering: the fewest moves). A
    position held under `MIN_DWELL` is absorbed by a neighbour widened to cover it, up to
    `MAX_WIDTH` frets. Open strings never move the hand.
    """
    items = []
    for sl in tab:
        fretted = [f for _, f in sl.placements if not tuning.is_open(f)]
        if fretted:
            items.append((sl.time, min(fretted), max(fretted), sl.anchor))
    if not items:
        return [Anchor(tab[0].time, tuning.capo + 1, NUM_FINGERS)] if tab else []
    out: list[tuple[Anchor, int, int]] = []  # with the lowest and highest fret it covers
    i, prev = 0, None
    while i < len(items):
        t, lo, hi, finger = items[i]
        width = max(NUM_FINGERS, hi - lo + 1)
        best = None
        for a in range(max(tuning.capo + 1, hi - width + 1), lo + 1):
            j = i
            while j < len(items) and items[j][1] >= a and items[j][2] <= a + width - 1:
                j += 1
            key = (j, a == finger, -abs(a - prev) if prev is not None else 0)
            if best is None or key > best[0]:
                best = (key, a, j)
        _, a, j = best
        out.append((Anchor(t, a, width), min(it[1] for it in items[i:j]), max(it[2] for it in items[i:j])))
        prev, i = a, j

    def widen(box: Anchor, lo: int, hi: int) -> bool:
        """Stretches `box` over frets lo..hi if it stays within MAX_WIDTH."""
        a, b = min(box.fret, lo), max(box.fret + box.width - 1, hi)
        if b - a + 1 > MAX_WIDTH:
            return False
        box.fret, box.width = a, max(b - a + 1, box.width)
        return True

    merged: list[Anchor] = []
    for k, (cur, lo, hi) in enumerate(out):
        nxt = out[k + 1][0] if k + 1 < len(out) else None
        if nxt is not None and nxt.time - cur.time < MIN_DWELL:
            if merged and widen(merged[-1], lo, hi):
                continue
            if widen(nxt, lo, hi):
                nxt.time = cur.time
                continue
        if merged and merged[-1].fret == cur.fret:
            merged[-1].width = max(merged[-1].width, cur.width)
            continue
        merged.append(cur)
    return merged


def ascii_tab(tab: list[Fingered], tuning: Tuning = Tuning(), names: str = "EADGBe") -> str:
    """Plain-text tablature, one column per slice (for previews and test failures)."""
    rows = [[] for _ in tuning.strings]
    for sl in tab:
        frets = {s: f for s, f in sl.placements}
        width = max(len(str(f)) for f in frets.values())
        for s, row in enumerate(rows):
            cell = str(frets[s]) if s in frets else ""
            row.append(cell.rjust(width, "-"))
    lines = []
    for s in reversed(range(len(rows))):
        label = names[s] if s < len(names) else str(s)
        lines.append(f"{label}|-" + "-".join(rows[s]) + "-|")
    return "\n".join(lines)


@dataclass
class Playability:
    """Summary used by tests and reports."""

    max_fret_jump: int = 0
    max_anchor_jump_fast: int = 0
    shifts: int = 0
    max_stretch: int = 0
    positions: list[int] = field(default_factory=list)


def playability(tab: list[Fingered], tuning: Tuning = Tuning(), fast: float = 0.2) -> Playability:
    """Largest fret/anchor jumps between slices closer than `fast` seconds, shifts, stretch."""
    p = Playability()
    prev = None
    for sl in tab:
        fretted = [f for _, f in sl.placements if not tuning.is_open(f)]
        if fretted:
            p.max_stretch = max(p.max_stretch, max(fretted) - min(fretted))
            if prev is not None:
                prev_frets, prev_anchor, prev_time = prev
                fast_enough = sl.time - prev_time < fast
                if fast_enough:
                    jump = max(abs(f - g) for f in fretted for g in prev_frets)
                    p.max_fret_jump = max(p.max_fret_jump, jump)
                    p.max_anchor_jump_fast = max(p.max_anchor_jump_fast, abs(sl.anchor - prev_anchor))
                if sl.anchor != prev_anchor:
                    p.shifts += 1
            prev = (fretted, sl.anchor, sl.time)
            if sl.anchor not in p.positions:
                p.positions.append(sl.anchor)
    return p
