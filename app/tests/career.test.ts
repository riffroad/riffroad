import { describe, expect, it } from 'vitest';
import { newWorld } from '../src/career/world';
import {
  learnSong,
  ENCORE,
  VENUES,
  WIN,
  buyGuitar,
  concludeGig,
  encoreBonus,
  equipGuitar,
  effortOf,
  fansFor,
  feeFor,
  gigAccuracy,
  lockedVenues,
  minSetlist,
  nameBand,
  newCareer,
  objective,
  ofVenue,
  offers,
  ownedGuitars,
  resetCareer,
  restWeek,
  sanitizeCareer,
  seasonSummary,
  songEffort,
  type Career,
  type GigSong,
} from '../src/career/career';
import { BOO_AFTER, Crowd } from '../src/career/crowd';
import { DEFAULT_GUITAR, FOR_SALE, GUITARS } from '../src/guitars';
import { defaultBand, NAME_MAX, sanitizeBand } from '../src/band';
import { bestTier, settleChallenge, tierOf, tierPrize, weeklyChallenge } from '../src/career/challenge';
import { careerTrophies } from '../src/trophies';
import { startingBand } from '../src/career/musicians';

const venue = (id: string) => VENUES.find((v) => v.id === id)!;
// A band whose precision and energy change nothing, never missing a gig.
const steady = (c: Career): Career => ({ ...c, members: c.members.map((m) => ({ ...m, precision: 50, energy: 50, reliability: 100, morale: 1 })) });

// Four-minute songs at 120 notes a minute (an effort of exactly 1), played at 85 % (B).
const songs = (...crowds: number[]): GigSong[] =>
  crowds.map((crowd, i) => ({ id: `s${i}`, title: `Song ${i}`, grade: 'B', accuracy: 0.85, crowd, notes: 480, seconds: 240 }));
const clean = (s: GigSong[]): GigSong[] => s.map((x) => ({ ...x, grade: 'A', accuracy: 0.95 }));
/** Played at an easy level: a quarter of the songs' 1 920 notes. */
const light = (s: GigSong[]): GigSong[] => s.map((x) => ({ ...x, full: 1920 }));
/** Played nearly whole. */
const whole = (s: GigSong[]): GigSong[] => s.map((x) => ({ ...x, full: 600 }));

