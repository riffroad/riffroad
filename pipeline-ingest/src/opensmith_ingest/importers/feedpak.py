"""feedpak → chart: the open song format of the feedBack project (spec 1.x,
https://github.com/got-feedBack/feedpak-spec).

A pack is a folder named `*.feedpak` or the same files zipped: `manifest.yaml` indexes
arrangements written by hand (notes already in time with the pack's audio, strings and frets
chosen by their author) and the audio stems. One fretted arrangement becomes the chart (default:
lead, else combo, rhythm, any other guitar part, bass); the complete mixdown (the `full` stem,
else the stems a pack plays when it opens) becomes the backing track.

Difficulty: a pack that carries a ladder of levels per phrase keeps it as written, each note or
chord getting the range of levels at which it appears (the top level of a phrase extends to the
arrangement's maximum, so a phrase complete at level 3 stays complete above). A pack with a
single level gets the five levels generated for Guitar Pro tabs, its fingering kept as written.

And back: `export_feedpak` writes an imported song's charts and audio as a pack (a chord chart
corrected by its player, for feedBack and anyone else).
"""

from __future__ import annotations

import json
import re
import shutil
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

import numpy as np
import yaml

from .. import audio_io
from ..builder import BeatGrid, build_chart
from ..chart import AnchorEvent, Beat, Chart, ChartChord, ChartNote, ChordTemplate, HandShape, Phrase, Span
from ..fingering import STANDARD, Fingered, Note, Tuning, infer_anchors
from ..progress import Progress, Sink
from ..tunings import name_of

SUPPORTED_MAJOR = 1
BASS = (28, 33, 38, 43)
# Open strings below or above the six of a guitar / four of a bass, for longer `tuning` lists.
GUITAR_LOW = (30, 35)
BASS_LOW, BASS_HIGH = 23, 48
# Arrangements a guitar game plays (`type` absent means a fretted part).
FRETTED = (None, "guitar", "bass")
PREFERRED = ("lead", "combo", "rhythm")
BACKING = "song.wav"
COVER = "cover.jpg"

# Note flag → chart technique.
FLAGS = {
    "ho": "hammerOn",
    "po": "pullOff",
    "vb": "vibrato",
    "pm": "palmMute",
    "mt": "mute",
    "fhm": "mute",
    "hm": "harmonic",
    "hp": "pinchHarmonic",
    "tr": "tremolo",
    "ac": "accent",
    "tp": "tap",
    "ln": "linkNext",
}


class FeedpakError(ValueError):
    pass


def _safe(rel: object) -> str:
    """A manifest path, refused when it could leave the pack (spec §2.2)."""
    if not isinstance(rel, str) or not rel or rel.startswith("/") or "\\" in rel or ":" in rel:
        raise FeedpakError(f"unsafe path in the pack: {rel!r}")
    if any(part in ("", ".", "..") for part in rel.split("/")):
        raise FeedpakError(f"unsafe path in the pack: {rel!r}")
    return rel


def _strip_comments(text: str) -> str:
    """JSONC → JSON: `//` and `/* */` comments removed, strings left alone."""
    out, k, n = [], 0, len(text)
    while k < n:
        c = text[k]
        if c == '"':
            end = k + 1
            while end < n and text[end] != '"':
                end += 2 if text[end] == "\\" else 1
            out.append(text[k : end + 1])
            k = end + 1
        elif text.startswith("//", k):
            k = text.find("\n", k) if "\n" in text[k:] else n
        elif text.startswith("/*", k):
            end = text.find("*/", k + 2)
            k = n if end < 0 else end + 2
        else:
            out.append(c)
            k += 1
    return "".join(out)


