"""A song imported from audio, made light enough to ship with the app: its backing (stereo) and
its guitar (mono) in Ogg Vorbis, a tenth of the WAV's size, and its charts pointing at them.
The app's engine reads both formats."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

BACKING = "backing.ogg"
GUITAR = "guitar.ogg"
CHARTS = ("song_chart.json", "song_chart.chords.json")
# libsndfile's Vorbis setting: 0 the best, 1 the smallest; 0.6 is about 115 kb/s in stereo.
QUALITY = 0.6
BLOCK = 32_768


def _encode(src: Path, dest: Path, *, mono: bool, quality: float) -> None:
    """`src` (any format libsndfile reads) as Ogg Vorbis, written block by block: libsndfile's
    Vorbis encoder crashes on a whole song in one write."""
    import soundfile as sf

    with sf.SoundFile(src) as r:
        channels = 1 if mono else min(r.channels, 2)
        with sf.SoundFile(dest, "w", r.samplerate, channels, format="OGG", subtype="VORBIS", compression_level=quality) as w:
            while True:
                block = r.read(BLOCK, dtype="float32", always_2d=True)
                if not len(block):
                    break
                block = block.mean(axis=1, keepdims=True) if mono else block[:, :channels]
                w.write(np.clip(block, -1.0, 1.0))


def bundle(src: Path, out: Path, *, album: str | None = None, quality: float = QUALITY) -> list[Path]:
    """The song imported in `src` written to `out`, ready to ship; `album` replaces the charts'
    (where a shipped song credits its source). Returns the files written."""
    src, out = Path(src), Path(out)
    main = json.loads((src / CHARTS[0]).read_text(encoding="utf-8"))
    audio = main.get("audio") or {}
    if not audio.get("backing"):
        raise ValueError(f"{src}: no backing track to ship")
    out.mkdir(parents=True, exist_ok=True)
    written = [out / BACKING]
    _encode(src / audio["backing"], out / BACKING, mono=False, quality=quality)
    guitar = audio.get("guitar") and src / audio["guitar"]
    if guitar and guitar.is_file():
        _encode(guitar, out / GUITAR, mono=True, quality=quality)
        written.append(out / GUITAR)
    for name in CHARTS:
        if not (src / name).is_file():
            continue
        chart = json.loads((src / name).read_text(encoding="utf-8"))
        chart["audio"] = {**chart.get("audio", {}), "backing": BACKING, "guitar": GUITAR if len(written) > 1 else None, "mix": None}
        if album is not None:
            chart["meta"]["album"] = album
        (out / name).write_text(json.dumps(chart, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        written.append(out / name)
    return written