describe('career', () => {
  it('starts in the garage, the venues opening with the fans', () => {
    const c = newCareer();
    expect(offers(c).map((o) => o.venue.id)).toEqual(['garage']);
    expect(lockedVenues(c).map((v) => v.id)).toEqual(['anniversaire', 'quartier', 'lycee']);
    const known: Career = { ...c, fans: 25 };
    expect(offers(known).map((o) => o.venue.id).sort()).toEqual(['anniversaire', 'garage', 'quartier']);
    expect(objective(known).text).toBe('50 fans pour jouer la fête de fin d’année');
    expect(['Le garage de Max', 'La fête de quartier', 'L’anniversaire de Léa', 'Le Pub du port'].map(ofVenue)).toEqual([
      'du garage de Max',
      'de la fête de quartier',
      'de l’anniversaire de Léa',
      'du Pub du port',
    ]);
  });

  it('offers the same gigs all week, others the week after', () => {
    const c: Career = { ...newCareer(), fans: 60 };
    expect(offers(c)).toEqual(offers(c));
    const audiences = new Set(Array.from({ length: 6 }, (_, w) => offers({ ...c, week: w + 1 })[0].audience));
    expect(audiences.size).toBeGreaterThan(1);
    const o = offers(c)[0];
    expect(o.audience).toBeGreaterThanOrEqual(o.venue.audience[0]);
    expect(o.audience).toBeLessThanOrEqual(o.venue.audience[1]);
  });

  it('pays and wins fans with the crowd, loses some when cut short', () => {
    expect(feeFor(venue('saloon'), 1)).toBe(70);
    expect(feeFor(venue('saloon'), 0)).toBe(25);
    expect(fansFor(70, 0.75, 'played')).toBe(53);
    expect(fansFor(70, 0, 'played')).toBe(11);
    expect(fansFor(70, 0.75, 'booed')).toBe(-7);
  });

  it('opens the decisive gig with the fans and the next act by winning it', () => {
    const c: Career = { ...newCareer(), fans: 55, week: 12 };
    const decisive = offers(c).find((o) => o.venue.decisive)!;
    expect(decisive.venue.id).toBe('lycee');
    const lost = concludeGig(c, decisive, songs(0.5, 0.55, 0.6), 'played');
    expect(lost.actUp).toBe(false);
    const won = concludeGig(steady(c), decisive, songs(0.7, 0.8, WIN + 0.15), 'played');
    expect(won.actUp).toBe(true);
    expect(won.career.act).toBe(2);
    expect([won.career.season, won.career.week, won.career.slots]).toEqual([1, 12, ['gig:lycee']]);
    expect(won.career.money).toBe(feeFor(decisive.venue, won.record.satisfaction));
    expect([restWeek(won.career).season, restWeek(won.career).week]).toEqual([2, 1]);
    expect(won.career.history[0].review).toContain('Song 1');
    expect(offers(won.career).every((o) => o.venue.act === 2)).toBe(true);
  });

  it('goes from the bars to the clubs, the Sous-Sol first', () => {
    const c: Career = { ...newCareer(), act: 2, fans: 520 };
    const decisive = offers(c).find((o) => o.venue.decisive)!;
    const { career } = concludeGig(c, decisive, songs(0.9), 'played');
    expect(career.act).toBe(3);
    expect(offers(career).map((o) => o.venue.id)).toEqual(['soussol']);
    expect(lockedVenues(career).map((v) => v.id)).toEqual(['usine', 'neonclub', 'machine', 'showcase']);
    expect(objective(career).text).toBe('4\u202f500 fans pour jouer le showcase du label');
    const opening = offers({ ...career, fans: 1200 }).find((o) => o.venue.opening);
    expect(opening?.venue).toMatchObject({ id: 'usine', opening: 'Neon Wolves', songs: 3 });
  });

  it('signs with the label for a show the crowd loved, its songs not played in an easy version', () => {
    const c: Career = { ...newCareer(), act: 3, fans: 4600 };
    const showcase = offers(c).find((o) => o.venue.decisive)!;
    expect(showcase.venue.id).toBe('showcase');
    expect(objective(c).text).toContain('les morceaux joués à 66 % de leurs notes');
    // The crowd won over at an easy level (a quarter of the notes): the scout wants the songs.
    const easy = concludeGig(c, showcase, light(clean(songs(0.9, 0.9, 0.9))), 'played');
    expect(easy.record.complete).toBeCloseTo(0.25);
    expect(easy.actUp).toBe(false);
    expect(easy.record.review).toContain('dénicheur');
    // Played nearly whole at 85 % (a B, the edge where dynamic difficulty keeps a player): signed.
    const signed = concludeGig(c, showcase, whole(songs(0.9, 0.9, 0.9)), 'played');
    expect(signed.record.grade).toBe('B');
    expect(signed.actUp).toBe(true);
    expect(signed.career.act).toBe(4);
    // Signed: on to the summer festivals.
    expect(offers({ ...signed.career, slots: [] }).map((o) => o.venue.id)).toEqual(['plage']);
    expect(objective(signed.career).text).toBe('90\u202f000 fans pour jouer le tremplin');
  });

  it('takes a slot of the week to learn a song', () => {
    const c: Career = { ...newCareer(), repertoire: {} };
    const once = learnSong(c, 'new')!;
    expect(once.repertoire.new).toBeDefined();
    expect(once.slots).toEqual(['learn']);
    expect(learnSong(once, 'new')).toBeNull();
    expect(learnSong({ ...c, slots: ['rest', 'rest', 'rest'] }, 'other')).toBeNull();
  });

  it('weighs the gig’s accuracy by the notes of each song', () => {
    expect(gigAccuracy([{ accuracy: 1, notes: 300 }, { accuracy: 0.5, notes: 100 }])).toBeCloseTo(0.875);
    expect(gigAccuracy([])).toBe(0);
  });

  it('pays nothing for a gig cut short and rests a week', () => {
    const c: Career = { ...newCareer(), fans: 30, money: 100 };
    const o = offers(c)[0];
    const booed = concludeGig(c, o, songs(0.05), 'booed');
    expect(booed.career.money).toBe(100);
    expect(booed.career.fans).toBeLessThan(30);
    expect(booed.record.review).toContain('sifflets');
    expect(restWeek(c).week).toBe(2);
  });

  it('reads a damaged save back into shape', () => {
    expect(sanitizeCareer(null)).toBeNull();
    expect(sanitizeCareer({ week: 40, act: 9, fans: -5, money: 'x', history: 'no' })).toEqual({
      version: 1,
      season: 1,
      week: 12,
      act: 6,
      fans: 0,
      money: 0,
      history: [],
      report: null,
      guitars: [],
      guitar: DEFAULT_GUITAR,
      trophies: {},
      stats: { gigs: 0, cleanGigs: 0, encores: 0, earned: 0 },
      repertoire: {},
      slots: [],
      gear: [],
      members: startingBand(),
      news: [],
      difficulty: 'pro',
      album: { takes: {}, released: [] },
      labelReport: null,
      hallOfFame: [],
      challenge: null,
      band: null,
      souvenirs: [],
      skills: { values: {}, history: [] },
      world: newWorld(),
      hype: 40,
      moment: null,
      sponsor: null,
      contract: null,
      followers: 0,
      posted: null,
      comms: false,
      charity: null,
    });
    const old = sanitizeCareer({ ...newCareer(), report: undefined, history: [{ venue: 'Le Zinc', season: 1, week: 2, satisfaction: 0.5 }] })!;
    expect(old.report).toBeNull();
    expect(old.history[0].effort).toBe(1);
    expect(old.history[0].encore).toBeNull();
  });

  it('counts, for a save from before the counts, what its history tells', () => {
    const played = { venue: 'Le Zinc', season: 1, week: 2, outcome: 'played', satisfaction: 0.5, money: 120 };
    const booed = { ...played, outcome: 'booed', money: 0 };
    const { stats: _s, trophies: _t, ...older } = { ...newCareer(), history: [played, booed, played] };
    expect(sanitizeCareer(older)?.stats).toEqual({ gigs: 2, cleanGigs: 0, encores: 0, earned: 240 });
    expect(sanitizeCareer({ ...newCareer(), trophies: { premiere: '2026-10-01', bogus: 'x', solo: 3 } })?.trophies).toEqual({ premiere: '2026-10-01' });
  });

  it('pays an encore on top, as its crowd ends it, and counts the gig', () => {
    const c: Career = { ...newCareer(), act: 2, fans: 200 };
    const o = { venue: venue('zinc'), audience: 100, songs: 4 };
    const encore = songs(0.9)[0];
    const bonus = encoreBonus(o, encore);
    expect(bonus).toEqual({ fans: 23, money: 55 });
    const plain = concludeGig(c, o, songs(0.85, 0.85, 0.85, 0.85), 'played');
    const called = concludeGig(c, o, songs(0.85, 0.85, 0.85, 0.85), 'played', { encore, pauses: 0 });
    expect(called.record.satisfaction).toBe(plain.record.satisfaction);
    expect(called.record.money).toBe(plain.record.money + 55);
    expect(called.record.fans).toBe(plain.record.fans + 23);
    expect(called.record.encore).toEqual({ title: 'Song 0', crowd: 0.9, fans: 23, money: 55 });
    expect(called.career.stats).toEqual({ gigs: 1, cleanGigs: 1, encores: 1, earned: called.record.money });
    const paused = concludeGig(c, o, songs(0.85), 'played', { pauses: 2 });
    expect(paused.career.stats).toMatchObject({ gigs: 1, cleanGigs: 0, encores: 0 });
    const cut = concludeGig(c, o, songs(0.85), 'abandoned', { encore });
    expect(cut.record.encore).toBeNull();
    expect(cut.career.stats.gigs).toBe(0);
    expect(ENCORE).toBe(0.85);
  });

  it('rewards demanding songs played fully, refuses snippets', () => {
    expect(songEffort({ notes: 0, seconds: 200 })).toBeCloseTo(0.6);
    expect(songEffort({ notes: 480, seconds: 240 })).toBeCloseTo(1);
    expect(songEffort({ notes: 2000, seconds: 240 })).toBeCloseTo(1.4);
    // Weighted by length: a long dense song outweighs a short sparse one.
    expect(effortOf([{ notes: 960, seconds: 240 }, { notes: 10, seconds: 60 }])).toBeCloseTo((1.4 * 240 + 0.6333 * 60) / 300, 3);
    expect(fansFor(100, 0.8, 'played', 1.4)).toBeGreaterThan(fansFor(100, 0.8, 'played', 0.6) * 2);
    expect(feeFor(venue('zinc'), 1, 1.4)).toBe(170);
    const o = offers({ ...newCareer(), act: 2, fans: 200 }).find((x) => x.venue.id === 'zinc')!;
    expect(minSetlist(o)).toBe(4 * 150);
  });

  it('closes a season with its report', () => {
    const c: Career = { ...newCareer(), fans: 30, week: 11 };
    const o = offers(c)[0];
    const first = restWeek(concludeGig(c, o, songs(0.8), 'played').career);
    expect(first.report).toBeNull();
    const last = restWeek(concludeGig(first, offers(first)[0], songs(0.5), 'played').career);
    expect([last.season, last.week, last.report]).toEqual([2, 1, 1]);
    const summary = seasonSummary(last, 1);
    expect(summary.gigs).toBe(2);
    expect(summary.fans).toBe(last.fans - 30);
    expect(summary.best?.satisfaction).toBeCloseTo(0.8);
    expect(restWeek({ ...newCareer(), week: 12 }).report).toBe(1);
  });
});

