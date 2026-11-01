/**
 * A career played from the first week to the last date by a simulated player, through the
 * career's own rules (offers, crowd, gig settlement, weeks, gear, musicians, repertoire, album,
 * weekly challenge, trophies): to see where a player of a given level gets stuck, what pays,
 * what never matters.
 *
 * The player: each note hit or missed at random, its error rate set by the profile at a song's
 * full difficulty (measured with the virtual guitarist, `opensmith-simulate`), lower on easier
 * levels (fewer notes a minute) and as a song is played again; the levels climb phrase by
 * phrase as the game's dynamic difficulty does (85 % up, under 50 % down). The rest is the
 * app's code, as the gig flow of main.ts uses it.
 */

import {
  canGig,
  concludeGig,
  crowdStart,
  ENCORE,
  guitarsOf,
  hireMusician,
  learnSong,
  acceptSponsor,
  hireComms,
  post,
  resolveMoment,
  signContract,
  slotOf,
  MIN_SONG,
  newCareer,
  offers,
  playingAct,
  rehearseBand,
  releaseAlbum,
  rest,
  retuneStep,
  studioTake,
  weekIndex,
  buyGear,
  type Career,
  type GigOutcome,
  type GigSong,
  type Offer,
} from '../../src/career/career';
import { settleChallenge, weeklyChallenge } from '../../src/career/challenge';
import { Crowd } from '../../src/career/crowd';
import { levelOf, type Difficulty } from '../../src/career/difficulty';
import type { GearId } from '../../src/career/gear';
import { ALBUM_TRACKS, signed } from '../../src/career/label';
import { sponsorOffers } from '../../src/career/manager';
import { clipCost } from '../../src/career/press';
import { rankOf, sceneChart } from '../../src/career/world';
import { market } from '../../src/career/musicians';
import { formOf, rehearse, REHEARSAL, scout, starter } from '../../src/career/repertoire';
import { gradeFor } from '../../src/progress';
import { award, careerTrophies } from '../../src/trophies';

/** What the simulation needs of a library song. */
export interface SimSong {
  id: string;
  title: string;
  duration: number;
  tuning: string;
  notes: number;
  chords: number;
  /** Notes and chords at each level, 0 to the top. */
  levelNotes: number[];
}

export interface Profile {
  id: string;
  /** Share of notes missed at a song's full difficulty, at the reference density. */
  error: number;
  /** Errors fall this much a week of career (a player who practises), down to `floor` of them. */
  improves?: number;
  floor?: number;
}

/** Virtual guitarist, full charts, Normal judging (notes counted): clean 96 %, good 87 %,
 * beginner 62 %. "learner": a beginner who gets better week after week. */
export const PROFILES: readonly Profile[] = [
  { id: 'propre', error: 0.04 },
  { id: 'bon', error: 0.13 },
  { id: 'debutant', error: 0.38 },
  { id: 'apprenti', error: 0.38, improves: 0.015, floor: 0.3 },
];

export type Strategy = 'fonceur' | 'applique' | 'occasionnel';

export interface SimOptions {
  songs: readonly SimSong[];
  profile: Profile;
  strategy: Strategy;
  difficulty: Difficulty;
  seed: number;
  /** Weeks before giving up (15 seasons by default). */
  maxWeeks?: number;
  /** How much easier a sparser level is: errors × (density ratio)^gamma. */
  gamma?: number;
  /** Dynamic difficulty: a phrase played under this accuracy goes down a level (the game's 0.5). */
  levelDown?: number;
}

/** Notes a minute of a full chart the profiles' error rates were measured at (library median). */
const REFERENCE_DENSITY = 223;
/** Distinct phrases of a song and how often each comes back. */
const PHRASES = 4;
const ITERATIONS = 3;
const LEVEL_UP = 0.85;

export interface Anomaly {
  week: number;
  what: string;
}

