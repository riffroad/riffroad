import './style.css';
import '@fontsource/chakra-petch/latin-500.css';
import '@fontsource/chakra-petch/latin-600.css';
import '@fontsource/chakra-petch/latin-700.css';
import '@fontsource/chakra-petch/latin-ext-600.css';
import '@fontsource/teko/latin-600.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import '@fontsource/jetbrains-mono/latin-600.css';
import './theme.css';
import { hardwareControls } from './ui/controls';
import { cableToTake, HwHud } from './hw-hud';
import { formatTime, leadIn, phraseIndexAt, startLevelFor, type Chart } from './chart';
import { coverElement } from './cover';
import { DemoEngine } from './engine/demo';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { isTauri, TauriEngine, type AudioStatus } from './engine/tauri';
import { findSong, type Engine, type SongEntry } from './engine/types';
import { DEFAULT_GUITAR, engineSettings, GuitarSettings, type GuitarValues } from './guitar-settings';
import { accuracy, type GameEvent } from './game/types';
import { missCounts, steadyOffset } from './game/timing';
import { GameView, type Pass, type PhraseDone } from './game/view';
import { Highway } from './highway/highway';
import { isScenery, SCENERIES, type SceneryId } from './highway/scenery';
import { Hud } from './hud';
import { Imports } from './imports';
import { arrangementLabel, Library, partLabel, partsOf, setSongLevel, songLevel, type LibraryPurpose } from './library';
import { gradeFor, record, recordAttack, recordPass, type Progress } from './progress';
import { AttackHud, attackLevel, AttackRun, attackStartLevel, attackSummary, STRIKES, type AttackDifficulty } from './score-attack';
import { accelerated, countNotes, percent, riffLoop, RiffPanel, roundSpeed, type PhraseState, type RiffChoice } from './riff';
import type { RiffLoop } from './engine/types';
import { phraseLabels } from './sections';
import { guitarFor, LAST_TUNING, mustTune, Tuner, TUNINGS, type HeldTuning } from './tuner';
import { AMP_MODELS, AmpPanel, DEFAULT_AMP, preset, sanitizeAmp, type AmpModelName, type AmpSettings } from './amp';
import { Welcome, welcomed, type WelcomePart } from './welcome';
import {
  ENCORE,
  buyGuitar,
  concludeGig,
  equipGuitar,
  localCareer,
  MIN_SONG,
  learnSong,
  acceptSponsor,
  fireComms,
  hireComms,
  post,
  resolveMoment,
  signContract,
  trainSlot,
  releaseAlbum,
  studioTake,
  buyGear,
  crowdStart,
  gigLineUp,
  guitarsOf,
  hireMusician,
  rehearseBand,
  rest,
  retuneStep,
  retunes,
  nameBand,
  weekIndex,
  newCareer,
  ownedGuitars,
  resetCareer,
  restWeek,
  sanitizeCareer,
  type Career,
  type GigOutcome,
  type GigSong,
  type Offer,
} from './career/career';
import { guitarOf } from './guitars';
import { award, careerTrophies, perfectSolo, songTrophies, TROPHIES, type GigFeat, type Trophy } from './trophies';
import { announce, showTrophies } from './trophy-board';
import { lessonChart, lessons, loadLessons, nextLesson, paceFactor, passed, recordLesson, type LessonPace } from './lessons';
import { LessonsScreen } from './lessons-screen';
import { interfaceSounds, SoundBoard } from './sfx';
import { SOUND_NAMES, type SoundName } from './sounds';
import { settleChallenge, TIERS, type Challenge } from './career/challenge';
import { changes, learnSkills, ratingOf, sampleOf, SKILLS, type SkillId } from './career/skills';
import { drillFor, DRILL_GOAL } from './career/training';
import { levelOf } from './career/difficulty';
import { rehearse, REHEARSAL, starter } from './career/repertoire';
import { Crowd } from './career/crowd';
import { CareerScreen } from './career/screen';
import { AccountChip, AccountPanel, askWhichSave, tauriCloud } from './account';
import { CloudSync, storagePart, type CloudStatus } from './cloud';
import { lang, LANGS, localize, setLang, t, tn, type Lang } from './i18n';
import { Perf, tour } from './perf';
import { thisWeek, weekOf, WorldScreen, type Card as BandCard, type Challenge as WorldChallenge } from './world';
import { careerBoost, onAt, words, type LiveEvent } from './events';
import { ghostAt, GhostHud, Trace, type Ghost } from './ghost';
import { addPractice, practiceCard, streakLine, streakOf, type PracticeLog } from './practice';

// The page's own text (index.html, written in French) in the interface language, before anything reads it.
localize();

/** Silence before the music, at most (the lessons always: their count-in is part of them). */
const LEAD_IN = 3;
/** The lead-in of the song being played (s). */
let lead = LEAD_IN;
/** Numbers grouped the way the interface language writes them. */
const NUMBERS = lang() === 'en' ? 'en-US' : 'fr-FR';
const STORAGE = 'opensmith.settings';
const FOLDER = 'opensmith.musicFolder';

interface Settings extends GuitarValues {
  invertStrings: boolean;
  speed: number;
  skill: number;
  startLevel: number;
  /** Loop Trainer speed and Accelerator, as last chosen. */
  riffSpeed: number;
  riffAccelerate: boolean;
  /** Mastered phrases fade out on their way to the strike line. */
  masterMode: boolean;
  /** Takes of what the guitar plays during songs, to tune the detection. */
  recordTakes: boolean;
  /** The tuning the guitar stays in, songs transposed to it (LAST_TUNING: the one it was last tuned to;
   * '': retuned for each song). */
  guitarTuning: string;
  /** A steady lag at the end of a song is compensated without asking. */
  autoLatency: boolean;
  /** How forgiving the judge is, from the next song. */
  judging: Judging;
  /** The place behind the highway outside the career (whose gigs bring their own). */
  scenery: SceneryId;
  /** The guitar's sound, in free play and in songs. */
  amp: AmpSettings;
  /** The desktop app plays itself (demo mode) instead of listening to the guitar. */
  autopilot: boolean;
}

const DEFAULTS: Settings = {
  invertStrings: false,
  speed: 12,
  skill: 0.92,
  startLevel: 0,
  riffSpeed: 0.75,
  riffAccelerate: true,
  masterMode: true,
  recordTakes: false,
  guitarTuning: LAST_TUNING,
  autoLatency: true,
  judging: 'normal',
  scenery: 'concert',
  amp: DEFAULT_AMP,
  autopilot: false,
  ...DEFAULT_GUITAR,
};
const STANDARD = [40, 45, 50, 55, 59, 64];
/** How forgiving the judge can be. */
type Judging = 'lenient' | 'normal' | 'strict';
const JUDGINGS: readonly Judging[] = ['lenient', 'normal', 'strict'];
/** Note speeds offered (highway units per second), as in the game settings. */
const SPEEDS = [
  { value: 9, label: t('Lente') },
  { value: 12, label: t('Normale') },
  { value: 16, label: t('Rapide') },
];

function loadSettings(): Settings {
  try {
    const saved = { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(STORAGE) ?? '{}') as Partial<Settings>) };
    return {
      ...saved,
      amp: sanitizeAmp(saved.amp),
      scenery: isScenery(saved.scenery) ? saved.scenery : 'concert',
      judging: JUDGINGS.includes(saved.judging) ? saved.judging : 'normal',
    };
  } catch {
    return { ...DEFAULTS };
  }
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const settings = loadSettings();
const engine: Engine = isTauri() ? new TauriEngine() : new DemoEngine();
const sfx = new SoundBoard(engine);

/** The sounds, made away from the screen's thread and handed to the engine as they come. */
function makeSounds(): void {
  try {
    const worker = new Worker(new URL('./sound-worker.ts', import.meta.url), { type: 'module' });
    let left = SOUND_NAMES.length;
    worker.onmessage = (e: MessageEvent<{ name: SoundName; rate: number; samples: Float32Array }>) => {
      engine.addSound(e.data.name, e.data.rate, e.data.samples);
      if (--left === 0) worker.terminate();
    };
  } catch (e) {
    console.warn('sons indisponibles', e);
  }
}
const perf = new Perf(document);
if (engine instanceof TauriEngine) perf.sink = (line) => engine.perfLog(line);
/** Seconds of song the highway shows ahead. */
const LOOKAHEAD = 3;
const highway = new Highway($('stage'), { invertStrings: settings.invertStrings, speed: settings.speed, lookahead: LOOKAHEAD });
// Selects, checkboxes and sliders, everywhere, dressed as stage hardware.
hardwareControls();
const hud = new Hud($('hud'));
const attackHud = new AttackHud($('hud'));
/** Score Attack: the run's points as it goes, and the run it races (ghost.ts). */
const ghostHud = new GhostHud($('hud'));
const trace = new Trace();
let ghost: Ghost | null = null;

/** The ghost of a Score Attack run of `id`: on the weekly challenge, the run just above the
 * player's on the board; otherwise their own best at that level. */
async function pickGhost(id: string, level: string): Promise<void> {
  ghost = null;
  ghostHud.show(null);
  if (worldRun && cloud) {
    const rival = await invoke<{ name: string; score: number; trace: number[] } | null>('cloud_rival').catch(() => null);
    if (rival?.trace.length) ghost = { name: rival.name, trace: rival.trace };
  }
  const own = progress[id]?.ghosts?.[level];
  if (!ghost && own?.length) ghost = { name: t('ta meilleure partie'), trace: own };
  if (currentId === id) ghostHud.show(ghost);
}
/** Score Attack: the run being played (fixed level, strikes), and the one asked for next. */
/** The tuning the guitar is in, as far as the app knows: the last song's or tuner's. */
let heldTuning: readonly number[] = [40, 45, 50, 55, 59, 64];
let attack: AttackRun | null = null;
let attackNext: AttackDifficulty | null = null;
/** Difficulty forced from the pause menu for this song (a step of `startLevelFor`); null: dynamic. */
let forcedStep: number | null = null;
/** The level chosen on the song card for the song about to start (null: dynamic). */
let levelNext: number | null = null;
/** The difficulty was forced during this play: the levels learnt are left as they were. */
let levelsForced = false;
/** The weekly challenge being played (a Score Attack of the career). */
let challengeRun: Challenge | null = null;
/** A run of the weekly challenge (world.ts), sent to its board at the end. */
let worldRun: WorldChallenge | null = null;
/** The song being recorded in the studio (a take for the album). */
let studioRun: string | null = null;
/** Playback speed of the song (outside the Loop Trainer): slowed down, a play is practice. */
let playSpeed = 1;
/** The lesson being played (its index), null for a song. */
let lessonRun: number | null = null;
/** A career training drill being played, on the card's rating it works. */
let drillRun: SkillId | null = null;
/** What the last song moved on the guitarist's card. */
let skillMoves: ReturnType<typeof changes> = [];
/** Each lesson's best, kept on this Mac. */
let lessonRecords = loadLessons();
const screens = {
  menu: $('menu'),
  library: $('library'),
  imports: $('importsScreen'),
  settings: $('settingsScreen'),
  pause: $('pause'),
  results: $('results'),
  career: $('career'),
  interlude: $('interlude'),
  encore: $('encore'),
  trophies: $('trophies'),
  lessons: $('lessons'),
  world: $('world'),
};
let imports: Imports | null = null;
let audio: AudioStatus | null = null;
/** Game events that arrived before their song's view existed (while loading). */
let backlog: GameEvent[] = [];
const form = $<HTMLFormElement>('settings');

/** The events on or coming (events.ts), from the server; asked again at most every ten minutes. */
let liveEvents: LiveEvent[] = [];
let eventsAt = 0;
async function refreshEvents(): Promise<void> {
  if (!(engine instanceof TauriEngine) || Date.now() - eventsAt < 10 * 60_000) return;
  eventsAt = Date.now();
  try {
    liveEvents = await invoke<LiveEvent[]>('cloud_events');
    updateMenu();
  } catch {
    // No server (offline, or no project): no event.
  }
}

/** The days played (practice.ts): seconds of music per day, with the progress. */
const PRACTICE = 'opensmith.practice';
function readPractice(): PracticeLog {
  try {
    return (JSON.parse(localStorage.getItem(PRACTICE) ?? '{}') as PracticeLog) ?? {};
  } catch {
    return {};
  }
}
/** Seconds played on the real guitar, not yet written down. */
let practicing = 0;
function notePractice(): void {
  if (practicing < 1) return;
  localStorage.setItem(PRACTICE, JSON.stringify(addPractice(readPractice(), new Date(), Math.round(practicing))));
  practicing = 0;
}

// The saves kept online (desktop app, signed in): up when they change, down from the menu.
const cloud =
  engine instanceof TauriEngine
    ? new CloudSync(
        tauriCloud,
        localStorage,
        {
          // The career as the app keeps it: in career.json beside the library (the window's
          // storage only held it before that, and is empty on a desktop app since).
          career: { 'opensmith.career': { read: () => engine.career.load(), write: (v) => engine.career.save(v as Career) } },
          progress: {
            'opensmith.progress': { read: () => engine.progress.load(), write: (v) => engine.progress.save(v as Progress) },
            'opensmith.lessons': storagePart(localStorage, 'opensmith.lessons'),
            'opensmith.practice': storagePart(localStorage, PRACTICE),
          },
        },
        askWhichSave,
      )
    : null;
let cloudSignedIn = false;
let cloudPulledAt = 0;
let cloudBusy: Promise<unknown> = Promise.resolve();

/** Fans at the start of this week, for the battle of the bands: `{week, start}`. */
const WEEK_FANS = 'opensmith.weekFans';
let cardSent = '';

