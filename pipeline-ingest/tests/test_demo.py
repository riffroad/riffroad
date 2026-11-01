"""The demo song shipped with the app: generated, valid, and what the repository carries."""

import json
from pathlib import Path

import numpy as np
import soundfile as sf

from opensmith_ingest.chart import Chart
from opensmith_ingest.demo import BACKING, RATE, make_demo

SHIPPED = Path(__file__).resolve().parents[2] / "app" / "demo" / "OpenSmith - First Riff"


def test_the_demo_song_is_a_playable_chart_on_its_backing_track(tmp_path):
    chart = make_demo(tmp_path)
    saved = Chart.load(tmp_path / "song_chart.json")
    assert (saved.title, saved.artist, saved.source_kind) == ("First Riff", "Riffroad", "synth")
    assert len(saved.notes) + len(saved.chords) > 80 and saved.max_difficulty >= 2
    info = sf.info(str(tmp_path / BACKING))
    assert (info.samplerate, info.channels) == (RATE, 1)
    assert abs(info.duration - chart.duration) < 0.05


def test_the_app_ships_the_demo_as_generated(tmp_path):
    make_demo(tmp_path)
    shipped = json.loads((SHIPPED / "song_chart.json").read_text())
    fresh = json.loads((tmp_path / "song_chart.json").read_text())
    shipped["meta"].pop("generator", None), fresh["meta"].pop("generator", None)
    assert shipped == fresh, "regenerate it: uv run opensmith-ingest demo -o '../app/demo/OpenSmith - First Riff'"
    shipped_audio, _ = sf.read(str(SHIPPED / BACKING))
    fresh_audio, _ = sf.read(str(tmp_path / BACKING))
    assert shipped_audio.shape == fresh_audio.shape and np.abs(shipped_audio - fresh_audio).max() < 1e-3
