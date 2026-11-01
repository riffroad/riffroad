import { describe, expect, it } from 'vitest';
import { acceptSponsor, buyGear, concludeGig, crowdStart, fireComms, hireComms, newCareer, offers, post, releaseAlbum, resolveMoment, restWeek, signContract, slotOf, studioTake, trainSlot, WEEKS, type Career, type GigSong } from '../src/career/career';
import { ALBUM_TRACKS, albumSales } from '../src/career/label';
import { contractOf, payroll, sponsorMet, sponsorOffers, startSponsor, wageOf } from '../src/career/manager';
import { startingBand } from '../src/career/musicians';
import { charityCost, clipCost, commsWage, dispute, donation, goodCause, hypeAfterGig, hypeWeek, interview, rivalLabel, sanitizeMoment } from '../src/career/press';
import { careerTrophies } from '../src/trophies';
import { useLang } from '../src/i18n';
import { changes, emptySkills, learnSkills, MEASURED, overall, ratingOf, sampleOf, weakest, type Judged } from '../src/career/skills';
import { drillFor } from '../src/career/training';
import { invitation, newWorld, rankOf, sceneChart, seasonAwards, worldWeek } from '../src/career/world';
import { lessonChart } from '../src/lessons';

/** `n` judged notes (or chords), `hit` share hit, `ms` off the beat, over `seconds`. */
function judged(n: number, hit: number, kind: 'note' | 'chord' = 'note', ms = 20, seconds = 240, event = 0): Judged[] {
  return Array.from({ length: n }, (_, i) => ({
    status: i < Math.round(n * hit) ? 'hit' : 'missed',
    error: ms / 1000,
    time: (i * seconds) / n,
    event: event + i,
    target: { kind },
  }));
}
const plainChart = { notes: [] as { techniques?: Record<string, unknown> }[] };

describe('the guitarist’s card', () => {
  it('reads each rating off a song played', () => {
    const s = sampleOf([...judged(200, 0.9), ...judged(50, 0.7, 'chord')], plainChart as never, 240);
    expect(s.precision!.value).toBeCloseTo((0.9 - 0.5) / 0.48);
    expect(s.accords!.value).toBeCloseTo((0.7 - 0.5) / 0.48);
    expect(s.rythme!.value).toBeCloseTo(1 - 5 / 85);
    expect(s.vitesse!.weight).toBe(250);
    expect(s.endurance).toBeDefined();
    expect(s.technique).toBeUndefined();
    // Techniques are counted apart from plain notes.
    const tech = { notes: Array.from({ length: 40 }, (_, i) => (i < 20 ? { techniques: { hammerOn: true } } : {})) };
    const t = sampleOf(judged(40, 1), tech as never, 60);
    expect([t.technique!.weight, t.precision!.weight]).toEqual([20, 20]);
  });

  it('moves with what is played, shows once measured, and names its weakest', () => {
    let card = emptySkills();
    expect(overall(card)).toBeNull();
    card = learnSkills(card, sampleOf(judged(30, 0.95), plainChart as never, 120), new Date('2026-11-01'));
    expect(ratingOf(card, 'precision')).toBeNull();
    const before = card;
    card = learnSkills(card, sampleOf([...judged(300, 0.95), ...judged(80, 0.6, 'chord')], plainChart as never, 240), new Date('2026-11-02'));
    expect(card.values.precision!.notes).toBeGreaterThanOrEqual(MEASURED);
    expect(ratingOf(card, 'precision')).toBeGreaterThan(ratingOf(card, 'accords')!);
    const lowest = (['precision', 'accords', 'rythme', 'vitesse', 'endurance'] as const).filter((id) => ratingOf(card, id) !== null).sort((x, y) => ratingOf(card, x)! - ratingOf(card, y)!)[0];
    expect(weakest(card)).toBe(lowest);
    expect(changes(before, card).map((c) => c.id)).toContain('precision');
    expect(card.history.at(-1)!.overall).toBe(overall(card));
    // A slower song pulls speed down less than a faster one lifts it.
    const fast = card.values.vitesse!.value;
    const slow = learnSkills(card, sampleOf(judged(60, 0.95), plainChart as never, 240)).values.vitesse!.value;
    expect(fast - slow).toBeLessThan(0.05);
  });
});