class Pack:
    """A feedpak, folder or zip; every file is reached through the manifest."""

    def __init__(self, path: Path):
        self.path = Path(path)
        self._zip: zipfile.ZipFile | None = None
        self._root = ""
        if self.path.is_dir():
            if not (self.path / "manifest.yaml").is_file():
                raise FeedpakError(f"{self.path.name}: no manifest.yaml in this pack")
        elif zipfile.is_zipfile(self.path):
            self._zip = zipfile.ZipFile(self.path)
            names = set(self._zip.namelist())
            if "manifest.yaml" not in names:
                # Zipped with its folder: the manifest one level down.
                inner = [n for n in names if n.count("/") == 1 and n.endswith("/manifest.yaml")]
                if len(inner) != 1:
                    raise FeedpakError(f"{self.path.name}: no manifest.yaml in this pack")
                self._root = inner[0][: -len("manifest.yaml")]
        else:
            raise FeedpakError(f"{self.path.name}: not a feedpak (neither a folder nor a zip archive)")
        self.manifest = self._manifest()

    def read(self, rel: str) -> bytes:
        rel = _safe(rel)
        try:
            if self._zip is not None:
                return self._zip.read(self._root + rel)
            return (self.path / rel).read_bytes()
        except (KeyError, OSError) as e:
            raise FeedpakError(f"{self.path.name}: {rel} is missing from the pack") from e

    def json(self, rel: str) -> dict:
        text = self.read(rel).decode("utf-8-sig")
        try:
            return json.loads(_strip_comments(text) if rel.endswith(".jsonc") else text)
        except json.JSONDecodeError as e:
            raise FeedpakError(f"{self.path.name}: {rel} is not valid JSON ({e})") from e

    def local(self, rel: str, scratch: Path) -> Path:
        """`rel` as a file on disk: the pack's own in a folder, else extracted into `scratch`."""
        if self._zip is None:
            path = self.path / _safe(rel)
            if not path.is_file():
                raise FeedpakError(f"{self.path.name}: {rel} is missing from the pack")
            return path
        dst = scratch / PurePosixPath(rel).name
        dst.write_bytes(self.read(rel))
        return dst

    def _manifest(self) -> dict:
        try:
            doc = yaml.safe_load(self.read("manifest.yaml").decode("utf-8-sig"))
        except yaml.YAMLError as e:
            raise FeedpakError(f"{self.path.name}: manifest.yaml is not valid YAML ({e})") from e
        if not isinstance(doc, dict):
            raise FeedpakError(f"{self.path.name}: manifest.yaml is not a mapping")
        version = str(doc.get("feedpak_version", "1.0.0"))
        major = version.split(".")[0]
        if not major.isdigit() or int(major) > SUPPORTED_MAJOR:
            raise FeedpakError(f"{self.path.name}: feedpak {version} is newer than this converter reads (1.x)")
        missing = [k for k in ("title", "artist", "arrangements", "stems") if not doc.get(k)]
        if missing:
            raise FeedpakError(f"{self.path.name}: manifest.yaml has no {', '.join(missing)}")
        return doc

    def arrangements(self) -> list[dict]:
        """The fretted arrangements with a chart (drum parts and notation-only ones left out)."""
        return [a for a in self.manifest["arrangements"] if isinstance(a, dict) and a.get("file") and a.get("type") in FRETTED]


def _is_bass(entry: dict) -> bool:
    return entry.get("type") == "bass" or "bass" in f"{entry.get('id', '')} {entry.get('name', '')}".lower()


def choose(arrangements: list[dict], wanted: str | None = None) -> dict:
    """The arrangement `wanted` (id or name), else lead, combo, rhythm, any guitar part, bass."""
    if not arrangements:
        raise FeedpakError("no guitar or bass arrangement in this pack")
    if wanted:
        w = wanted.lower()
        found = next((a for a in arrangements if w in (str(a.get("id", "")).lower(), str(a.get("name", "")).lower())), None)
        if found is None:
            names = ", ".join(str(a.get("id")) for a in arrangements)
            raise FeedpakError(f"no arrangement '{wanted}' in this pack (there is: {names})")
        return found
    for word in PREFERRED:
        for a in arrangements:
            if word in f"{a.get('id', '')} {a.get('name', '')}".lower() and not _is_bass(a):
                return a
    return next((a for a in arrangements if not _is_bass(a)), arrangements[0])