describe('crowd', () => {
  it('warms up with good notes and cools down with misses', () => {
    const crowd = new Crowd(0.5);
    for (let i = 0; i < 60; i++) {
      crowd.note(true);
      crowd.update(0.25);
    }
    expect(crowd.value).toBeGreaterThan(0.9);
    for (let i = 0; i < 30; i++) {
      crowd.note(i % 2 === 0);
      crowd.update(0.25);
    }
    expect(crowd.value).toBeLessThan(0.3);
  });

  it('follows at the same pace at any frame rate', () => {
    const a = new Crowd(0.5);
    const b = new Crowd(0.5);
    a.note(true);
    b.note(true);
    for (let i = 0; i < 60; i++) a.update(1 / 60);
    for (let i = 0; i < 120; i++) b.update(1 / 120);
    expect(a.value).toBeCloseTo(b.value, 6);
  });

  it('boos the band off after a long cold spell, cools at a retuning', () => {
    const crowd = new Crowd(0.5);
    for (let i = 0; i < 40; i++) crowd.note(false);
    let off = false;
    for (let t = 0; t < BOO_AFTER + 10 && !off; t += 0.5) off = crowd.update(0.5);
    expect(off).toBe(true);
    const warm = new Crowd(0.8);
    warm.cool(0.12);
    expect(warm.value).toBeCloseTo(0.68);
    expect(warm.target).toBeLessThan(0.8);
  });
});