/** The career as friends see it (world.ts), sent when it changed. */
async function publishCard(): Promise<void> {
  if (!career.band) return;
  const week = weekOf(Date.now() / 1000);
  type Mark = { week: number; start: number } | null;
  let mark: Mark;
  try {
    mark = JSON.parse(localStorage.getItem(WEEK_FANS) ?? 'null') as Mark;
  } catch {
    mark = null;
  }
  if (!mark || mark.week !== week || mark.start > career.fans) {
    mark = { week, start: career.fans };
    localStorage.setItem(WEEK_FANS, JSON.stringify(mark));
  }
  const card: BandCard = { band: career.band.name, act: career.act, fans: career.fans, week, weekFans: career.fans - mark.start };
  const text = JSON.stringify(card);
  if (text === cardSent) return;
  await invoke('cloud_set_card', { card });
  cardSent = text;
}

/** One sync at a time. What comes down (from the menu or the settings only) reloads the page
 * right away, before anything in memory can save over it. */
function cloudSync(pull: boolean): Promise<string> {
  const run = cloudBusy.then(async () => {
    if (!cloud) return '';
    let status = await tauriCloud.status();
    $('accountTab').hidden = !status.available;
    cloudSignedIn = !!status.email;
    accountStatus = status;
    accountChip.show(menuModes.includes(mode), status);
    if (!status.email) return '';
    // Saves go up once the e-mail is confirmed; asked again until it is.
    if (status.verified !== true) status = await tauriCloud.check();
    if (!status.verified) return t('Confirme ton e-mail (le lien reçu) pour envoyer tes sauvegardes.');
    const down = pull && (mode === 'menu' || mode === 'settings');
    const r = await cloud.sync(down);
    if (down) cloudPulledAt = Date.now();
    await publishCard();
    if (r.pulled.length) {
      location.reload();
      return t('Sauvegardes récupérées.');
    }
    if (r.conflict) return t('Une sauvegarde a aussi changé sur un autre Mac : retourne au menu pour choisir laquelle garder.');
    return r.pushed.length ? t('Sauvegardes envoyées.') : t('Tout est à jour.');
  });
  cloudBusy = run.catch(() => undefined);
  return run;
}

const cloudQuietly = (pull: boolean) => void cloudSync(pull).catch((e) => console.warn('compte', e));
setInterval(() => {
  notePractice();
  if (cloudSignedIn) cloudQuietly(false);
}, 60_000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) return;
  notePractice();
  if (cloudSignedIn) cloudQuietly(false);
});

/** The account at the top right of the menus; the last status known. */
const accountChip = new AccountChip(() => openSettings('account'));
let accountStatus: CloudStatus | null = null;
const menuModes = ['menu', 'library', 'imports', 'settings', 'career', 'trophies', 'amp', 'lessons', 'world'];

const accountPanel = new AccountPanel($('accountSettings'), {
  changed: (status) => {
    accountStatus = status;
    cloudSignedIn = !!status.email;
    accountChip.show(menuModes.includes(mode), status);
  },
  sync: () => cloudSync(true),
  signedOut: () => {
    cloud?.forget();
    cloudSignedIn = false;
  },
  // Like a save come down: the page reloads before anything in memory saves over it.
  restore: async (slot, version) => {
    const run = cloudBusy.then(() => cloud?.restore(slot, version));
    cloudBusy = run.catch(() => undefined);
    await run;
    location.reload();
  },
});
(form.elements.namedItem('scenery') as HTMLSelectElement).replaceChildren(...SCENERIES.map((s) => new Option(s.label, s.id)));
(form.elements.namedItem('guitarTuning') as HTMLSelectElement).replaceChildren(
  new Option(t('Le dernier où je l’ai accordée (morceaux décalés vers lui)'), LAST_TUNING),
  new Option(t('Celui de chaque morceau (je réaccorde)'), ''),
  ...TUNINGS.map((x) => new Option(x.name, x.name)),
);
// The interface language: kept apart from the game settings, a change reloads the page in it.
const langSelect = form.elements.namedItem('lang') as HTMLSelectElement;
langSelect.replaceChildren(...LANGS.map((l) => new Option(l.label, l.id)));
langSelect.value = lang();
langSelect.addEventListener('change', () => setLang(langSelect.value as Lang));

type Mode = 'menu' | 'library' | 'imports' | 'tuner' | 'settings' | 'amp' | 'riff' | 'play' | 'pause' | 'results' | 'career' | 'interlude' | 'encore' | 'trophies' | 'lessons' | 'world';
let mode: Mode = 'menu';
let songs: SongEntry[] = [];
let current: SongEntry | null = null;
let currentId: string | null = null;
let progress: Progress = {};
let chart: Chart | null = null;
let view: GameView | null = null;
let songTime = 0;

/** Loop Trainer on: the chosen phrases looping, and the accuracy of each pass. */
interface Riff {
  choice: RiffChoice;
  loop: RiffLoop;
  passes: number[];
}
let riff: Riff | null = null;
/** Where the Loop Trainer set-up goes back to when cancelled. */
let riffFrom: Mode = 'pause';
/** The song being loaded opens on the Loop Trainer (chosen from the menu). */
let riffFirst = false;
/** What the library was opened for. */
let libraryPurpose: LibraryPurpose = 'play';

/** A career gig being played: its setlist song after song, the crowd all along. */
interface GigRun {
  offer: Offer;
  setlist: string[];
  index: number;
  crowd: Crowd;
  songs: GigSong[];
  /** Tuning of the song being played: the next one in another tuning means retuning the guitar. */
  tuning: string | null;
  /** The tunings the band's guitars hold (two with the second guitar): switching between them
   * on stage costs the room nothing. */
  held: string[];
  /** Pauses taken during the gig. */
  pauses: number;
  /** The encore the crowd called for: the song chosen, then how it went once played through. */
  encore: string | null;
  encoreSong: GigSong | null;
  /** Trophies the gig's songs earned, announced with the gig's report. */
  earned: Trophy[];
}
let career: Career = newCareer();
let gig: GigRun | null = null;
let interludeTimer = 0;
/** The crowd's murmur under a song, against between songs. */
const ROOM_IN_SONG = 0.35;
/** Seconds between two songs of a gig; how much a retuning, and a pause, cool the room. */
const INTERLUDE = 6;
/** What pauses and retunings cost the crowd, by the career's difficulty. */
const stageRules = () => levelOf(career.difficulty);

/** The career is kept with the library in the app (the first version kept it in the window's
 * storage: picked up from there once). */
/** The career save was read: before that, nothing is measured into it (it would be lost). */
let careerReady = false;
const careerLoaded = engine.career
  .load()
  .then(async (raw) => {
    const saved = sanitizeCareer(raw) ?? (engine instanceof TauriEngine ? sanitizeCareer(await localCareer.load()) : null);
    if (saved) career = saved;
    // What an older career had already earned (its act, its fees), without fanfare.
    earn(careerTrophies(career, null));
    highway.setBand(career.band);
    updateMenu();
  })
  .catch(() => {})
  .then(() => {
    careerReady = true;
    wearGuitar();
  });

function storeCareer(): void {
  void engine.career.save(career);
}

/** A short notice at the top of the screen (a member missing tonight…). */
function notice(text: string): void {
  const card = document.createElement('div');
  card.className = 'trophy-toast notice-toast';
  card.textContent = text;
  $('trophyToasts').append(card);
  window.setTimeout(() => card.remove(), 6500);
}

/** A career without a repertoire yet (new, or from before repertoires) gets its first songs:
 * those it played on stage, else the easiest of the library. */
function seedRepertoire(): void {
  if (Object.keys(career.repertoire).length) return;
  const playable = songs.filter((s) => s.hasAudio !== false);
  if (!playable.length) return;
  const played = career.history.flatMap((r) => r.songs.map((s) => s.id));
  career = { ...career, repertoire: starter(playable, played, weekIndex(career), MIN_SONG) };
  storeCareer();
}

/** The song just played, rehearsed: back in form if the band knows it. */
function rehearseSong(gain = REHEARSAL): void {
  if (!currentId || !(currentId in career.repertoire) || autopiloting()) return;
  career = { ...career, repertoire: rehearse(career.repertoire, currentId, weekIndex(career), gain) };
  storeCareer();
}

/** Trophies `ids` earned (those new), kept with the career; returns them to announce. */
function earn(ids: readonly string[]): Trophy[] {
  if (autopiloting()) return [];
  const out = award(career, ids);
  if (!out.earned.length) return [];
  career = out.career;
  storeCareer();
  wearGuitar();
  return out.earned;
}

/** The song just played, as the trophies see it (`mastery` after this play). */
function songEarns(grade: string, mastery: number): Trophy[] {
  if (!view || !chart || riff) return [];
  const s = view.score;
  return earn(
    songTrophies({
      notes: s.hits + s.misses,
      misses: s.misses,
      bestStreak: s.bestStreak,
      grade,
      mastery,
      perfectSolo: perfectSolo(chart, view.results),
      attack: attack ? { level: attack.level.key, strikes: attack.strikes, failed: attack.failed } : null,
    }),
  );
}

/** The guitar played (bought in the career's shop, played in every mode): on the neck, and
 * chosen among those owned in the settings. */
function wearGuitar(): void {
  highway.setGuitar(guitarOf(career.guitar));
  const select = field<HTMLSelectElement>('guitar');
  select.replaceChildren(...ownedGuitars(career).map((g) => new Option(g.name, g.id)));
  select.value = career.guitar;
}

/** A song's preview in the library, against its level in play: in the background. */
const PREVIEW_GAIN = 0.6;

function setMode(next: Mode): void {
  // Leaving the library (a song chosen, or back to the menu): its preview stops.
  if (mode === 'library' && next !== 'library') engine.preview?.(null, 0);
  mode = next;
  // The hardware strip in the menus; the game's own HUD takes the top during a song.
  hwHud.show(menuModes.includes(next));
  accountChip.show(menuModes.includes(next), accountStatus);
  for (const [name, el] of Object.entries(screens)) el.hidden = name !== next;
  hud.show(next === 'play' || next === 'pause' || next === 'results');
  if (next === 'results') screens.results.querySelector<HTMLElement>('[data-action="library"]')!.textContent = backLabel();
  if (next === 'pause') {
    const button = (action: string) => screens.pause.querySelector<HTMLElement>(`[data-action="${action}"]`)!;
    button('restart').textContent = riff ? t('Recommencer la passe') : t('Recommencer');
    button('riff').textContent = riff ? t('Modifier le riff') : t('Loop Trainer');
    // On stage, no starting over and no Loop Trainer: only going on, or leaving.
    button('restart').hidden = !!gig;
    button('riff').hidden = !!gig || lessonRun !== null;
    button('library').textContent = gig ? t('Quitter le concert') : backLabel();
    $('pauseGig').hidden = !gig;
    const free = gig ? gig.pauses < stageRules().freePauses : false;
    $('pauseGig').textContent = gig
      ? free
        ? t('Le public attend : cette pause-ci est gratuite (Rookie).')
        : t('Le public attend : la reprise lui coûtera {n} points.', { n: Math.round(stageRules().pause * 100) })
      : '';
    showPause();
  }
}

/** Where leaving a song goes back to. */
function backLabel(): string {
  return lessonRun !== null ? t('Leçons') : challengeRun || studioRun || drillRun ? t('Carrière') : t('Morceaux');
}

const quick = $<HTMLFormElement>('quick');

/** The pause: the song, where it stands, the score so far, and what can change without leaving it. */
function showPause(): void {
  if (!chart || !view) return;
  $('pauseCover').replaceChildren(cover(chart, 'pause-cover'));
  $('pauseTitle').textContent = chart.meta.title;
  $('pauseMeta').textContent = [chart.meta.artist, chart.arrangement.tuning.name, arrangementLabel(chart.arrangement.name)].filter(Boolean).join(' · ');
  const at = Math.max(0, songTime);
  $('pauseBar').style.width = `${Math.min(1, at / Math.max(chart.meta.duration, 1)) * 100}%`;
  const where = riff
    ? t('Loop Trainer à {speed}, passe {n}', { speed: percent(riff.choice.speed), n: riff.passes.length + 1 })
    : phraseLabels(chart)[phraseIndexAt(chart, at)];
  $('pauseWhere').textContent = [`${formatTime(at)} / ${formatTime(chart.meta.duration)}`, where].filter(Boolean).join(' · ');
  const s = view.score;
  const rows: [string, string][] = [
    [t('Points'), s.points.toLocaleString(NUMBERS)],
    [t('Précision'), s.hits + s.misses ? `${Math.round(accuracy(s) * 100)} %` : '—'],
    [t('Série'), String(s.streak)],
    [t('Meilleure série'), String(s.bestStreak)],
  ];
  $('pauseScore').replaceChildren(
    ...rows.map(([k, v]) => {
      const cell = document.createElement('div');
      const dt = document.createElement('dt');
      const dd = document.createElement('dd');
      dt.textContent = k;
      dd.textContent = v;
      cell.append(dt, dd);
      return cell;
    }),
  );
  renderQuick();
}

