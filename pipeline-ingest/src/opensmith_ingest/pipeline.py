"""Song file → stems → beat grid → transcription → playable chart, plus the game's audio.

Outputs in `out_dir` (all at the engine's 48 kHz):
* `backing_track_no_guitar.wav` — what plays while you play (mix minus the guitar stem);
* `isolated_guitar.wav` — the original guitar, for a "guide" mix or listening back;
* `song_chart.json` — the chart (schema/chart.schema.json);
* `song_chart.chords.json` — the "Chords" arrangement: the chords on the beats (`chord_chart`).
"""

from __future__ import annotations

import json
import logging
import shutil
import time
from collections.abc import Callable
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np

from . import align, audio_io, beats, builder, chord_chart, separation, transcription, tunings
from .chart import Chart
from .fingering import Tuning
from .importers.guitarpro import TabPart, named_sections, parse_guitarpro
from .progress import Progress, Sink
from .stem import GuitarStem

log = logging.getLogger(__name__)

DEMUCS_RATE = 44_100
ANALYSIS_RATE = 22_050
# Basic Pitch's notes for the guitar stem, kept next to the chart: re-charting skips it.
TRANSCRIPTION_CACHE = "transcription.json"
# The song file's picture, next to the chart (the app shows it).
COVER = "cover.jpg"
# The chart a re-charting replaced.
PREVIOUS_CHART = "song_chart.previous.json"
# Which tab the chart was made from, when it was.
TAB_RECORD = "tab.json"
# The chords of a transcribed song, beside its chart.
CHORD_CHART = "song_chart.chords.json"


@dataclass
class IngestReport:
    chart: Chart
    chart_path: Path
    backing_path: Path
    guitar_path: Path
    duration: float
    bpm: float
    raw_notes: int
    clean_notes: int
    separation_seconds: float
    device: str
    stem: str
    total_seconds: float
    tuning_choice: tunings.TuningChoice | None
    # The human tab the notes come from, and the share of its notes the transcription confirms.
    tab: Path | None = None
    confirmed: float | None = None

    def summary(self) -> str:
        c = self.chart
        source = (
            f"tab {self.tab.name} placed on the recording ({self.confirmed:.0%} of its notes heard)"
            if self.tab is not None
            else f"{self.clean_notes} notes kept of {self.raw_notes} transcribed"
        )
        return (
            f"{c.title}: {self.duration:.1f} s, {self.bpm:.1f} BPM, {c.tuning.name}, {len(c.phrases)} phrases, "
            f"{source} → {len(c.notes)} notes + {len(c.chords)} chords "
            f"({c.arrangement_type}); stem {self.stem}, separation {self.separation_seconds:.1f} s on {self.device}, "
            f"total {self.total_seconds:.1f} s"
        )


def guitar_phrase_features(guitar: np.ndarray, rate: int, steps: int = 16) -> Callable[[float, float], np.ndarray]:
    """Beat-synchronous chroma of the guitar stem: what a phrase sounds like, harmonically and
    rhythmically. Transcribed notes of a distorted guitar vary too much between repeats of the
    same riff to recognise it (a test song: 0.16 note overlap, 0.98 chroma similarity)."""
    import librosa

    hop = 512
    chroma = librosa.feature.chroma_cqt(y=guitar, sr=rate, hop_length=hop)
    times = librosa.frames_to_time(np.arange(chroma.shape[1]), sr=rate, hop_length=hop)

    def features(start: float, end: float) -> np.ndarray:
        edges = np.linspace(start, end, steps + 1)
        parts = []
        for a, b in zip(edges, edges[1:]):
            m = (times >= a) & (times < b)
            parts.append(chroma[:, m].mean(axis=1) if m.any() else np.zeros(12))
        return np.concatenate(parts)

    return features