describe('guitar shop', () => {
  const rich = (money: number): Career => ({ ...newCareer(), money });

  it('starts with the stock guitar, the others for sale dearer one after the other or won', () => {
    expect(ownedGuitars(newCareer()).map((g) => g.id)).toEqual([DEFAULT_GUITAR]);
    expect(GUITARS[0]).toMatchObject({ id: DEFAULT_GUITAR, price: 0 });
    for (let i = 1; i < FOR_SALE.length; i++) expect(FOR_SALE[i].price).toBeGreaterThan(FOR_SALE[i - 1].price);
    expect(GUITARS.filter((g) => g.trophy).map((g) => g.id)).toEqual(['relique', 'lave', 'platine']);
    expect(buyGuitar(rich(1e6), 'lave')).toBeNull();
  });

  it('buys a guitar with the fees and plays it from then on', () => {
    const c = buyGuitar(rich(500), 'sunburst')!;
    expect(c.money).toBe(100);
    expect(c.guitars).toEqual(['sunburst']);
    expect(c.guitar).toBe('sunburst');
    expect(ownedGuitars(c).map((g) => g.id)).toEqual([DEFAULT_GUITAR, 'sunburst']);
  });

  it('sells nothing too dear, owned already or unknown', () => {
    expect(buyGuitar(rich(399), 'sunburst')).toBeNull();
    expect(buyGuitar(buyGuitar(rich(800), 'sunburst')!, 'sunburst')).toBeNull();
    expect(buyGuitar(rich(1e6), DEFAULT_GUITAR)).toBeNull();
    expect(buyGuitar(rich(1e6), 'banjo')).toBeNull();
  });

  it('plays only a guitar owned', () => {
    const c = buyGuitar(rich(200), 'erable')!;
    expect(equipGuitar(c, DEFAULT_GUITAR).guitar).toBe(DEFAULT_GUITAR);
    expect(equipGuitar(c, 'galaxie').guitar).toBe('erable');
  });

  it('keeps the band, guitars, trophies, counts and album through a new career', () => {
    const stats = { gigs: 12, cleanGigs: 4, encores: 2, earned: 900 };
    const band = defaultBand('Les Larsen');
    const c = { ...buyGuitar(rich(2000), 'or')!, fans: 600, act: 2, season: 3, trophies: { premiere: '2026-10-01' }, stats, band };
    const played = concludeGig(c, { venue: venue('zinc'), audience: 100, songs: 1 }, songs(0.7), 'played').career;
    const fresh = resetCareer(played);
    expect(fresh).toMatchObject({ fans: 0, money: 0, act: 1, season: 1, history: [], guitars: ['or'], guitar: 'or', trophies: { premiere: '2026-10-01' }, band });
    expect(fresh.stats.gigs).toBe(13);
    expect(fresh.souvenirs).toHaveLength(1);
  });

  it('repairs the guitars of a save: older, tampered with', () => {
    const { guitars: _g, guitar: _p, ...older } = newCareer();
    expect(sanitizeCareer(older)).toMatchObject({ guitars: [], guitar: DEFAULT_GUITAR });
    const tampered = sanitizeCareer({ ...newCareer(), guitars: ['neon', 'banjo', 'neon', DEFAULT_GUITAR], guitar: 'galaxie' });
    expect(tampered).toMatchObject({ guitars: ['neon'], guitar: DEFAULT_GUITAR });
    expect(sanitizeCareer({ ...newCareer(), guitars: ['neon'], guitar: 'neon' })?.guitar).toBe('neon');
  });
});

