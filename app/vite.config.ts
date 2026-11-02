import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Songs made by the pipeline (`opensmith-ingest … -o ../out/<song>`), else the demo song. */
const OUT = join(HERE, '..', 'out');
const LIBRARY = resolve(process.env.OPENSMITH_LIBRARY ?? (existsSync(OUT) ? OUT : join(HERE, 'demo')));

const MIME: Record<string, string> = {
  '.json': 'application/json',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
};

interface Entry {
  id: string;
  title: string;
  artist: string;
  duration: number;
  tuning: string;
  arrangement: string;
  arrangementType: string;
  notes: number;
  chords: number;
  cover: string | null;
  album: string | null;
  year: number | null;
  source: string;
  hasAudio: boolean;
  maxDifficulty: number;
  phrases: string[];
  phraseSections: string[];
  levelNotes: number[];
  techniques?: Record<string, number>;
  chordNames?: string[];
  /** The song's other arrangements: the charts beside it (`song_chart.<part>.json`). */
  others?: Entry[];
}

interface Span {
  name: string;
  start: number;
  end: number;
}

/** Notes and chords played at each level 0..maxDifficulty. */
function levelNotes(c: { notes: { levels: number[] }[]; chords: { levels: number[] }[]; arrangement: { maxDifficulty?: number } }): number[] {
  const out = new Array<number>((c.arrangement.maxDifficulty ?? 0) + 1).fill(0);
  for (const e of [...c.notes, ...c.chords]) {
    for (let d = e.levels[0]; d <= Math.min(e.levels[1], out.length - 1); d++) out[d]++;
  }
  return out;
}

type Played = { levels: number[]; techniques?: Record<string, unknown> };

/** Notes and chords played with each technique at the hardest level, by the chart's name for it
 * ("slide" for a slide), as the app's library tells them. */
function techniquesPlayed(c: { notes: Played[]; chords: Played[]; arrangement: { maxDifficulty?: number } }): Record<string, number> {
  const top = c.arrangement.maxDifficulty ?? 0;
  const out: Record<string, number> = {};
  const names = ['hammerOn', 'pullOff', 'slideTo', 'bend', 'vibrato', 'palmMute', 'mute', 'harmonic', 'pinchHarmonic', 'tremolo', 'tap'];
  for (const e of [...c.notes, ...c.chords]) {
    if (e.levels[1] < top || !e.techniques) continue;
    for (const k of names) {
      const v = e.techniques[k];
      const used = k === 'slideTo' ? v !== undefined && v !== null : k === 'bend' ? typeof v === 'number' && v > 0 : v === true;
      if (used) out[k === 'slideTo' ? 'slide' : k] = (out[k === 'slideTo' ? 'slide' : k] ?? 0) + 1;
    }
  }
  return out;
}

/** The chords strummed at the hardest level, by name, in the order they first come. */
function chordNames(c: { chords: { levels: number[]; template: number }[]; chordTemplates: { name: string }[]; arrangement: { maxDifficulty?: number } }): string[] {
  const top = c.arrangement.maxDifficulty ?? 0;
  const names = c.chords.filter((x) => x.levels[1] >= top).map((x) => c.chordTemplates[x.template]?.name.trim() ?? '');
  return [...new Set(names.filter(Boolean))];
}

/** The part of the song (section name, as written) where each phrase of `names` is first played. */
function phraseSections(c: { phrases: Span[]; sections?: Span[] }, names: string[]): string[] {
  return names.map((name) => {
    const start = c.phrases.find((p) => p.name === name)?.start ?? 0;
    return (c.sections ?? []).find((s) => s.start <= start + 1e-6 && start < s.end - 1e-6)?.name ?? '';
  });
}

function scan(root: string, dir = root, depth = 0, out: Entry[] = []): Entry[] {
  if (depth > 4 || !existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      scan(root, path, depth + 1, out);
      continue;
    }
    if (name !== 'song_chart.json') continue;
    const entry = entryOf(root, path);
    if (!entry) continue;
    const others = readdirSync(dir)
      .filter((n) => n.startsWith('song_chart.') && n.endsWith('.json') && n !== name)
      .sort()
      .flatMap((n) => entryOf(root, join(dir, n)) ?? []);
    out.push(others.length ? { ...entry, others } : entry);
  }
  return out;
}

/** A library song as the chart at `path` describes it (null: not a chart). */
function entryOf(root: string, path: string): Entry | null {
  const dir = dirname(path);
  try {
    const c = JSON.parse(readFileSync(path, 'utf8'));
    if (c.format !== 'opensmith-chart') return null;
    const phrases = [...new Set<string>(c.phrases.map((p: Span) => p.name).filter((n: string) => !n.startsWith('rest')))];
    return {
      id: relative(root, path).split(sep).join('/'),
      title: c.meta.title,
      artist: c.meta.artist,
      duration: c.meta.duration,
      tuning: c.arrangement.tuning.name,
      arrangement: c.arrangement.name,
      arrangementType: c.arrangement.type ?? 'lead',
      notes: c.notes.length,
      chords: c.chords.length,
      cover: existsSync(join(dir, 'cover.jpg')) ? relative(root, join(dir, 'cover.jpg')).split(sep).join('/') : null,
      album: c.meta.album ?? null,
      year: c.meta.year ?? null,
      source: c.meta.source?.kind ?? 'audio',
      hasAudio: Boolean(c.audio?.backing),
      maxDifficulty: c.arrangement.maxDifficulty ?? 0,
      phrases,
      phraseSections: phraseSections(c, phrases),
      levelNotes: levelNotes(c),
      techniques: techniquesPlayed(c),
      chordNames: chordNames(c),
    };
  } catch {
    return null; // not a chart
  }
}

/** Development song library: /library/index.json lists the charts under ../out, /library/* serves their files. */
function songLibrary(root = LIBRARY): Plugin {
  return {
    name: 'opensmith-library',
    configureServer(server) {
      server.middlewares.use('/library', (req, res, next) => {
        const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
        if (url === '/' || url === '/index.json') {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(scan(root)));
          return;
        }
        const file = resolve(root, '.' + url);
        if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader('Content-Type', MIME[extname(file).toLowerCase()] ?? 'application/octet-stream');
        res.setHeader('Content-Length', String(statSync(file).size));
        createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [songLibrary()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: process.env.TAURI_DEV_HOST || false,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 1500 },
  test: { environment: 'node', include: ['tests/**/*.test.ts'], setupFiles: ['tests/setup.ts'] },
});