def tuning_of(entry: dict, arr: dict, strings_used: int) -> Tuning:
    """Open strings from the semitone offsets (manifest first, then the arrangement JSON) over
    standard E A D G B E, or E A D G for a bass; 7 and 8 strings add low B and F#, a 5-string
    bass a low B. A 6-entry bass tuning on a chart that uses 4 strings is a 4-string bass.
    Whole octaves of `centOffset` move the strings, the rest is the recording's detune."""
    offsets = entry.get("tuning", arr.get("tuning")) or [0] * 6
    if not isinstance(offsets, list) or not 4 <= len(offsets) <= 8 or not all(isinstance(o, (int, float)) for o in offsets):
        raise FeedpakError(f"unreadable tuning: {offsets!r}")
    offsets = [int(o) for o in offsets]
    capo = int(entry.get("capo", arr.get("capo", 0)) or 0)
    cents = float(entry.get("centOffset", arr.get("centOffset", 0.0)) or 0.0)
    bass = _is_bass(entry) or len(offsets) < 6
    if bass and len(offsets) == 6 and strings_used <= 4:
        offsets = offsets[:4]
    if bass:
        base = {4: BASS, 5: (BASS_LOW, *BASS), 6: (BASS_LOW, *BASS, BASS_HIGH)}.get(len(offsets))
    else:
        base = {6: STANDARD, 7: (GUITAR_LOW[1], *STANDARD), 8: (*GUITAR_LOW, *STANDARD)}.get(len(offsets))
    if base is None:
        raise FeedpakError(f"a {'bass' if bass else 'guitar'} with {len(offsets)} strings is not supported")
    octaves = round(cents / 1200)
    base = tuple(b + 12 * octaves for b in base)
    strings = tuple(b + o for b, o in zip(base, offsets))
    return Tuning(strings, name_of(strings, base), capo, cents=round(cents - 1200 * octaves, 2))


def _techniques(n: dict) -> dict:
    out = {name: True for flag, name in FLAGS.items() if n.get(flag)}
    slide = int(n.get("sl", -1) if n.get("sl") is not None else -1)
    if slide >= 0:
        out["slideTo"] = slide
    bend = float(n.get("bn", 0) or 0)  # already in semitones (unlike some older formats' steps)
    if bend > 0:
        out["bend"] = bend
    return out


def _chord_techniques(notes: list[dict]) -> dict:
    out: dict = {}
    if notes and all(n.get("pm") for n in notes):
        out["palmMute"] = True
    if notes and all(n.get("mt") or n.get("fhm") for n in notes):
        out["mute"] = True
    if any(n.get("ac") for n in notes):
        out["accent"] = True
    if any(n.get("ln") for n in notes):
        out["linkNext"] = True
    return out


def _strum(notes: list[dict]) -> str | None:
    picks = {n.get("pkd") for n in notes}
    return "down" if 0 in picks else "up" if 1 in picks else None


@dataclass
class Timeline:
    """Song-wide grid: song_timeline.json first, else what the first arrangement carries; the
    tempo of the chosen arrangement first, else the song's."""

    beats: list[tuple[float, int]]
    sections: list[tuple[float, str]]
    bpm: float | None
    time_signature: tuple[int, int]


def timeline(pack: Pack, first: dict, arr: dict) -> Timeline:
    song = pack.json(pack.manifest["song_timeline"]) if pack.manifest.get("song_timeline") else {}
    beats = sorted((float(b["time"]), int(b.get("measure", -1))) for b in song.get("beats") or first.get("beats") or [] if "time" in b)
    sections = sorted((float(s["time"]), str(s.get("name", ""))) for s in song.get("sections") or first.get("sections") or [] if "time" in s)
    tempos = arr.get("tempos") or song.get("tempos") or []
    bpm = float(tempos[0]["bpm"]) if tempos and tempos[0].get("bpm") else None
    sigs = song.get("time_signatures") or []
    ts = (int(sigs[0]["ts"][0]), int(sigs[0]["ts"][1])) if sigs and len(sigs[0].get("ts", [])) == 2 else (4, 4)
    if bpm is None and len(beats) > 2:
        bpm = 60.0 / float(np.median(np.diff([t for t, _ in beats])))
    return Timeline(beats, sections, bpm, ts)