function renderQuick(): void {
  for (const name of ['backingVolume', 'monitorVolume', 'stemVolume'] as const) {
    (quick.elements.namedItem(name) as HTMLInputElement).value = String(settings[name]);
    quick.querySelector(`[data-out="${name}"]`)!.textContent = `${Math.round(settings[name] * 100)} %`;
  }
  // Without the USB guitar cable the guitar is not sent back (the Mac's microphone would howl).
  const monitor = quick.elements.namedItem('monitorVolume') as HTMLInputElement;
  monitor.disabled = !audio?.monitor;
  monitor.closest('.row')!.classList.toggle('disabled', monitor.disabled);
  // Only songs imported with their guitar kept apart have one to bring back.
  $('stemRow').hidden = !chart?.audio.guitar;
  $('quickAmp').querySelectorAll<HTMLElement>('button').forEach((b) => b.classList.toggle('on', b.dataset.model === settings.amp.model));
  $('quickSpeed').querySelectorAll<HTMLElement>('button').forEach((b) => b.classList.toggle('on', Number(b.dataset.speed) === settings.speed));
  // Score Attack keeps the difficulty it was started at.
  quick.querySelector<HTMLElement>('.quick-level')!.hidden = !!attack;
  (quick.elements.namedItem('difficulty') as HTMLSelectElement).value = forcedStep === null ? 'auto' : String(forcedStep);
  const note = $('levelNote');
  note.hidden = forcedStep === null || !!attack || !chart;
  if (chart && forcedStep !== null) {
    const level = startLevelFor(forcedStep, chart.arrangement.maxDifficulty, current?.levelNotes);
    note.textContent = t('Niveau {level} sur {max} sur tout le morceau, dès la phrase suivante. Tes niveaux appris ne bougent pas.', {
      level: level + 1,
      max: chart.arrangement.maxDifficulty + 1,
    });
  }
}

/** Difficulty from the pause menu: a level on every phrase from the next one, or back to dynamic. */
function setDifficulty(value: string): void {
  if (!chart || attack) return;
  forcedStep = value === 'auto' ? null : Number(value);
  // A song played from the library keeps it for next time (its card shows it).
  if (currentId && !gig && lessonRun === null && drillRun === null) {
    setSongLevel(currentId, forcedStep);
    library.refreshLevel();
  }
  if (forcedStep !== null) levelsForced = true;
  const level = startLevelFor(forcedStep ?? settings.startLevel, chart.arrangement.maxDifficulty, current?.levelNotes);
  engine.setDifficulty(forcedStep === null, level);
  renderQuick();
}

function segment(label: string, data: Record<string, string>): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  Object.assign(b.dataset, data);
  return b;
}

$('quickAmp').replaceChildren(...AMP_MODELS.map((m) => segment(m.label, { model: m.name })));
$('quickSpeed').replaceChildren(...SPEEDS.map((s) => segment(s.label, { speed: String(s.value) })));

quick.addEventListener('input', (e) => {
  const input = e.target as HTMLInputElement;
  if (input.name !== 'backingVolume' && input.name !== 'monitorVolume' && input.name !== 'stemVolume') return;
  settings[input.name] = Number(input.value);
  syncSettings();
  applyVolumes();
  renderQuick();
});

quick.addEventListener('change', (e) => {
  const input = e.target as HTMLSelectElement;
  if (input.name === 'difficulty') setDifficulty(input.value);
});

quick.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('button');
  if (b?.dataset.model && b.dataset.model !== settings.amp.model) {
    settings.amp = preset(b.dataset.model as AmpModelName);
    ampPanel.update(settings.amp);
    if (engine instanceof TauriEngine) engine.configureAmp(settings.amp);
  }
  if (b?.dataset.speed) settings.speed = Number(b.dataset.speed);
  syncSettings();
  renderQuick();
});

/** The volumes where they play: the native engine, or the browser's backing track. */
function applyVolumes(): void {
  sfx.setVolumes(settings.effectsVolume, settings.crowdVolume, settings.masterVolume);
  if (engine instanceof TauriEngine) engine.configure(engineSettings(settings));
  if (engine instanceof DemoEngine) engine.setVolume((settings.backingVolume * settings.masterVolume) ** 2);
}

const tuner = new Tuner($('tuner'), { finish: () => finishTuner() });

/** After a device change: the engine restarts, the screens follow what it reports. */
function refreshAudio(): void {
  if (!(engine instanceof TauriEngine)) return;
  const live = engine;
  for (const delay of [700, 2000]) {
    window.setTimeout(() => {
      void live.status().then((s) => {
        audio = s;
        describeAudio(s);
        hwHud.status(s);
        if (guitarSettings.visible) guitarSettings.open(s);
        if (ampPanel.visible) ampPanel.hint(s);
      });
    }, delay);
  }
}

/** An input picked by hand in the settings: the cable plugged in later does not override it. */
let inputChosen = false;
/** The cable last switched to: not tried again until it is unplugged (it may fail to open). */
let cableTried: string | null = null;

/**
 * The USB guitar cable plugged in while the app runs: it listens to it at once (its sound back
 * in the speakers), and leaves the demo for the real guitar. Not in the middle of a song, which
 * a change of input would stop: at the next screen.
 */
async function watchCable(s: AudioStatus): Promise<void> {
  if (!(engine instanceof TauriEngine) || cableToTake(s, [{ name: '', rocksmith: true }], inputChosen, null) === null) return;
  if (['play', 'pause', 'interlude', 'encore'].includes(mode)) return;
  const live = engine;
  const inputs = await live.inputs().catch(() => []);
  if (!inputs.some((i) => i.rocksmith)) cableTried = null;
  const cable = cableToTake(s, inputs, inputChosen, cableTried);
  if (!cable) return;
  cableTried = cable;
  live.setInput(null);
  if (settings.autopilot) {
    settings.autopilot = false;
    syncSettings();
    live.setAutopilot(false);
    hwHud.setAutopilot(false);
  }
  notice(t('{cable} branché : Riffroad écoute ta guitare.', { cable }));
  refreshAudio();
}

const guitarSettings = new GuitarSettings($('guitarSettings'), settings, {
  changed: () => {
    syncSettings();
    applyVolumes();
  },
  calibrate: () => {
    if (engine instanceof TauriEngine) engine.calibrate();
  },
  inputs: () => (engine instanceof TauriEngine ? engine.inputs() : Promise.resolve([])),
  outputs: () => (engine instanceof TauriEngine ? engine.outputs() : Promise.resolve([])),
  setInput: (name) => {
    inputChosen = name !== null;
    if (engine instanceof TauriEngine) engine.setInput(name);
    refreshAudio();
  },
  setOutput: (name) => {
    if (engine instanceof TauriEngine) engine.setOutput(name);
    refreshAudio();
  },
  amp: () => settings.amp,
  setAmp: (a) => {
    settings.amp = a;
    ampPanel.update(a);
    syncSettings();
    if (engine instanceof TauriEngine) engine.configureAmp(a);
  },
});

/** The guitar settings live in the settings screen; the first-launch guide borrows a part of them. */
const guitarRoot = $('guitarSettings');
const guitarHome = { parent: guitarRoot.parentElement!, next: guitarRoot.nextSibling };

function placeGuitarSettings(part: WelcomePart | null, into?: HTMLElement): void {
  if (part && into) {
    into.replaceChildren(guitarRoot);
    guitarSettings.only(part);
    guitarSettings.open(audio);
  } else if (guitarRoot.parentElement !== guitarHome.parent) {
    guitarSettings.close();
    guitarSettings.only(null);
    guitarHome.parent.insertBefore(guitarRoot, guitarHome.next);
  }
}

const welcome = new Welcome($('welcome'), {
  status: () => audio,
  settings: placeGuitarSettings,
  tune: () => openTuner(null),
  done: () => showMenu(),
});

/** The first-launch guide, over the menu. */
function openWelcome(): void {
  showMenu();
  welcome.open();
}

/** The desktop app playing every note itself (demo), instead of listening to the guitar. */
const autopiloting = (): boolean => engine instanceof TauriEngine && settings.autopilot;

const hwHud = new HwHud($('hwHud'), engine instanceof TauriEngine, {
  setAutopilot: (on) => {
    settings.autopilot = on;
    syncSettings();
    if (engine instanceof TauriEngine) engine.setAutopilot(on);
    hwHud.setAutopilot(on);
    notice(on ? t('Démo auto : le jeu joue chaque note tout seul (rien n’est enregistré).') : t('Guitare réelle : le jeu écoute ta guitare.'));
  },
  openTuner: () => openTuner(null),
  openAudio: () => openSettings('audio'),
  openImports: () => openImports(),
});

const ampPanel = new AmpPanel($('amp'), settings.amp, {
  changed: (v) => {
    settings.amp = v;
    syncSettings();
    if (engine instanceof TauriEngine) engine.configureAmp(v);
  },
  outputs: () => (engine instanceof TauriEngine ? engine.outputs() : Promise.resolve([])),
  setOutput: (name) => {
    if (engine instanceof TauriEngine) engine.setOutput(name);
  },
  status: () => (engine instanceof TauriEngine ? engine.status() : Promise.resolve(null)),
});

/** Free play: the guitar through the amp, no song (the tuner's pitch shows the note played). */
function openAmp(): void {
  tuner.close();
  guitarSettings.close();
  setMode('amp');
  if (engine instanceof TauriEngine) engine.setTuner(true);
  ampPanel.open(engine instanceof TauriEngine ? audio : null);
}

function closeAmp(): void {
  if (engine instanceof TauriEngine) {
    void engine.status().then((s) => {
      audio = s;
      describeAudio(s);
    });
  }
  showMenu();
}

const riffPanel = new RiffPanel($('riff'), { start: (choice) => startRiff(choice), cancel: () => closeRiffPanel() });

/** Phrase `k` if it has notes, else the next one that has (or the previous). */
function playable(song: Chart, k: number): number {
  const has = (i: number) => countNotes(song, song.phrases[i].start, song.phrases[i].end) > 0;
  const n = song.phrases.length;
  k = Math.max(0, Math.min(n - 1, k));
  for (let i = k; i < n; i++) if (has(i)) return i;
  for (let i = k - 1; i >= 0; i--) if (has(i)) return i;
  return k;
}

/** The phrase played worst in this game, else the one under the clock. */
function weakestPhrase(song: Chart): number {
  let worst = -1;
  let accuracy = Infinity;
  view?.results.forEach((r, i) => {
    if (r.accuracy < accuracy) [worst, accuracy] = [i, r.accuracy];
  });
  return worst >= 0 ? worst : playable(song, phraseIndexAt(song, songTime));
}

function phraseState(song: Chart, i: number): PhraseState {
  const top = song.arrangement.maxDifficulty;
  if (currentId && (progress[currentId]?.mastered[song.phrases[i].name] ?? -1) >= top) return 'mastered';
  const r = view?.results.get(i);
  if (!r) return '';
  return r.accuracy >= 0.85 ? 'good' : r.accuracy < 0.5 ? 'poor' : 'played';
}

/** The Loop Trainer set-up: the current riff, or phrase `phrase` (the one under the clock). */
function openRiff(phrase?: number, from?: Mode): void {
  const song = chart;
  if (!song) return;
  if (attack) {
    // A Score Attack run goes to its end; afterwards, practice reloads the song in learning mode.
    if (mode !== 'results' || !currentId) return;
    attack = null;
    void start(currentId, true);
    return;
  }
  if (mode === 'play') engine.pause();
  riffFrom = from ?? (mode === 'results' ? 'results' : 'pause');
  const k = phrase ?? playable(song, phraseIndexAt(song, songTime));
  const choice = riff
    ? { ...riff.choice }
    : { first: k, last: k, speed: settings.riffSpeed, accelerate: settings.riffAccelerate };
  setMode('riff');
  riffPanel.open(song, choice, (i) => phraseState(song, i));
}

function closeRiffPanel(): void {
  riffPanel.close();
  if (riffFrom === 'library') toLibrary();
  else setMode(riffFrom);
}

/** A song chosen for the Loop Trainer: straight to choosing the passage. */
function riffFromLibrary(): void {
  if (!chart) return;
  riffFirst = false;
  hud.setSong(chart, cover(chart, 'hud-cover'));
  applyMaster();
  openRiff(undefined, 'library');
}

/** Loops the chosen phrases from a little before them, at the chosen speed. */
function startRiff(choice: RiffChoice): void {
  if (!chart) return;
  riffPanel.close();
  settings.riffSpeed = choice.speed;
  settings.riffAccelerate = choice.accelerate;
  syncSettings();
  const loop = riffLoop(chart, choice.first, choice.last, settings.inputOffsetMs / 1000);
  riff = { choice, loop, passes: [] };
  engine.setSpeed(choice.speed);
  engine.setRiff(loop);
  engine.play();
  showRiff();
  applyMaster();
  setMode('play');
}

/** Master mode: the phrases mastered at the top level, if the option is on. */
function applyMaster(): void {
  if (attack) {
    // Score Attack: no fading but at Maître, where every phrase fades.
    const all = attack.level.fade && chart ? new Set(chart.phrases.map((_, i) => i)) : null;
    highway.setMaster(all);
    hud.setMaster(all);
    return;
  }
  const p = currentId ? progress[currentId] : undefined;
  let fading: Set<number> | null = null;
  if (chart && p && settings.masterMode) {
    const top = chart.arrangement.maxDifficulty;
    fading = new Set();
    chart.phrases.forEach((phrase, i) => {
      if ((p.mastered[phrase.name] ?? -1) >= top) fading!.add(i);
    });
  }
  highway.setMaster(fading);
  hud.setMaster(fading);
}

function showRiff(): void {
  hud.setRiff(riff && { first: riff.choice.first, last: riff.choice.last, speed: riff.choice.speed, passes: riff.passes });
  document.body.classList.toggle('in-riff', !!riff);
}

/** Back to the whole song at full speed. */
function exitRiff(): void {
  if (!riff) return;
  riff = null;
  engine.setRiff(null);
  engine.setSpeed(1);
  playSpeed = 1;
  showRiff();
}

/** Playback speed of the song, 25 to 150 %, the pitch unchanged (not on stage nor in Score
 * Attack). */
function setPlaySpeed(speed: number): void {
  playSpeed = Math.round(Math.min(1.5, Math.max(0.25, speed)) * 20) / 20;
  engine.setSpeed(playSpeed);
  hud.toast({
    kind: playSpeed < 1 ? 'down' : 'up',
    key: 'speed',
    title: t('Vitesse {pct}', { pct: percent(playSpeed) }),
    detail: playSpeed < 1 ? t('Entraînement : pas compté dans tes records') : undefined,
  });
}