export interface SimResult {
  profile: string;
  strategy: Strategy;
  difficulty: Difficulty;
  seed: number;
  weeks: number;
  /** Week each act was reached (2..6: 6 = the Hall of Fame). */
  actWeek: Record<number, number>;
  /** Money when each act began. */
  moneyAtAct: Record<number, number>;
  fansAtAct: Record<number, number>;
  finalAct: number;
  fans: number;
  money: number;
  gigs: number;
  booed: number;
  encores: number;
  /** Decisive gigs tried and won, by act. */
  decisive: Record<number, { tried: number; won: number; satisfaction: number[]; grades: string[]; complete: number[] }>;
  /** Accuracy of the songs played on stage, by act. */
  accuracyByAct: Record<number, number[]>;
  satisfactionByAct: Record<number, number[]>;
  effortByAct: Record<number, number[]>;
  levelShareByAct: Record<number, number[]>;
  moneyBySeason: number[];
  fansBySeason: number[];
  departures: number;
  hires: number;
  gear: Partial<Record<GearId, number>>;
  albums: { week: number; quality: number; copies: number }[];
  challenges: { tried: number; tiers: number[]; paid: number };
  trophies: string[];
  repertoire: number;
  practice: number;
  weeksWithoutGig: number;
  weeksSetlistShort: number;
  stolen: number;
  /** Wages paid late, sponsors signed and paid off, moments met, awards won, the hype at the end. */
  lateWages: number;
  sponsors: { signed: number; met: number };
  moments: Record<string, number>;
  awards: string[];
  hype: number[];
  /** Each week: the fans at its end and what its slots went to. */
  log: { fans: number; slots: string[] }[];
  /** Charity gigs played, donations, posts (videos among them), weeks with a communications manager. */
  charity: number;
  donations: number;
  posts: { all: number; clips: number };
  commsWeeks: number;
  followers: number;
  anomalies: Anomaly[];
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Skill {
  /** Level of each distinct phrase (dynamic difficulty, kept between plays as the app does). */
  levels: number[];
  plays: number;
}

export function simulateCareer(o: SimOptions): SimResult {
  const rand = rng(o.seed * 7919 + o.profile.id.length * 104729 + o.strategy.length * 13 + o.difficulty.length);
  const gamma = o.gamma ?? 0.3;
  const levelDown = o.levelDown ?? 0.5;
  const maxWeeks = o.maxWeeks ?? 180;
  const byId = new Map(o.songs.map((s) => [s.id, s]));
  const skills = new Map<string, Skill>();
  const rules = levelOf(o.difficulty);
  const r: SimResult = {
    profile: o.profile.id,
    strategy: o.strategy,
    difficulty: o.difficulty,
    seed: o.seed,
    weeks: 0,
    actWeek: {},
    moneyAtAct: {},
    fansAtAct: {},
    finalAct: 1,
    fans: 0,
    money: 0,
    gigs: 0,
    booed: 0,
    encores: 0,
    decisive: {},
    accuracyByAct: {},
    satisfactionByAct: {},
    effortByAct: {},
    levelShareByAct: {},
    moneyBySeason: [],
    fansBySeason: [],
    departures: 0,
    hires: 0,
    gear: {},
    albums: [],
    challenges: { tried: 0, tiers: [], paid: 0 },
    trophies: [],
    repertoire: 0,
    practice: 0,
    weeksWithoutGig: 0,
    weeksSetlistShort: 0,
    stolen: 0,
    lateWages: 0,
    sponsors: { signed: 0, met: 0 },
    moments: {},
    awards: [],
    hype: [],
    log: [],
    charity: 0,
    donations: 0,
    posts: { all: 0, clips: 0 },
    commsWeeks: 0,
    followers: 0,
    anomalies: [],
  };
  const top = (s: SimSong) => Math.max(0, s.levelNotes.length - 1);
  const skillOf = (s: SimSong): Skill => {
    let k = skills.get(s.id);
    if (!k) skills.set(s.id, (k = { levels: Array(PHRASES).fill(0), plays: 0 }));
    return k;
  };
  const errorAt = (s: SimSong, level: number, plays: number, week: number): number => {
    const notes = s.levelNotes[Math.min(level, top(s))] ?? s.notes + s.chords;
    const density = s.duration > 0 ? (notes / s.duration) * 60 : REFERENCE_DENSITY;
    const base = o.profile.improves ? o.profile.error * Math.max(o.profile.floor ?? 0, (1 - o.profile.improves) ** (week - 1)) : o.profile.error;
    const learned = 1 - 0.25 * Math.min(1, plays / 20);
    return Math.min(0.95, Math.max(0.005, base * learned * Math.pow(Math.max(density, 1) / REFERENCE_DENSITY, gamma)));
  };

  /** A song played through (or until booed): notes hit or missed phrase by phrase, levels moved
   * as the game moves them, the crowd following each note. */
  const play = (s: SimSong, week: number, crowd: Crowd | null, levelOverride?: number): { song: GigSong; booed: boolean; levelShare: number } => {
    const k = skillOf(s);
    const seconds = s.duration / (PHRASES * ITERATIONS);
    let hits = 0;
    let judged = 0;
    let played = 0;
    let levelSum = 0;
    let booed = false;
    for (let it = 0; it < PHRASES * ITERATIONS && !booed; it++) {
      const p = it % PHRASES;
      const level = levelOverride ?? k.levels[p];
      levelSum += top(s) ? level / top(s) : 1;
      const notes = Math.round((s.levelNotes[Math.min(level, top(s))] ?? 0) / (PHRASES * ITERATIONS));
      const e = errorAt(s, level, k.plays, week);
      let ok = 0;
      for (let n = 0; n < notes; n++) {
        const hit = rand() >= e;
        if (hit) ok++;
        if (crowd) {
          crowd.note(hit);
          if (crowd.update(seconds / notes)) {
            booed = true;
            judged += n + 1;
            hits += ok;
            played += (seconds * (n + 1)) / notes;
            break;
          }
        }
      }
      if (booed) break;
      if (!notes && crowd && crowd.update(seconds)) booed = true;
      judged += notes;
      hits += ok;
      played += seconds;
      if (levelOverride === undefined && notes) {
        const acc = ok / notes;
        if (acc >= LEVEL_UP && k.levels[p] < top(s)) k.levels[p]++;
        else if (acc < levelDown && k.levels[p] > 0) k.levels[p]--;
      }
    }
    k.plays++;
    const accuracy = judged ? hits / judged : 0;
    return {
      song: { id: s.id, title: s.title, grade: gradeFor(accuracy, judged), accuracy, crowd: crowd?.value ?? 0, notes: judged, seconds: Math.min(s.duration, played), full: s.levelNotes[top(s)] },
      booed,
      levelShare: levelSum / (PHRASES * ITERATIONS),
    };
  };

  /** How ready a song is: its expected accuracy at the levels it is at. */
  const readiness = (c: Career, s: SimSong): number => {
    const k = skillOf(s);
    const level = Math.round(k.levels.reduce((a, b) => a + b, 0) / PHRASES);
    const form = c.repertoire[s.id] ? formOf(c.repertoire[s.id], weekIndex(c)) : 0;
    return (1 - errorAt(s, level, k.plays, weekIndex(c))) * (0.85 + 0.25 * form);
  };

  /** The setlist for `offer`: its number of songs from the repertoire, the readiest, long enough,
   * grouped by tuning; null when the repertoire cannot fill it. */
  const setlistFor = (c: Career, offer: Offer): SimSong[] | null => {
    const known = Object.keys(c.repertoire)
      .map((id) => byId.get(id))
      .filter((s): s is SimSong => !!s)
      .sort((a, b) => readiness(c, b) - readiness(c, a));
    if (known.length < offer.songs) return null;
    let pick = known.slice(0, offer.songs);
    // Too short: swap the shortest for longer ones.
    const min = offer.songs * MIN_SONG;
    const rest = known.slice(offer.songs).sort((a, b) => b.duration - a.duration);
    while (pick.reduce((t, s) => t + s.duration, 0) < min && rest.length) {
      pick.sort((a, b) => a.duration - b.duration);
      pick = [rest.shift()!, ...pick.slice(1)];
    }
    if (pick.reduce((t, s) => t + s.duration, 0) < min) return null;
    return pick.sort((a, b) => a.tuning.localeCompare(b.tuning));
  };

  /** A song learned (a slot of the week) when the repertoire cannot fill `need` songs and one more. */
  const learnFor = (c: Career, need: number): Career => {
    if (Object.keys(c.repertoire).length >= need + 1) return c;
    const proposals = scout(o.songs, c.repertoire, playingAct(c), weekIndex(c), MIN_SONG);
    return (proposals.length && learnSong(c, proposals[0].id)) || c;
  };

  /** A gig played as main.ts plays it: the crowd from its start, retuning between songs, an
   * encore when the crowd calls for it, the settlement. */
  const gig = (c: Career, offer: Offer, list: SimSong[]): Career => {
    const week = weekIndex(c);
    const crowd = new Crowd(crowdStart(c, offer), rules.patience);
    const songs: GigSong[] = [];
    let outcome: GigOutcome = 'played';
    let held: string[] = [];
    let prev: string | null = null;
    const shares: number[] = [];
    for (const s of list) {
      const step = retuneStep(held, prev, s.tuning, guitarsOf(c));
      held = step.held;
      if (step.costs) crowd.cool(rules.retune);
      prev = s.tuning;
      const out = play(s, week, crowd);
      shares.push(out.levelShare);
      songs.push(out.song);
      if (out.booed) {
        outcome = 'booed';
        break;
      }
    }
    let encore: GigSong | null = null;
    if (outcome === 'played' && crowd.value >= ENCORE) {
      const extra = Object.keys(c.repertoire)
        .map((id) => byId.get(id))
        .filter((s): s is SimSong => !!s && !list.includes(s))
        .sort((a, b) => readiness(c, b) - readiness(c, a))[0];
      if (extra) {
        if (retuneStep(held, prev, extra.tuning, guitarsOf(c)).costs) crowd.cool(rules.retune);
        encore = play(extra, week, crowd).song;
      }
    }
    const before = c.act;
    const result = concludeGig(c, offer, songs, outcome, { encore, pauses: 0, when: new Date(0) });
    r.gigs++;
    if (outcome === 'booed') r.booed++;
    if (result.record.encore) r.encores++;
    (r.satisfactionByAct[before] ??= []).push(result.record.satisfaction);
    (r.accuracyByAct[before] ??= []).push(result.record.accuracy);
    (r.effortByAct[before] ??= []).push(result.record.effort);
    (r.levelShareByAct[before] ??= []).push(shares.reduce((a, b) => a + b, 0) / Math.max(1, shares.length));
    if (offer.venue.decisive) {
      const d = (r.decisive[offer.venue.act] ??= { tried: 0, won: 0, satisfaction: [], grades: [], complete: [] });
      d.tried++;
      d.satisfaction.push(result.record.satisfaction);
      d.grades.push(result.record.grade);
      d.complete.push(result.record.complete ?? 1);
      if (result.actUp) d.won++;
    }
    let after = result.career;
    after = award(after, careerTrophies(after, { outcome, satisfaction: result.record.satisfaction, encore: !!result.record.encore }), new Date(0)).career;
    return after;
  };

  const GEAR_ORDER: Record<Strategy, GearId[]> = {
    fonceur: ['van', 'sono', 'ampli', 'merch', 'guitare2', 'equipe', 'ecrans', 'bus', 'pyro', 'scene', 'studio'],
    applique: ['ampli', 'guitare2', 'van', 'merch', 'sono', 'equipe', 'bus', 'studio', 'ecrans', 'pyro', 'scene'],
    occasionnel: ['ampli', 'guitare2', 'merch', 'van', 'sono', 'equipe', 'bus', 'ecrans', 'studio', 'pyro', 'scene'],
  };

  let c: Career = newCareer(o.difficulty);
  c = { ...c, repertoire: starter(o.songs, [], weekIndex(c), MIN_SONG) };
  let seasonSeen = 1;
  while (weekIndex(c) <= maxWeeks && c.hallOfFame.length === 0) {
    const week = weekIndex(c);
    const startWeek = `${c.season}-${c.week}`;
    c = { ...c, report: null };
    // The business: the label once the showcase is won, a sponsor when one comes by, the moment's
    // choice (each strategy its way).
    if (c.act >= 4 && !c.contract) c = signContract(c, o.strategy === 'fonceur' ? 'major' : o.strategy === 'applique' ? 'independant' : 'autoprod');
    if (!c.sponsor && o.strategy !== 'occasionnel') {
      // The card is not simulated: a goal on its rating could never be met here.
      const rank = rankOf(sceneChart(c.world, 'sim', c.fans, weekIndex(c)));
      const deal = sponsorOffers(playingAct(c), c.season, c.week, c.fans, rank, c.followers).find((d) => d.goal !== 'card');
      if (deal) {
        c = acceptSponsor(c, deal);
        r.sponsors.signed++;
      }
    }
    if (c.moment) {
      const m = c.moment;
      r.moments[m.kind] = (r.moments[m.kind] ?? 0) + 1;
      const gift = Number(m.args.gift ?? 0);
      const cause = o.strategy === 'applique' ? 'concert' : o.strategy === 'occasionnel' && c.money > 3 * gift ? 'don' : 'relayer';
      const pick = { interview: o.strategy === 'fonceur' ? 'provoc' : 'humble', dispute: 'pause', offre: 'non', debauchage: c.money > 5000 ? 'garder' : 'partir', viral: 'ok', cause }[m.kind];
      if (pick === 'don') r.donations++;
      c = resolveMoment(c, pick);
    }
    // The networks: a post a week (a video when money allows), a manager once the clubs pay.
    if (o.strategy !== 'occasionnel') {
      const clip = o.strategy === 'applique' && c.money > 10 * clipCost(playingAct(c));
      const posted = post(c, clip ? 'clip' : 'coulisses');
      if (posted) {
        c = posted;
        r.posts.all++;
        if (clip) r.posts.clips++;
      }
    }
    if (o.strategy === 'applique' && !c.comms && playingAct(c) >= 3 && c.money > 20000) c = hireComms(c);
    if (c.comms) r.commsWeeks++;
    // Gear and musicians, a reserve kept for the road.
    for (const id of GEAR_ORDER[o.strategy]) {
      const bought = buyGear({ ...c, money: c.money - 150 }, id);
      if (bought) {
        c = { ...bought, money: bought.money + 150 };
        r.gear[id] = week;
      }
    }
    if (o.strategy === 'applique') {
      for (const m of market(playingAct(c), week)) {
        const now = c.members.find((x) => x.role === m.role)!;
        if (m.precision + m.energy > now.precision + now.energy + 15 && m.fee <= c.money - 300) {
          const hired = hireMusician(c, m);
          if (hired) {
            c = hired;
            r.hires++;
          }
        }
      }
    }
    // The weekly challenge: free money (a library song at the act's level).
    if (o.strategy !== 'occasionnel') {
      const ch = weeklyChallenge(c, o.songs);
      const s = ch && byId.get(ch.song);
      if (ch && s) {
        const share = { easy: 0.3, medium: 0.55, hard: 0.8, master: 1 }[ch.level];
        const pass = { easy: 0.4, medium: 0.5, hard: 0.6, master: 0.7 }[ch.level];
        const out = play(s, week, null, Math.round(top(s) * share));
        const settled = settleChallenge(c, ch, { failed: out.song.accuracy < pass, accuracy: out.song.accuracy });
        c = settled.career;
        r.challenges.tried++;
        r.challenges.tiers.push(settled.tier);
        r.challenges.paid += settled.paid;
      }
    }
    const list = offers(c);
    if (!list.length) r.anomalies.push({ week, what: 'aucune offre de concert cette semaine' });
    if (list.some((x) => x.stolen)) r.stolen++;
    c = learnFor(c, Math.max(0, ...list.map((x) => x.songs)));
    // Practice at home (free play), the diligent player: the songs of the next setlists.
    if (o.strategy === 'applique') {
      const known = Object.keys(c.repertoire)
        .map((id) => byId.get(id)!)
        .filter(Boolean)
        .sort((a, b) => readiness(c, a) - readiness(c, b))
        .slice(0, 3);
      for (const s of known) {
        play(s, week, null);
        c = { ...c, repertoire: rehearse(c.repertoire, s.id, week, REHEARSAL) };
        r.practice++;
      }
    }
    // The slots: gigs first, then rehearsal, studio or rest.
    let gigsThisWeek = 0;
    let short = false;
    const trace: string[] = [];
    for (let guard = 0; `${c.season}-${c.week}` === startWeek && guard < 20; guard++) {
      const gigsWanted = o.strategy === 'occasionnel' ? 1 : 2;
      const available = offers(c).filter((x) => !x.stolen);
      const decisive = available.find((x) => x.venue.decisive);
      const plain = available.filter((x) => !x.venue.decisive).sort((a, b) => b.venue.fee * (b.headliner ? 2 : 1) - a.venue.fee * (a.headliner ? 2 : 1));
      let choice: Offer | null = null;
      // The charity gig the band organised comes first.
      const benefit = available.find((x) => x.charity);
      if (benefit && canGig(c) && gigsThisWeek < gigsWanted && setlistFor(c, benefit)) choice = benefit;
      if (!choice && canGig(c) && gigsThisWeek < gigsWanted) {
        if (decisive) {
          const ready = setlistFor(c, decisive);
          const expected = ready ? ready.reduce((t, s) => t + readiness(c, s), 0) / ready.length : 0;
          const target = decisive.venue.win ?? 0.6;
          // The diligent player waits to be ready; the others go for it.
          const go = o.strategy !== 'applique' || (expected - 0.55) / 0.4 >= target + 0.05 || (r.decisive[decisive.venue.act]?.tried ?? 0) === 0;
          if (go && ready) choice = decisive;
        }
        choice ??= plain.find((x) => setlistFor(c, x)) ?? null;
        if (!choice && available.length) short = true;
      }
      if (choice) {
        if (choice.charity) r.charity++;
        const setlist = setlistFor(c, choice)!;
        trace.push(slotOf(choice));
        c = gig(c, choice, setlist);
        gigsThisWeek++;
        continue;
      }
      const morale = c.members.reduce((t, m) => t + m.morale, 0) / c.members.length;
      if (o.strategy !== 'occasionnel' && signed(c) && c.contract && Object.keys(c.album.takes).length < ALBUM_TRACKS && morale >= 0.4) {
        const pool = Object.keys(c.repertoire)
          .map((id) => byId.get(id)!)
          .filter((s) => s && !(s.id in c.album.takes))
          .sort((a, b) => readiness(c, b) - readiness(c, a));
        const s = pool[0];
        if (s) {
          const take = play(s, week, null);
          trace.push(`studio (${c.album.session ?? 0})`);
          c = studioTake(c, s.id, take.song.accuracy);
          continue;
        }
      }
      trace.push(o.strategy !== 'occasionnel' && morale >= 0.45 ? 'répète' : 'repos');
      c = o.strategy !== 'occasionnel' && morale >= 0.45 ? rehearseBand(c) : rest(c);
    }
    if (!gigsThisWeek) r.weeksWithoutGig++;
    if (short) r.weeksSetlistShort++;
    const album = releaseAlbum(c, new Date(0));
    if (album) {
      c = album.career;
      r.albums.push({ week, quality: album.release.quality, copies: album.release.copies });
    }
    r.departures += c.news.filter((n) => n.includes('quitte le groupe')).length;
    r.lateWages += c.news.filter((n) => n.includes('payés en retard')).length;
    r.sponsors.met += c.news.filter((n) => n.includes('objectif atteint')).length;
    r.awards.push(...c.news.filter((n) => n.includes('la scène te récompense')).map((n) => n.split(' :')[0]));
    r.hype.push(c.hype);
    r.log.push({ fans: c.fans, slots: trace });
    c = { ...c, news: [] };
    c = award(c, careerTrophies(c, null), new Date(0)).career;
    for (let a = 2; a <= 6; a++)
      if (c.act >= a && r.actWeek[a] === undefined) {
        r.actWeek[a] = week;
        r.moneyAtAct[a] = c.money;
        r.fansAtAct[a] = c.fans;
      }
    if (c.season !== seasonSeen) {
      r.moneyBySeason.push(c.money);
      r.fansBySeason.push(c.fans);
      seasonSeen = c.season;
    }
    // Sanity: what a save must never hold.
    if (!Number.isFinite(c.money) || !Number.isFinite(c.fans)) r.anomalies.push({ week, what: `argent ou fans non numériques (${c.money}, ${c.fans})` });
    if (c.money < 0) r.anomalies.push({ week, what: `argent négatif : ${c.money}` });
    if (c.act < 1 || c.act > 6) r.anomalies.push({ week, what: `acte hors bornes : ${c.act}` });
    if (`${c.season}-${c.week}` === startWeek) {
      r.anomalies.push({ week, what: `la semaine ne passe pas (${trace.join(', ')} ; créneaux ${c.slots.join(', ')})` });
      break;
    }
  }
  if (c.hallOfFame.length && r.actWeek[6] === undefined) r.actWeek[6] = weekIndex(c);
  r.weeks = weekIndex(c);
  r.finalAct = c.act;
  r.fans = c.fans;
  r.money = c.money;
  r.trophies = Object.keys(c.trophies).sort();
  r.repertoire = Object.keys(c.repertoire).length;
  r.followers = c.followers;
  return r;
}