describe('training', () => {
  it('makes a drill for each rating, faster as the rating grows, with its techniques', () => {
    for (const id of ['precision', 'accords', 'rythme', 'vitesse', 'endurance', 'technique'] as const) {
      const d = drillFor(id, 50);
      expect(d.steps.length, id).toBeGreaterThan(15);
      expect(drillFor(id, 90).bpm).toBeGreaterThan(d.bpm);
    }
    const chart = lessonChart(drillFor('technique', 60), 0);
    expect(chart.meta.title).toContain('Technique');
    expect(chart.notes.some((n) => n.techniques?.hammerOn)).toBe(true);
    expect(chart.notes.some((n) => n.techniques?.slideTo === 7)).toBe(true);
  });

  it('takes a slot of the career’s week', () => {
    expect(trainSlot(newCareer()).slots).toEqual(['training']);
  });
});

describe('the scene', () => {
  it('moves every week, ranks the band among the others, invites it to open for one above', () => {
    const w = newWorld();
    const next = worldWeek(w, 1, 1);
    expect(worldWeek(w, 1, 1)).toEqual(next);
    expect(next.bands.some((b, i) => b.fans !== w.bands[i].fans)).toBe(true);
    const chart = sceneChart(w, 'Moi', 1000, 5);
    expect(chart[rankOf(chart) - 1]).toMatchObject({ name: 'Moi', you: true });
    expect(chart.some((l) => l.rival)).toBe(true);
    const weeks = Array.from({ length: 40 }, (_, k) => invitation(w, 1000, 1, k + 1)).filter(Boolean);
    expect(weeks.length).toBeGreaterThan(4);
    expect(weeks.length).toBeLessThan(25);
  });

  it('gives its awards at the end of the season', () => {
    const w = { ...newWorld(), seasonStart: 1000 };
    expect(seasonAwards(w, { rank: 1, bestSatisfaction: 0.96, fans: 5000, album: 0.92 })).toEqual(['groupe', 'live', 'revelation', 'album']);
    expect(seasonAwards(w, { rank: 4, bestSatisfaction: 0.8, fans: 1500, album: 0 })).toEqual([]);
  });

  it('brings its headliners’ invitations among the offers, to a colder crowd', () => {
    let found: Career | null = null;
    for (let week = 1; week <= WEEKS && !found; week++) {
      const c = { ...newCareer(), act: 2, fans: 400, week };
      if (offers(c).some((o) => o.invited)) found = c;
    }
    expect(found).not.toBeNull();
    const invited = offers(found!).find((o) => o.invited)!;
    const plain = { ...invited, invited: undefined };
    expect(crowdStart(found!, invited)).toBeCloseTo(crowdStart(found!, plain) - 0.12);
    // One a week, even once the fans won open another room.
    const after = { ...found!, fans: 100000, slots: [slotOf(invited)] };
    expect(offers(after).some((o) => o.invited)).toBe(false);
  });
});

describe('the business', () => {
  it('pays the musicians from the clubs on, the friends play for nothing before', () => {
    const band = startingBand();
    expect([1, 2].map((act) => payroll(band, act))).toEqual([0, 0]);
    expect(payroll(band, 3)).toBeGreaterThan(0);
    expect(wageOf({ precision: 60, energy: 60, raise: 0.5 }, 4)).toBe(1.5 * wageOf({ precision: 60, energy: 60 }, 4));
    // Not enough money: paid late, morale down.
    const broke = restWeek({ ...newCareer(), act: 3, money: 10 });
    expect(broke.money).toBe(0);
    expect(broke.news[0]).toContain('salaires');
  });

  it('signs a sponsor who pays every week and a bonus for its goal', () => {
    expect(sponsorOffers(1, 1, 1, 0)).toEqual([]);
    expect(sponsorOffers(2, 1, 2, 0)).toEqual([]);
    const [deal] = sponsorOffers(2, 1, 5, 200);
    const c = acceptSponsor({ ...newCareer(), act: 2, money: 0 }, { ...deal, goal: 'fans', target: 100, weeks: 1 });
    const after = restWeek({ ...c, fans: c.fans + 150 });
    expect(after.money).toBe(deal.pay + deal.bonus);
    expect(after.sponsor).toBeNull();
    expect(sponsorMet(startSponsor({ ...deal, goal: 'gigs', target: 2 }, 0), { rank: 9, card: null, fans: 0 })).toBe(false);
  });

  it('signs a label contract once the showcase is won: an advance, then its share of the albums', () => {
    const signedBand: Career = { ...newCareer(), act: 4, fans: 20000 };
    expect(signContract(newCareer(), 'major')).toEqual(newCareer());
    const major = signContract(signedBand, 'major');
    expect(major.money).toBe(15000);
    const self = signContract(signedBand, 'autoprod');
    const takes = Object.fromEntries(Array.from({ length: ALBUM_TRACKS }, (_, i) => [`t${i}`, 0.9]));
    const out = (c: Career) => releaseAlbum({ ...c, album: { takes, released: [] } })!;
    expect(out(major).release.copies).toBe(Math.round(albumSales(20000, 0.9) * contractOf('major').promotion));
    expect(out(self).release.copies).toBeLessThan(out(major).release.copies);
    // Self-released: no label objectives at the season's end.
    expect(restWeek({ ...self, week: WEEKS }).labelReport).toBeNull();
  });
});