class Templates:
    """The pack's chord shapes, plus one per chord voiced differently from the shape it names
    (the chart judges a chord by its shape)."""

    def __init__(self, raw: list[dict], strings: int):
        self.strings = strings
        self.list = [
            ChordTemplate(
                str(t.get("name") or t.get("displayName") or ""),
                [max(int(f), -1) for f in (list(t.get("frets") or []) + [-1] * strings)[:strings]],
                [min(max(int(f), -1), 4) for f in (list(t.get("fingers") or []) + [-1] * strings)[:strings]],
            )
            for t in raw
        ]

    def of(self, chord: dict) -> int:
        frets = [-1] * self.strings
        for n in chord.get("notes") or []:
            s = int(n.get("s", -1))
            if 0 <= s < self.strings:
                frets[s] = int(n.get("f", 0))
        k = int(chord.get("id", -1))
        if 0 <= k < len(self.list) and (self.list[k].frets == frets or not chord.get("notes")):
            return k
        name = self.list[k].name if 0 <= k < len(self.list) else ""
        for j, t in enumerate(self.list):
            if t.frets == frets and t.name == name:
                return j
        fingers = self.list[k].fingers if 0 <= k < len(self.list) else [-1] * self.strings
        self.list.append(ChordTemplate(name, frets, list(fingers)))
        return len(self.list) - 1


def _ranges(levels: list[int], max_d: int, top: int) -> list[tuple[int, int]]:
    """Consecutive runs of levels; a run that reaches the phrase's top extends to `top`."""
    out, start = [], levels[0]
    for prev, cur in zip(levels, levels[1:] + [None]):
        if cur != prev + 1:
            out.append((start, top if prev == max_d else prev))
            start = cur
    return out


def _laddered(chart: Chart, arr: dict, templates: Templates, strings: int) -> None:
    """Notes, chords, anchors and hand shapes of a pack with levels per phrase (§6.7)."""
    phrases = [p for p in arr["phrases"] if isinstance(p, dict)]
    ladders = []
    for p in phrases:
        levels = {int(lv.get("difficulty", i)): lv for i, lv in enumerate(p.get("levels") or [])}
        max_d = int(p.get("max_difficulty", max(levels, default=0)))
        ladders.append((float(p["start_time"]), float(p["end_time"]), max_d, levels))
    top = max((m for *_, m, _ in ladders), default=0)
    signatures: dict[tuple, str] = {}
    for start, end, max_d, levels in ladders:
        notes: dict[tuple, tuple[list[int], dict]] = {}
        chords: dict[tuple, tuple[list[int], dict]] = {}
        for d in range(max_d + 1):
            lv = levels.get(d)
            if lv is None:
                continue
            for n in lv.get("notes") or []:
                if n.get("ig") or not 0 <= int(n.get("s", -1)) < strings or int(n.get("f", -1)) < 0:
                    continue
                notes.setdefault((round(float(n["t"]), 4), int(n["s"]), int(n["f"])), ([], n))[0].append(d)
            for c in lv.get("chords") or []:
                if c.get("ig"):
                    continue
                chords.setdefault((round(float(c["t"]), 4), json.dumps(c.get("notes"), sort_keys=True), c.get("id")), ([], c))[0].append(d)
        hand = levels.get(max_d) or (levels[max(levels)] if levels else {})
        for a in hand.get("anchors") or []:
            chart.anchors.append(AnchorEvent(float(a["time"]), max(int(a.get("fret", 1)), 0), max(round(float(a.get("width", 4))), 1)))
        for h in hand.get("handshapes") or []:
            chart.hand_shapes.append(HandShape(templates.of({"id": h.get("chord_id", 0)}), float(h["start_time"]), float(h["end_time"])))
        for (t, s, f), (ds, n) in notes.items():
            for r in _ranges(sorted(ds), max_d, top):
                chart.notes.append(ChartNote(t, s, f, max(float(n.get("sus", 0) or 0), 0.0), r, _techniques(n)))
        for (t, _, _), (ds, c) in chords.items():
            cn = c.get("notes") or []
            sustain = max((float(x.get("sus", 0) or 0) for x in cn), default=0.0)
            for r in _ranges(sorted(ds), max_d, top):
                chart.chords.append(ChartChord(t, templates.of(c), sustain, r, _strum(cn), _chord_techniques(cn)))
        # Same notes at the top level → the same phrase (dynamic difficulty, Loop Trainer).
        full = levels.get(max_d) or {}
        content = tuple(
            sorted((round(float(n["t"]) - start, 2), int(n.get("s", 0)), int(n.get("f", 0))) for n in full.get("notes") or [])
        ) + tuple(sorted((round(float(c["t"]) - start, 2), str(c.get("id"))) for c in full.get("chords") or []))
        name = signatures.setdefault((round(end - start, 2), content), f"P{len(signatures) + 1}")
        chart.phrases.append(Phrase(name, start, end, max_d))
    chart.max_difficulty = top


