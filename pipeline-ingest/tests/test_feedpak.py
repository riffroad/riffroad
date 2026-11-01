"""feedpak import: packs written here (folder and zip), read like the spec says (§2–§7)."""

import json
import shutil
import zipfile

import numpy as np
import pytest
import soundfile as sf
from test_import_cli import run_cli

from opensmith_ingest.chart import Chart
from opensmith_ingest.importers.feedpak import FeedpakError, Pack, choose, ingest_feedpak, load_feedpak, tuning_of

SR = 44_100


def write_pack(root, manifest: str, files: dict, seconds: float = 4.0):
    """A folder pack: `manifest.yaml`, JSON files, and a stereo sine WAV for each `.wav` named
    (its value: the amplitude)."""
    root.mkdir(parents=True)
    (root / "manifest.yaml").write_text(manifest, encoding="utf-8")
    for rel, content in files.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        if rel.endswith(".wav"):
            t = np.arange(int(seconds * SR)) / SR
            wave = (content * np.sin(2 * np.pi * 220 * t)).astype(np.float32)
            sf.write(str(path), np.stack([wave, wave], axis=1), SR)
        else:
            path.write_text(content if isinstance(content, str) else json.dumps(content), encoding="utf-8")
    return root


def zip_pack(folder, dst, *, with_folder=False):
    with zipfile.ZipFile(dst, "w") as z:
        for path in sorted(folder.rglob("*")):
            if path.is_file():
                rel = path.relative_to(folder).as_posix()
                z.write(path, f"{folder.name}/{rel}" if with_folder else rel)
    return dst


MANIFEST = """\
feedpak_version: "1.19.0"
title: "Night Drive"
artist: "The Larsens"
album: "Garage Days"
year: 2024
duration: 4.0
song_timeline: song_timeline.json
cover: cover.png
arrangements:
  - id: rhythm
    name: Rhythm
    file: arrangements/rhythm.json
    tuning: [-2, 0, 0, 0, 0, 0]
  - id: lead
    name: Lead
    file: arrangements/lead.json
    tuning: [-2, 0, 0, 0, 0, 0]
  - id: bass
    name: Bass
    type: bass
    file: arrangements/bass.json
    tuning: [-2, 0, 0, 0, 0, 0]
  - id: drums_kit
    type: drums
    drum_tab: drum_tab.json
  - id: keys
    type: piano
    notation: arrangements/notation_keys.json
stems:
  - id: full
    file: stems/full.wav
    default: false
  - id: guitar
    file: stems/guitar.wav
    default: true
"""