describe('the press', () => {
  it('stirs the hype with the gigs, and lets it settle', () => {
    expect(hypeAfterGig(40, 0.95, false)).toBe(43);
    expect(hypeAfterGig(40, 0.3, false)).toBe(35);
    expect(hypeAfterGig(40, 0.9, true)).toBe(30);
    expect(hypeWeek(90)).toBeLessThan(90);
    expect(hypeWeek(10)).toBeGreaterThan(10);
  });

  it('asks the player to choose, and the choice counts', () => {
    const c: Career = { ...newCareer(), act: 2, hype: 40, moment: interview(1, 3) };
    const bold = resolveMoment(c, 'provoc');
    expect([bold.hype, bold.moment]).toEqual([48, null]);
    expect(bold.members[0].morale).toBeCloseTo(c.members[0].morale - 0.05);
    const [a, b] = c.members;
    const quarrel = { ...c, moment: dispute(a.name, b.name) };
    const sided = resolveMoment(quarrel, 'a');
    expect(sided.members[0].morale - a.morale).toBeCloseTo(0.15);
    expect(sided.members[1].morale - b.morale).toBeCloseTo(-0.2);
    const pause = resolveMoment(quarrel, 'pause');
    expect(pause.slots).toEqual(['rest']);
    expect(resolveMoment(c, 'nope')).toBe(c);
  });

  it('turns a gig on fire into a video that goes viral, now and then', () => {
    const song: GigSong = { id: 's', title: 'S', grade: 'S', accuracy: 1, crowd: 0.99, notes: 480, seconds: 240 };
    let viral = 0;
    for (let season = 1; season <= 4; season++)
      for (let week = 1; week <= WEEKS; week++) {
        const c = { ...newCareer(), act: 2, fans: 400, season, week };
        const o = offers(c)[0];
        if (concludeGig(c, o, [song, song, song], 'played').career.moment?.kind === 'viral') viral++;
      }
    expect(viral).toBeGreaterThan(0);
    expect(viral).toBeLessThan(WEEKS);
    // Not every great gig: a video goes viral now and then.
  });
});

describe('the album and the late career’s money', () => {
  const label: Career = { ...newCareer(), act: 4, fans: 20000, money: 1000000 };

  it('records two takes a studio session, three better ones in the band’s own studio', () => {
    let c = studioTake(label, 'a', 0.8);
    expect([c.slots, c.album.session]).toEqual([['studio'], 1]);
    c = studioTake(c, 'b', 0.7);
    expect([c.slots, c.album.session ?? 0, Object.keys(c.album.takes)]).toEqual([['studio'], 0, ['a', 'b']]);
    c = studioTake(c, 'c', 0.7);
    expect(c.slots).toEqual(['studio', 'studio']);
    let own = studioTake(buyGear(label, 'studio')!, 'a', 0.8);
    expect(own.album.takes.a).toBeCloseTo(0.85);
    own = studioTake(studioTake(own, 'b', 0.8), 'c', 0.8);
    expect(own.slots).toEqual(['studio']);
  });

  it('spends it on the road: a paid crew, a tour bus, a stadium stage', () => {
    const crew = restWeek(buyGear({ ...label, act: 5, members: label.members.map((m) => ({ ...m, morale: 0.5 })) }, 'equipe')!);
    const none = restWeek({ ...label, act: 5, money: label.money - 20000, members: label.members.map((m) => ({ ...m, morale: 0.5 })) });
    expect(none.money - crew.money).toBe(3000);
    const touring = (c: Career) => restWeek({ ...c, slots: ['gig:a', 'gig:b', 'rehearsal'] }).members[0].morale;
    expect(touring(buyGear(label, 'bus')!) - touring(label)).toBeCloseTo(0.05);
    const stars: Career = { ...label, act: 5, fans: 100000 };
    const big = buyGear(stars, 'scene')!;
    const plain = offers(stars)[0];
    const staged = offers(big)[0];
    expect(staged.audience / plain.audience).toBeCloseTo(1.1, 1);
    expect(crowdStart(big, staged) - crowdStart(stars, plain)).toBeCloseTo(0.05);
  });
});

