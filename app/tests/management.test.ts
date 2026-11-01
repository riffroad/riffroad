import { describe, expect, it } from 'vitest';
import {
  buyGear,
  canGig,
  concludeGig,
  crowdStart,
  gigLineUp,
  guitarsOf,
  hireMusician,
  newCareer,
  offers,
  rehearseBand,
  rest,
  restWeek,
  retunes,
  sanitizeCareer,
  slotsLeft,
  VENUES,
  weekIndex,
  type Career,
  type GigSong,
} from '../src/career/career';
import { merchSales, tourCosts } from '../src/career/gear';
import { afterGig, afterWeek, bandFactor, crowdBoost, departures, lineUp, market, sanitizeMembers, startingBand, type Musician } from '../src/career/musicians';

const songs = (...crowds: number[]): GigSong[] =>
  crowds.map((crowd, i) => ({ id: `s${i}`, title: `Song ${i}`, grade: 'B', accuracy: 0.85, crowd, notes: 480, seconds: 240 }));
const steady = (c: Career): Career => ({ ...c, members: c.members.map((m) => ({ ...m, precision: 50, energy: 50, reliability: 100, morale: 1 })) });
const bars: Career = steady({ ...newCareer(), act: 2, fans: 400, money: 5000 });

describe('the week', () => {
  it('has three slots: one gig (two with the van), rehearsals, rest', () => {
    const o = offers(bars)[0];
    const after = concludeGig(bars, o, songs(0.8), 'played').career;
    expect(after.slots).toEqual([`gig:${o.venue.id}`]);
    expect(slotsLeft(after)).toBe(2);
    expect(canGig(after)).toBe(false);
    expect(offers(after).map((x) => x.venue.id)).not.toContain(o.venue.id);
    const van = buyGear(bars, 'van')!;
    const once = concludeGig(van, offers(van)[0], songs(0.8), 'played').career;
    expect(canGig(once)).toBe(true);
    // The other venues keep their audience once one is played.
    expect(offers(once)[0]).toEqual(offers(van)[1]);
  });

  it('ends once its slots are used, the rest counting as rest', () => {
    const c = rest(rehearseBand(bars));
    expect(c.slots).toEqual(['rehearsal', 'rest']);
    const next = rest(c);
    expect([next.week, next.slots]).toEqual([2, []]);
    expect(rest(rest(rest(bars))).week).toBe(2);
    const skipped = restWeek(bars);
    expect(skipped.week).toBe(2);
    expect(skipped.members[0].morale).toBeCloseTo(1);
  });

  it('brings every song a little more in form at a band rehearsal', () => {
    const now = weekIndex(bars);
    const c: Career = { ...bars, repertoire: { a: { form: 0.2, played: now, since: 1 }, b: { form: 0.9, played: now, since: 1 } } };
    const r = rehearseBand(c).repertoire;
    expect(r.a.form).toBeCloseTo(0.35);
    expect(r.b.form).toBeCloseTo(1);
  });
});

describe('the gear', () => {
  it('is bought once, with the money', () => {
    const c = buyGear(bars, 'sono')!;
    expect([c.money, c.gear]).toEqual([3900, ['sono']]);
    expect(buyGear(c, 'sono')).toBeNull();
    expect(buyGear({ ...bars, money: 100 }, 'van')).toBeNull();
    expect(buyGear(c, 'nope' as never)).toBeNull();
  });

  it('brings more people (PA), money (merch), a warmer start (amp)', () => {
    const plain = offers(bars);
    const loud = offers(buyGear(bars, 'sono')!);
    loud.forEach((o, i) => expect(Math.abs(o.audience - plain[i].audience * 1.15)).toBeLessThanOrEqual(1));
    expect(loud[0].audience).toBeGreaterThan(plain[0].audience);
    const o = plain[0];
    const merch = buyGear(bars, 'merch')!;
    const sold = concludeGig(merch, o, songs(0.9), 'played').record;
    const none = concludeGig(bars, o, songs(0.9), 'played').record;
    expect(sold.merch).toBe(merchSales(o.audience, 0.9));
    expect(sold.money).toBe(none.money + sold.merch);
    expect(crowdStart(bars, o)).toBeCloseTo(0.5);
    expect(crowdStart(buyGear(bars, 'ampli')!, o)).toBeCloseTo(0.58);
    const usine = { venue: VENUES.find((v) => v.id === 'usine')!, audience: 700, songs: 3 };
    expect(crowdStart(bars, usine)).toBeCloseTo(0.3);
  });
});

describe('the big venues', () => {
  const stars: Career = steady({ ...newCareer(), act: 5, fans: 100000, money: 200000 });
  const stadium = { venue: VENUES.find((v) => v.id === 'sud')!, audience: 45000, songs: 7 };

  it('cost a share of what they pay, more as they grow, half with the band’s own crew', () => {
    expect([1, 2, 3, 4, 5].map((act) => tourCosts(act, 10000, false))).toEqual([0, 0, 1500, 3000, 4000]);
    expect(tourCosts(5, 10000, true)).toBe(2000);
    const own = concludeGig(stars, stadium, songs(0.9), 'played').record;
    const crew = concludeGig(buyGear(stars, 'equipe')!, stadium, songs(0.9), 'played').record;
    expect(own.costs).toBeGreaterThan(0);
    expect(crew.costs).toBeCloseTo(own.costs! / 2, -1);
    expect(crew.money).toBeGreaterThan(own.money);
  });

  it('have their own gear: screens warm the crowd, pyrotechnics double an encore', () => {
    expect(crowdStart(buyGear(stars, 'ecrans')!, stadium) - crowdStart(stars, stadium)).toBeCloseTo(0.05);
    const encore = { ...songs(0.95)[0], id: 'encore' };
    const plain = concludeGig(stars, stadium, songs(0.95), 'played', { encore }).record.encore!;
    const blaze = concludeGig(buyGear(stars, 'pyro')!, stadium, songs(0.95), 'played', { encore }).record.encore!;
    expect([blaze.fans, blaze.money]).toEqual([plain.fans * 2, plain.money * 2]);
  });
});