def _slices(arr: dict, tuning: Tuning, templates: Templates) -> list[Fingered]:
    """A single-level arrangement as the slices a tab gives the builder, fingering as written."""
    events: dict[float, list[tuple[int, int, float, dict]]] = {}
    for n in arr.get("notes") or []:
        if not n.get("ig") and 0 <= int(n.get("s", -1)) < len(tuning.strings) and int(n.get("f", -1)) >= 0:
            events.setdefault(round(float(n["t"]), 6), []).append((int(n["s"]), int(n["f"]), float(n.get("sus", 0) or 0), _techniques(n)))
    for c in arr.get("chords") or []:
        if c.get("ig"):
            continue
        notes = c.get("notes") or []
        if not notes:
            k = int(c.get("id", -1))
            shape = templates.list[k] if 0 <= k < len(templates.list) else None
            notes = [{"s": s, "f": f} for s, f in enumerate(shape.frets) if f >= 0] if shape else []
        for n in notes:
            if 0 <= int(n.get("s", -1)) < len(tuning.strings) and int(n.get("f", -1)) >= 0:
                events.setdefault(round(float(c["t"]), 6), []).append((int(n["s"]), int(n["f"]), float(n.get("sus", 0) or 0), _techniques(n)))
    tab = []
    for t in sorted(events):
        # One note per string at a time: the last written wins.
        evs = sorted({s: (s, f, d, x) for s, f, d, x in events[t]}.values(), key=lambda e: tuning.pitch(e[0], e[1]))
        notes = [Note(t, tuning.pitch(s, f), d) for s, f, d, _ in evs]
        tab.append(Fingered(t, notes, [(s, f) for s, f, _, _ in evs], 1, [x for *_, x in evs]))
    infer_anchors(tab, tuning)
    return tab


def _beats_per_bar(tl: Timeline) -> int:
    bars = [k for k, (_, m) in enumerate(tl.beats) if m > 0]
    return max(round(float(np.median(np.diff(bars)))) if len(bars) > 1 else tl.time_signature[0], 1)


def _extend(tl: Timeline, duration: float) -> None:
    """Beats on to `duration` at the last beats' pace, bars numbered on: packs whose grid stops
    before their notes and audio do."""
    if len(tl.beats) < 2 or tl.beats[-1][0] >= duration:
        return
    period = float(np.median(np.diff([t for t, _ in tl.beats[-9:]])))
    if period <= 0:
        return
    per_bar = _beats_per_bar(tl)
    last_bar = max((k for k, (_, m) in enumerate(tl.beats) if m > 0), default=0)
    bar, count = max(tl.beats[last_bar][1], 1), len(tl.beats) - 1 - last_bar
    t = tl.beats[-1][0]
    while t + period <= duration + 1e-6:
        t += period
        count += 1
        if count == per_bar:
            bar, count = bar + 1, 0
        tl.beats.append((round(t, 4), bar if count == 0 else -1))


def _last_event(arr: dict) -> float:
    """When the arrangement's last note or chord ends, ladder levels included."""
    events = list(arr.get("notes") or []) + list(arr.get("chords") or [])
    for p in arr.get("phrases") or []:
        for lv in (p.get("levels") or []) if isinstance(p, dict) else []:
            events += list(lv.get("notes") or []) + list(lv.get("chords") or [])
    ends = [float(e["t"]) + max([float(e.get("sus", 0) or 0)] + [float(n.get("sus", 0) or 0) for n in e.get("notes") or []]) for e in events if "t" in e]
    return max(ends, default=0.0)


def _grid(tl: Timeline, duration: float) -> BeatGrid:
    if len(tl.beats) >= 2:
        times = [t for t, _ in tl.beats]
        bars = [k for k, (_, m) in enumerate(tl.beats) if m > 0] or [0]
        per_bar = _beats_per_bar(tl)
        if times[-1] < duration:
            times.append(duration)
        return BeatGrid(times, bars, per_bar)
    return BeatGrid.regular(tl.bpm or 120.0, duration, beats_per_bar=tl.time_signature[0])


