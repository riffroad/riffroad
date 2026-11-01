"""OpenSmith chart model — the playable arrangement the game loads (schema/chart.schema.json)."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any

import jsonschema

from . import __version__
from .fingering import Tuning

# The chart format: schema/chart.schema.json at the repository's root, shared with the engine and
# the app. A copy travels in the package for installs outside the repository (a plugin's
# environment); a test keeps the two identical.
REPO_SCHEMA = Path(__file__).resolve().parents[3] / "schema" / "chart.schema.json"
SCHEMA_PATH = REPO_SCHEMA if REPO_SCHEMA.is_file() else Path(__file__).with_name("chart.schema.json")
GENERATOR = f"opensmith-ingest {__version__}"


@lru_cache(maxsize=1)
def schema() -> dict:
    return json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


def validate(doc: dict) -> None:
    """Raises `jsonschema.ValidationError` when `doc` is not a valid chart."""
    jsonschema.validate(doc, schema())


@dataclass
class Beat:
    time: float
    bar: int | None = None


@dataclass
class Span:
    name: str
    start: float
    end: float


@dataclass
class Phrase:
    name: str
    start: float
    end: float
    max_difficulty: int


@dataclass
class ChordTemplate:
    name: str
    frets: list[int]
    fingers: list[int]


@dataclass
class ChartNote:
    time: float
    string: int
    fret: int
    sustain: float = 0.0
    levels: tuple[int, int] = (0, 0)
    techniques: dict[str, Any] = field(default_factory=dict)


@dataclass
class ChartChord:
    time: float
    template: int
    sustain: float = 0.0
    levels: tuple[int, int] = (0, 0)
    strum: str | None = None
    techniques: dict[str, Any] = field(default_factory=dict)


@dataclass
class AnchorEvent:
    time: float
    fret: int
    width: int = 4


@dataclass
class HandShape:
    template: int
    start: float
    end: float


@dataclass
class Chart:
    title: str
    artist: str
    duration: float
    source_kind: str
    source_file: str
    tuning: Tuning = Tuning()
    arrangement_name: str = "Lead"
    arrangement_type: str = "lead"
    max_difficulty: int = 4
    bpm: float = 120.0
    time_signature: tuple[int, int] = (4, 4)
    album: str | None = None
    year: int | None = None
    audio_backing: str | None = None
    audio_guitar: str | None = None
    audio_mix: str | None = None
    audio_offset: float = 0.0
    beats: list[Beat] = field(default_factory=list)
    sections: list[Span] = field(default_factory=list)
    phrases: list[Phrase] = field(default_factory=list)
    templates: list[ChordTemplate] = field(default_factory=list)
    notes: list[ChartNote] = field(default_factory=list)
    chords: list[ChartChord] = field(default_factory=list)
    anchors: list[AnchorEvent] = field(default_factory=list)
    hand_shapes: list[HandShape] = field(default_factory=list)
    # What made it: this converter, and the rules of its kind of chart when they change.
    generator: str = GENERATOR

    def to_dict(self) -> dict:
        r = lambda x: round(float(x), 4)  # noqa: E731 — 0.1 ms is far below anything audible
        return {
            "format": "opensmith-chart",
            "version": 1,
            "meta": {
                "title": self.title,
                "artist": self.artist,
                "album": self.album,
                "year": self.year,
                "duration": r(self.duration),
                "source": {"kind": self.source_kind, "file": self.source_file},
                "generator": self.generator,
            },
            "audio": {
                "backing": self.audio_backing,
                "guitar": self.audio_guitar,
                "mix": self.audio_mix,
                "offset": r(self.audio_offset),
            },
            "arrangement": {
                "name": self.arrangement_name,
                "type": self.arrangement_type,
                "tuning": {"name": self.tuning.name, "strings": list(self.tuning.strings), **({"cents": self.tuning.cents} if self.tuning.cents else {})},
                "capo": self.tuning.capo,
                "maxDifficulty": self.max_difficulty,
            },
            "tempo": {"bpm": round(float(self.bpm), 2), "timeSignature": list(self.time_signature)},
            "beats": [{"time": r(b.time), **({"bar": b.bar} if b.bar else {})} for b in self.beats],
            "sections": [{"name": s.name, "start": r(s.start), "end": r(s.end)} for s in self.sections],
            "phrases": [
                {"name": p.name, "start": r(p.start), "end": r(p.end), "maxDifficulty": p.max_difficulty} for p in self.phrases
            ],
            "chordTemplates": [{"name": t.name, "frets": list(t.frets), "fingers": list(t.fingers)} for t in self.templates],
            "notes": [
                {
                    "time": r(n.time),
                    "string": n.string,
                    "fret": n.fret,
                    "sustain": r(n.sustain),
                    "levels": list(n.levels),
                    **({"techniques": dict(n.techniques)} if n.techniques else {}),
                }
                for n in self.notes
            ],
            "chords": [
                {
                    "time": r(c.time),
                    "template": c.template,
                    "sustain": r(c.sustain),
                    "levels": list(c.levels),
                    **({"strum": c.strum} if c.strum else {}),
                    **({"techniques": dict(c.techniques)} if c.techniques else {}),
                }
                for c in self.chords
            ],
            "anchors": [{"time": r(a.time), "fret": a.fret, "width": a.width} for a in self.anchors],
            "handShapes": [{"template": h.template, "start": r(h.start), "end": r(h.end)} for h in self.hand_shapes],
        }

    def save(self, path: Path) -> dict:
        doc = self.to_dict()
        validate(doc)
        Path(path).write_text(json.dumps(doc, indent=1, ensure_ascii=False), encoding="utf-8")
        return doc

    @classmethod
    def from_dict(cls, doc: dict) -> Chart:
        validate(doc)
        meta, arr, audio = doc["meta"], doc["arrangement"], doc["audio"]
        tuning = Tuning(tuple(arr["tuning"]["strings"]), arr["tuning"]["name"], arr["capo"], cents=arr["tuning"].get("cents", 0.0))
        return cls(
            title=meta["title"],
            artist=meta["artist"],
            album=meta.get("album"),
            year=meta.get("year"),
            duration=meta["duration"],
            source_kind=meta["source"]["kind"],
            source_file=meta["source"]["file"],
            generator=meta.get("generator", GENERATOR),
            tuning=tuning,
            arrangement_name=arr["name"],
            arrangement_type=arr["type"],
            max_difficulty=arr["maxDifficulty"],
            bpm=doc["tempo"]["bpm"],
            time_signature=tuple(doc["tempo"]["timeSignature"]),
            audio_backing=audio["backing"],
            audio_guitar=audio["guitar"],
            audio_mix=audio["mix"],
            audio_offset=audio["offset"],
            beats=[Beat(b["time"], b.get("bar")) for b in doc["beats"]],
            sections=[Span(s["name"], s["start"], s["end"]) for s in doc["sections"]],
            phrases=[Phrase(p["name"], p["start"], p["end"], p["maxDifficulty"]) for p in doc["phrases"]],
            templates=[ChordTemplate(t["name"], t["frets"], t["fingers"]) for t in doc["chordTemplates"]],
            notes=[
                ChartNote(n["time"], n["string"], n["fret"], n["sustain"], tuple(n["levels"]), n.get("techniques", {}))
                for n in doc["notes"]
            ],
            chords=[
                ChartChord(c["time"], c["template"], c["sustain"], tuple(c["levels"]), c.get("strum"), c.get("techniques", {}))
                for c in doc["chords"]
            ],
            anchors=[AnchorEvent(a["time"], a["fret"], a["width"]) for a in doc["anchors"]],
            hand_shapes=[HandShape(h["template"], h["start"], h["end"]) for h in doc["handShapes"]],
        )

    @classmethod
    def load(cls, path: Path) -> Chart:
        return cls.from_dict(json.loads(Path(path).read_text(encoding="utf-8")))

    def events_at(self, level: int) -> tuple[list[ChartNote], list[ChartChord]]:
        """Notes and chords shown at difficulty `level` (the same level for every phrase)."""
        notes = [n for n in self.notes if n.levels[0] <= level <= n.levels[1]]
        chords = [c for c in self.chords if c.levels[0] <= level <= c.levels[1]]
        return notes, chords
