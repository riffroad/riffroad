import { describe, expect, it } from 'vitest';
import {
  canGig,
  concludeGig,
  crowdStart,
  gigLineUp,
  gigsPerWeek,
  newCareer,
  objective,
  offers,
  releaseAlbum,
  resetCareer,
  restWeek,
  studioTake,
  VENUES,
  type Career,
  type GigSong,
  type Offer,
} from '../src/career/career';
import { levelOf } from '../src/career/difficulty';
import { RIVAL_TARGET, stolenDate, weekEvent, type WeekEvent } from '../src/career/events';
import { ALBUM_TRACKS, albumSales, labelObjectives, objectiveBonus, signed } from '../src/career/label';
import { careerTrophies } from '../src/trophies';

const songs = (...crowds: number[]): GigSong[] =>
  crowds.map((crowd, i) => ({ id: `s${i}`, title: `Song ${i}`, grade: 'A', accuracy: 0.95, crowd, notes: 480, seconds: 240 }));
const steady = (c: Career): Career => ({ ...c, members: c.members.map((m) => ({ ...m, precision: 50, energy: 50, reliability: 100, morale: 1 })) });
const venue = (id: string) => VENUES.find((v) => v.id === id)!;
const offer = (id: string, audience = 1000): Offer => ({ venue: venue(id), audience, songs: venue(id).songs });

/** The first week (season, week) from season 2 on with event `e`. */
function weekWith(e: WeekEvent): { season: number; week: number } {
  for (let season = 2; season < 40; season++) for (let week = 1; week <= 12; week++) if (weekEvent(season, week) === e) return { season, week };
  throw new Error(e);
}

describe('acts 4 and 5', () => {
  it('sends the band past the rival at the tremplin, or not', () => {
    const c = steady({ ...newCareer(), act: 4, fans: 91000 });
    expect(objective(c).text).toContain('Les Vautours');
    const lost = concludeGig(c, offer('tremplin', 19000), songs(0.72, 0.72), 'played');
    expect(lost.actUp).toBe(false);
    expect(lost.record.review).toContain('Les Vautours');
    const won = concludeGig(c, offer('tremplin', 19000), songs(RIVAL_TARGET + 0.05, RIVAL_TARGET + 0.05), 'played');
    expect(won.career.act).toBe(5);
    expect(offers({ ...won.career, fans: 0 }).every((o) => o.venue.act === 5)).toBe(true);
  });

  it('puts the band in the Hall of Fame for a last date won at 75 %, its songs played at 80 % of their notes', () => {
    const c = steady({ ...newCareer(), act: 5, fans: 200000, band: { name: 'Les Larsen', emblem: 'crane', lettering: 'metal', palette: 0 } });
    const lighter = concludeGig(c, offer('derniere', 90000), songs(0.9).map((s) => ({ ...s, full: 800 })), 'played');
    expect(lighter.actUp).toBe(false);
    expect(lighter.record.review).toContain('histoire');
    const won = concludeGig(c, offer('derniere', 90000), songs(0.9), 'played');
    expect(won.career.act).toBe(6);
    expect(won.career.hallOfFame).toEqual([expect.objectContaining({ band: 'Les Larsen', difficulty: 'pro', season: 1 })]);
    expect(objective(won.career).text).toContain('Hall of Fame');
    expect(careerTrophies(won.career, null)).toEqual(expect.arrayContaining(['signe', 'tremplin', 'hall']));
    // A new career keeps the hall.
    expect(resetCareer(won.career, 'legende')).toMatchObject({ act: 1, difficulty: 'legende', hallOfFame: won.career.hallOfFame });
  });
});

describe('the weeks’ events and the rival', () => {
  it('happen about one week in three, the same all week, never at the very start', () => {
    expect(weekEvent(1, 1)).toBeNull();
    expect(weekEvent(3, 5)).toBe(weekEvent(3, 5));
    const weeks = Array.from({ length: 600 }, (_, i) => weekEvent(2 + Math.floor(i / 12), (i % 12) + 1));
    const share = weeks.filter(Boolean).length / weeks.length;
    expect(share).toBeGreaterThan(0.25);
    expect(share).toBeLessThan(0.45);
    expect(new Set(weeks.filter(Boolean)).size).toBe(5);
  });

  it('bring a scout (fans ×2), a power cut (colder start), a headliner to replace', () => {
    const scoutWeek = steady({ ...newCareer(), act: 2, fans: 600, ...weekWith('denicheur') });
    const o = offers(scoutWeek).find((x) => x.scout)!;
    const plain = { ...o, scout: undefined };
    expect(concludeGig(scoutWeek, o, songs(0.8), 'played').record.fans).toBe(2 * concludeGig(scoutWeek, plain, songs(0.8), 'played').record.fans);
    const cut = steady({ ...newCareer(), act: 2, fans: 600, ...weekWith('panne') });
    const dark = offers(cut).find((x) => x.acoustic)!;
    expect(crowdStart(cut, dark)).toBeCloseTo(0.42);
    const cancel = steady({ ...newCareer(), act: 2, fans: 600, ...weekWith('annulation') });
    const big = offers(cancel).find((x) => x.headliner)!;
    expect(big.audience).toBe(big.venue.audience[1] * 2);
    expect(crowdStart(cancel, big)).toBeCloseTo(0.35);
    const fee = concludeGig(cancel, big, songs(0.8), 'played').record.money;
    expect(fee).toBe(2 * concludeGig(cancel, { ...big, headliner: undefined }, songs(0.8), 'played').record.money);
    // The replaced headliner is a date of its own: the venue's usual date stays open.
    const after = concludeGig(cancel, big, songs(0.8), 'played').career;
    expect(after.slots).toEqual([`gig:${big.venue.id}+`]);
  });

  it('sicken the drummer all week, break the van down', () => {
    const sick = steady({ ...newCareer(), ...weekWith('malade') });
    const lineUp = gigLineUp(sick, offers(sick)[0]);
    expect(lineUp.missing.map((m) => m.role)).toContain('batterie');
    const broken = { ...newCareer(), ...weekWith('van') };
    expect(gigsPerWeek(broken)).toBe(0);
    expect(canGig(broken)).toBe(false);
    expect(gigsPerWeek({ ...broken, gear: ['van'] })).toBe(1);
  });

  it('lets the rival take a date now and then, never the only one', () => {
    expect(stolenDate(4, 4, 1)).toBeNull();
    let found = false;
    for (let season = 1; season < 20 && !found; season++) {
      for (let week = 1; week <= 12 && !found; week++) {
        const i = stolenDate(season, week, 3);
        if (i === null) continue;
        found = true;
        const c = { ...newCareer(), act: 2, fans: 600, season, week };
        const list = offers(c);
        expect(list.filter((o) => o.stolen)).toHaveLength(list.filter((o) => !o.venue.decisive && !o.headliner).length >= 2 ? 1 : 0);
      }
    }
    expect(found).toBe(true);
  });
});