def load_feedpak(path: Path | Pack, arrangement: str | None = None, audio_seconds: float | None = None) -> tuple[Chart, Pack]:
    """The chart of one arrangement of a pack (audio not decoded: see `ingest_feedpak`).

    The song lasts as long as its audio when known, else as the manifest says, and never ends
    before its last note: packs in the wild carry a stale `duration` either way."""
    pack = path if isinstance(path, Pack) else Pack(path)
    m = pack.manifest
    entry = choose(pack.arrangements(), arrangement)
    arr = pack.json(_safe(entry["file"]))
    first = pack.json(_safe(pack.arrangements()[0]["file"])) if pack.arrangements()[0] is not entry else arr
    used = [int(n.get("s", 0)) for n in arr.get("notes") or []] + [int(x.get("s", 0)) for c in arr.get("chords") or [] for x in c.get("notes") or []]
    tuning = tuning_of(entry, arr, max(used, default=0) + 1)
    strings = len(tuning.strings)
    duration = max(audio_seconds or float(m.get("duration") or 0.0), _last_event(arr) + 1.0)
    tl = timeline(pack, first, arr)
    _extend(tl, duration)
    templates = Templates(arr.get("templates") or [], strings)
    name = str(entry.get("name") or arr.get("name") or entry.get("id") or "Lead")
    kind = "bass" if _is_bass(entry) else "rhythm" if "rhythm" in name.lower() else "lead"
    laddered = any(int(p.get("max_difficulty", 0) or 0) > 0 for p in arr.get("phrases") or [] if isinstance(p, dict))
    if laddered:
        chart = Chart(str(m["title"]), str(m["artist"]), duration, "feedpak", pack.path.name, tuning, name, kind)
        _laddered(chart, arr, templates, strings)
        chart.templates = templates.list
        chart.bpm = tl.bpm or 120.0
        chart.time_signature = tl.time_signature
        chart.beats = [Beat(t, bar if bar > 0 else None) for t, bar in tl.beats] or [Beat(0.0, 1)]
        for k, (start, sec) in enumerate(tl.sections):
            end = tl.sections[k + 1][0] if k + 1 < len(tl.sections) else max(duration, start)
            chart.sections.append(Span(sec, start, end))
        chart.notes.sort(key=lambda n: (n.time, n.string))
        chart.chords.sort(key=lambda c: c.time)
        chart.anchors.sort(key=lambda a: a.time)
        chart.hand_shapes.sort(key=lambda h: h.start)
    else:
        tab = _slices(arr, tuning, templates)
        if not tab:
            raise FeedpakError(f"{pack.path.name}: the {name} arrangement has no notes")
        chart = build_chart(
            None,
            _grid(tl, duration),
            title=str(m["title"]),
            artist=str(m["artist"]),
            duration=duration,
            tuning=tuning,
            source_kind="feedpak",
            source_file=pack.path.name,
            arrangement_name=name,
            tab=tab,
            sections=tl.sections or None,
        )
        chart.arrangement_type = kind
        if tl.bpm:
            chart.bpm = tl.bpm
    chart.album = str(m["album"]) if m.get("album") else None
    chart.year = int(m["year"]) if str(m.get("year", "")).isdigit() else None
    return chart, pack


def _backing_stems(manifest: dict) -> list[dict]:
    """The complete mixdown: `full` (spec §5.3), else the stems played when the song opens."""
    stems = [s for s in manifest["stems"] if isinstance(s, dict) and s.get("file")]
    full = [s for s in stems if s.get("id") == "full"]
    if full:
        return full
    on = [s for s in stems if str(s.get("default", False)).lower() in ("true", "on", "yes")]
    return on or stems


def other_parts(arrangements: list[dict], chosen: dict) -> list[tuple[str, dict]]:
    """The pack's guitar arrangements besides `chosen`, each with the part name of its chart file
    (`song_chart.<part>.json`, from its id). Bass waits for a four-string highway."""
    out: list[tuple[str, dict]] = []
    for k, a in enumerate(arrangements):
        if a is chosen or _is_bass(a):
            continue
        base = re.sub(r"[^a-z0-9]+", "-", str(a.get("id") or a.get("name") or "").lower()).strip("-") or f"part-{k + 1}"
        part, n = base, 1
        while part in (p for p, _ in out):
            n += 1
            part = f"{base}-{n}"
        out.append((part, a))
    return out


