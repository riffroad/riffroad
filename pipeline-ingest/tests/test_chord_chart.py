"""Chord charts: chords recognised per beat from transcribed notes, beginner shapes, the chart."""

import pytest

from opensmith_ingest.builder import MAX_DIFFICULTY, BeatGrid
from opensmith_ingest.chart import Chart
from opensmith_ingest.chord_chart import build_chord_chart, ladder, recognise, root_margins, shape
from opensmith_ingest.fingering import Tuning
from opensmith_ingest.harmony import chord_name
from opensmith_ingest.transcription import RawNote

BEAT = 0.5
C, D, E, G, A = 0, 2, 4, 7, 9


def held(pitches, first_beat, beats, loud=0.8):
    return [RawNote(first_beat * BEAT, (first_beat + beats) * BEAT, p, loud) for p in pitches]


@pytest.mark.parametrize(
    "root,quality,frets",
    [
        (C, "maj", (-1, 3, 2, 0, 1, 0)),
        (G, "maj", (3, 2, 0, 0, 0, 3)),
        (D, "maj", (-1, -1, 0, 2, 3, 2)),
        (A, "maj", (-1, 0, 2, 2, 2, 0)),
        (E, "maj", (0, 2, 2, 1, 0, 0)),
        (A, "min", (-1, 0, 2, 2, 1, 0)),
        (E, "min", (0, 2, 2, 0, 0, 0)),
        (D, "min", (-1, -1, 0, 2, 3, 1)),
        (5, "maj", (1, 3, 3, 2, 1, 1)),  # F: the barre
        (10, "maj", (-1, 1, 3, 3, 3, 1)),  # Bb: the barre on the A string, lower than on the E
        (11, "min", (-1, 2, 4, 4, 3, 2)),  # Bm
        (E, "5", (0, 2, 2, -1, -1, -1)),
        (G, "5", (3, 5, 5, -1, -1, -1)),
        (C, "5", (-1, 3, 5, 5, -1, -1)),
    ],
)
def test_a_beginner_gets_the_shapes_they_learn_first(root, quality, frets):
    assert shape(root, quality) == frets


def test_shapes_follow_the_tuning():
    eb = Tuning((39, 44, 49, 54, 58, 63), "Eb Standard")
    assert shape(3, "maj", eb) == (0, 2, 2, 1, 0, 0)  # Eb sounds from the E shape, open
    drop = Tuning((38, 45, 50, 55, 59, 64), "Drop D")
    assert shape(D, "5", drop) == (0, 0, 0, -1, -1, -1)  # the one-finger power chord
    capo = Tuning(capo=2)
    assert shape(E, "min", capo) == (-1, -1, 2, 4, 5, 3)  # the Dm shape above the capo
    played = [capo.strings[s] + f for s, f in enumerate(shape(D, "maj", capo)) if f >= 0]
    assert chord_name(played) == "D"


def test_each_level_asks_a_little_more_of_the_chord():
    # F: its root, F5, the F without its barre, the barre chord.
    assert ladder(5, "maj") == [(1, (1, -1, -1, -1, -1, -1)), (2, (1, 3, 3, -1, -1, -1)), (3, (-1, -1, 3, 2, 1, 1)), (MAX_DIFFICULTY, (1, 3, 3, 2, 1, 1))]
    # G: the small one on the treble strings, one finger.
    assert ladder(G, "maj")[2] == (3, (-1, -1, 0, 0, 0, 3))
    # D has four strings: its whole shape from level 3.
    assert [top for top, _ in ladder(D, "maj")] == [1, 2, MAX_DIFFICULTY]
    # A power chord is all of them after its root.
    assert ladder(E, "5") == [(1, (0, -1, -1, -1, -1, -1)), (MAX_DIFFICULTY, (0, 2, 2, -1, -1, -1))]


def test_a_beat_whose_notes_say_another_chord_is_strummed_muted():
    # C, then a beat that sounds A minor (A C E) — too short a change for the song's flow, which
    # keeps C — then C again.
    notes = held([48, 52, 55, 60], 0, 4) + held([48, 52, 57], 4, 1) + held([48, 52, 55, 60], 5, 4)
    beats = [k * BEAT for k in range(10)]
    chords = recognise(notes, beats)
    assert chords == [(C, "maj")] * 9
    margins = root_margins(notes, beats, chords)
    assert margins[4] < 0 < min(margins[:4] + margins[5:])
    grid = BeatGrid.regular(120.0, 4.5)
    chart = build_chord_chart(notes, grid, title="Song", artist="Band", duration=4.5)
    top = chart.events_at(MAX_DIFFICULTY)[1]
    assert [c.techniques.get("mute", False) for c in top] == [False] * 4 + [True] + [False] * 4


def test_chords_are_recognised_beat_by_beat_and_rests_are_kept():
    # C for four beats, G for four, two silent beats, Am for four; a passing note in the C.
    notes = held([48, 52, 55, 60], 0, 4) + held([43, 47, 50, 55], 4, 4) + held([45, 52, 57, 60, 64], 10, 4)
    notes.append(RawNote(1.0, 1.2, 50, 0.5))
    beats = [k * BEAT for k in range(15)]
    assert recognise(notes, beats) == [(C, "maj")] * 4 + [(G, "maj")] * 4 + [None] * 2 + [(A, "min")] * 4


def test_power_chords_are_told_from_major_and_minor():
    notes = held([40, 47, 52], 0, 4) + held([45, 52, 57], 4, 4)
    assert recognise(notes, [k * BEAT for k in range(9)]) == [(E, "5")] * 4 + [(A, "5")] * 4


def test_the_chord_chart_strums_each_beat_and_eases_the_low_levels(tmp_path):
    notes = held([48, 52, 55, 60, 64], 0, 8) + held([43, 47, 50, 55, 59, 67], 8, 8)
    grid = BeatGrid.regular(120.0, 8.0)
    chart = build_chord_chart(notes, grid, title="Song", artist="Band", duration=8.0)
    assert (chart.arrangement_name, chart.arrangement_type) == ("Chords", "rhythm")
    top = chart.events_at(MAX_DIFFICULTY)
    assert [c.time for c in top[1]] == [k * BEAT for k in range(16)] and not top[0]
    names = [chart.templates[c.template].name for c in top[1]]
    assert names == ["C"] * 8 + ["G"] * 8
    assert chart.templates[top[1][0].template].frets == [-1, 3, 2, 0, 1, 0]
    # The easiest level: the bass of the chord on each bar.
    notes0, chords0 = chart.events_at(0)
    assert not chords0 and [(n.time, n.string, n.fret) for n in notes0] == [(0.0, 1, 3), (2.0, 1, 3), (4.0, 0, 3), (6.0, 0, 3)]
    # Then the power chord on every beat, the chord on its highest four strings, the whole chord.
    for level, frets in [(2, [-1, 3, 5, 5, -1, -1]), (3, [-1, -1, 2, 0, 1, 0]), (4, [-1, 3, 2, 0, 1, 0])]:
        notes_l, chords_l = chart.events_at(level)
        assert not notes_l and len(chords_l) == 16
        assert chart.templates[chords_l[0].template].frets == frets
    assert chart.templates[chart.events_at(2)[1][0].template].name == "C5"
    chart.save(tmp_path / "song_chart.chords.json")
    assert Chart.load(tmp_path / "song_chart.chords.json").arrangement_name == "Chords"