def transcribe(guitar_path: Path) -> list[transcription.RawNote]:
    """Basic Pitch on the guitar stem, cached in its folder."""
    cache = guitar_path.with_name(TRANSCRIPTION_CACHE)
    if cache.exists():
        return [transcription.RawNote(**n) for n in json.loads(cache.read_text(encoding="utf-8"))]
    raw = transcription.basic_pitch(guitar_path)
    cache.write_text(json.dumps([asdict(n) for n in raw]), encoding="utf-8")
    return raw


def ingest_audio(
    path: Path,
    out_dir: Path,
    *,
    title: str | None = None,
    artist: str = "Unknown",
    tuning: Tuning | None = None,
    device: str | None = None,
    shifts: int = 1,
    stem: str = "auto",
    progress: Sink | None = None,
    tab: Path | None = None,
    track: int | None = None,
) -> IngestReport:
    """`progress` receives (stage, fraction of the whole import done) as the work advances.
    With a Guitar Pro `tab` (its `track`, default the first guitar), the chart takes the tab's
    notes placed on the recording instead of the transcription's."""
    t0 = time.perf_counter()
    path, out_dir = Path(path), Path(out_dir)
    steps = Progress(progress)
    steps.stage("decode")
    mix = audio_io.decode(path, DEMUCS_RATE, 2)
    out_dir.mkdir(parents=True, exist_ok=True)
    audio_io.extract_cover(path, out_dir / COVER)
    duration = mix.shape[1] / DEMUCS_RATE
    steps.stage("separate")
    stems = separation.separate(mix, device, shifts, progress=steps.update)
    steps.stage("stems")
    stems.choose_guitar(stem)
    backing_path = out_dir / "backing_track_no_guitar.wav"
    guitar_path = out_dir / "isolated_guitar.wav"
    audio_io.write_wav(backing_path, audio_io.resample(stems.backing, DEMUCS_RATE, audio_io.ENGINE_RATE), audio_io.ENGINE_RATE)
    audio_io.write_wav(guitar_path, audio_io.resample(stems.guitar, DEMUCS_RATE, audio_io.ENGINE_RATE), audio_io.ENGINE_RATE)

    steps.stage("transcribe")
    raw = transcribe(guitar_path)
    stem_audio = GuitarStem(stems.guitar.mean(0), DEMUCS_RATE)
    # Clean over the widest range first: the tuning is not known yet.
    notes = transcription.clean(raw, tunings.ANALYSIS, stem=stem_audio)
    part = parse_guitarpro(tab, track) if tab is not None else None
    choice = None
    if part is not None:
        tuning = part.tuning
    elif tuning is None:
        choice = tunings.detect(notes)
        tuning = choice.tuning

    steps.stage("beats")
    rhythm = (stems.sources["drums"] + stems.sources["bass"]).mean(0, keepdims=True)
    grid = beats.track(
        audio_io.resample(mix.mean(0, keepdims=True), DEMUCS_RATE, ANALYSIS_RATE)[0],
        ANALYSIS_RATE,
        duration,
        rhythm=audio_io.resample(rhythm, DEMUCS_RATE, ANALYSIS_RATE)[0],
        notes=notes,
    )
    steps.stage("chart")
    placement = align.place(part, stem_audio, raw) if part is not None else None
    if placement is not None and not placement.plausible:
        # Not this recording's tab after all: the transcription it is.
        log.warning("%s does not fit the recording (%.0f%% of its notes heard): transcribing instead", tab, 100 * placement.confirmed)
        placement, part, tab = None, None, None
        choice = tunings.detect(notes)
        tuning = choice.tuning
    if placement is not None and part is not None and tab is not None:
        chart = _tab_chart(part, placement, tab, title or path.stem, artist, duration)
    else:
        features = guitar_phrase_features(audio_io.resample(stems.guitar.mean(0, keepdims=True), DEMUCS_RATE, ANALYSIS_RATE)[0], ANALYSIS_RATE)
        chart = builder.build_chart(
            notes,
            grid,
            title=title or path.stem,
            artist=artist,
            duration=duration,
            tuning=tuning,
            source_kind="audio",
            source_file=path.name,
            phrase_features=features,
            check=lambda voted: transcription.recheck(voted, stem_audio, tuning),
        )
    chart.audio_backing = backing_path.name
    chart.audio_guitar = guitar_path.name
    chart_path = out_dir / "song_chart.json"
    chart.save(chart_path)
    if placement is None:
        _save_chords(out_dir, chart, raw, grid, features)
    if placement is not None and tab is not None:
        _note_tab(out_dir, tab, track, placement.confirmed)
    steps.done()
    return IngestReport(
        chart,
        chart_path,
        backing_path,
        guitar_path,
        duration,
        grid.bpm,
        len(raw),
        len(notes),
        stems.seconds,
        stems.device,
        stems.stem,
        time.perf_counter() - t0,
        choice,
        tab,
        placement.confirmed if placement is not None else None,
    )