function setRiffSpeed(speed: number): void {
  if (!riff) return;
  riff.choice.speed = roundSpeed(speed);
  settings.riffSpeed = riff.choice.speed;
  syncSettings();
  engine.setSpeed(riff.choice.speed);
  showRiff();
}

/** Once round the loop: its score, the Accelerator, and at full speed the song's progress. */
function onPass(pass: Pass): void {
  if (!riff || !chart) return;
  const judged = pass.score.hits + pass.score.misses;
  if (!judged) return;
  const acc = pass.score.hits / judged;
  riff.passes.push(acc);
  const details: string[] = [];
  const speed = riff.choice.speed;
  if (speed >= 1 && currentId) {
    const out = recordPass(progress[currentId], chart, pass.results, new Date(), !levelsForced);
    progress[currentId] = out.progress;
    void engine.progress.save(progress);
    // Working a passage at full speed keeps the song in form, a little.
    rehearseSong(0.08);
    applyMaster();
    if (out.records.includes('mastery')) details.push(t('Maîtrise {before} → {after}', { before: percent(out.masteryBefore), after: percent(out.masteryAfter) }));
  }
  if (riff.choice.accelerate) {
    const next = accelerated(speed, acc);
    if (next !== speed) {
      setRiffSpeed(next);
      details.unshift(t('Vitesse {before} → {after}', { before: percent(speed), after: percent(next) }));
    }
  }
  showRiff();
  const kind = acc >= 1 ? 'perfect' : acc >= 0.9 ? 'up' : acc < 0.5 ? 'down' : 'phrase';
  hud.toast({ kind, title: t('Passe {n} · {accuracy}', { n: riff.passes.length, accuracy: percent(acc) }), detail: details.join(' · ') || undefined });
}

/** The tuner before a song (its tuning), or on its own (standard tuning). */
function openTuner(song: Chart | null): void {
  if (!(engine instanceof TauriEngine)) return;
  guitarSettings.close();
  tunerFor = song;
  setMode('tuner');
  engine.setTuner(true);
  const tuning = song?.arrangement.tuning;
  heldTuning = tuning?.strings ?? STANDARD;
  tuner.open(tuning?.strings ?? STANDARD, tuning?.name ?? 'E Standard', song?.meta.title, song ? cover(song, 'tuner-cover-art') : null, tuning?.cents ?? 0);
}

/** The tuning the guitar was last tuned to for a song (kept between launches), and whether that
 * was since the app started (a guitar left aside drifts). */
const GUITAR_TUNED = 'opensmith.guitar-tuned';
let guitarTuned: HeldTuning | null = (() => {
  try {
    return JSON.parse(localStorage.getItem(GUITAR_TUNED) ?? 'null') as HeldTuning | null;
  } catch {
    return null;
  }
})();
let tunedSinceLaunch = false;
/** Wait mode's hint was shown for this lesson; the note the song stopped on. */
let waitHinted = false;
let waitingOn: number | null = null;
/** The song (or lesson) the tuner is open for (null: on its own, any tuning). */
let tunerFor: Chart | null = null;

/** The tuner before `song` only when the guitar may not be in its tuning: first song since the
 * app started, or another tuning (the setting moves songs to the guitar's where it can). */
const tunerNeeded = (song: Chart): boolean => engine instanceof TauriEngine && (!tunedSinceLaunch || mustTune(tuningOf(song), guitarTuned));

const tuningOf = (song: Chart): HeldTuning => ({ name: song.arrangement.tuning.name, strings: song.arrangement.tuning.strings, cents: song.arrangement.tuning.cents ?? 0 });

/** Tuned (or skipped): the song starts (or its Loop Trainer); on its own, back to the menu. */
function finishTuner(): void {
  if (engine instanceof TauriEngine) engine.setTuner(false);
  if (tunerFor) {
    guitarTuned = tuningOf(tunerFor);
    tunerFor = null;
    tunedSinceLaunch = true;
    try {
      localStorage.setItem(GUITAR_TUNED, JSON.stringify(guitarTuned));
    } catch {
      // no storage: the tuner opens for the next song
    }
  }
  tuner.close();
  if (!chart) showMenu();
  else if (riffFirst) riffFromLibrary();
  else restart();
}

/** The picture of the song being played (or its generated stand-in). */
function cover(song: Chart, className: string): HTMLElement {
  return coverElement(song.meta.title, song.meta.artist, current ? engine.coverUrl(current) : null, className);
}

/** One screen for every setting: the guitar (desktop app) and the game. */
function openSettings(tab?: SettingsTab): void {
  tuner.close();
  setMode('settings');
  showSettingsTab(tab ?? (engine instanceof TauriEngine ? 'audio' : 'game'));
}

type SettingsTab = 'audio' | 'latency' | 'game' | 'account';