def ingest_feedpak(path: Path, out_dir: Path, *, arrangement: str | None = None, progress: Sink | None = None) -> Chart:
    """A feedpak into `out_dir`: the chart, the mixdown as the backing track (48 kHz, 16 bits)
    and the cover. Without `arrangement`, the pack's other guitar arrangements go beside the
    chart, as `song_chart.<part>.json`."""
    out_dir = Path(out_dir)
    steps = Progress(progress, {"decode": 0.8, "chart": 0.2})
    steps.stage("decode")
    pack = Pack(path)
    choose(pack.arrangements(), arrangement)  # a wrong choice is said before decoding
    out_dir.mkdir(parents=True, exist_ok=True)
    scratch = Path(tempfile.mkdtemp(prefix="feedpak-", dir=out_dir))
    try:
        mix = None
        for stem in _backing_stems(pack.manifest):
            audio = audio_io.decode(pack.local(stem["file"], scratch), audio_io.ENGINE_RATE, 2)
            if mix is None:
                mix = audio
            else:
                n = max(mix.shape[1], audio.shape[1])
                mix = np.pad(mix, ((0, 0), (0, n - mix.shape[1]))) + np.pad(audio, ((0, 0), (0, n - audio.shape[1])))
        if mix is None or mix.shape[1] == 0:
            raise FeedpakError(f"{pack.path.name}: no audio in this pack")
        peak = float(np.max(np.abs(mix)))
        if peak > 1.0:  # stems summed past full scale
            mix /= peak
        audio_io.write_wav(out_dir / BACKING, mix, audio_io.ENGINE_RATE, pcm16=True)
        cover = pack.manifest.get("cover")
        if cover:
            try:
                audio_io.extract_cover(pack.local(cover, scratch), out_dir / COVER)
            except FeedpakError:  # missing art: the song comes without a cover
                pass
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
    steps.stage("chart")
    seconds = mix.shape[1] / audio_io.ENGINE_RATE
    chart, _ = load_feedpak(pack, arrangement, audio_seconds=seconds)
    chart.audio_backing = BACKING
    chart.save(out_dir / "song_chart.json")
    if arrangement is None:
        for old in out_dir.glob("song_chart.*.json"):
            old.unlink()
        found = pack.arrangements()
        for part, entry in other_parts(found, choose(found)):
            other, _ = load_feedpak(pack, str(entry.get("id") or entry.get("name")), audio_seconds=seconds)
            other.audio_backing = BACKING
            other.save(out_dir / f"song_chart.{part}.json")
    steps.done()
    return chart


# Chart technique → note flag (FLAGS the other way; a mute written as `mt`).
FLAG_OF = {name: flag for flag, name in FLAGS.items() if flag != "fhm"}
# Techniques a chord passes to each of its notes.
CHORD_FLAGS = ("palmMute", "mute", "accent", "linkNext")


def _note_doc(s: int, f: int, sustain: float, techniques: dict, t: float | None = None) -> dict:
    n: dict = {} if t is None else {"t": round(t, 4)}
    n.update(s=s, f=f)
    if sustain > 0:
        n["sus"] = round(sustain, 4)
    n.update({flag: True for name, flag in FLAG_OF.items() if techniques.get(name)})
    if "slideTo" in techniques:
        n["sl"] = int(techniques["slideTo"])
    if techniques.get("bend"):
        n["bn"] = float(techniques["bend"])
    return n


def _chord_doc(chart: Chart, c: ChartChord) -> dict:
    techs = {k: v for k, v in c.techniques.items() if k in CHORD_FLAGS}
    notes = [_note_doc(s, f, c.sustain, techs) for s, f in enumerate(chart.templates[c.template].frets) if f >= 0]
    if c.strum:
        for n in notes:
            n["pkd"] = 0 if c.strum == "down" else 1
    return {"t": round(c.time, 4), "id": c.template, "notes": notes}


