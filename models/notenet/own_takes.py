"""The player's own recording sessions (Lessons → Your guitar) into takes like Guitar-TECHS's: the
guitar as the cable carried it, each note or strum moved onto its real attack (a beginner plays
early or late), the ones not played, or not at the pitch asked, left out. The note session
becomes `<take>_singlenotes` (the virtual guitarist's sample bank reads it: the player's own
guitar, pickups and cable), the chord session `<take>_chords` (real playing for the note
detector and the judging benches).

uv run --project pipeline-ingest python -I models/notenet/own_takes.py ~/Music/OpenSmith/.takes <takes out>
"""

import json
import sys
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf

SESSIONS = {"record-notes": "singlenotes", "record-chords": "chords"}
EARLY, LATE = 0.25, 0.5  # how far from the click an attack is looked for (s)
RISE = np.log(2.0)  # an attack: the level up at least twofold (6 dB) within ~20 ms
PITCH_TOLERANCE = 0.7  # semitones, the octave aside (the low strings fool pitch trackers)
CHORD_SHARE = 0.5  # of the chroma energy in the chord's own pitch classes


def song_to_sample(anchors: list, sr: int, last: bool = False):
    """Song time → sample of the take, from its (sample, song time) anchors. A lesson in wait
    mode stood still on each note until it was played: its anchors repeat a song time, and `last`
    takes the end of such a stop rather than its start."""
    pairs: dict[float, int] = {}
    for sample, time in anchors:
        if last or time not in pairs:
            pairs[time] = sample
    times = np.array(sorted(pairs), dtype=float)
    samples = np.array([pairs[t] for t in sorted(pairs)], dtype=float)

    def at(t: float) -> float:
        if len(times) == 1 or t <= times[0]:
            return samples[0] + (t - times[0]) * sr
        if t >= times[-1]:
            return samples[-1] + (t - times[-1]) * sr
        return float(np.interp(t, times, samples))

    return at


def attack(env: np.ndarray, span: tuple[int, int]) -> int | None:
    """The attack (ms) nearest the strongest rise of `env` (1 ms frames) within `span` (ms)."""
    lo, hi = max(span[0], 40), min(span[1], len(env) - 12)
    if hi <= lo:
        return None
    log = np.log(env + 1e-7)
    before = np.array([log[i - 30 : i - 10].mean() for i in range(lo, hi)])
    after = np.array([log[i : i + 10].mean() for i in range(lo, hi)])
    k = int(np.argmax(after - before))
    if after[k] - before[k] < RISE:
        return None
    peak = lo + k
    floor = np.median(env[peak - 40 : peak - 10]) + 1e-9
    above = np.where(env[peak - 10 : peak + 10] > 6 * floor)[0]
    return peak - 10 + int(above[0]) if len(above) else peak


def pitch_ok(x: np.ndarray, sr: int, start: int, midi: int) -> bool:
    """Whether the note after `start` is `midi`, give or take an octave."""
    cut = x[start + int(0.04 * sr) : start + int(0.24 * sr)]
    if len(cut) < int(0.1 * sr):
        return False
    f0 = librosa.yin(cut, fmin=60, fmax=1500, sr=sr, frame_length=4096)
    heard = float(np.median(12 * np.log2(f0 / 440.0) + 69))
    off = (heard - midi + 6) % 12 - 6
    return abs(off) <= PITCH_TOLERANCE and abs(heard - midi) <= 12 + PITCH_TOLERANCE


def chord_ok(x: np.ndarray, sr: int, start: int, pitches: list[int]) -> bool:
    """Whether the strum after `start` sounds mostly the chord's pitch classes."""
    cut = x[start + int(0.03 * sr) : start + int(0.4 * sr)]
    if len(cut) < int(0.2 * sr):
        return False
    chroma = librosa.feature.chroma_stft(y=cut, sr=sr, n_fft=8192, hop_length=2048).mean(axis=1)
    classes = {p % 12 for p in pitches}
    # librosa's chroma starts at C.
    return chroma[[c for c in classes]].sum() / (chroma.sum() + 1e-9) >= CHORD_SHARE


def convert(folder: Path, out_base: Path) -> str | None:
    chart = json.loads((folder / "chart.json").read_text())
    kind = SESSIONS.get(chart["meta"]["source"]["file"])
    if kind is None:
        return None
    meta = json.loads((folder / "take.json").read_text())
    x, sr = sf.read(folder / "guitar.wav", dtype="float32")
    first, last = song_to_sample(meta["anchors"], sr), song_to_sample(meta["anchors"], sr, last=True)
    env = np.abs(x[: len(x) // (sr // 1000) * (sr // 1000)]).reshape(-1, sr // 1000).mean(axis=1)
    tuning = chart["arrangement"]["tuning"]["strings"]

    def expected(t: float) -> tuple[int, int]:
        """Where an attack at song time `t` may show in the recording (ms): from a little early
        to a little late (the live game took the latency off), the whole stop in wait mode."""
        t += meta.get("inputOffset", 0.0)
        return int(first(t - EARLY) / sr * 1000), int(last(t + LATE) / sr * 1000)

    notes, chords, dropped = [], [], 0
    for n in chart["notes"]:
        ms = attack(env, expected(n["time"]))
        if ms is None or not pitch_ok(x, sr, ms * sr // 1000, tuning[n["string"]] + n["fret"]):
            dropped += 1
            continue
        notes.append({**n, "time": round(ms / 1000, 4)})
    for c in chart["chords"]:
        frets = chart["chordTemplates"][c["template"]]["frets"]
        ms = attack(env, expected(c["time"]))
        if ms is None or not chord_ok(x, sr, ms * sr // 1000, [tuning[s] + f for s, f in enumerate(frets) if f >= 0]):
            dropped += 1
            continue
        chords.append({**c, "time": round(ms / 1000, 4)})
    # Each one rings until the next, at most as long as it was asked to.
    events = sorted(notes + chords, key=lambda e: e["time"])
    for e, nxt in zip(events, events[1:] + [None]):
        until = (nxt["time"] - 0.02) if nxt else len(x) / sr
        e["sustain"] = round(max(0.0, min(until - e["time"], max(e.get("sustain", 0.0), 1.0))), 3)
    duration = len(x) / sr
    doc = {
        **chart,
        "meta": {**chart["meta"], "duration": duration, "generator": "own_takes.py"},
        "beats": [],
        "sections": [],
        "phrases": [{"name": "all", "start": 0.0, "end": duration, "maxDifficulty": 0}],
        "notes": notes,
        "chords": chords,
        "anchors": [],
        "handShapes": [],
    }
    name = f"{folder.name}_{kind}"
    out = out_base / name
    out.mkdir(parents=True, exist_ok=True)
    sf.write(out / "guitar.wav", x, sr, subtype="FLOAT")
    (out / "chart.json").write_text(json.dumps(doc))
    take = {**meta, "title": name, "anchors": [[0, 0.0]], "inputOffset": 0.0, "levels": [0]}
    (out / "take.json").write_text(json.dumps(take, indent=1))
    return f"{name}: {len(notes)} notes, {len(chords)} chords kept, {dropped} left out"


def main(takes: Path, out: Path):
    done = [convert(f, out) for f in sorted(p.parent for p in takes.glob("*/take.json"))]
    print("\n".join(d for d in done if d) or "no recording session among these takes")


if __name__ == "__main__":
    main(Path(sys.argv[1]).expanduser(), Path(sys.argv[2]).expanduser())