describe('band and souvenirs', () => {
  it('names the band, trimmed and kept short; an empty name leaves it unnamed', () => {
    expect(nameBand(newCareer(), defaultBand('  Les Larsen  ')).band).toEqual(defaultBand('Les Larsen'));
    expect(nameBand(newCareer(), defaultBand('x'.repeat(40))).band?.name).toHaveLength(NAME_MAX);
    expect(nameBand(newCareer(), defaultBand('   ')).band).toBeNull();
    expect(sanitizeBand({ name: 'Riff Raff', emblem: 'licorne', lettering: 'comic', palette: 99 })).toEqual(defaultBand('Riff Raff'));
    expect(sanitizeBand({ name: 'Riff Raff', emblem: 'crane', lettering: 'gothique', palette: 4 })).toMatchObject({ emblem: 'crane', lettering: 'gothique', palette: 4 });
    expect(sanitizeBand('Riff Raff')).toBeNull();
  });

  it('leaves a souvenir of every gig: the band as it was, the night, the songs, the encore', () => {
    const band = { ...defaultBand('Les Larsen'), emblem: 'crane' as const };
    const c: Career = { ...newCareer(), act: 2, fans: 200, season: 2, week: 5, band };
    const o = { venue: venue('bistrot'), audience: 180, songs: 2 };
    const when = new Date('2026-10-28T21:30:00Z');
    const { career, souvenir } = concludeGig(c, o, songs(0.9, 0.95), 'played', { encore: songs(0.9)[0], when });
    expect(souvenir).toEqual({
      venue: 'bistrot',
      name: 'Le Bistrot Rock',
      act: 2,
      decisive: true,
      season: 2,
      week: 5,
      date: when.toISOString(),
      band,
      audience: 180,
      setlist: ['Song 0', 'Song 1'],
      encore: 'Song 0',
      outcome: 'played',
      satisfaction: 0.925,
    });
    expect(career.souvenirs[0]).toEqual(souvenir);
    // Renaming the band later leaves the old posters as they were.
    const renamed = nameBand(career, defaultBand('Autre nom'));
    expect(renamed.souvenirs[0].band?.name).toBe('Les Larsen');
    const booed = concludeGig(renamed, o, songs(0.05), 'booed').career;
    expect(booed.souvenirs.map((x) => x.outcome)).toEqual(['booed', 'played']);
    expect(sanitizeCareer(booed)?.souvenirs).toEqual(booed.souvenirs);
  });
});