function showSettingsTab(tab: SettingsTab): void {
  if (tab === 'audio' || tab === 'latency') {
    guitarSettings.open(audio, engine instanceof TauriEngine);
    guitarSettings.tab(tab);
  } else guitarSettings.close();
  form.hidden = tab !== 'game';
  $('accountSettings').hidden = tab !== 'account';
  if (tab === 'account') void accountPanel.open();
  document.querySelectorAll<HTMLElement>('#settingsTabs .tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === tab));
}

function applyDemoSettings(): void {
  // Score Attack plays the whole song at its difficulty's level, without dynamic difficulty.
  const max = current?.maxDifficulty ?? 4;
  const startLevel = attack
    ? attackStartLevel(attack.level.key, max, current?.levelNotes)
    : startLevelFor(forcedStep ?? settings.startLevel, max, current?.levelNotes);
  const dynamic = !attack && forcedStep === null;
  if (engine instanceof DemoEngine) engine.config = { ...engine.config, skill: settings.skill, startLevel, dynamic };
  if (engine instanceof TauriEngine) {
    engine.startLevel = startLevel;
    engine.dynamic = dynamic;
  }
}

/** Live mode: which input the engine listens to (the USB guitar cable, hopefully). */
/** The library's line about the audio devices. */
function describeAudio(s: AudioStatus): void {
  const line = $('engineStatus');
  if (s.error) {
    line.textContent = t('Audio indisponible : {error}', { error: s.error });
    line.classList.add('error');
    return;
  }
  line.textContent = s.rocksmith
    ? t('Câble guitare USB branché ({input}) → {output}. Accorde-toi et choisis un morceau.', { input: s.input ?? '', output: s.output ?? '' })
    : t('Pas de câble guitare USB : écoute de « {input} », retour guitare coupé. Branche le câble et relance pour jouer.', { input: s.input ?? '' });
  line.classList.toggle('warn', !s.rocksmith);
}

async function showAudioStatus(): Promise<void> {
  if (!(engine instanceof TauriEngine)) return;
  for (let i = 0; i < 50; i++) {
    const s = await engine.status();
    audio = s;
    // The menus are timed with or without a sound card.
    if (i === 0 && s.tour) {
      // In front: a window out of sight draws nothing, so nothing to time.
      void getCurrentWindow().show().then(() => getCurrentWindow().setFocus());
      void tour(document, s.tour === '1' ? [] : s.tour.split(','), perf);
    }
    if (s.error) {
      describeAudio(s);
      return;
    }
    if (s.ready) {
      describeAudio(s);
      welcome.refresh();
      if (s.autoplay) void start(s.autoplay);
      if (s.autoimport) void imports?.add([s.autoimport]);
      if (!s.autoplay && !s.autoimport && !welcomed()) openWelcome();
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** The songs of the library (charts made by the pipeline). A call while the library is being
 * read waits for that reading, then reads it once more (one reading at a time). */
let reading: Promise<SongEntry[]> | null = null;
let readAgain: Promise<SongEntry[]> | null = null;
function loadLibrary(): Promise<SongEntry[]> {
  if (reading) return (readAgain ??= reading.then(() => ((readAgain = null), loadLibrary())));
  reading = (async () => {
    try {
      songs = await engine.library();
    } catch (e) {
      console.error(e);
    } finally {
      reading = null;
    }
    updateMenu();
    return songs;
  })();
  return reading;
}

const library = new Library($('library'), {
  coverUrl: (song) => engine.coverUrl(song),
  play: (id) => {
    engine.unlock();
    levelNext = songLevel(id);
    void start(id);
  },
  riff: (id) => {
    engine.unlock();
    levelNext = songLevel(id);
    void start(id, true);
  },
  scoreAttack: (id, difficulty) => {
    engine.unlock();
    attackNext = difficulty;
    void start(id);
  },
  back: () => showMenu(),
  preview: (song) => engine.preview?.(song?.id ?? null, (settings.backingVolume * settings.masterVolume) ** 2 * PREVIEW_GAIN),
});

async function openLibrary(purpose: LibraryPurpose): Promise<void> {
  libraryPurpose = purpose;
  setMode('library');
  const grid = perf.step(t('grille des morceaux'));
  library.show(songs, progress, purpose);
  grid();
  // Read again for songs added or changed outside the app; the grid is redrawn only if there are
  // (a song being clicked keeps its place and its card). Unchanged, the engine gives the same list.
  const before = songs;
  const read = perf.step(t('relecture de la bibliothèque'));
  await loadLibrary();
  read();
  if (mode === 'library' && songs !== before) library.refresh(songs, progress);
}

/** The last song played (in whichever arrangement), to pick up where the player left. */
function lastPlayed(): SongEntry | null {
  const played = songs.flatMap(partsOf).filter((s) => progress[s.id]?.lastPlayed);
  played.sort((a, b) => progress[b.id]!.lastPlayed!.localeCompare(progress[a.id]!.lastPlayed!));
  return played[0] ?? null;
}

function updateMenu(): void {
  notePractice();
  const streak = streakOf(readPractice(), new Date());
  $('menuStreak').textContent = streakLine(streak);
  $('menuStreak').classList.toggle('at-risk', streak.atRisk);
  $('menuCareer').textContent = career.history.length
    ? t('Saison {season} · semaine {week} · {fans} fans', { season: career.season, week: career.week, fans: career.fans.toLocaleString(NUMBERS) })
    : t('Du garage au stade, concert après concert');
  const won = TROPHIES.filter((trophy) => trophy.id in career.trophies).length;
  $('menuTrophies').textContent = won
    ? t('{won} sur {total}', { won, total: TROPHIES.length })
    : t('{won} sur {total} : sur scène et sur les morceaux', { won, total: TROPHIES.length });
  const all = lessons().filter((l) => !l.record);
  const done = all.filter((l) => passed(l, lessonRecords)).length;
  $('menuLessons').textContent = done
    ? done === all.length
      ? t('Toutes réussies : place aux morceaux !')
      : t('{done} sur {total} réussies · prochaine : {title}', { done, total: all.length, title: all[nextLesson(all, lessonRecords)].title })
    : t('Pour apprendre à jouer, en partant de zéro');
  const on = onAt(liveEvents, new Date())[0];
  $('menuEvent').hidden = !on;
  if (on) {
    const w = words(on);
    $('menuEvent').replaceChildren(Object.assign(document.createElement('b'), { textContent: w.title }), ` · ${w.text}`);
  }
  const week = thisWeek(liveEvents);
  const weekSong = findSong(songs, week.song);
  $('menuWorld').textContent = weekSong ? t('Cette semaine : {title}', { title: weekSong.title }) : t('Un morceau par semaine, un classement pour tous');
  const n = songs.length;
  $('menuSongs').textContent = n ? tn(n, '{n} morceau dans la bibliothèque', '{n} morceaux dans la bibliothèque') : t('Aucun morceau pour l’instant');
  const last = lastPlayed();
  const resume = screens.menu.querySelector<HTMLElement>('.menu-resume')!;
  resume.hidden = !last;
  if (!last) return;
  resume.dataset.song = last.id;
  const part = songs.some((s) => s.others?.length && partsOf(s).includes(last)) ? ` · ${partLabel(last)}` : '';
  $('resumeTitle').textContent = `${last.title} · ${last.artist}${part}`;
  const m = Math.round((progress[last.id]?.mastery ?? 0) * 100);
  const best = progress[last.id]?.bestGrade;
  $('resumeMeta').textContent = best ? t('Maîtrise {m} % · meilleure note {grade}', { m, grade: best }) : t('Maîtrise {m} %', { m });
  $('resumeArt').replaceChildren(coverElement(last.title, last.artist, engine.coverUrl(last), 'resume-cover'));
}

/** Trophies just earned: announced, with a fanfare. */
function celebrate(trophies: Trophy[]): void {
  announce($('trophyToasts'), trophies);
  if (trophies.length) window.setTimeout(() => sfx.cue('fanfare'), 400);
}

/** Back to the main menu, from anywhere outside a song. */
function showMenu(): void {
  void refreshEvents();
  if (gig) finishGig('abandoned');
  sfx.room(null);
  if (lessonRun !== null) recordFor(false);
  lessonRun = null;
  drillRun = null;
  challengeRun = null;
  studioRun = null;
  if ((tuner.visible || ampPanel.visible) && engine instanceof TauriEngine) engine.setTuner(false);
  tuner.close();
  ampPanel.close();
  guitarSettings.close();
  riffPanel.close();
  if (chart) {
    exitRiff();
    engine.pause();
    chart = null;
    view = null;
    highway.setChart(null);
  }
  setMode('menu');
  updateMenu();
  // Another Mac may have played meanwhile.
  if (cloudSignedIn && Date.now() - cloudPulledAt > 120_000) cloudQuietly(true);
}

function openImports(): void {
  setMode('imports');
}

async function start(id: string, riffOpening = false): Promise<void> {
  lessonRun = null;
  drillRun = null;
  recordFor(false);
  // Wait mode is the lessons': a song keeps its time.
  if (engine instanceof TauriEngine) engine.setWait(false);
  current = findSong(songs, id) ?? null;
  riffFirst = riffOpening;
  currentId = id;
  riff = null;
  playSpeed = 1; // a load plays at full speed
  showRiff();
  attack = attackNext ? new AttackRun(attackLevel(attackNext)) : null;
  attackNext = null;
  // A song starts at the difficulty chosen on its card (dynamic unless a level was picked there or
  // in the pause menu); Score Attack has its own levels.
  forcedStep = attack ? null : levelNext;
  levelNext = null;
  levelsForced = forcedStep !== null;
  // Practising after the run (or anything else) is no longer the challenge.
  if (!attack || challengeRun?.song !== id) challengeRun = null;
  if (!attack || worldRun?.song !== id || worldRun.level !== attack.level.key) worldRun = null;
  trace.reset();
  if (attack) void pickGhost(id, attack.level.key);
  else {
    ghost = null;
    ghostHud.show(null);
  }
  if (attack || studioRun !== id) studioRun = null;
  attackHud.show(attack);
  applyDemoSettings();
  // The loading card only for a load long enough to be seen (a big backing track).
  const song = current;
  const shown = window.setTimeout(() => showLoading(song), 150);
  if (engine instanceof TauriEngine) engine.guitar = guitarFor(settings.guitarTuning, guitarTuned);
  untilMusic = perf.step(t('jusqu’à la musique'));
  const loaded = perf.step(t('chargement du morceau'));
  try {
    chart = await engine.load(id, progress[id]?.levels);
    loaded();
  } catch (e) {
    untilMusic = null;
    library.status(t('Impossible d’ouvrir ce morceau : {error}', { error: (e as Error).message }), true);
    sfx.ui('error');
    return;
  } finally {
    window.clearTimeout(shown);
    $('loading').hidden = true;
  }
  library.status('');
  if (engine instanceof TauriEngine && engine.transposed) {
    const n = engine.transposed;
    const shift = `${n > 0 ? '+' : '−'}${(Math.round(Math.abs(n) * 10) / 10).toLocaleString(NUMBERS)}`;
    hud.toast({
      kind: 'phrase',
      title: t('Joué en {tuning}', { tuning: chart.arrangement.tuning.name }),
      detail: tn(Math.abs(n), 'Morceau décalé de {shift} demi-ton', 'Morceau décalé de {shift} demi-tons', { shift }),
    });
  }
  heldTuning = chart.arrangement.tuning.strings;
  view = new GameView(chart);
  const built = perf.step(t('piste de notes'));
  highway.setChart(chart);
  built();
  if (gig) {
    const venue = gig.offer.venue.name;
    hud.setGig(gig.encore ? t('{venue} · rappel', { venue }) : t('{venue} · morceau {n} sur {total}', { venue, n: gig.index + 1, total: gig.setlist.length }));
    // Between songs the guitar stays tuned, unless the tuning changes: the room cools meanwhile,
    // except when the second guitar already holds that tuning.
    const tuning = `${chart.arrangement.tuning.strings.join(',')}|${chart.arrangement.tuning.cents ?? 0}`;
    const retune = gig.tuning !== null && gig.tuning !== tuning;
    const step = retuneStep(gig.held, gig.tuning, tuning, guitarsOf(career));
    gig.held = step.held;
    gig.tuning = tuning;
    if (step.costs) gig.crowd.cool(stageRules().retune);
    hud.setCrowd(gig.crowd.value);
    sfx.room(ROOM_IN_SONG * gig.crowd.value);
    if (engine instanceof TauriEngine && (gig.index === 0 || retune)) openTuner(chart);
    else restart();
    return;
  }
  if (tunerNeeded(chart)) openTuner(chart);
  else if (riffFirst) riffFromLibrary();
  else restart();
}

const careerScreen = new CareerScreen($('career'), {
  songs: () => songs.filter((s) => s.hasAudio !== false),
  progress: () => progress,
  coverUrl: (song) => engine.coverUrl(song),
  play: (offer, setlist) => startGig(offer, setlist),
  rest: () => {
    career = restWeek(career);
    storeCareer();
    careerScreen.showHub(career);
  },
  restSlot: () => {
    career = rest(career);
    storeCareer();
    careerScreen.showHub(career);
  },
  rehearseBand: () => {
    career = rehearseBand(career);
    storeCareer();
    careerScreen.showHub(career);
  },
  buyGear: (id) => {
    career = buyGear(career, id) ?? career;
    storeCareer();
    careerScreen.showShop(career);
  },
  hire: (m) => {
    career = hireMusician(career, m) ?? career;
    storeCareer();
    careerScreen.showMembers(career);
  },
  reset: (d) => {
    career = resetCareer(career, d);
    seedRepertoire();
    storeCareer();
    careerScreen.showHub(career);
  },
  record: (id) => {
    engine.unlock();
    studioRun = id;
    void start(id);
  },
  train: (skill) => {
    engine.unlock();
    void startDrill(skill);
  },
  choose: (choice) => {
    career = resolveMoment(career, choice);
    storeCareer();
    careerScreen.showHub(career);
  },
  sign: (id) => {
    career = signContract(career, id);
    storeCareer();
    careerScreen.showHub(career);
  },
  sponsor: (o) => {
    career = acceptSponsor(career, o);
    storeCareer();
    careerScreen.showBusiness(career);
  },
  post: (kind) => {
    career = post(career, kind) ?? career;
    storeCareer();
    careerScreen.showSocial(career);
  },
  comms: (hire) => {
    career = hire ? hireComms(career) : fireComms(career);
    storeCareer();
    careerScreen.showSocial(career);
  },
  release: () => {
    const before = career.money;
    const out = releaseAlbum(career);
    if (!out) return;
    career = out.career;
    storeCareer();
    notice(
      t('{album} est sorti : {copies} exemplaires, {money} € et {fans} nouveaux fans.', {
        album: out.release.name,
        copies: out.release.copies.toLocaleString(NUMBERS),
        money: (career.money - before).toLocaleString(NUMBERS),
        fans: Math.round(out.release.copies * 0.15).toLocaleString(NUMBERS),
      }),
    );
    celebrate(earn(careerTrophies(career, null)));
    careerScreen.showStudio(career);
  },
  learn: (id) => {
    career = learnSong(career, id) ?? career;
    storeCareer();
    careerScreen.showRepertoire(career);
  },
  buy: (id) => {
    career = buyGuitar(career, id) ?? career;
    storeCareer();
    wearGuitar();
    careerScreen.showShop(career);
  },
  equip: (id) => {
    career = equipGuitar(career, id);
    storeCareer();
    wearGuitar();
    careerScreen.showShop(career);
  },
  challenge: (ch) => {
    engine.unlock();
    challengeRun = ch;
    attackNext = ch.level;
    void start(ch.song);
  },
  preview: (id) => highway.setGuitar(guitarOf(id ?? career.guitar)),
  saveBand: (band) => {
    career = nameBand(career, band);
    storeCareer();
    highway.setBand(career.band);
    careerScreen.showHub(career);
  },
  readReport: () => {
    career = { ...career, report: null };
    storeCareer();
    careerScreen.showHub(career);
  },
  back: () => showMenu(),
});

const lessonsScreen = new LessonsScreen($('lessons'), (index, pace) => {
  engine.unlock();
  void startLesson(index, pace);
});

/** The lessons, the one just played (or the next to pass) opened. */
function openLessons(picked?: number): void {
  lessonsScreen.show(lessons(), lessonRecords, picked);
  setMode('lessons');
}

/** Lesson `index`, played over its metronome after the tuner, at the `pace` chosen on the
 * lessons screen (in wait mode, the song stops on each note until it is played). */
async function startLesson(index: number, pace: LessonPace = lessonsScreen.pace): Promise<void> {
  const lesson = lessons()[index];
  if (!lesson) return;
  lessonRun = index;
  drillRun = null;
  recordFor(lesson.record ?? false);
  current = null;
  currentId = null;
  riffFirst = false;
  riff = null;
  playSpeed = 1;
  showRiff();
  attack = null;
  attackNext = null;
  forcedStep = null;
  levelsForced = false;
  challengeRun = null;
  studioRun = null;
  attackHud.show(null);
  applyDemoSettings();
  try {
    if (engine instanceof TauriEngine) engine.setWait(pace === 'wait');
    waitHinted = false;
    chart = await engine.loadLesson(lessonChart(lesson, index, paceFactor(pace)));
  } catch (e) {
    notice(t('Impossible d’ouvrir la leçon : {error}', { error: (e as Error).message }));
    sfx.ui('error');
    return;
  }
  heldTuning = chart.arrangement.tuning.strings;
  view = new GameView(chart);
  highway.setChart(chart);
  hud.toast({ kind: 'phrase', title: lesson.title, detail: lesson.how[0] });
  if (tunerNeeded(chart)) openTuner(chart);
  else restart();
}

/** A training drill on the card's `skill`, made for its rating, played like a lesson. */
async function startDrill(skill: SkillId): Promise<void> {
  await careerLoaded;
  const lesson = drillFor(skill, ratingOf(career.skills, skill));
  lessonRun = null;
  drillRun = skill;
  recordFor(false);
  current = null;
  currentId = null;
  riffFirst = false;
  riff = null;
  playSpeed = 1;
  showRiff();
  attack = null;
  attackNext = null;
  forcedStep = null;
  levelsForced = false;
  challengeRun = null;
  studioRun = null;
  attackHud.show(null);
  applyDemoSettings();
  try {
    if (engine instanceof TauriEngine) engine.setWait(false);
    chart = await engine.loadLesson(lessonChart(lesson, 0));
  } catch (e) {
    notice(t('Impossible d’ouvrir l’entraînement : {error}', { error: (e as Error).message }));
    sfx.ui('error');
    return;
  }
  heldTuning = chart.arrangement.tuning.strings;
  view = new GameView(chart);
  highway.setChart(chart);
  hud.toast({ kind: 'phrase', title: lesson.title, detail: lesson.how[0] });
  if (tunerNeeded(chart)) openTuner(chart);
  else restart();
}

/** The card measured on the song just played: by a guitar (not the game playing itself, as the
 * browser's demo always does), not a slowed-down practice, not before the save was read. */
function measureSkills(): void {
  skillMoves = [];
  if (!careerReady || !view || !chart || engine.kind !== 'live' || autopiloting() || playSpeed < 1 || riff) return;
  const before = career.skills;
  career = { ...career, skills: learnSkills(career.skills, sampleOf(view.items, chart, chart.meta.duration)) };
  storeCareer();
  skillMoves = changes(before, career.skills);
}

/** What the card moved, in a line: "Precision 61 → 63 · Chords 55 → 54". */
const movesLine = (): string =>
  skillMoves.map((m) => t('{skill} {from} → {to}', { skill: SKILLS.find((k) => k.id === m.id)!.label, from: m.from, to: m.to })).join(' · ');

/** End of a drill: a slot of the career's week, and what the card moved. */
function drillVerdict(acc: number, judged: boolean): void {
  career = trainSlot(career);
  storeCareer();
  const ok = judged && acc >= DRILL_GOAL;
  $('verdict').textContent = ok ? t('Séance réussie !') : t('Encore un essai !');
  const moves = movesLine();
  $('records').textContent = moves ? t('Ta fiche : {moves}', { moves }) : t('Ta fiche a pris note de la séance.');
  $('records').classList.toggle('new', skillMoves.some((m) => m.to > m.from));
  screens.results.querySelector<HTMLElement>('[data-action="next-lesson"]')!.hidden = true;
}

/** Recording sessions record the guitar whatever the settings say; elsewhere, the settings. */
function recordFor(session: boolean): void {
  if (engine instanceof TauriEngine) engine.setRecording(settings.recordTakes || session);
}

/** End of a lesson: passed or not, its best kept, and the way to the next one. */
function lessonVerdict(acc: number, judged: boolean, practice: boolean): void {
  const list = lessons();
  const index = lessonRun!;
  const lesson = list[index];
  if (lesson.record) {
    $('verdict').textContent = t('Enregistrement terminé');
    $('records').textContent =
      engine.kind === 'live'
        ? t('Merci ! Ta guitare est enregistrée sur ce Mac (dossier Musique → OpenSmith → .takes).')
        : t('En mode démo, rien n’est enregistré : il faut l’app et ta guitare.');
    $('records').classList.toggle('new', engine.kind === 'live');
    screens.results.querySelector<HTMLElement>('[data-action="next-lesson"]')!.hidden = true;
    return;
  }
  if (judged && !practice && !autopiloting()) lessonRecords = recordLesson(lessonRecords, lesson.id, acc);
  const ok = judged && !practice && acc >= lesson.goal;
  if (ok) {
    window.setTimeout(() => sfx.cue('fanfare'), 500);
    sfx.applause(0.4);
  }
  const pct = (x: number) => t('{n} %', { n: Math.round(x * 100) });
  $('verdict').textContent = ok ? t('Leçon réussie !') : practice ? t('Entraînement au ralenti') : t('Encore un essai !');
  const next = list[index + 1];
  $('records').textContent = ok
    ? next
      ? t('Prochaine leçon : {title}', { title: next.title })
      : t('Toutes les leçons sont réussies : place aux vrais morceaux !')
    : practice
      ? t('Reviens à 100 % de la vitesse pour réussir la leçon.')
      : t('Tu as joué {acc} des notes, l’objectif est {goal}.', { acc: pct(judged ? acc : 0), goal: pct(lesson.goal) });
  $('records').classList.toggle('new', ok);
  const go = screens.results.querySelector<HTMLElement>('[data-action="next-lesson"]')!;
  go.hidden = !ok || !next;
  screens.results.querySelector<HTMLElement>('[data-action="restart"]')!.classList.toggle('primary', go.hidden);
}

const world = new WorldScreen(screens.world, {
  events: () => liveEvents,
  song: (id) => findSong(songs, id) ?? null,
  cover: (id) => {
    const song = findSong(songs, id);
    return song ? coverElement(song.title, song.artist, engine.coverUrl(song), 'world-cover') : null;
  },
  signedIn: async () => cloud !== null && !!(await tauriCloud.status()).email,
  play: (challenge) => {
    engine.unlock();
    attackNext = challenge.level;
    worldRun = challenge;
    void start(challenge.song);
  },
  account: () => openSettings('account'),
});

function openWorld(): void {
  setMode('world');
  void world.show();
}

async function openTrophies(): Promise<void> {
  await careerLoaded;
  showTrophies(screens.trophies, career);
  notePractice();
  screens.trophies.querySelector('.trophies-panel > .help')?.after(practiceCard(readPractice(), new Date()));
  setMode('trophies');
}

async function openCareer(): Promise<void> {
  // The career is played on a guitar: not by the demo's autopilot.
  if (autopiloting()) {
    notice(t('La carrière se joue à la guitare : repasse en « Guitare réelle », en haut à droite.'));
    return;
  }
  await careerLoaded;
  // The week's challenge, the repertoire: songs of the library.
  if (!songs.length) await loadLibrary();
  seedRepertoire();
  setMode('career');
  careerScreen.showHub(career);
}

/** On stage: the setlist from its first song, the crowd waiting, the venue around. */
function startGig(offer: Offer, setlist: string[]): void {
  engine.unlock();
  // An opening act plays to a crowd that came for the headliner; the band and the amp warm it.
  gig = { offer, setlist, index: 0, crowd: new Crowd(crowdStart(career, offer), stageRules().patience), songs: [], tuning: null, held: [], pauses: 0, encore: null, encoreSong: null, earned: [] };
  const missing = gigLineUp(career, offer).missing;
  if (missing.length) {
    const names = missing.map((m) => m.name).join(lang() === 'en' ? ' and ' : ' et ');
    notice(tn(missing.length, '{names} manque ce soir : un remplaçant joue.', '{names} manquent ce soir : un remplaçant joue.', { names }));
  }
  highway.setScenery(offer.venue.look.scene, offer.venue.look.fill, offer.venue.look.sign);
  highway.setCrowd(gig.crowd.value);
  // A power cut: an acoustic set, the amp on its clean channel until the end of the gig.
  if (offer.acoustic) {
    notice(t('Panne de courant : set acoustique, l’ampli passe en son clair.'));
    if (engine instanceof TauriEngine) engine.configureAmp(preset('clean'));
  }
  void start(setlist[0]);
}

/** Notes and chords of a song at its full difficulty: how complete a gig played it. */
const fullNotes = (s: SongEntry | null): number | undefined => s?.levelNotes?.at(-1) ?? (s ? s.notes + s.chords : undefined);

/** A song of the gig over: into its progress, then the next one after a breath, an encore when
 * the crowd calls for it, or the end. */
function gigSongEnded(): void {
  if (!gig || !view || !chart) return;
  engine.pause();
  measureSkills();
  const grade = gradeOf(view.score);
  const outcome = recordSong(grade);
  gig.earned.push(...songEarns(grade, outcome?.masteryAfter ?? 0));
  const notes = view.score.hits + view.score.misses;
  const song: GigSong = { id: currentId ?? '', title: chart.meta.title, grade, accuracy: accuracy(view.score), crowd: gig.crowd.value, notes, seconds: chart.meta.duration, full: fullNotes(current) };
  // The room answers the song: as warm as it is.
  sfx.applause(0.3 + 0.7 * gig.crowd.value);
  if (gig.crowd.value >= 0.5) sfx.cheer(gig.crowd.value);
  if (gig.encore) {
    gig.encoreSong = song;
    finishGig('played');
    return;
  }
  gig.songs.push(song);
  if (gig.songs.length < gig.setlist.length) showInterlude(grade);
  else if (gig.crowd.value >= ENCORE) showEncore();
  else finishGig('played');
}

/** Songs for an encore: the best mastered of the repertoire not played tonight, else one of the
 * night again. */
function encoreChoices(run: GigRun): SongEntry[] {
  const playable = songs.filter((s) => s.hasAudio !== false && s.id in career.repertoire);
  const fresh = playable
    .filter((s) => !run.setlist.includes(s.id))
    .sort((a, b) => (progress[b.id]?.mastery ?? 0) - (progress[a.id]?.mastery ?? 0) || a.title.localeCompare(b.title));
  const again = playable.filter((s) => run.setlist.includes(s.id));
  return [...fresh, ...again].slice(0, 3);
}

/** The crowd calls the band back: an encore to choose, or a bow. */
function showEncore(): void {
  const run = gig!;
  const crowd = run.crowd.value;
  $('encoreVenue').textContent = run.offer.venue.name;
  $('encoreCrowd').style.width = `${Math.round(crowd * 100)}%`;
  $('encoreCrowd').style.setProperty('--fill', `${Math.round(crowd * 100)}%`);
  $('encoreText').textContent = t(
    'Public {crowd} % : la salle ne veut pas te laisser partir. Un rappel joué jusqu’au bout rapporte des fans et un cachet en plus, d’autant plus que la salle reste chaude.',
    { crowd: Math.round(crowd * 100) },
  );
  $('encoreSongs').replaceChildren(
    ...encoreChoices(run).map((s) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'encore-song';
      b.dataset.action = 'encore-song';
      b.dataset.song = s.id;
      const retune = current && s.tuning !== current.tuning;
      const title = document.createElement('b');
      title.textContent = run.setlist.includes(s.id) ? t('Rejouer {title}', { title: s.title }) : s.title;
      const meta = document.createElement('span');
      meta.textContent = [
        s.artist,
        retune ? t('{tuning} (autre accordage)', { tuning: s.tuning }) : s.tuning,
        formatTime(s.duration),
        t('maîtrise {m} %', { m: Math.round((progress[s.id]?.mastery ?? 0) * 100) }),
      ].join(' · ');
      b.append(title, meta);
      return b;
    }),
  );
  highway.celebrate(0.6);
  sfx.room(0.4 + 0.6 * crowd, 'clapping');
  setMode('encore');
}

function playEncore(id: string): void {
  if (!gig || mode !== 'encore') return;
  gig.encore = id;
  gig.index = gig.setlist.length;
  void start(id);
}

function showInterlude(grade: string): void {
  const run = gig!;
  const next = songs.find((s) => s.id === run.setlist[run.songs.length]);
  const crowd = run.crowd.value;
  $('interludeVenue').textContent = run.offer.venue.name;
  $('interludeTitle').textContent = t('Morceau {n} sur {total} · note {grade}', { n: run.songs.length, total: run.setlist.length, grade });
  $('interludeCrowd').style.width = `${Math.round(crowd * 100)}%`;
  $('interludeCrowd').style.setProperty('--fill', `${Math.round(crowd * 100)}%`);
  $('interludeCrowdText').textContent = t('Public {crowd} %', { crowd: Math.round(crowd * 100) });
  const retune = next && current && next.tuning !== current.tuning;
  // The second guitar holds a second tuning: going back and forth between them is free.
  const tunings = run.setlist.map((id) => songs.find((s) => s.id === id)?.tuning ?? '');
  const costs = retunes(tunings, guitarsOf(career))[run.songs.length];
  const tuning = !next
    ? ''
    : !retune
      ? next.tuning
      : costs
        ? t('{tuning} (autre accordage : la salle va refroidir)', { tuning: next.tuning })
        : t('{tuning} (deuxième guitare : la salle ne refroidit pas)', { tuning: next.tuning });
  $('interludeNext').textContent = next ? t('Ensuite : {title} · {tuning}', { title: next.title, tuning }) : '';
  sfx.room(crowd);
  setMode('interlude');
  let left = INTERLUDE;
  $('interludeCount').textContent = `(${left})`;
  window.clearInterval(interludeTimer);
  interludeTimer = window.setInterval(() => {
    left -= 1;
    $('interludeCount').textContent = `(${left})`;
    if (left <= 0) nextGigSong();
  }, 1000);
}

function nextGigSong(): void {
  window.clearInterval(interludeTimer);
  if (!gig || mode !== 'interlude') return;
  gig.index = gig.songs.length;
  void start(gig.setlist[gig.index]);
}

/** The gig over (played to the end, booed off or left): its outcome into the career, the report. */
function finishGig(outcome: GigOutcome): void {
  const run = gig;
  if (!run) return;
  window.clearInterval(interludeTimer);
  // The setlist was played through: leaving at the encore, or during it, is a bow.
  if (run.encore || mode === 'encore') outcome = 'played';
  // A song cut short still counts for the crowd it left.
  else if (outcome !== 'played' && view && chart && run.songs.length <= run.index && mode !== 'interlude') {
    const notes = view.score.hits + view.score.misses;
    const seconds = Math.min(chart.meta.duration, Math.max(0, songTime));
    run.songs.push({ id: currentId ?? '', title: chart.meta.title, grade: gradeOf(view.score), accuracy: accuracy(view.score), crowd: run.crowd.value, notes, seconds, full: fullNotes(current) });
  }
  gig = null;
  sfx.room(null);
  const result = concludeGig(career, run.offer, run.songs, outcome, { encore: run.encoreSong, pauses: run.pauses, boost: careerBoost(liveEvents, new Date()) });
  career = result.career;
  storeCareer();
  const feat: GigFeat = { outcome, satisfaction: result.record.satisfaction, encore: !!result.record.encore };
  celebrate([...run.earned, ...earn(careerTrophies(career, feat))]);
  if (tuner.visible && engine instanceof TauriEngine) engine.setTuner(false);
  tuner.close();
  exitRiff();
  engine.pause();
  chart = null;
  view = null;
  highway.setChart(null);
  highway.setScenery(settings.scenery);
  highway.setCrowd(null);
  hud.setGig(null);
  if (run.offer.acoustic && engine instanceof TauriEngine) engine.configureAmp(settings.amp);
  setMode('career');
  careerScreen.showResult(career, result.record, result.actUp);
}

function showLoading(song: SongEntry | null): void {
  $('loadingArt').replaceChildren(...(song ? [coverElement(song.title, song.artist, engine.coverUrl(song), 'loading-cover')] : []));
  $('loadingTitle').textContent = song ? `${song.title} · ${song.artist}` : t('Morceau');
  $('loading').hidden = false;
}

const helpSheet = $('help');

/** The keyboard shortcuts sheet; a song being played pauses first. */
function toggleHelp(open = helpSheet.hidden): void {
  if (open && mode === 'play') togglePause();
  helpSheet.hidden = !open;
}

helpSheet.addEventListener('click', (e) => {
  if (e.target === helpSheet) toggleHelp(false);
});

function restart(): void {
  if (!chart) return;
  trace.reset();
  if (riff) {
    // The pass starts over from the loop's start.
    engine.setRiff(riff.loop);
    engine.play();
    setMode('play');
    return;
  }
  levelsForced = forcedStep !== null;
  applyDemoSettings();
  hud.setSong(chart, cover(chart, 'hud-cover'));
  attack?.reset();
  attackHud.show(attack);
  applyMaster();
  lead = lessonRun === null && drillRun === null ? leadIn(chart, LOOKAHEAD, LEAD_IN) : LEAD_IN;
  engine.seek(-lead);
  engine.play();
  sfx.countIn(chart, -lead);
  setMode('play');
}

function togglePause(): void {
  if (mode === 'play') {
    engine.pause();
    setMode('pause');
  } else if (mode === 'pause') {
    // On stage, the crowd waits: every pause cools it a little.
    if (gig) {
      if (gig.pauses >= stageRules().freePauses) gig.crowd.cool(stageRules().pause);
      gig.pauses++;
    }
    engine.play();
    setMode('play');
  }
}

function seekBy(delta: number): void {
  if (!chart || riff || attack || (mode !== 'play' && mode !== 'pause')) return;
  engine.seek(Math.max(-lead, Math.min(chart.meta.duration, songTime + delta)));
}

function toLibrary(): void {
  if ((tuner.visible || ampPanel.visible) && engine instanceof TauriEngine) engine.setTuner(false);
  tuner.close();
  ampPanel.close();
  guitarSettings.close();
  riffPanel.close();
  exitRiff();
  engine.pause();
  chart = null;
  view = null;
  highway.setChart(null);
  // The weekly challenge goes back to the career it belongs to.
  if (lessonRun !== null) {
    const index = lessonRun;
    lessonRun = null;
    openLessons(index);
  } else if (challengeRun || studioRun || drillRun) {
    challengeRun = null;
    studioRun = null;
    drillRun = null;
    void openCareer();
  } else void openLibrary(libraryPurpose);
}

/** S to D from the share of notes played, '—' when none was judged. */
function gradeOf(s: GameView['score']): string {
  return gradeFor(accuracy(s), s.hits + s.misses);
}

/** Into the song's progress: levels for next time, records, mastery. */
function recordSong(grade: string): ReturnType<typeof record> | null {
  // The game playing itself (demo) learns nothing about the player.
  if (!currentId || !view || !chart || autopiloting()) return null;
  const outcome = record(progress[currentId], chart, view.score, view.results, grade, new Date(), !levelsForced);
  progress[currentId] = outcome.progress;
  void engine.progress.save(progress);
  return outcome;
}

/** Score Attack: a phrase under the difficulty's bar is a strike, the third ends the song. */
function onAttackPhrase(phrase: PhraseDone): void {
  if (!attack || !chart || mode !== 'play') return;
  const verdict = attack.phrase(phrase, chart.phrases[phrase.iteration]?.end ?? songTime);
  if (!verdict) return;
  attackHud.show(attack);
  if (verdict === 'strike') {
    hud.toast({ kind: 'lost', title: t('Échec {n} sur {max}', { n: attack.strikes, max: STRIKES }), detail: `${phrase.name} · ${percent(phrase.accuracy)}` });
  } else {
    showResults();
  }
}

/** The end of a Score Attack run on the results screen: score with bonus, place, high scores. */
function showAttackResults(grade: string): void {
  document.querySelector('#results .attack-summary')?.remove();
  document.querySelectorAll('#results .challenge-result:not(.take)').forEach((e) => e.remove());
  if (!attack || !view || !chart || !currentId) return;
  const s = view.score;
  const total = attack.total(s.points);
  const run = { score: total, accuracy: accuracy(s), grade, streak: s.bestStreak };
  const out = recordAttack(progress[currentId], chart, attack.level.key, run, view.results, attack.failed, new Date(), trace.samples);
  progress[currentId] = out.progress;
  void engine.progress.save(progress);
  if (attack.failed) $('verdict').textContent = t('Échec : trois phrases ratées');
  $('records').before(attackSummary(attack, total, out.rank, out.scores));
  if (challengeRun && challengeRun.level === attack.level.key) settleRun(challengeRun, { failed: attack.failed, accuracy: run.accuracy });
  if (worldRun && worldRun.song === currentId && worldRun.level === attack.level.key) {
    const line = document.createElement('p');
    line.className = 'challenge-result world';
    line.textContent = t('Défi mondial : envoi…');
    $('records').before(line);
    void world.submit(worldRun, total, run.accuracy, attack.failed, trace.samples).then((text) => (line.textContent = text));
  }
}

/** A studio take: its accuracy kept for the album if it is the best one, a slot of the week. */
function settleTake(id: string, quality: number): void {
  const before = career.album.takes[id] ?? 0;
  career = studioTake(career, id, quality);
  storeCareer();
  const line = document.createElement('p');
  line.className = 'challenge-result take';
  line.textContent =
    quality > before
      ? t('Studio : prise à {take} %, gardée pour l’album.', { take: Math.round(quality * 100) })
      : t('Studio : prise à {take} %, la meilleure reste à {best} %.', { take: Math.round(quality * 100), best: Math.round(before * 100) });
  $('records').before(line);
}

/** A run of the weekly challenge: the tier it reached, the prize it pays, on the results. */
function settleRun(ch: Challenge, run: { failed: boolean; accuracy: number }): void {
  const out = settleChallenge(career, ch, run);
  const before = career.challenge?.key === ch.key ? career.challenge.tier : 0;
  career = out.career;
  storeCareer();
  celebrate(earn(careerTrophies(career, null)));
  const line = document.createElement('p');
  line.className = `challenge-result${out.tier ? ` tier-${out.tier}` : ''}`;
  const pct = `${Math.round(run.accuracy * 100)} %`;
  const tier = out.tier ? TIERS[out.tier - 1].name : '';
  line.textContent = run.failed
    ? t('Défi de la semaine : trois phrases ratées, pas de prime. Rejoue pour la décrocher.')
    : !out.tier
      ? t('Défi de la semaine : {accuracy} de précision, le bronze est à {bronze} %.', { accuracy: pct, bronze: Math.round(TIERS[0].accuracy * 100) })
      : out.paid
        ? t('Défi de la semaine : {tier} ! +{paid} € de prime.', { tier, paid: out.paid })
        : before > out.tier
          ? t('Défi de la semaine : {tier}, déjà mieux cette semaine.', { tier })
          : t('Défi de la semaine : {tier}, déjà obtenu cette semaine.', { tier });
  $('records').before(line);
}

/** On the results: why the notes were missed, and a steady lag offered as latency to compensate. */
function showTiming(v: GameView): void {
  for (const old of document.querySelectorAll('#results .timing-result')) old.remove();
  const line = (text: string) => {
    const p = document.createElement('p');
    p.className = 'challenge-result timing-result';
    p.textContent = text;
    $('records').before(p);
    return p;
  };
  const n = missCounts(v.items.filter((i) => i?.status === 'missed').map((i) => i.reason));
  const parts = [
    n.late && t('{n} trop tard', { n: n.late }),
    n.early && t('{n} trop tôt', { n: n.early }),
    n.high && tn(n.high, '{n} trop haute', '{n} trop hautes'),
    n.low && tn(n.low, '{n} trop basse', '{n} trop basses'),
    n.chord && tn(n.chord, '{n} mauvais accord', '{n} mauvais accords'),
    n.unplayed && tn(n.unplayed, '{n} pas jouée', '{n} pas jouées'),
  ].filter(Boolean);
  if (parts.length) line(t('Notes ratées : {list}', { list: parts.join(' · ') }));
  // Slowed down or sped up, song-time errors are not the latency.
  const steady = engine instanceof TauriEngine && playSpeed === 1 ? steadyOffset(v.timing) : null;
  if (!steady) return;
  if (settings.autoLatency) {
    const before = settings.inputOffsetMs;
    settings.inputOffsetMs = Math.max(-150, Math.min(150, before + steady.medianMs));
    syncSettings();
    applyVolumes();
    const p = line(
      t('Latence ajustée de {shift} ms (compensation à {offset} ms) : tes notes arrivaient toutes décalées d’à peu près autant.', {
        shift: `${steady.medianMs > 0 ? '+' : '−'}${Math.abs(steady.medianMs)}`,
        offset: settings.inputOffsetMs,
      }),
    );
    const undo = document.createElement('button');
    undo.type = 'button';
    undo.className = 'action small';
    undo.textContent = t('Annuler l’ajustement');
    undo.addEventListener('click', () => {
      settings.inputOffsetMs = before;
      syncSettings();
      applyVolumes();
      undo.replaceWith(t('Compensation remise à {offset} ms.', { offset: before }));
    });
    p.append(' ', undo);
    return;
  }
  const ms = Math.abs(steady.medianMs);
  const p = line(
    steady.medianMs > 0
      ? t('Tes notes arrivent en moyenne {ms} ms en retard, toujours à peu près pareil : c’est sans doute la latence.', { ms })
      : t('Tes notes arrivent en moyenne {ms} ms en avance, toujours à peu près pareil : c’est sans doute la latence.', { ms }),
  );
  const fix = document.createElement('button');
  fix.type = 'button';
  fix.className = 'action small';
  const target = Math.max(-150, Math.min(150, settings.inputOffsetMs + steady.medianMs));
  fix.textContent = t('Compenser ({offset} ms)', { offset: `${steady.medianMs > 0 ? '+' : '−'}${ms}` });
  fix.addEventListener('click', () => {
    settings.inputOffsetMs = target;
    syncSettings();
    applyVolumes();
    fix.replaceWith(t('Compensation réglée à {offset} ms.', { offset: target }));
  });
  p.append(' ', fix);
}

function showResults(): void {
  if (!view || !chart) return;
  engine.pause();
  const s = view.score;
  const acc = accuracy(s);
  const judged = s.hits + s.misses > 0;
  const grade = gradeOf(s);
  const verdicts: Record<string, string> = {
    S: t('Légendaire !'),
    A: t('Excellent !'),
    B: t('Bien joué !'),
    C: t('Pas mal, continue !'),
    D: t('Le prochain sera meilleur'),
    '—': t('Aucune note jouée'),
  };
  $('resultsCover').replaceChildren(cover(chart, 'results-cover'));
  $('resultsTitle').textContent = chart.meta.title;
  $('resultsArtist').textContent = chart.meta.artist;
  const gradeEl = $('grade');
  gradeEl.textContent = grade;
  gradeEl.dataset.grade = grade;
  gradeEl.classList.remove('reveal');
  void gradeEl.offsetWidth;
  gradeEl.classList.add('reveal');
  $('verdict').textContent = verdicts[grade];
  sfx.cue('grade');
  if (lessonRun === null && playSpeed >= 1) sfx.applause(({ S: 1, A: 0.75, B: 0.5 } as Record<string, number>)[grade] ?? 0);
  // The card measured on what was just played.
  measureSkills();
  // Into the song's progress: levels for next time, records, mastery.
  let records = '';
  // Slowed down, a play is practice: no records, no rehearsal, no trophy.
  const practice = playSpeed < 1;
  const outcome = attack || practice || lessonRun !== null ? null : recordSong(grade);
  document.querySelector('#results .challenge-result.take')?.remove();
  if (!practice && lessonRun === null) {
    // A song of the repertoire played through: a rehearsal; a studio take when recording.
    rehearseSong();
    if (studioRun && studioRun === currentId) settleTake(studioRun, accuracy(view.score));
    celebrate(songEarns(grade, outcome?.masteryAfter ?? (currentId ? (progress[currentId]?.mastery ?? 0) : 0)));
  }
  if (outcome) {
    const lines: Record<string, string> = {
      score: t('Nouveau record de points !'),
      streak: t('Meilleure série battue !'),
      grade: t('Meilleure note !'),
    };
    const pct = (x: number) => `${Math.round(x * 100)} %`;
    const parts = outcome.records.filter((r) => r in lines).map((r) => lines[r]);
    parts.push(
      outcome.progress.plays === 1
        ? t('Maîtrise {mastery}', { mastery: pct(outcome.masteryAfter) })
        : t('Maîtrise {before} → {after}', { before: pct(outcome.masteryBefore), after: pct(outcome.masteryAfter) }),
    );
    records = parts.join(' · ');
  }
  $('records').textContent = records;
  $('records').classList.toggle('new', records.includes('!'));
  screens.results.querySelector<HTMLElement>('[data-action="riff-weakest"]')!.hidden = lessonRun !== null;
  screens.results.querySelector<HTMLElement>('[data-action="next-lesson"]')!.hidden = true;
  screens.results.querySelector<HTMLElement>('[data-action="restart"]')!.classList.add('primary');
  const moves = movesLine();
  if (moves && lessonRun === null && !drillRun) $('records').textContent = [records, t('Ta fiche : {moves}', { moves })].filter(Boolean).join(' · ');
  if (lessonRun !== null) lessonVerdict(acc, judged, practice);
  if (drillRun) drillVerdict(acc, judged);
  showAttackResults(grade);
  showTiming(view);
  // One bar per phrase: height = level played, colour = how well.
  const levels = chart.arrangement.maxDifficulty + 1;
  const labels = phraseLabels(chart);
  $('phraseStrip').replaceChildren(
    ...chart.phrases.map((p, i) => {
      const bar = document.createElement('i');
      const r = view!.results.get(i);
      bar.style.flexGrow = String(Math.max(p.end - p.start, 0.01));
      bar.style.setProperty('--h', r ? String((r.level + 1) / levels) : '0.06');
      bar.style.animationDelay = `${0.3 + (0.8 * i) / chart!.phrases.length}s`;
      bar.className = !r ? 'none' : r.accuracy >= 0.85 ? 'good' : r.accuracy >= 0.5 ? 'fair' : 'poor';
      const name = labels[i] || t('Silence');
      bar.title = r ? `${name} · ${Math.round(r.accuracy * 100)} %` : name;
      return bar;
    }),
  );
  const results = [...view.results.values()];
  const reached = results.reduce((m, r) => Math.max(m, r.nextLevel + 1), 0);
  const rows: [string, number, (n: number) => string][] = [
    [t('Points'), s.points, (n) => Math.round(n).toLocaleString(NUMBERS)],
    [t('Précision'), judged ? acc * 100 : NaN, (n) => (Number.isNaN(n) ? '—' : `${Math.round(n)} %`)],
    [t('Meilleure série'), s.bestStreak, (n) => String(Math.round(n))],
    [t('Parfaits'), s.hits ? (s.perfects / s.hits) * 100 : NaN, (n) => (Number.isNaN(n) ? '—' : `${Math.round(n)} %`)],
    [t('Notes ratées'), s.misses, (n) => String(Math.round(n))],
    [t('Niveau atteint'), reached || NaN, (n) => (Number.isNaN(n) ? '—' : `${Math.round(n)}/${levels}`)],
  ];
  const cells = rows.map(([k]) => {
    const cell = document.createElement('div');
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = k;
    cell.append(dt, dd);
    return cell;
  });
  $('stats').replaceChildren(...cells);
  const t0 = performance.now();
  const count = (now: number) => {
    const k = Math.min(1, (now - t0) / 1200);
    const ease = 1 - (1 - k) ** 3;
    rows.forEach(([, value, format], i) => {
      cells[i].querySelector('dd')!.textContent = format(Number.isNaN(value) ? NaN : value * ease);
    });
    if (k < 1 && mode === 'results') requestAnimationFrame(count);
  };
  requestAnimationFrame(count);
  if (grade === 'S' || grade === 'A') highway.celebrate(1);
  else if (grade === 'B') highway.celebrate(0.5);
  setMode('results');
}

function field<T extends HTMLInputElement | HTMLSelectElement>(name: string): T {
  return form.elements.namedItem(name) as T;
}

function syncSettings(): void {
  try {
    localStorage.setItem(STORAGE, JSON.stringify(settings));
  } catch {
    // storage unavailable: settings last for this session
  }
  field<HTMLInputElement>('invertStrings').checked = settings.invertStrings;
  field<HTMLInputElement>('masterMode').checked = settings.masterMode;
  field<HTMLInputElement>('recordTakes').checked = settings.recordTakes;
  field<HTMLInputElement>('autoLatency').checked = settings.autoLatency;
  field<HTMLSelectElement>('judging').value = settings.judging;
  field<HTMLSelectElement>('scenery').value = settings.scenery;
  field<HTMLSelectElement>('guitarTuning').value = settings.guitarTuning;
  if (!gig) highway.setScenery(settings.scenery);
  field<HTMLSelectElement>('speed').value = String(settings.speed);
  field<HTMLInputElement>('skill').value = String(settings.skill);
  field<HTMLSelectElement>('startLevel').value = String(settings.startLevel);
  $('skillOut').textContent = `${Math.round(settings.skill * 100)} %`;
  highway.configure({ invertStrings: settings.invertStrings, speed: settings.speed });
}

form.addEventListener('input', (e) => {
  // The language is not a game setting (see langSelect).
  if (e.target === langSelect) return;
  settings.invertStrings = field<HTMLInputElement>('invertStrings').checked;
  settings.masterMode = field<HTMLInputElement>('masterMode').checked;
  settings.autoLatency = field<HTMLInputElement>('autoLatency').checked;
  if (settings.recordTakes !== field<HTMLInputElement>('recordTakes').checked) {
    settings.recordTakes = !settings.recordTakes;
    if (engine instanceof TauriEngine) engine.setRecording(settings.recordTakes);
  if (engine instanceof TauriEngine) engine.setJudging(settings.judging);
  }
  const judging = field<HTMLSelectElement>('judging').value as Judging;
  if (JUDGINGS.includes(judging) && judging !== settings.judging) {
    settings.judging = judging;
    if (engine instanceof TauriEngine) engine.setJudging(judging);
  }
  settings.guitarTuning = field<HTMLSelectElement>('guitarTuning').value;
  const scenery = field<HTMLSelectElement>('scenery').value;
  if (isScenery(scenery)) settings.scenery = scenery;
  settings.speed = Number(field<HTMLSelectElement>('speed').value);
  settings.skill = Number(field<HTMLInputElement>('skill').value);
  settings.startLevel = Number(field<HTMLSelectElement>('startLevel').value);
  const guitar = field<HTMLSelectElement>('guitar').value;
  if (guitar && guitar !== career.guitar) {
    career = equipGuitar(career, guitar);
    storeCareer();
    wearGuitar();
  }
  syncSettings();
});

document.addEventListener('click', (e) => {
  const action = (e.target as HTMLElement).closest<HTMLElement>('[data-action]')?.dataset.action;
  const tab = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]')?.dataset.tab;
  if (tab === 'audio' || tab === 'latency' || tab === 'game' || tab === 'account') showSettingsTab(tab);
  if (action === 'resume') togglePause();
  else if (action === 'restart') restart();
  else if (action === 'library') {
    if (gig) finishGig('abandoned');
    else toLibrary();
  } else if (action === 'menu' || action === 'pause-menu') showMenu();
  else if (action === 'open-career') void openCareer();
  else if (action === 'open-trophies') void openTrophies();
  else if (action === 'open-world') openWorld();
  else if (action === 'open-lessons') openLessons();
  else if (action === 'next-lesson' && lessonRun !== null) void startLesson(lessonRun + 1);
  else if (action === 'encore-song') playEncore((e.target as HTMLElement).closest<HTMLElement>('[data-song]')?.dataset.song ?? '');
  else if (action === 'encore-skip') finishGig('played');
  else if (action === 'gig-next') nextGigSong();
  else if (action === 'gig-quit') finishGig('abandoned');
  else if (action === 'open-library') void openLibrary('play');
  else if (action === 'open-riff-library') void openLibrary('riff');
  else if (action === 'open-imports') openImports();
  else if (action === 'resume-last') {
    const id = screens.menu.querySelector<HTMLElement>('.menu-resume')?.dataset.song;
    if (id) {
      engine.unlock();
      libraryPurpose = 'play';
      void start(id);
    }
  } else if (action === 'open-settings') openSettings();
  else if (action === 'open-tuner') openTuner(null);
  else if (action === 'open-amp') openAmp();
  else if (action === 'close-amp') closeAmp();
  else if (action === 'close-help') toggleHelp(false);
  else if (action === 'open-welcome') openWelcome();
  else if (action === 'riff') openRiff();
  else if (action === 'riff-weakest' && chart) openRiff(weakestPhrase(chart));
  else if (action === 'riff-exit') {
    exitRiff();
    restart();
  }
});

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (e.key === 'P' && e.shiftKey) {
    perf.toggle();
    return;
  }
  if (e.key === '?') {
    toggleHelp();
    return;
  }
  if (!helpSheet.hidden) {
    if (e.key === 'Escape') toggleHelp(false);
    return;
  }
  if (welcome.visible) {
    if (e.key === 'Escape') welcome.finish();
    return;
  }
  if (mode === 'riff') {
    // A focused button takes Enter and Space itself.
    if (e.key === 'Escape') closeRiffPanel();
    else if ((e.key === 'Enter' || e.key === ' ') && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      riffPanel.start();
    }
    return;
  }
  if (mode === 'lessons' && (e.key === 'Enter' || e.key === ' ') && !(e.target instanceof HTMLButtonElement)) {
    e.preventDefault();
    lessonsScreen.startPicked();
    return;
  }
  switch (e.key) {
    case 'l':
    case 'L':
      if (!gig && lessonRun === null && (mode === 'play' || mode === 'pause' || mode === 'results')) openRiff();
      break;
    case 'ArrowUp':
    case 'ArrowDown':
      if (riff && (mode === 'play' || mode === 'pause')) {
        e.preventDefault();
        setRiffSpeed(riff.choice.speed + (e.key === 'ArrowUp' ? 0.05 : -0.05));
      } else if (!gig && !attack && (mode === 'play' || mode === 'pause')) {
        e.preventDefault();
        setPlaySpeed(playSpeed + (e.key === 'ArrowUp' ? 0.05 : -0.05));
      }
      break;
    case ' ':
      e.preventDefault();
      if (mode === 'results') restart();
      else if (mode === 'interlude') nextGigSong();
      else if (mode === 'tuner') {
        if (tuner.allDone()) finishTuner();
      } else if (mode === 'play' && waitingOn !== null) {
        // Wait mode: that note is let go, the song goes on.
        waitingOn = null;
        engine.play();
      } else togglePause();
      break;
    case 'Escape':
      if (mode === 'play') togglePause();
      // On stage, Escape never leaves by accident: the pause offers "Quitter le concert".
      else if (gig && mode === 'pause') togglePause();
      else if (gig && mode === 'tuner') finishTuner();
      else if (gig && mode === 'interlude') nextGigSong();
      else if (gig && mode === 'encore') finishGig('played');
      else if (mode === 'career' || mode === 'lessons') showMenu();
      else if (mode === 'library') {
        if (library.cardOpen) library.closeCard();
        else showMenu();
      } else if (mode === 'pause' || mode === 'results' || (mode === 'tuner' && chart)) toLibrary();
      else if (mode !== 'menu') showMenu();
      break;
    case '/':
      if (mode === 'library') {
        e.preventDefault();
        library.focusSearch();
      }
      break;
    case 'r':
    case 'R':
      if (!gig && (mode === 'play' || mode === 'pause' || mode === 'results')) restart();
      break;
    case 'ArrowLeft':
      if (!gig) seekBy(-5);
      break;
    case 'ArrowRight':
      if (!gig) seekBy(5);
      break;
    case 'i':
    case 'I':
      settings.invertStrings = !settings.invertStrings;
      syncSettings();
      break;
  }
});

