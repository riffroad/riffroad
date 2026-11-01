"""`opensmith-ingest` command line."""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections.abc import Callable
from importlib.metadata import entry_points
from pathlib import Path

from .fingering import Tuning
from .tunings import by_name

TUNINGS = {
    "standard": "E Standard",
    "eb": "Eb Standard",
    "dropd": "Drop D",
    "d": "D Standard",
    "dropc#": "Drop C#",
    "dropc": "Drop C",
    "c": "C Standard",
    "dropb": "Drop B",
}

Emit = Callable[..., None]

# Commands added by other packages: an entry point of this group is a function given the
# subcommands and the help of --progress-json; it adds its command and returns what runs it,
# called with the parsed arguments and the JSON sink (None on a terminal). Its `formats`
# attribute names the file extensions the command imports: the app sends it those files.
PLUGINS = "opensmith_ingest.commands"


def _tuning(args: argparse.Namespace) -> Tuning | None:
    """None lets the pipeline detect the tuning from the notes."""
    if args.tuning == "auto":
        return None
    t = by_name(TUNINGS[args.tuning])
    return Tuning(t.strings, t.name, args.capo) if args.capo else t


class JsonLines:
    """Machine-readable output for the app: one JSON object per line on stdout. Anything else
    printed while working (libraries included) is moved to stderr."""

    def __init__(self) -> None:
        sys.stdout.flush()
        self._out = os.fdopen(os.dup(1), "w", buffering=1, encoding="utf-8")
        os.dup2(2, 1)

    def __call__(self, **fields) -> None:
        self._out.write(json.dumps(fields, ensure_ascii=False) + "\n")
        self._out.flush()


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="opensmith-ingest", description="Songs and tabs → OpenSmith game charts")
    sub = parser.add_subparsers(dest="cmd", required=True)
    machine = "report progress as JSON lines on stdout (used by the app)"

    audio = sub.add_parser("audio", help="MP3/WAV/FLAC → stems + transcription + chart")
    audio.add_argument("song", type=Path)
    audio.add_argument("-o", "--out", type=Path)
    audio.add_argument("--title", help="default: the file's tags, else its name")
    audio.add_argument("--artist", help="default: the file's tags, else its name")
    audio.add_argument("--device", choices=["cuda", "mps", "cpu"])
    audio.add_argument("--tuning", choices=["auto", *TUNINGS], default="auto")
    audio.add_argument("--capo", type=int, default=0)
    audio.add_argument("--stem", choices=["auto", "guitar", "other", "guitar+other"], default="auto")
    audio.add_argument(
        "--tab",
        default="auto",
        help="Guitar Pro tab whose notes to place on the recording: a file, 'auto' (one next to the song, named after it) or 'none'",
    )
    audio.add_argument("--track", type=int, help="track of the tab (default: the first guitar)")
    audio.add_argument("--progress-json", action="store_true", help=machine)

    retab = sub.add_parser("retab", help="place a Guitar Pro tab on a song already imported from audio")
    retab.add_argument("file", type=Path, help="the .gp3/.gp4/.gp5 tab")
    retab.add_argument("-o", "--out", type=Path, required=True, help="the imported song's folder")
    retab.add_argument("--track", type=int, help="track of the tab (default: the first guitar)")
    retab.add_argument("--progress-json", action="store_true", help=machine)

    gp = sub.add_parser("guitarpro", help="Guitar Pro .gp3/.gp4/.gp5/.gp → chart")
    gp.add_argument("file", type=Path)
    gp.add_argument("-o", "--out", type=Path)
    gp.add_argument("--track", type=int, help="track index (default: first guitar track)")
    gp.add_argument("--progress-json", action="store_true", help=machine)

    pak = sub.add_parser("feedpak", help="feedpak (folder or .feedpak archive) → chart + song audio (notes already in time)")
    pak.add_argument("file", type=Path)
    pak.add_argument("-o", "--out", type=Path)
    pak.add_argument("--arrangement", help="its id or name (default: lead, else combo, rhythm, another guitar part, bass)")
    pak.add_argument("--list", action="store_true", help="list the arrangements, and exit")
    pak.add_argument("--progress-json", action="store_true", help=machine)

    again = sub.add_parser("rechart", help="rebuild imported songs' charts from their stems (current charting rules)")
    again.add_argument("folders", type=Path, nargs="+")
    again.add_argument("--no-consensus", action="store_true", help="keep each repeat of a phrase as transcribed")
    again.add_argument("--retune", action="store_true", help="detect the tuning again instead of keeping it")

    export = sub.add_parser("export-feedpak", help="an imported song (its folder) → a .feedpak: every part, its audio and cover")
    export.add_argument("folder", type=Path)
    export.add_argument("-o", "--out", type=Path, required=True, help="the .feedpak to write")

    chords = sub.add_parser("chords", help="make a chord chart again from its own chords, some replaced everywhere (today's levels)")
    chords.add_argument("chart", type=Path, help="an MP3's chord chart (song_chart.chords.json)")
    chords.add_argument("--set", dest="changes", action="append", default=[], metavar="OLD=NEW", help="replace a chord everywhere: G=Em, F#m=F#5")
    chords.add_argument("-o", "--out", type=Path, help="where to write it (default: in place)")

    tab = sub.add_parser("tab", help="print a chart as tablature")
    tab.add_argument("chart", type=Path)
    tab.add_argument("--level", type=int)
    tab.add_argument("--from", dest="start", type=float, default=0.0)
    tab.add_argument("--to", dest="end", type=float)

    sub.add_parser("bench-guitarset", help="fingering agreement with GuitarSet guitarists")

    bench = sub.add_parser("bench", help="the MP3 pipeline measured against a library's hand-written charts, stage by stage")
    bench.add_argument("library", type=Path, help="a library folder (one song per folder, as the app keeps them)")
    bench.add_argument("--limit", type=int, default=30, help="songs drawn at random (0: all)")
    bench.add_argument("--seed", type=int, default=1, help="which songs are drawn")
    bench.add_argument("--work", type=Path, default=Path.home() / ".cache" / "opensmith-bench", help="cache of stems, transcriptions and results")
    bench.add_argument("--mix", action="store_true", help="also Basic Pitch on the whole mix (what separation changes)")
    bench.add_argument("--rechart", action="store_true", help="rebuild the cached charts with the current rules (no separation)")
    bench.add_argument("--again", action="store_true", help="measure the cached songs again")
    bench.add_argument("--ablation", action="store_true", help="also measure the clean-up with each of its steps off")
    bench.add_argument("--offset", type=int, default=0, help="skip this many songs of the draw (a held-out set: --offset 100)")
    bench.add_argument("--device", choices=["cuda", "mps", "cpu"])
    bench.add_argument("--label", help="name of the run in the dashboard (default: the source revision)")

    view = sub.add_parser("bench-view", help="the bench's dashboard in the browser: run under way, stages, gains, history")
    view.add_argument("--work", type=Path, default=Path.home() / ".cache" / "opensmith-bench")
    view.add_argument("--port", type=int, default=8765)
    view.add_argument("--library", type=Path, default=Path.home() / "Music" / "OpenSmith", help="the library the bench draws from (its size, for the coverage)")
    view.add_argument("--trainings", type=Path, help="a folder of training descriptions (JSON, see bench_view.py): the page follows their logs")

    demo = sub.add_parser("demo", help="the generated demo song shipped with the app (backing track + chart)")
    demo.add_argument("-o", "--out", type=Path, required=True)

    ship = sub.add_parser("bundle", help="an imported song made light to ship with the app (Ogg stems + its charts)")
    ship.add_argument("song", type=Path, help="the song's imported folder")
    ship.add_argument("-o", "--out", type=Path, required=True)
    ship.add_argument("--album", help="replaces the charts' album (a shipped song's credit)")

    sub.add_parser("formats", help="the file extensions installed plugins import, as JSON {extension: command}")
    formats: dict[str, str] = {}
    for entry in entry_points(group=PLUGINS):
        try:
            register = entry.load()
            run = register(sub, machine)
        except Exception as e:  # a broken plugin leaves the other commands working
            print(f"opensmith-ingest: plugin {entry.name} not loaded: {e}", file=sys.stderr)
            continue
        sub.choices[entry.name].set_defaults(plugin=run)
        formats.update({ext.lower().lstrip("."): entry.name for ext in getattr(register, "formats", ())})
    parser.set_defaults(formats=formats)
    return parser