describe('weekly challenge', () => {
  const library = ['b', 'a', 'c', 'e', 'd'].map((id) => ({ id }));

  it('picks the same song all week, another the next, at a difficulty set by the act', () => {
    const c: Career = { ...newCareer(), season: 1, week: 3 };
    const ch = weeklyChallenge(c, library)!;
    expect(weeklyChallenge(c, [...library].reverse())).toEqual(ch);
    expect(ch).toMatchObject({ key: '1-3', level: 'medium', prize: 80 });
    expect(weeklyChallenge({ ...c, week: 4 }, library)!.level).toBe('easy');
    expect(weeklyChallenge({ ...c, act: 2, week: 3 }, library)).toMatchObject({ level: 'hard', prize: 150 });
    expect(weeklyChallenge({ ...c, act: 3, week: 3 }, library)!.level).toBe('master');
    const weeks = new Set(Array.from({ length: 12 }, (_, w) => weeklyChallenge({ ...c, week: w + 1 }, library)!.song));
    expect(weeks.size).toBeGreaterThan(2);
    expect(weeklyChallenge(c, [])).toBeNull();
  });

  it('reaches bronze, silver or gold by accuracy, nothing when failed', () => {
    expect(tierOf({ failed: false, accuracy: 0.59 })).toBe(0);
    expect(tierOf({ failed: false, accuracy: 0.6 })).toBe(1);
    expect(tierOf({ failed: false, accuracy: 0.85 })).toBe(2);
    expect(tierOf({ failed: false, accuracy: 0.95 })).toBe(3);
    // As the results show it: 91.7 % reads 92 %, gold.
    expect(tierOf({ failed: false, accuracy: 0.917 })).toBe(3);
    expect(tierOf({ failed: false, accuracy: 0.594 })).toBe(0);
    expect(tierOf({ failed: true, accuracy: 0.99 })).toBe(0);
  });

  it('pays each tier once a week, a better one the difference', () => {
    const c: Career = { ...newCareer(), money: 100, week: 3 };
    const ch = weeklyChallenge(c, library)!;
    expect([1, 2, 3].map((t) => tierPrize(ch, t))).toEqual([30, 55, 80]);
    const silver = settleChallenge(c, ch, { failed: false, accuracy: 0.85 });
    expect(silver).toMatchObject({ tier: 2, paid: 55 });
    expect(silver.career.money).toBe(155);
    const again = settleChallenge(silver.career, ch, { failed: false, accuracy: 0.81 });
    expect(again.paid).toBe(0);
    expect(again.career).toBe(silver.career);
    const gold = settleChallenge(silver.career, ch, { failed: false, accuracy: 0.97 });
    expect(gold).toMatchObject({ tier: 3, paid: 25 });
    expect(gold.career.challenge).toEqual({ key: '1-3', tier: 3 });
    expect(careerTrophies(gold.career, null)).toContain('defi');
    // A new week, a new challenge: its prizes are to win again.
    const next = { ...gold.career, week: 4 };
    expect(bestTier(next, weeklyChallenge(next, library)!)).toBe(0);
    expect(resetCareer(gold.career).challenge).toBeNull();
  });
});