describe('the networks, good causes and the communications manager', () => {
  const clubs: Career = { ...newCareer(), act: 3, fans: 2000, followers: 500, money: 50000 };

  it('posts once a week: behind the scenes for free, a video for a price, both further with a manager', () => {
    const free = post(clubs, 'coulisses')!;
    expect(free.followers).toBeGreaterThan(clubs.followers);
    expect(post(free, 'clip')).toBeNull();
    const video = post(clubs, 'clip')!;
    expect(clubs.money - video.money).toBe(clipCost(3));
    expect(video.followers - clubs.followers).toBeGreaterThan(free.followers - clubs.followers);
    expect(post({ ...clubs, money: 10 }, 'clip')).toBeNull();
    const managed = post(hireComms(clubs), 'clip')!;
    expect(managed.followers - clubs.followers).toBeGreaterThan(video.followers - clubs.followers);
  });

  it('hires a communications manager from the clubs on: paid every week, the hype settling higher', () => {
    expect(hireComms({ ...newCareer(), act: 2 }).comms).toBe(false);
    const team = hireComms(clubs);
    const week = restWeek({ ...team, hype: 70 });
    const without = restWeek({ ...clubs, hype: 70 });
    expect(without.money - week.money).toBe(commsWage(3));
    expect(week.hype).toBeGreaterThan(without.hype);
    expect(fireComms(team).comms).toBe(false);
  });

  it('turns a good cause into a charity gig: no fee, its costs, many fans, and a trophy for three', () => {
    const asked = { ...clubs, moment: goodCause(1, 5, 3) };
    const c = resolveMoment(asked, 'concert');
    const benefit = offers(c).find((o) => o.charity)!;
    expect(benefit).toBeDefined();
    // In a room the band already fills, not the act's biggest one.
    expect(c.fans).toBeGreaterThanOrEqual(benefit.venue.fans);
    const plain = { ...benefit, charity: undefined };
    const songs: GigSong[] = [0.8, 0.8, 0.8].map((crowd, i) => ({ id: `s${i}`, title: 'S', grade: 'B', accuracy: 0.85, crowd, notes: 480, seconds: 240 }));
    const gave = concludeGig(c, benefit, songs, 'played');
    const paid = concludeGig(c, plain, songs, 'played');
    expect(gave.record.money).toBe(-charityCost(3));
    expect(gave.record.fans).toBeGreaterThan(paid.record.fans * 1.5);
    expect(gave.career.hype).toBeGreaterThan(paid.career.hype + 9);
    expect(gave.career.charity).toBeNull();
    expect(offers(gave.career).some((o) => o.charity)).toBe(false);
    expect(careerTrophies({ ...gave.career, stats: { ...gave.career.stats, charity: 3 } }, null)).toContain('coeur');
    const donated = resolveMoment(asked, 'don');
    expect(clubs.money - donated.money).toBe(donation(3));
  });

  it('switches to a rival label: a better share, no label bonus this season', () => {
    const label = signContract({ ...newCareer(), act: 4, fans: 20000 }, 'independant');
    const moved = resolveMoment({ ...label, moment: rivalLabel(30000) }, 'oui');
    expect(moved.contract!.royalty).toBeCloseTo(0.35);
    expect(moved.money - label.money).toBe(30000);
    expect(restWeek({ ...moved, week: WEEKS }).labelReport).toBeNull();
  });

  it('writes a saved moment again in the interface language', () => {
    const saved = JSON.parse(JSON.stringify(goodCause(1, 5, 3)));
    useLang('en');
    try {
      expect(sanitizeMoment(saved)!.title).toBe('A call on social media');
    } finally {
      useLang('fr');
    }
    expect(sanitizeMoment({ title: 'old', text: 'old', choices: [] })).toBeNull();
  });

  it('asks a sponsor’s chart goal two places up, and pays more to a followed band', () => {
    const offersAt = (rank: number, followers: number) => sponsorOffers(3, 1, 5, 2000, rank, followers);
    const rankGoal = [1, 5, 9, 13].flatMap((week) => sponsorOffers(3, 2, week, 2000, 7)).find((o) => o.goal === 'rank');
    if (rankGoal) expect(rankGoal.target).toBe(5);
    expect(offersAt(7, 2000)[0].pay).toBeGreaterThan(offersAt(7, 0)[0].pay);
  });
});