def _save_chords(out_dir: Path, chart: Chart, raw: list[transcription.RawNote], grid: builder.BeatGrid, features: Callable[[float, float], np.ndarray]) -> None:
    """The song's "Chords" arrangement beside its `chart`, on the same audio."""
    chords = chord_chart.build_chord_chart(
        raw,
        grid,
        title=chart.title,
        artist=chart.artist,
        duration=chart.duration,
        tuning=chart.tuning,
        source_kind=chart.source_kind,
        source_file=chart.source_file,
        phrase_features=features,
    )
    chords.album, chords.year = chart.album, chart.year
    chords.audio_backing, chords.audio_guitar, chords.audio_mix, chords.audio_offset = (
        chart.audio_backing,
        chart.audio_guitar,
        chart.audio_mix,
        chart.audio_offset,
    )
    chords.save(out_dir / CHORD_CHART)


def _tab_chart(part: TabPart, placement: align.Placement, tab: Path, title: str, artist: str, duration: float) -> Chart:
    """The chart of a tab placed on a recording: the tab's notes, fingering, bars and sections
    at the song's times. Title and artist from the tab when it has them."""
    chart = builder.build_chart(
        None,
        placement.grid,
        title=part.title or title,
        artist=part.artist or artist,
        duration=duration,
        tuning=part.tuning,
        source_kind="guitarpro",
        source_file=Path(tab).name,
        arrangement_name=part.track_name,
        tab=[sl for sl in placement.tab if 0.0 <= sl.time < duration],
        sections=named_sections(part, placement.grid),
    )
    chart.album = part.album
    return chart


def retab(out_dir: Path, tab: Path, *, track: int | None = None) -> IngestReport:
    """Puts a Guitar Pro tab on a song already imported from audio (its stems and transcription
    are reused): the chart takes the tab's notes at the recording's times. The previous chart is
    kept in `song_chart.previous.json`, the tab noted in `tab.json`."""
    t0 = time.perf_counter()
    out_dir, tab = Path(out_dir), Path(tab)
    chart_path = out_dir / "song_chart.json"
    old = Chart.load(chart_path)
    if not old.audio_guitar:
        raise ValueError(f"{out_dir}: no guitar stem to place the tab on")
    guitar_path = out_dir / old.audio_guitar
    stem_audio = GuitarStem.load(guitar_path)
    raw = transcribe(guitar_path)
    part = parse_guitarpro(tab, track)
    placement = align.place(part, stem_audio, raw)
    if not placement.plausible:
        raise ValueError(
            f"la tablature {tab.name} ne correspond pas à cet enregistrement "
            f"({placement.confirmed:.0%} de ses notes entendues, tempo ×{placement.stretch:.2f})"
        )
    chart = _tab_chart(part, placement, tab, old.title, old.artist, old.duration)
    chart.audio_backing, chart.audio_guitar, chart.audio_mix, chart.audio_offset = (
        old.audio_backing,
        old.audio_guitar,
        old.audio_mix,
        old.audio_offset,
    )
    chart.album = chart.album or old.album
    chart.year = old.year
    shutil.copyfile(chart_path, out_dir / PREVIOUS_CHART)
    chart.save(chart_path)
    _note_tab(out_dir, tab, track, placement.confirmed)
    return IngestReport(
        chart,
        chart_path,
        out_dir / (old.audio_backing or ""),
        guitar_path,
        old.duration,
        placement.grid.bpm,
        len(raw),
        len(raw),
        0.0,
        "-",
        "-",
        time.perf_counter() - t0,
        None,
        tab,
        placement.confirmed,
    )


