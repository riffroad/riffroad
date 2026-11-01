"""An imported song made light to ship with the app: Ogg stems, charts pointing at them."""

import json

import numpy as np
import soundfile as sf

from opensmith_ingest.bundle import BACKING, GUITAR, bundle


def _imported(folder, seconds=3.0, sr=48_000):
    t = np.arange(int(seconds * sr)) / sr
    band = np.stack([0.3 * np.sin(2 * np.pi * 110 * t), 0.3 * np.sin(2 * np.pi * 165 * t)], axis=1)
    guitar = np.stack([0.4 * np.sin(2 * np.pi * 330 * t)] * 2, axis=1)
    sf.write(folder / "backing_track_no_guitar.wav", band, sr, subtype="FLOAT")
    sf.write(folder / "isolated_guitar.wav", guitar, sr, subtype="FLOAT")
    chart = {"meta": {"title": "T", "artist": "A", "album": None}, "audio": {"backing": "backing_track_no_guitar.wav", "guitar": "isolated_guitar.wav", "mix": None, "offset": 0.0}, "notes": [{"time": 1.0}]}
    for name in ("song_chart.json", "song_chart.chords.json"):
        (folder / name).write_text(json.dumps(chart))


def test_ships_the_stems_as_ogg_and_points_the_charts_at_them(tmp_path):
    src, out = tmp_path / "imported", tmp_path / "shipped"
    src.mkdir()
    _imported(src)
    files = bundle(src, out, album="Label · CC BY 4.0")
    assert {f.name for f in files} == {BACKING, GUITAR, "song_chart.json", "song_chart.chords.json"}
    backing, guitar = sf.info(str(out / BACKING)), sf.info(str(out / GUITAR))
    assert (backing.format, backing.channels, backing.samplerate) == ("OGG", 2, 48_000)
    assert (guitar.channels, guitar.samplerate) == (1, 48_000)
    assert abs(backing.duration - 3.0) < 0.01
    # A tenth of the WAV or less, and still the same music.
    assert (out / BACKING).stat().st_size < (src / "backing_track_no_guitar.wav").stat().st_size / 10
    left = sf.read(str(out / BACKING), dtype="float32")[0][:, 0]
    crossings = np.count_nonzero((left[:-1] < 0) & (left[1:] >= 0))
    assert abs(crossings / 3.0 - 110) < 3
    for name in ("song_chart.json", "song_chart.chords.json"):
        chart = json.loads((out / name).read_text())
        assert chart["audio"] == {"backing": BACKING, "guitar": GUITAR, "mix": None, "offset": 0.0}
        assert chart["meta"]["album"] == "Label · CC BY 4.0"
        assert chart["notes"] == [{"time": 1.0}]