const GAME_EVENTS = new Set(['reset', 'expected', 'hit', 'miss', 'late', 'phrase', 'score', 'pass', 'end']);

let last = performance.now();
/** From a song's start to its music (its first frame at song time 0 or later). */
let untilMusic: (() => void) | null = null;
function frame(ms: number): void {
  const dt = Math.min(0.1, Math.max(0, (ms - last) / 1000));
  last = ms;
  perf.frame(ms);
  // Music played on the real guitar counts toward the day (not the demo playing itself).
  if (mode === 'play' && engine.playing && engine instanceof TauriEngine && !settings.autopilot) practicing += dt;
  const t0 = performance.now();
  const f = engine.frame(ms);
  const t1 = performance.now();
  if (!hwHud.hidden) hwHud.level(f.peak, ms);
  if (tuner.visible) tuner.feed(f.events, ms);
  if (guitarSettings.visible) guitarSettings.feed(f, ms);
  if (ampPanel.visible) ampPanel.feed(f, ms);
  if (chart && view) {
    songTime = f.time;
    if (untilMusic && songTime >= 0) {
      untilMusic();
      untilMusic = null;
    }
    if (backlog.length) {
      view.apply(backlog, f.time);
      backlog = [];
    }
    view.apply(f.events, f.time);
    for (const e of f.events) {
      if (e.type === 'takeSaved') hud.toast({ kind: 'phrase', title: t('Prise enregistrée'), detail: formatTime(e.seconds) });
      // Wait mode: the note the song stopped on, and once per lesson what the stop means.
      if (e.type === 'waiting') {
        waitingOn = e.index;
        if (!waitHinted) hud.toast({ kind: 'phrase', title: t('Le jeu t’attend'), detail: t('Place tes doigts, puis joue : ça repart. Espace pour passer une note.') });
        waitHinted = true;
      } else if ((e.type === 'hit' || e.type === 'miss') && e.index === waitingOn) waitingOn = null;
      else if (e.type === 'reset') waitingOn = null;
    }
    for (const t of view.drainToasts()) {
      hud.toast(t);
      if (mode !== 'play') continue;
      if (t.kind === 'streak') {
        sfx.cue('streak');
        if (gig) sfx.cheer(0.25 + 0.5 * gig.crowd.value);
      } else if (t.kind === 'up' || t.kind === 'mastered' || t.kind === 'perfect') sfx.cue('levelUp');
    }
    for (const p of view.drainPasses()) onPass(p);
    for (const p of view.drainPhrases()) onAttackPhrase(p);
    hud.update(view, f.time);
    if (attack && mode === 'play') {
      trace.note(f.time, view.score.points);
      if (ghost) ghostHud.update(view.score.points, ghostAt(ghost.trace, f.time));
    }
    // On stage, every note warms or cools the crowd; a crowd left cold too long ends the gig.
    let booed = false;
    if (gig && mode === 'play') {
      for (const e of f.events) if (e.type === 'hit' || e.type === 'miss') gig.crowd.note(e.type === 'hit');
      booed = gig.crowd.update(dt);
      sfx.room(ROOM_IN_SONG * gig.crowd.value);
      hud.setCrowd(gig.crowd.value);
      highway.setCrowd(gig.crowd.value);
    }
    const ended = mode === 'play' && view.ended && !riff;
    highway.render(f.time + settings.visualOffsetMs / 1000, view, dt);
    if (booed) finishGig('booed');
    else if (ended) {
      if (gig) gigSongEnded();
      else showResults();
    }
  } else {
    for (const e of f.events) {
      if (e.type === 'reset') backlog = [];
      if (GAME_EVENTS.has(e.type)) backlog.push(e);
      // The guitar out of a song (menus, free play, settings): its strings ring on the neck.
      else if (e.type === 'played') highway.heard(e.midi, heldTuning);
      else if (e.type === 'strum') highway.strummed();
    }
    backlog = backlog.slice(-5000);
    highway.listen(f.peak, dt);
    highway.render(0, null, dt);
  }
  const t2 = performance.now();
  perf.worked({ moteur: t1 - t0, image: t2 - t1 }, { webgl: highway.drawMs });
  requestAnimationFrame(frame);
}

