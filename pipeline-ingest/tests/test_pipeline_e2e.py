"""MP3 → Demucs → beats → Basic Pitch → Viterbi → chart, on a synthetic song with ground truth.

Slow (~40 s: stem separation and transcription). Run with `uv run pytest -m slow`.
"""

from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from opensmith_ingest import audio_io
from opensmith_ingest.chart import Chart
from opensmith_ingest.fingering import Fingered, playability
from opensmith_ingest.pipeline import ingest_audio
from opensmith_ingest.synth import rock_song

pytestmark = pytest.mark.slow


@pytest.fixture(scope="module")
def run(tmp_path_factory):
    out = tmp_path_factory.mktemp("e2e")
    song = rock_song()
    audio_io.write_wav(out / "mix.wav", song.mix, song.sr)
    audio_io.encode_mp3(out / "mix.wav", out / "song.mp3")
    events = []
    report = ingest_audio(
        out / "song.mp3", out / "chart", title="Synthetic Rock", artist="OpenSmith", progress=lambda s, f: events.append((s, f))
    )
    report.progress_events = events
    print("\n" + report.summary())
    return song, report


def charted_pitches(chart: Chart, level: int) -> list[tuple[float, int]]:
    notes, chords = chart.events_at(level)
    got = [(n.time, chart.tuning.pitch(n.string, n.fret)) for n in notes]
    for c in chords:
        got += [(c.time, chart.tuning.pitch(s, f)) for s, f in enumerate(chart.templates[c.template].frets) if f >= 0]
    return got


def test_outputs_are_written_and_valid(run):
    song, report = run
    chart = Chart.load(report.chart_path)
    for path in (report.backing_path, report.guitar_path):
        info = sf.info(str(path))
        assert info.samplerate == 48_000 and abs(info.duration - song.duration) < 0.05
    assert chart.audio_backing == "backing_track_no_guitar.wav" and chart.audio_guitar == "isolated_guitar.wav"
    assert chart.notes or chart.chords



