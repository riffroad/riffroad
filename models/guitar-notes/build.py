"""The guitar notes the engine plays its songs on: every string at frets 0 to 15, plain and
palm-muted, as two players of Guitar-TECHS (CC BY 4.0, https://guitar-techs.github.io) played
them, direct input. Each note is cut on its real attack, tuned to its exact pitch, set to the same
loudness; the second player's darker guitar is brought most of the way to the first's. A note
missing from the recordings is its neighbour a fret up or down, retuned.
Writes one Ogg Vorbis stream of all the notes and its index (JSON).

uv run --project pipeline-ingest python -I models/guitar-notes/build.py <takes> engine-rt/session/assets/guitar-notes

<takes>: Guitar-TECHS items made into takes by models/notenet/guitartechs.py.
"""

import json
import sys
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf
from scipy import signal

SR = 48_000
OPEN = [40, 45, 50, 55, 59, 64]
FRETS = range(16)
PLAYERS = ["P1", "P2"]
# Kind: (take name, longest kept in s, fade-out in s, loudness of the first 200 ms in dBFS).
KINDS = {"plain": ("singlenotes_allsinglenotes", 2.2, 0.12, -20.0), "palmmute": ("techniques_PalmMute", 0.6, 0.04, -23.0)}
GAP = int(0.1 * SR)


def attack(x: np.ndarray, t: float) -> int:
    """The attack near `t` (the MIDI onset can be late or early): the steepest 1 ms rise from
    150 ms before to 150 ms after, taken back to where the level was under a tenth of the note's,
    and 2 ms more."""
    lo = max(0, int((t - 0.15) * SR))
    env = np.convolve(np.abs(x[lo : int((t + 0.15) * SR)]), np.ones(48) / 48, "same")
    k = int(np.argmax(env[48:] - env[:-48])) + 48
    level = env[k : k + int(0.03 * SR)].max()
    quiet = np.nonzero(env[:k] < 0.1 * level)[0]
    j = int(quiet[-1]) if quiet.size else 0
    return max(0, lo + j - int(0.002 * SR))


def pitch(x: np.ndarray, short: bool) -> float | None:
    """The note's steady pitch (Hz), to 1 cent."""
    seg = x[int(0.02 * SR) : int(0.25 * SR)] if short else x[int(0.08 * SR) : int(0.7 * SR)]
    f0 = librosa.yin(seg, fmin=70, fmax=1000, sr=SR, frame_length=2048 if short else 4096)
    f0 = f0[(f0 > 72) & (f0 < 990)]
    return float(np.median(f0)) if f0.size else None


def retune(x: np.ndarray, ratio: float) -> np.ndarray:
    """Played `ratio` times slower: lower by that ratio, and longer."""
    return librosa.resample(x, orig_sr=SR, target_sr=SR * ratio, res_type="soxr_hq")


def cut(take: Path, kind: str) -> dict[tuple[int, int], np.ndarray]:
    """(string, fret) → the note from its attack, tuned, faded in over 1 ms and out at its end."""
    name, longest, fade, _ = KINDS[kind]
    x, sr = sf.read(take / "guitar.wav", dtype="float64")
    assert sr == SR
    x = signal.sosfiltfilt(signal.butter(2, 40, "highpass", fs=SR, output="sos"), x)  # drift and rumble out
    notes = sorted(json.loads((take / "chart.json").read_text())["notes"], key=lambda n: n["time"])
    found: dict[tuple[int, int], np.ndarray] = {}
    for k, n in enumerate(notes):
        key = (n["string"], n["fret"])
        if n["fret"] > FRETS[-1] + 1:
            continue
        # The next note played: the takes play one every 4 s, the MIDI pickup's ghosts in between
        # (other strings ringing along) don't end this one.
        nxt = next((m["time"] for m in notes[k + 1 :] if m["time"] > n["time"] + 1.0), np.inf)
        i = attack(x, n["time"])
        end = min(n["time"] + n["sustain"] + 0.3, nxt - 0.01, n["time"] + longest + 0.1)
        note = x[i : int(end * SR)]
        if len(note) < int(0.1 * SR):
            continue
        # Of a note found twice, the one really played and let ring: the MIDI pickup also
        # reports ghosts, and a note picked again cuts the one before short.
        def score(v: np.ndarray) -> float:
            return float(np.abs(v[: int(0.15 * SR)]).max()) * min(1.0, len(v) / (longest * SR))

        if key not in found or score(note) > score(found[key]):
            found[key] = note
    out = {}
    for s in range(6):
        for f in FRETS:
            src = next((f2 for f2 in (f, f + 1, f - 1) if (s, f2) in found), None)
            if src is None:
                print(f"  {take.name}: string {s} fret {f} missing")
                continue
            note = found[(s, src)]
            written = librosa.midi_to_hz(OPEN[s] + src)
            heard = pitch(note, kind == "palmmute")
            # A pitch far from the note's is the measure gone wrong (a harmonic), not the guitar.
            if heard is None or abs(1200 * np.log2(heard / written)) > 40:
                heard = written
            note = retune(note, heard / librosa.midi_to_hz(OPEN[s] + f))[: int(longest * SR)]
            ramp = np.clip(np.arange(len(note)) / (0.001 * SR), 0, 1) * np.clip((len(note) - np.arange(len(note))) / (fade * SR), 0, 1)
            out[(s, f)] = note * ramp
    return out