syncSettings();
interfaceSounds(document, sfx, () => mode !== 'play');
// The browser lets sound start only after a first gesture.
document.addEventListener('pointerdown', () => engine.unlock(), { once: true });
window.setTimeout(makeSounds, 300);
applyVolumes();
setMode('menu');
const progressLoaded = engine.progress
  .load()
  .then((p) => (progress = p))
  .catch(() => {});

if (engine instanceof TauriEngine) {
  // The window opens hidden (macOS paints a web view white until its page shows): it appears
  // once the menu and a first frame of the stage are drawn.
  requestAnimationFrame(() => requestAnimationFrame(() => void getCurrentWindow().show()));
  document.body.classList.add('live');
  engine.configureAmp(settings.amp);
  engine.setAutopilot(settings.autopilot);
  if (engine instanceof TauriEngine) engine.setRecording(settings.recordTakes);
  hwHud.setAutopilot(settings.autopilot);
  // The hardware strip follows the engine: input, connection, latency.
  const watchAudio = () => {
    void engine
      .status()
      .then((s) => {
        hwHud.status(s);
        return watchCable(s);
      })
      .catch(() => hwHud.status(null));
  };
  watchAudio();
  window.setInterval(watchAudio, 2000);
  let folder: string | null = null;
  try {
    folder = localStorage.getItem(FOLDER);
  } catch {
    // no storage: the folder is asked again next time
  }
  imports = new Imports($('imports'), $('dropOverlay'), {
    // Anywhere outside a song: dropped files go to the import.
    accepting: () => !['play', 'pause', 'interlude', 'encore', 'tuner', 'riff', 'results'].includes(mode),
    received: () => openImports(),
    play: (song) => void start(song),
    library: () => void openLibrary('play'),
    // Songs land in the background, a song may be under way: the open library keeps its place.
    libraryChanged: () => {
      void loadLibrary().then(() => {
        if (mode === 'library') library.refresh(songs, progress);
      });
    },
    queueChanged: (s) => hwHud.imports(s),
    folder,
    saveFolder: (path) => {
      try {
        if (path) localStorage.setItem(FOLDER, path);
        else localStorage.removeItem(FOLDER);
      } catch {
        // storage unavailable
      }
    },
  });
  imports.start().catch((e) => console.error('imports', e));
}
void showAudioStatus();
requestAnimationFrame(frame);
void progressLoaded.then(() => cloudQuietly(true));
void progressLoaded.then(loadLibrary).then(() => {
  const song = new URLSearchParams(location.search).get('song');
  if (song) void start(song);
});

Object.assign(window, { opensmith: { engine, highway, perf, welcome: openWelcome, get view() { return view; }, get time() { return songTime; } } });