def main(argv: list[str] | None = None) -> None:
    args = _parser().parse_args(argv)
    emit = JsonLines() if getattr(args, "progress_json", False) else None
    try:
        _run(args, emit)
    except Exception as e:
        if emit is None:
            raise
        emit(error=str(e) or type(e).__name__)
        sys.exit(1)
    sys.stdout.flush()


def imported(emit: Emit | None, chart, path: Path, **extra) -> None:
    """Reports an imported chart (plugins report theirs with it too)."""
    if emit:
        emit(done=True, chart=str(path), title=chart.title, artist=chart.artist, notes=len(chart.notes), chords=len(chart.chords), **extra)
    else:
        print(f"{chart.title}: {len(chart.notes)} notes, {len(chart.chords)} chords → {path}")


def _run(args: argparse.Namespace, emit: Emit | None) -> None:
    if getattr(args, "plugin", None):
        args.plugin(args, emit)
    elif args.cmd == "formats":
        print(json.dumps(args.formats))
    elif args.cmd == "audio":
        from . import audio_io
        from .naming import guess_title_artist
        from .pipeline import ingest_audio

        tags = audio_io.tags(args.song)
        # Tags first, cleaned like file names: videos often tag "Artist - Title (Official Video)".
        title, title_artist = guess_title_artist(tags.get("title") or args.song.stem, tags.get("artist"))
        title = args.title or title
        artist = args.artist or title_artist or tags.get("artist") or "Unknown"
        out = args.out or Path("out") / args.song.stem
        sink = (lambda stage, f: emit(stage=stage, fraction=round(f, 4))) if emit else None
        from .align import find_tab

        tab = None if args.tab == "none" else find_tab(args.song) if args.tab == "auto" else Path(args.tab)
        report = ingest_audio(
            args.song,
            out,
            title=title,
            artist=artist,
            tuning=_tuning(args),
            device=args.device,
            stem=args.stem,
            progress=sink,
            tab=tab,
            track=args.track,
        )
        if emit:
            c = report.chart
            extra = {"tab": tab.name, "confirmed": round(report.confirmed or 0.0, 3)} if tab is not None else {}
            imported(emit, c, report.chart_path, tuning=c.tuning.name, bpm=round(report.bpm, 1), seconds=round(report.total_seconds, 1), **extra)
            return
        print(report.summary())
        if report.tuning_choice is not None:
            c = report.tuning_choice
            from .harmony import NOTE_NAMES

            low = f"{NOTE_NAMES[c.lowest_played % 12]}{c.lowest_played // 12 - 1}" if c.lowest_played is not None else "-"
            print(f"tuning: {c.tuning.name} (lowest note played {low}; {c.below_standard} notes below E standard) — override with --tuning")
        print(f"→ {report.chart_path}")
    elif args.cmd == "guitarpro":
        if emit:
            emit(stage="chart", fraction=0.1)
        from .importers.guitarpro import load_guitarpro

        chart = load_guitarpro(args.file, track=args.track)
        out = args.out or Path("out") / args.file.stem
        out.mkdir(parents=True, exist_ok=True)
        chart.save(out / "song_chart.json")
        imported(emit, chart, out / "song_chart.json")
    elif args.cmd == "feedpak":
        from .importers.feedpak import Pack, ingest_feedpak

        if args.list:
            for a in Pack(args.file).arrangements():
                print(f"{a.get('id')}: {a.get('name', a.get('id'))}")
            return
        out = args.out or Path("out") / args.file.name.removesuffix(".feedpak")
        sink = (lambda stage, f: emit(stage=stage, fraction=round(f, 4))) if emit else None
        chart = ingest_feedpak(args.file, out, arrangement=args.arrangement, progress=sink)
        imported(emit, chart, out / "song_chart.json", tuning=chart.tuning.name, arrangement=chart.arrangement_name)
    elif args.cmd == "retab":
        from .pipeline import retab

        if emit:
            emit(stage="chart", fraction=0.1)
        report = retab(args.out, args.file, track=args.track)
        if emit:
            imported(emit, report.chart, report.chart_path, tab=args.file.name, confirmed=round(report.confirmed or 0.0, 3))
            return
        print(report.summary())
        print(f"→ {report.chart_path}")
    elif args.cmd == "rechart":
        from .pipeline import rechart

        for folder in args.folders:
            report: dict = {}
            chart = rechart(folder, consensus=not args.no_consensus, report=report, retune=args.retune)
            details = ", ".join(f"{k.replace('_', ' ')} {v}" for k, v in report.items())
            print(f"{chart.artist} — {chart.title}: {len(chart.notes)} notes, {len(chart.chords)} chords, {len(chart.anchors)} hand positions ({details})")
    elif args.cmd == "export-feedpak":
        from .importers.feedpak import export_feedpak

        print(json.dumps({"written": str(export_feedpak(args.folder, args.out))}))
    elif args.cmd == "chords":
        from .chart import Chart
        from .chord_chart import chords_of, parse_chord, rechord

        changes = {}
        for change in args.changes:
            old, _, new = change.partition("=")
            a, b = parse_chord(old.strip()), parse_chord(new.strip())
            if a is None or b is None:
                sys.exit(f"--set {change}: chords are named C, F#m, Bb5…")
            changes[a] = b
        chart = Chart.load(args.chart)
        before = chords_of(chart)[1]
        rechord(chart, changes).save(args.out or args.chart)
        print(json.dumps({"changed": sum(1 for c in before if c in changes)}))
    elif args.cmd == "tab":
        from .chart import Chart
        from .preview import render

        chart = Chart.load(args.chart)
        level = chart.max_difficulty if args.level is None else args.level
        print(f"{chart.artist} — {chart.title} [{chart.arrangement_name}, level {level}/{chart.max_difficulty}, {chart.bpm:.0f} BPM]")
        print(render(chart, level, start=args.start, end=args.end))
    elif args.cmd == "demo":
        from .demo import make_demo

        chart = make_demo(args.out)
        print(f"{chart.artist} — {chart.title}: {len(chart.notes)} notes, {len(chart.chords)} chords → {args.out}")
    elif args.cmd == "bundle":
        from .bundle import bundle

        files = bundle(args.song, args.out, album=args.album)
        print(f"{len(files)} files, {sum(f.stat().st_size for f in files) / 1e6:.1f} MB → {args.out}")
    elif args.cmd == "bench":
        from .bench import Run, SongResult, measure, references, summary

        songs = references(args.library, None, args.seed)[args.offset :]
        songs = songs[: args.limit] if args.limit else songs
        print(f"{len(songs)} hand-written charts drawn from {args.library}; work in {args.work}")
        options = {"limit": args.limit, "offset": args.offset, "seed": args.seed, "mix": args.mix, "rechart": args.rechart, "again": args.again, "ablation": args.ablation}
        run = Run(args.work, len(songs), options, args.label)
        for k, song in enumerate(songs, 1):
            run.progress(song.name)
            try:
                r = measure(song, args.work / song.name, mix=args.mix, again=args.again, rechart=args.rechart, ablation=args.ablation, device=args.device)
            except Exception as e:  # one song failing leaves the others measured
                r = SongResult(song.name, song.name, "", "", "", error=f"{type(e).__name__}: {e}")
            run.add(r)
            stages = ", ".join(f"{name} {s.f1():.0%}" for name, s in r.stages.items())
            print(f"{k}/{len(songs)} {r.artist} — {r.title}: {r.error or stages} ({r.seconds:.0f} s)", flush=True)
        run.save(finished=True)
        run.progress(None, finished=True)
        print(summary(run.results))
    elif args.cmd == "bench-view":
        from .bench_view import serve

        serve(args.work, args.port, args.library, args.trainings)
    elif args.cmd == "bench-guitarset":
        from .benchmark import evaluate, fetch_annotations

        score = evaluate(sorted(fetch_annotations().glob("*.jams")))
        print(f"{score.notes} notes: {100 * score.accuracy:.1f}% on the guitarist's string (lowest-fret baseline {100 * score.baseline:.1f}%)")
        for style, (n, hits) in score.by_style.items():
            print(f"  {style}: {100 * hits / n:.1f}% of {n}")


if __name__ == "__main__":
    main()