def loudness(note: np.ndarray, kind: str) -> np.ndarray:
    """At the kind's loudness over its first 200 ms, peaks under 0.95."""
    rms = np.sqrt(np.mean(note[: int(0.2 * SR)] ** 2))
    note = note * 10 ** (KINDS[kind][3] / 20) / max(rms, 1e-9)
    return note / max(1.0, np.abs(note).max() / 0.95)


def matching_fir(x: np.ndarray, target: np.ndarray, strength: float) -> np.ndarray:
    """An EQ bringing `x`'s long-term spectrum toward `target`'s, smoothed over a third of an
    octave, at most ±15 dB. Minimum phase, as an analog EQ: nothing rings before an attack."""
    f, px = signal.welch(x, SR, nperseg=8192)
    _, pt = signal.welch(target, SR, nperseg=8192)
    ratio = 10 * np.log10((pt + 1e-20) / (px + 1e-20))
    smooth = np.array([ratio[(f >= fc / 2 ** (1 / 6)) & (f <= fc * 2 ** (1 / 6))].mean() if fc > 0 else 0.0 for fc in f])
    smooth = np.clip(np.nan_to_num(smooth), -15, 15) * strength
    smooth[f < 60] = smooth[np.argmax(f >= 60)]
    # The minimum-phase filter keeps the square root of the magnitude it is given.
    return signal.minimum_phase(signal.firwin2(4095, f / (SR / 2), 10 ** (smooth / 10)), method="homomorphic")


def main(takes: Path, out: Path) -> None:
    notes = {(p, kind): cut(takes / f"{p}_{KINDS[kind][0]}", kind) for p in PLAYERS for kind in KINDS}
    # The second player's guitar is much darker: most of the way toward the first's, a little of
    # its own kept, measured on the same plain notes.
    shared = sorted(set(notes[("P1", "plain")]) & set(notes[("P2", "plain")]))
    fir = matching_fir(np.concatenate([notes[("P2", "plain")][k] for k in shared]), np.concatenate([notes[("P1", "plain")][k] for k in shared]), 0.8)
    for kind in KINDS:
        notes[("P2", kind)] = {k: signal.fftconvolve(v, fir)[: len(v)] for k, v in notes[("P2", kind)].items()}
    stream, index, at = [], [], 0
    for (p, kind), by_key in notes.items():
        for (s, f), v in sorted(by_key.items()):
            v = loudness(v, kind)
            index.append([PLAYERS.index(p), kind, s, f, at, len(v)])
            stream += [v, np.zeros(GAP)]
            at += len(v) + GAP
    out.parent.mkdir(parents=True, exist_ok=True)
    audio = np.concatenate(stream).astype(np.float32)
    # libsndfile's Vorbis writer crashes on large writes: a second at a time.
    with sf.SoundFile(out.with_suffix(".ogg"), "w", SR, 1, format="OGG", subtype="VORBIS", compression_level=0.5) as f:
        for i in range(0, len(audio), SR):
            f.write(audio[i : i + SR])
    meta = {
        "source": "Guitar-TECHS (Pedroza, Abreu, Corey, Roman, 2025), https://guitar-techs.github.io, CC BY 4.0",
        "sampleRate": SR,
        "players": PLAYERS,
        "notes": index,
    }
    out.with_suffix(".json").write_text(json.dumps(meta, separators=(",", ":")) + "\n")
    size = out.with_suffix(".ogg").stat().st_size
    print(f"{len(index)} notes, {at / SR:.0f} s, {size / 1e6:.1f} MB")


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]))