describe('the musicians', () => {
  const ace: Musician = { name: 'Ace', role: 'batterie', precision: 90, energy: 90, reliability: 100, morale: 1 };

  it('weigh on fans and fee by their precision, on the crowd by their energy', () => {
    const plain = startingBand().map((m) => ({ ...m, precision: 50, energy: 50, morale: 1 }));
    expect(bandFactor(plain)).toBeCloseTo(1);
    expect(crowdBoost(plain)).toBeCloseTo(0);
    expect(bandFactor([ace, ace, ace])).toBeCloseTo(1.12);
    expect(crowdBoost([ace, ace, ace])).toBeCloseTo(0.08);
    // Low morale wears them down.
    expect(bandFactor([{ ...ace, morale: 0 }])).toBeLessThan(bandFactor([ace]));
  });

  it('may miss a gig when unreliable, always the same one', () => {
    const shaky = startingBand().map((m) => ({ ...m, reliability: 10 }));
    const nights = Array.from({ length: 40 }, (_, i) => lineUp(shaky, `night-${i}`).missing.length);
    expect(nights.some((n) => n > 0)).toBe(true);
    expect(lineUp(shaky, 'night-3')).toEqual(lineUp(shaky, 'night-3'));
    expect(lineUp([ace], 'any').missing).toEqual([]);
    const { members, missing } = lineUp(shaky, `night-${nights.findIndex((n) => n > 0)}`);
    expect(members.filter((m) => m.name === 'un remplaçant')).toHaveLength(missing.length);
    const o = offers(bars)[0];
    expect(gigLineUp(bars, o).missing).toEqual([]);
  });

  it('gain morale with good gigs and rest, lose it with bad gigs and touring, and leave', () => {
    const band = startingBand();
    expect(afterGig(band, 0.85, 'played')[0].morale).toBeCloseTo(0.75);
    expect(afterGig(band, 0.3, 'played')[0].morale).toBeCloseTo(0.58);
    expect(afterGig(band, 0.9, 'booed')[0].morale).toBeCloseTo(0.55);
    expect(afterWeek(band, ['gig:x', 'rest', 'rest'])[0].morale).toBeCloseTo(0.85);
    // Touring twice a week wears them, however good the gigs.
    expect(afterWeek(band, ['gig:x', 'gig:y', 'rehearsal'])[0].morale).toBeCloseTo(0.63);
    const unhappy = band.map((m, i) => (i === 1 ? { ...m, morale: 0.1 } : m));
    const { members, gone } = departures(unhappy);
    expect(gone.map((m) => m.name)).toEqual(['Karim']);
    expect(members[1].name).toContain('Remplaçant');
    const c = restWeek({ ...newCareer(), members: unhappy.map((m) => ({ ...m, morale: m.morale - 0.25 })), slots: ['gig:garage', 'gig:x', 'gig:y'] });
    expect(c.news[0]).toContain('Vautours');
  });

  it('can be hired from the market, better and dearer as the act goes on', () => {
    const garage = market(1, 3);
    const clubs = market(3, 3);
    expect(garage.map((m) => m.role)).toEqual(['batterie', 'basse', 'chant']);
    expect(market(1, 3)).toEqual(garage);
    const avg = (ms: typeof garage) => ms.reduce((t, m) => t + m.precision + m.energy, 0) / ms.length;
    expect(avg(clubs)).toBeGreaterThan(avg(garage));
    expect(clubs.reduce((t, m) => t + m.fee, 0)).toBeGreaterThan(garage.reduce((t, m) => t + m.fee, 0));
    const pick = clubs[0];
    expect(hireMusician({ ...bars, money: pick.fee - 1, fans: 1e6 }, pick)).toBeNull();
    expect(pick.fans).toBeGreaterThan(0);
    expect(hireMusician({ ...bars, money: 1e6, fans: pick.fans - 1 }, pick)).toBeNull();
    const hired = hireMusician({ ...bars, money: 1e6, fans: 1e6 }, pick)!;
    expect(hired.money).toBe(1e6 - pick.fee);
    expect(hired.members.find((m) => m.role === pick.role)?.name).toBe(pick.name);
    expect(hired.members).toHaveLength(3);
  });

  it('are read back from a save, the garage friends where something is missing', () => {
    expect(sanitizeMembers(null)).toEqual(startingBand());
    const read = sanitizeMembers([{ name: 'Ace', role: 'basse', precision: 300, energy: 'x', reliability: 80, morale: 2 }]);
    expect(read[1]).toEqual({ name: 'Ace', role: 'basse', precision: 99, energy: 50, reliability: 80, morale: 1 });
    expect(read[0].name).toBe('Max');
    expect(sanitizeCareer({ ...newCareer(), gear: ['van', 'van', 'jet'], slots: ['rest', 4] })).toMatchObject({ gear: ['van'], slots: ['rest'] });
  });
});

describe('tunings on stage', () => {
  it('cost a retuning at each change with one guitar, nothing between the two with a second', () => {
    const set = ['E', 'E', 'D', 'E', 'D', 'C'];
    expect(retunes(set, 1)).toEqual([false, false, true, true, true, true]);
    expect(retunes(set, 2)).toEqual([false, false, false, false, false, true]);
    expect(guitarsOf(buyGear(bars, 'guitare2')!)).toBe(2);
  });
});