def arrangement_doc(chart: Chart) -> dict:
    """A chart as a pack's arrangement: its shapes, each phrase's ladder of levels (§6.7), and the
    whole part at its highest level for readers without ladders."""
    top_notes, top_chords = chart.events_at(chart.max_difficulty)
    phrases = []
    for p in chart.phrases:
        inside = lambda t, p=p: p.start <= t < p.end  # noqa: E731
        levels = []
        for d in range(p.max_difficulty + 1):
            level: dict = {
                "difficulty": d,
                "notes": [_note_doc(n.string, n.fret, n.sustain, n.techniques, n.time) for n in chart.notes if inside(n.time) and n.levels[0] <= d <= n.levels[1]],
                "chords": [_chord_doc(chart, c) for c in chart.chords if inside(c.time) and c.levels[0] <= d <= c.levels[1]],
            }
            if d == p.max_difficulty:
                level["anchors"] = [{"time": a.time, "fret": a.fret, "width": a.width} for a in chart.anchors if inside(a.time)]
                level["handshapes"] = [{"chord_id": h.template, "start_time": h.start, "end_time": h.end} for h in chart.hand_shapes if inside(h.start)]
            levels.append(level)
        phrases.append({"name": p.name, "start_time": p.start, "end_time": p.end, "max_difficulty": p.max_difficulty, "levels": levels})
    return {
        "name": chart.arrangement_name,
        "templates": [{"name": t.name, "frets": t.frets, "fingers": t.fingers} for t in chart.templates],
        "notes": [_note_doc(n.string, n.fret, n.sustain, n.techniques, n.time) for n in top_notes],
        "chords": [_chord_doc(chart, c) for c in top_chords],
        "phrases": phrases,
    }


def export_feedpak(folder: Path, dst: Path) -> Path:
    """An imported song (its folder: `song_chart.json`, the other parts' `song_chart.<part>.json`,
    their audio and cover) as a zipped pack at `dst`: every part an arrangement, the recording as
    the `full` stem (else its backing and guitar, both played)."""
    folder, dst = Path(folder), Path(dst)
    charts = [(p, Chart.load(p)) for p in [folder / "song_chart.json", *sorted(folder.glob("song_chart.*.json"))] if p.is_file()]
    if not charts:
        raise FeedpakError(f"{folder.name}: no chart in this folder")
    main = charts[0][1]
    files: dict[str, Path | bytes] = {}
    arrangements = []
    for path, chart in charts:
        if len(chart.tuning.strings) != len(STANDARD):
            raise FeedpakError(f"{path.name}: only six-string guitar parts are exported")
        part = path.name.removeprefix("song_chart").removesuffix(".json").strip(".")
        ident = re.sub(r"[^a-z0-9]+", "-", (part or chart.arrangement_name).lower()).strip("-") or "part"
        files[f"arrangements/{ident}.json"] = json.dumps(arrangement_doc(chart)).encode()
        arrangements.append(
            {
                "id": ident,
                "name": chart.arrangement_name,
                "type": "guitar",
                "file": f"arrangements/{ident}.json",
                "tuning": [s - b for s, b in zip(chart.tuning.strings, STANDARD)],
                "capo": chart.tuning.capo,
                "centOffset": chart.tuning.cents,
            }
        )
    stems = []
    sources = [("full", main.audio_mix)] if main.audio_mix else [("backing", main.audio_backing), ("guitar", main.audio_guitar)]
    for ident, rel in sources:
        if rel and (folder / rel).is_file():
            files[f"audio/{Path(rel).name}"] = folder / rel
            stems.append({"id": ident, "file": f"audio/{Path(rel).name}", "default": True})
    if not stems:
        raise FeedpakError(f"{folder.name}: no audio to put in the pack")
    files["song_timeline.json"] = json.dumps(
        {
            "beats": [{"time": b.time, "measure": b.bar or -1} for b in main.beats],
            "sections": [{"time": s.start, "name": s.name} for s in main.sections],
            "tempos": [{"time": 0.0, "bpm": main.bpm}],
            "time_signatures": [{"time": 0.0, "ts": list(main.time_signature)}],
        }
    ).encode()
    manifest: dict = {"feedpak_version": "1.0.0", "title": main.title, "artist": main.artist}
    manifest.update({k: v for k, v in (("album", main.album), ("year", main.year)) if v})
    manifest.update(duration=round(main.duration, 3), song_timeline="song_timeline.json", arrangements=arrangements, stems=stems)
    if (folder / COVER).is_file():
        files[COVER] = folder / COVER
        manifest["cover"] = COVER
    dst.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("manifest.yaml", yaml.safe_dump(manifest, sort_keys=False, allow_unicode=True))
        for rel, content in files.items():
            if isinstance(content, Path):
                z.write(content, rel)
            else:
                z.writestr(rel, content)
    return dst