TIMELINE = {
    "version": 1,
    "tempos": [{"time": 0.0, "bpm": 120.0}],
    "time_signatures": [{"time": 0.0, "ts": [4, 4]}],
    "beats": [{"time": 0.5 * k, "measure": k // 4 + 1 if k % 4 == 0 else -1} for k in range(9)],
    "sections": [{"name": "intro", "number": 1, "time": 0.0}, {"name": "riff", "number": 1, "time": 2.0}],
}

# The same two-bar riff played twice: notes, a slide, a bend, hammer-on, palm-muted power chord.
RIFF = [
    {"t": 0.0, "s": 0, "f": 0, "sus": 0.0, "pm": True},
    {"t": 0.5, "s": 0, "f": 3, "sl": 5, "sus": 0.4},
    {"t": 1.0, "s": 1, "f": 5, "bn": 1.0},
    {"t": 1.5, "s": 1, "f": 7, "ho": 1, "fhm": True},
]


def riff_at(t0):
    return [dict(n, t=n["t"] + t0) for n in RIFF]


POWER = {"id": 0, "notes": [{"s": 0, "f": 0, "pkd": 0, "pm": True}, {"s": 1, "f": 0, "pm": True}]}
TEMPLATES = [{"name": "D5", "frets": [0, 0, -1, -1, -1, -1], "fingers": [0, 0, -1, -1, -1, -1]}]


def single_level():
    return {"name": "Rhythm", "notes": riff_at(0.0) + riff_at(2.0), "chords": [dict(POWER, t=3.9)], "templates": TEMPLATES, "anchors": [], "handshapes": []}


def laddered():
    """Lead with levels per phrase: level 0 the first note of each bar, level 1 everything."""

    def phrase(t0):
        notes = riff_at(t0)
        return {
            "start_time": t0,
            "end_time": t0 + 2.0,
            "max_difficulty": 1,
            "levels": [
                {"difficulty": 0, "notes": [notes[0], notes[2]], "chords": [], "anchors": [{"time": t0, "fret": 1, "width": 4}], "handshapes": []},
                {"difficulty": 1, "notes": notes, "chords": [dict(POWER, t=t0 + 1.9)], "anchors": [{"time": t0, "fret": 1, "width": 5}], "handshapes": []},
            ],
        }

    return {"name": "Lead", "notes": [], "chords": [], "templates": TEMPLATES, "phrases": [phrase(0.0), phrase(2.0)]}


BASS_JSON = {"name": "Bass", "tuning": [0, 0, 0, 0, 0, 0], "notes": [{"t": 0.0, "s": 0, "f": 0}, {"t": 1.0, "s": 3, "f": 2}, {"t": 2.0, "s": 1, "f": 5}]}


def full_pack(tmp_path, name="night.feedpak"):
    return write_pack(
        tmp_path / name,
        MANIFEST,
        {
            "song_timeline.json": TIMELINE,
            "arrangements/rhythm.json": single_level(),
            "arrangements/lead.json": laddered(),
            "arrangements/bass.json": BASS_JSON,
            "stems/full.wav": 0.5,
            "stems/guitar.wav": 0.9,
        },
    )


def test_lead_keeps_its_hand_written_levels_and_fingering(tmp_path):
    chart, _ = load_feedpak(full_pack(tmp_path))
    assert (chart.title, chart.artist, chart.album, chart.year) == ("Night Drive", "The Larsens", "Garage Days", 2024)
    assert chart.arrangement_name == "Lead" and chart.arrangement_type == "lead"
    assert chart.tuning.name == "Drop D" and chart.tuning.strings == (38, 45, 50, 55, 59, 64)
    assert chart.max_difficulty == 1
    # Level 0: first note of each bar; level 1: everything, on the strings and frets written.
    easy, _ = chart.events_at(0)
    assert [(n.time, n.string, n.fret) for n in easy] == [(0.0, 0, 0), (1.0, 1, 5), (2.0, 0, 0), (3.0, 1, 5)]
    notes, chords = chart.events_at(1)
    assert [(n.time, n.string, n.fret) for n in notes][:4] == [(0.0, 0, 0), (0.5, 0, 3), (1.0, 1, 5), (1.5, 1, 7)]
    assert [c.time for c in chords] == [1.9, 3.9]
    assert chart.templates[chords[0].template].name == "D5"
    # The same riff twice is the same phrase (dynamic difficulty, Loop Trainer).
    assert [(p.name, p.start, p.end, p.max_difficulty) for p in chart.phrases] == [("P1", 0.0, 2.0, 1), ("P1", 2.0, 4.0, 1)]
    assert [(a.time, a.width) for a in chart.anchors] == [(0.0, 5), (2.0, 5)]
    # The last chord at 3.9 s: the song lasts until a second after it, longer than the manifest says.
    assert chart.duration == pytest.approx(4.9)
    assert [(s.name, s.start, s.end) for s in chart.sections] == [("intro", 0.0, 2.0), ("riff", 2.0, pytest.approx(4.9))]
    assert chart.bpm == 120.0 and [b.bar for b in chart.beats[:5]] == [1, None, None, None, 2]


def test_techniques_are_carried_over(tmp_path):
    chart, _ = load_feedpak(full_pack(tmp_path))
    notes, chords = chart.events_at(1)
    by_time = {n.time: n.techniques for n in notes}
    assert by_time[0.0] == {"palmMute": True}
    assert by_time[0.5] == {"slideTo": 5}
    assert by_time[1.0] == {"bend": 1.0}, "feedpak bends are already in semitones"
    assert by_time[1.5] == {"hammerOn": True, "mute": True}
    assert chords[0].strum == "down" and chords[0].techniques == {"palmMute": True}


def test_a_single_level_pack_gets_generated_levels_with_its_fingering(tmp_path):
    chart, _ = load_feedpak(full_pack(tmp_path), arrangement="rhythm")
    assert chart.arrangement_type == "rhythm" and chart.max_difficulty == 4
    notes, chords = chart.events_at(chart.max_difficulty)
    assert [(n.time, n.string, n.fret) for n in notes] == [(t + o, s, f) for o in (0.0, 2.0) for t, s, f in ((0.0, 0, 0), (0.5, 0, 3), (1.0, 1, 5), (1.5, 1, 7))]
    assert len(chords) == 1 and chart.templates[chords[0].template].frets[:2] == [0, 0]
    assert {n.time: n.techniques.get("slideTo") for n in notes}[0.5] == 5
    easy, _ = chart.events_at(0)
    assert 0 < len(easy) < len(notes)


def test_bass_with_six_offsets_on_four_strings_is_a_four_string_bass(tmp_path):
    chart, _ = load_feedpak(full_pack(tmp_path), arrangement="Bass")
    assert chart.arrangement_type == "bass"
    # The manifest's tuning wins over the arrangement JSON's (§5.2).
    assert chart.tuning.strings == (26, 33, 38, 43) and chart.tuning.name == "Drop D"
    assert [(n.string, n.fret) for n in chart.events_at(chart.max_difficulty)[0]] == [(0, 0), (3, 2), (1, 5)]


@pytest.mark.parametrize(
    "entry, arr, used, strings, cents",
    [
        ({"tuning": [0] * 7}, {}, 7, (35, 40, 45, 50, 55, 59, 64), 0.0),
        ({"tuning": [0] * 5, "type": "bass"}, {}, 5, (23, 28, 33, 38, 43), 0.0),
        ({"tuning": [0] * 4, "centOffset": -1200.0, "type": "bass"}, {}, 4, (16, 21, 26, 31), 0.0),
        ({"centOffset": 11.8}, {"tuning": [-1] * 6}, 6, (39, 44, 49, 54, 58, 63), 11.8),
        ({}, {"tuning": [0] * 6, "capo": 2}, 6, (40, 45, 50, 55, 59, 64), 0.0),
    ],
)
def test_tunings(entry, arr, used, strings, cents):
    t = tuning_of(entry, arr, used)
    assert t.strings == strings and t.cents == cents
    assert t.capo == arr.get("capo", 0)


def test_the_arrangement_chosen_by_default_is_the_lead(tmp_path):
    found = Pack(full_pack(tmp_path)).arrangements()
    assert [a["id"] for a in found] == ["rhythm", "lead", "bass"], "drum and notation-only parts are not playable here"
    assert choose(found)["id"] == "lead"
    assert choose([a for a in found if a["id"] != "lead"])["id"] == "rhythm"
    assert choose([found[2]])["id"] == "bass"
    with pytest.raises(FeedpakError, match="no arrangement 'solo'.*rhythm, lead, bass"):
        choose(found, "solo")


def test_zip_and_folder_forms_read_the_same(tmp_path):
    folder = full_pack(tmp_path)
    expected = load_feedpak(folder)[0].to_dict()
    for k, with_folder in enumerate((False, True)):
        archive = zip_pack(folder, tmp_path / f"night{k}.feedpak", with_folder=with_folder)
        doc = load_feedpak(archive)[0].to_dict()
        assert doc["meta"]["source"]["file"] == archive.name
        doc["meta"]["source"] = expected["meta"]["source"]
        assert doc == expected


def test_jsonc_comments_are_stripped(tmp_path):
    manifest = MANIFEST.replace("arrangements/lead.json", "arrangements/lead.jsonc")
    text = "// hand-edited\n" + json.dumps(laddered()).replace('"name": "Lead"', '"name": "Lead /* not a comment */"', 1)
    text = text.replace('"phrases"', '/* the ladder */ "phrases"')
    folder = write_pack(tmp_path / "p.feedpak", manifest, {"song_timeline.json": TIMELINE, "arrangements/lead.jsonc": text, "arrangements/rhythm.json": single_level(), "arrangements/bass.json": BASS_JSON})
    chart, _ = load_feedpak(folder)
    assert chart.max_difficulty == 1


def test_embedded_beats_are_used_without_a_song_timeline(tmp_path):
    manifest = MANIFEST.replace("song_timeline: song_timeline.json\n", "")
    rhythm = dict(single_level(), beats=[{"time": 0.25 * k, "measure": k // 8 + 1 if k % 8 == 0 else -1} for k in range(17)], sections=[{"name": "verse", "number": 1, "time": 0.0}])
    folder = write_pack(tmp_path / "p.feedpak", manifest, {"arrangements/rhythm.json": rhythm, "arrangements/lead.json": laddered(), "arrangements/bass.json": BASS_JSON})
    chart, _ = load_feedpak(folder, arrangement="lead")
    assert chart.bpm == 240.0, "tempo from the first arrangement's beats"
    assert [s.name for s in chart.sections] == ["verse"]


@pytest.mark.parametrize("bad", ["../escape.json", "/etc/passwd", "a//b.json", "C:/x.json", "a\\b.json"])
def test_paths_leaving_the_pack_are_refused(tmp_path, bad):
    folder = write_pack(tmp_path / "p.feedpak", MANIFEST.replace("arrangements/lead.json", bad), {"song_timeline.json": TIMELINE})
    with pytest.raises(FeedpakError, match="unsafe path"):
        load_feedpak(folder, arrangement="lead")


def test_a_newer_major_version_or_a_broken_pack_says_so(tmp_path):
    newer = write_pack(tmp_path / "a.feedpak", MANIFEST.replace('"1.19.0"', '"2.0.0"'), {})
    with pytest.raises(FeedpakError, match="feedpak 2.0.0 is newer"):
        Pack(newer)
    empty = write_pack(tmp_path / "b.feedpak", 'title: "X"\nartist: "Y"\n', {})
    with pytest.raises(FeedpakError, match="no arrangements, stems"):
        Pack(empty)
    drums_only = write_pack(tmp_path / "c.feedpak", 'title: X\nartist: Y\narrangements:\n  - id: d\n    type: drums\n    drum_tab: d.json\nstems:\n  - id: full\n    file: s.wav\n', {})
    with pytest.raises(FeedpakError, match="no guitar or bass arrangement"):
        load_feedpak(drums_only)
    not_a_pack = tmp_path / "d.feedpak"
    not_a_pack.write_bytes(b"nothing")
    with pytest.raises(FeedpakError, match="not a feedpak"):
        Pack(not_a_pack)


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="decoding the stems needs ffmpeg")
def test_the_full_mixdown_becomes_the_backing_track(tmp_path):
    folder = full_pack(tmp_path)
    (folder / "cover.png").write_bytes(b"")  # unreadable picture: no cover, the import goes on
    out = tmp_path / "song"
    chart = ingest_feedpak(zip_pack(folder, tmp_path / "night.feedpak.zip"), out)
    audio, rate = sf.read(str(out / "song.wav"))
    assert rate == 48_000 and audio.shape[1] == 2
    assert abs(len(audio) / rate - 4.0) < 0.01
    assert np.max(np.abs(audio)) == pytest.approx(0.5, abs=0.01), "the `full` stem, not the guitar one nor their sum"
    saved = Chart.load(out / "song_chart.json")
    assert saved.audio_backing == "song.wav" and saved.source_kind == "feedpak" and saved.title == chart.title
    assert not list(out.glob("feedpak-*")), "scratch files are removed"
    # The other guitar arrangement goes beside it, bass aside (a six-string highway).
    assert sorted(p.name for p in out.glob("song_chart.*.json")) == ["song_chart.rhythm.json"]
    rhythm = Chart.load(out / "song_chart.rhythm.json")
    assert (rhythm.arrangement_name, rhythm.arrangement_type, rhythm.audio_backing) == ("Rhythm", "rhythm", "song.wav")
    assert rhythm.duration == saved.duration


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="decoding the stems needs ffmpeg")
def test_the_default_stems_are_mixed_when_there_is_no_mixdown(tmp_path):
    manifest = MANIFEST.replace("  - id: full\n    file: stems/full.wav\n    default: false\n", "  - id: drums\n    file: stems/drums.wav\n    default: on\n")
    files = {"song_timeline.json": TIMELINE, "arrangements/rhythm.json": single_level(), "arrangements/lead.json": laddered(), "arrangements/bass.json": BASS_JSON, "stems/guitar.wav": 0.4, "stems/drums.wav": 0.3}
    out = tmp_path / "song"
    ingest_feedpak(write_pack(tmp_path / "p.feedpak", manifest, files), out)
    audio, _ = sf.read(str(out / "song.wav"))
    assert np.max(np.abs(audio)) == pytest.approx(0.7, abs=0.01)


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="decoding the stems needs ffmpeg")
def test_the_command_reports_json_lines(tmp_path):
    folder = full_pack(tmp_path)
    code, lines = run_cli("feedpak", str(folder), "-o", str(tmp_path / "song"), "--progress-json")
    assert code == 0
    assert lines[0]["stage"] == "decode" and lines[-1]["done"] is True
    assert lines[-1]["arrangement"] == "Lead" and lines[-1]["tuning"] == "Drop D"
    code, lines = run_cli("feedpak", str(folder), "--arrangement", "solo", "-o", str(tmp_path / "x"), "--progress-json")
    assert code == 1 and "no arrangement 'solo'" in lines[-1]["error"]


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="decoding the stems needs ffmpeg")
@pytest.mark.parametrize("stated", [2.0, 9.0])
def test_a_stale_duration_gives_way_to_the_audio_and_the_notes(tmp_path, stated):
    """Packs seen in the wild: a manifest and a beat grid that stop before the notes and audio
    do, or a duration longer than the audio."""
    manifest = MANIFEST.replace("duration: 4.0", f"duration: {stated}")
    timeline = dict(TIMELINE, beats=TIMELINE["beats"][:5])  # the grid stops at 2 s
    files = {"song_timeline.json": timeline, "arrangements/rhythm.json": single_level(), "arrangements/lead.json": laddered(), "arrangements/bass.json": BASS_JSON, "stems/full.wav": 0.5, "stems/guitar.wav": 0.5}
    pack = write_pack(tmp_path / "p.feedpak", manifest, files, seconds=6.0)
    for arrangement in ("rhythm", "lead"):
        chart = ingest_feedpak(pack, tmp_path / arrangement, arrangement=arrangement)
        assert chart.duration == pytest.approx(6.0), "as long as the audio"
        assert chart.beats[-1].time == pytest.approx(6.0, abs=0.5), "the grid goes on at the same pace"
        assert [b.bar for b in chart.beats if b.bar][:4] == [1, 2, 3, 4], "bars numbered on"
        last = max(n.time for n in chart.notes)
        assert last == 3.5 and any(p.start <= last < p.end for p in chart.phrases), "no note left out of a phrase"


def test_a_song_goes_out_as_a_pack_and_comes_back_the_same(tmp_path):
    from opensmith_ingest.builder import MAX_DIFFICULTY, BeatGrid
    from opensmith_ingest.chord_chart import build_chord_chart
    from opensmith_ingest.importers.feedpak import export_feedpak
    from opensmith_ingest.transcription import RawNote

    def held(pitches, first, beats):
        return [RawNote(first * 0.5, (first + beats) * 0.5, p, 0.8) for p in pitches]

    # An MP3's chord chart (C, then a doubtful beat strummed muted, then G) and its recording.
    notes = held([48, 52, 55, 60], 0, 4) + held([48, 52, 57], 4, 1) + held([48, 52, 55, 60], 5, 3) + held([43, 47, 50, 55, 59, 67], 8, 8)
    song = tmp_path / "Band - Song"
    song.mkdir()
    chart = build_chord_chart(notes, BeatGrid.regular(120.0, 8.0), title="Song", artist="Band", duration=8.0)
    chart.audio_backing = "backing.wav"
    chart.save(song / "song_chart.json")
    t = np.arange(8 * SR) / SR
    sf.write(str(song / "backing.wav"), np.stack([0.2 * np.sin(2 * np.pi * 220 * t)] * 2, axis=1).astype(np.float32), SR)
    pack = export_feedpak(song, tmp_path / "Song.feedpak")
    assert zipfile.is_zipfile(pack)
    back = ingest_feedpak(pack, tmp_path / "back")
    assert (back.title, back.artist, back.source_kind) == ("Song", "Band", "feedpak")

    def seen(c, level):
        n, ch = c.events_at(level)
        return sorted((x.time, x.string, x.fret, bool(x.techniques.get("mute"))) for x in n), sorted(
            (x.time, tuple(c.templates[x.template].frets), bool(x.techniques.get("mute"))) for x in ch
        )

    for level in range(MAX_DIFFICULTY + 1):
        assert seen(back, level) == seen(chart, level), level
    assert any(m for *_, m in seen(back, MAX_DIFFICULTY)[1])