def _note_tab(out_dir: Path, tab: Path, track: int | None, confirmed: float) -> None:
    """Remembers, next to the chart, which tab it was made from (the app reads it too)."""
    st = Path(tab).stat()
    record = {"source": str(Path(tab).resolve()), "size": st.st_size, "modified": int(st.st_mtime), "track": track, "confirmed": round(confirmed, 3)}
    (out_dir / TAB_RECORD).write_text(json.dumps(record, indent=2), encoding="utf-8")


def _applied_tab(out_dir: Path) -> Path | None:
    """The Guitar Pro tab placed on this imported song, if it still exists."""
    record = out_dir / TAB_RECORD
    if not record.exists():
        return None
    source = json.loads(record.read_text(encoding="utf-8")).get("source")
    return Path(source) if source and Path(source).is_file() else None


def rechart(out_dir: Path, *, consensus: bool = True, report: dict | None = None, retune: bool = False) -> Chart:
    """Rebuilds the chart of an imported song from its stems (no separation; the transcription
    is cached): the song's beats are kept, the charting is redone with today's rules, and the
    tuning too with `retune` (kept otherwise). A title left as "Artist - Title (Official
    Video)" is cleaned up. A song with a tab placed on it gets the tab placed again."""
    from .naming import guess_title_artist

    out_dir = Path(out_dir)
    tab = _applied_tab(out_dir)
    if tab is not None:
        placed = retab(out_dir, tab)
        if report is not None:
            report.update(tab=tab.name, confirmed=f"{placed.confirmed:.0%}")
        return placed.chart
    old = Chart.load(out_dir / "song_chart.json")
    if not old.audio_guitar:
        raise ValueError(f"{out_dir}: no guitar stem to re-chart (imported tab?)")
    guitar_path = out_dir / old.audio_guitar
    origin = out_dir / "import.json"
    if not (out_dir / COVER).exists() and origin.exists():
        source = Path(json.loads(origin.read_text(encoding="utf-8")).get("source", ""))
        if source.is_file():
            audio_io.extract_cover(source, out_dir / COVER)
    raw = transcribe(guitar_path)
    stem_audio = GuitarStem.load(guitar_path)
    notes = transcription.clean(raw, tunings.ANALYSIS, stem=stem_audio)
    tuning = tunings.detect(notes).tuning if retune else old.tuning
    if report is not None and retune:
        report["tuning"] = tuning.name
    grid = builder.BeatGrid.from_downbeats([b.time for b in old.beats], [b.time for b in old.beats if b.bar is not None])
    known = old.artist if old.artist not in ("", "Unknown") else None
    title, by = guess_title_artist(old.title, known)
    artist = by or old.artist
    guitar = audio_io.decode(guitar_path, ANALYSIS_RATE, 1)[0]
    features = guitar_phrase_features(guitar, ANALYSIS_RATE)
    chart = builder.build_chart(
        notes,
        grid,
        title=title,
        artist=artist,
        duration=old.duration,
        tuning=tuning,
        source_kind=old.source_kind,
        source_file=old.source_file,
        phrase_features=features,
        consensus=consensus,
        report=report,
        check=lambda voted: transcription.recheck(voted, stem_audio, tuning),
    )
    chart.audio_backing, chart.audio_guitar, chart.audio_mix, chart.audio_offset = (
        old.audio_backing,
        old.audio_guitar,
        old.audio_mix,
        old.audio_offset,
    )
    chart.album, chart.year = old.album, old.year
    chart.save(out_dir / "song_chart.json")
    _save_chords(out_dir, chart, raw, grid, features)
    return chart