describe('the label', () => {
  const label: Career = { ...newCareer(), act: 4, fans: 9000, money: 0, season: 2, week: 12 };

  it('signs with the band at act 4 and sets three objectives a season', () => {
    expect(signed(newCareer())).toBe(false);
    expect(signed(label)).toBe(true);
    const goals = labelObjectives(label);
    expect(goals).toHaveLength(3);
    expect(new Set(goals.map((g) => g.id)).size).toBe(3);
    expect(labelObjectives(label)).toEqual(goals);
  });

  it('pays the objectives met when the season ends', () => {
    const played = steady(label);
    const history = Array.from({ length: 3 }, (_, i) => concludeGig({ ...played, week: 9 + i }, offer('plage', 6000), songs(0.9), 'played').record);
    const c: Career = { ...played, history };
    const met = labelObjectives(c).filter((o) => o.done >= o.target).length;
    const next = restWeek(c);
    expect(next.labelReport).toEqual({ season: 2, met, bonus: met * objectiveBonus(4) });
    expect(next.money).toBe(met * objectiveBonus(4));
    expect([next.season, next.week]).toEqual([3, 1]);
  });

  it('records takes in the studio and releases an album of eight', () => {
    let c: Career = { ...label, week: 3 };
    c = studioTake(c, 'a', 0.8);
    expect(c.slots).toEqual(['studio']);
    c = studioTake(c, 'a', 0.6);
    expect(c.album.takes.a).toBe(0.8);
    expect(releaseAlbum(c)).toBeNull();
    for (let i = 0; i < ALBUM_TRACKS; i++) c = { ...c, album: { ...c.album, takes: { ...c.album.takes, [`t${i}`]: 0.9 } } };
    const out = releaseAlbum(c)!;
    // Without a contract chosen, an independent label's terms: 30 % of 10 € a copy.
    expect(out.release.copies).toBe(albumSales(c.fans, 0.9));
    expect(out.career.money).toBe(c.money + Math.round(out.release.copies * 10 * 0.3));
    expect(out.career.fans).toBe(c.fans + Math.round(out.release.copies * 0.15));
    expect(out.career.album).toEqual({ takes: {}, released: [out.release] });
    expect(careerTrophies(out.career, null)).toContain('album');
  });
});

describe('difficulty', () => {
  it('pays a Legend more than a Pro, a Rookie less', () => {
    const o = offer('zinc', 100);
    const fee = (d: 'rookie' | 'pro' | 'legende') => concludeGig(steady({ ...newCareer(d), act: 2, fans: 200 }), o, songs(0.8), 'played').record;
    // Fees only: a harder career pays more, it does not go faster.
    expect(fee('legende').money).toBeGreaterThan(fee('pro').money);
    expect(fee('legende').fans).toBe(fee('pro').fans);
    expect(fee('rookie').fans).toBe(fee('pro').fans);
    expect(fee('rookie').money).toBeLessThan(fee('pro').money);
    expect(levelOf('rookie').freePauses).toBe(1);
    // A Rookie gets through a decisive date a little colder, a Legend needs it warmer.
    const lycee = offer('lycee', 80);
    const at = (d: 'rookie' | 'pro' | 'legende', crowd: number) => concludeGig(steady({ ...newCareer(d), act: 1, fans: 60 }), lycee, songs(crowd, crowd, crowd), 'played').actUp;
    expect([at('rookie', 0.55), at('pro', 0.55), at('pro', 0.62), at('legende', 0.62), at('legende', 0.66)]).toEqual([true, false, true, false, true]);
    expect(levelOf('legende').patience).toBeLessThan(levelOf('pro').patience);
  });
});