def test_the_chords_arrangement_follows_the_riffs(run):
    _, report = run
    chords = Chart.load(report.chart_path.with_name("song_chart.chords.json"))
    assert (chords.arrangement_name, chords.audio_backing) == ("Chords", "backing_track_no_guitar.wav")
    _, strums = chords.events_at(chords.max_difficulty)

    def bass_at(t: float) -> int | None:
        c = min(strums, key=lambda c: abs(c.time - t))
        frets = chords.templates[c.template].frets
        return min(chords.tuning.pitch(s, f) for s, f in enumerate(frets) if f >= 0) % 12 if abs(c.time - t) < 0.1 else None

    # Riff A: E5 on the bar, A5 on its third beat (see `rock_song`).
    beat = 60.0 / 110.0
    riffs = [1.0 + bar * 4 * beat for bar in range(0, 16, 2) if (bar // 2) % 4 != 3]
    right = sum(bass_at(t) == 4 for t in riffs) + sum(bass_at(t + 2 * beat) == 9 for t in riffs)
    assert right >= 0.8 * 2 * len(riffs)

def test_beat_grid_matches_the_drummer(run):
    song, report = run
    chart = Chart.load(report.chart_path)
    detected = np.array([b.time for b in chart.beats])
    err = np.array([np.min(np.abs(detected - t)) for t in song.beats])
    print(f"beats: median {1000 * np.median(err):.1f} ms, p90 {1000 * np.percentile(err, 90):.1f} ms, {chart.bpm:.2f} BPM (true {song.bpm})")
    assert np.median(err) < 0.008
    assert abs(chart.bpm - song.bpm) / song.bpm < 0.01
    bars = np.array([b.time for b in chart.beats if b.bar])
    bar_err = np.array([np.min(np.abs(bars - t)) for t in song.bars])
    print(f"bar lines: {100 * np.mean(bar_err < 0.05):.0f}% on the true downbeats")
    assert np.mean(bar_err < 0.05) > 0.9
    # Riffs A A / A B alternate every 4 bars: phrases must be recognised as repeats.
    played = [p.name for p in chart.phrases if p.name != "rest"]
    print(f"phrases: {' '.join(played)}")
    assert played == ["A", "B", "A", "B"]


def test_guitar_is_separated_from_the_band(run):
    song, report = run
    guitar, _ = sf.read(str(report.guitar_path))
    backing, _ = sf.read(str(report.backing_path))
    truth = audio_io.resample(song.guitar, song.sr, 48_000).mean(0)
    n = min(len(truth), len(guitar))
    corr = np.corrcoef(guitar.mean(1)[:n], truth[:n])[0, 1]
    leak = np.corrcoef(backing.mean(1)[:n], truth[:n])[0, 1]
    print(f"separation ({report.stem}): guitar stem r={corr:.2f}, guitar left in backing r={leak:.2f}")
    assert corr > 0.8
    assert abs(leak) < 0.3


def test_transcribed_notes_match_the_riff(run):
    song, report = run
    chart = Chart.load(report.chart_path)
    got = charted_pitches(chart, chart.max_difficulty)
    truth = [(n.time, n.pitch) for n in song.guitar_notes]
    used, tp = set(), 0
    for t, p in truth:
        for k, (gt, gp) in enumerate(got):
            if k not in used and gp == p and abs(gt - t) <= 0.05:
                used.add(k)
                tp += 1
                break
    precision, recall = tp / max(len(got), 1), tp / len(truth)
    f1 = 2 * precision * recall / max(precision + recall, 1e-9)
    print(f"notes: precision {precision:.2f}, recall {recall:.2f}, F1 {f1:.2f} ({len(got)} charted / {len(truth)} played)")
    assert f1 > 0.8


def test_generated_tab_is_playable(run):
    _, report = run
    chart = Chart.load(report.chart_path)
    slices: dict[float, list] = {}
    for n in chart.events_at(chart.max_difficulty)[0]:
        slices.setdefault(n.time, []).append((n.string, n.fret))
    for c in chart.events_at(chart.max_difficulty)[1]:
        slices.setdefault(c.time, []).extend((s, f) for s, f in enumerate(chart.templates[c.template].frets) if f >= 0)
    tab = []
    for t in sorted(slices):
        placements = slices[t]
        fretted = [f for _, f in placements if f > 0]
        tab.append(Fingered(t, [], placements, min(fretted) if fretted else 1))
    p = playability(tab, chart.tuning, fast=0.2)
    print(f"playability: max fast fret jump {p.max_fret_jump}, max stretch {p.max_stretch}, positions {sorted(p.positions)}")
    assert p.max_fret_jump < 12
    assert p.max_stretch <= 5


def test_progress_moves_forward_through_every_stage(run):
    _, report = run
    events = report.progress_events
    fractions = [f for _, f in events]
    assert fractions == sorted(fractions) and fractions[-1] == 1.0
    stages = list(dict.fromkeys(s for s, _ in events))
    assert stages == ["decode", "separate", "stems", "transcribe", "beats", "chart", "done"]
    inside = [f for s, f in events if s == "separate"]
    assert len(inside) > 3, "stem separation reports its own progress"


def test_repeated_phrases_are_written_the_same_way(run):
    _, report = run
    chart = Chart.load(report.chart_path)
    beats = [b.time for b in chart.beats]
    position = lambda t: float(np.interp(t, beats, np.arange(len(beats))))  # noqa: E731
    events = charted_pitches(chart, chart.max_difficulty)
    by_name: dict[str, list[set]] = {}
    for p in chart.phrases:
        if p.name == "rest":
            continue
        p0 = position(p.start)
        content = {(round((position(t) - p0) * 12), pitch) for t, pitch in events if p.start <= t < p.end}
        by_name.setdefault(p.name, []).append(content)
    repeated = [v for v in by_name.values() if len(v) > 1]
    assert repeated and all(all(c == v[0] for c in v) for v in repeated)


def test_the_hand_moves_only_when_the_music_does(run):
    _, report = run
    chart = Chart.load(report.chart_path)
    print(f"hand positions: {[(round(a.time, 2), a.fret, a.width) for a in chart.anchors]}")
    assert len(chart.anchors) <= 3
    assert all(b.time - a.time >= 0.6 for a, b in zip(chart.anchors, chart.anchors[1:]))
