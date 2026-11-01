import { defaultBand, drawLogo, EMBLEMS, LETTERINGS, logoUrl, NAME_MAX, PALETTES, type Band } from '../band';
import { formatTime } from '../chart';
import { coverElement } from '../cover';
import type { SongEntry } from '../engine/types';
import { drawGuitar, GUITARS, guitarOf, type Guitar } from '../guitars';
import { TROPHIES } from '../trophies';
import { attackLevel } from '../score-attack';
import { lang, t, tn } from '../i18n';
import { fold } from '../library';
import type { Progress } from '../progress';
import {
  ACTS,
  MIN_SONG,
  SLOTS,
  WEEKS,
  canGig,
  feeFor,
  gigLineUp,
  gigsPerWeek,
  guitarsOf,
  retunes,
  slotsLeft,
  lockedVenues,
  minSetlist,
  objective,
  offers,
  ownsGuitar,
  playingAct,
  seasonSummary,
  songEffort,
  type Career,
  type GigRecord,
  type Offer,
  venueIn,
  weekIndex,
} from './career';
import { bestTier, tierPrize, TIERS, weeklyChallenge, type Challenge } from './challenge';
import { poster } from './poster';
import { density, formOf, rating, scout, type Learned } from './repertoire';
import { GEAR, type GearId } from './gear';
import { DIFFICULTIES, levelOf, type Difficulty } from './difficulty';
import { EVENTS, RIVAL, rivalFans, weekEvent } from './events';
import { ALBUM_TRACKS, albumQuality, LABEL, labelObjectives, objectiveBonus, signed as isSigned } from './label';
import { CONTRACTS, payroll, sponsorGoal, sponsorOffers, wageOf, type LabelId, type SponsorOffer } from './manager';
import { CAUSES, charityCost, clipCost, commsWage, postEffect, type Moment, type PostKind } from './press';
import { MEASURED, overall, overallSince, ratingOf, SKILLS, weakest, type SkillId } from './skills';
import { AWARDS, bandName, rankOf, sceneChart } from './world';
import { market, moraleLabel, ROLES, type Candidate, type Musician } from './musicians';

export interface CareerHooks {
  /** Songs that can be played on stage (with their audio). */
  songs(): SongEntry[];
  progress(): Progress;
  coverUrl(song: SongEntry): Promise<string | null>;
  play(offer: Offer, setlist: string[]): void;
  rest(): void;
  /** A new career, as demanding as `d`. */
  reset(d: Difficulty): void;
  /** The season report was read. */
  readReport(): void;
  /** A guitar bought in the shop, and one chosen among those owned. */
  buy(id: string): void;
  equip(id: string): void;
  /** The band named and drawn. */
  saveBand(band: Band): void;
  /** A guitar of the shop tried on the 3D neck (null: back to the one played). */
  preview(id: string | null): void;
  /** The weekly challenge taken up. */
  challenge(ch: Challenge): void;
  /** A song the scout proposed, learned. */
  learn(id: string): void;
  /** A slot of the week spent resting, or rehearsing with the band. */
  restSlot(): void;
  rehearseBand(): void;
  /** Gear bought; a musician of the market hired. */
  buyGear(id: GearId): void;
  hire(m: Candidate): void;
  /** A studio take of a song; the album released. */
  record(id: string): void;
  release(): void;
  /** Training on the card's `skill` (a slot of the week). */
  train(skill: SkillId): void;
  /** A choice in the moment waiting. */
  choose(choice: string): void;
  /** The label contract signed; a sponsor signed. */
  sign(id: LabelId): void;
  sponsor(o: SponsorOffer): void;
  /** This week's post; the communications manager hired or let go. */
  post(kind: PostKind): void;
  comms(hire: boolean): void;
  back(): void;
}

/** A number as the interface language writes it: 4 500, 4,500. */
const num = (x: number) => x.toLocaleString(lang() === 'en' ? 'en-US' : 'fr-FR');
const pct = (x: number) => t('{n} %', { n: Math.round(x * 100) });
/** A share as a CSS width. */
const width = (x: number) => `${(Math.min(1, Math.max(0, x)) * 100).toFixed(1)}%`;
const euros = (x: number) => t('{n} €', { n: num(x) });
const times = (x: number) => `×${lang() === 'en' ? x.toFixed(2) : x.toFixed(2).replace('.', ',')}`;
const signed = (x: number) => `${x >= 0 ? '+' : '−'}${num(Math.abs(x))}`;
/** Names joined: "Léa et Max". */
const joined = (names: readonly string[]) => (names.length ? names.reduce((a, b) => t('{a} et {b}', { a, b })) : '');

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

/** A song's form in words, with its arrow. */
function formLabel(form: number): string {
  return form >= 0.7 ? t('↑ en forme') : form >= 0.4 ? t('→ correct') : t('↓ rouillé');
}

const ratingTier = (r: number): string => (r >= 75 ? 'gold' : r >= 65 ? 'silver' : 'bronze');
const formClass = (form: number): string => (form >= 0.7 ? 'up' : form >= 0.4 ? 'flat' : 'down');

const ago = (weeks: number): string => (weeks <= 0 ? t('joué cette semaine') : tn(weeks, 'joué il y a {n} semaine', 'joué il y a {n} semaines'));
/** When a song never played since was learned. */
const learnedAgo = (weeks: number): string => (weeks <= 0 ? t('appris cette semaine') : tn(weeks, 'appris il y a {n} semaine', 'appris il y a {n} semaines'));

function button(label: string, data: Record<string, string>, className = 'action'): HTMLButtonElement {
  const b = el('button', className, label);
  b.type = 'button';
  Object.assign(b.dataset, data);
  return b;
}

/** Tuning changes in a setlist, in playing order. */
export function tuningChanges(setlist: readonly SongEntry[]): number {
  let n = 0;
  for (let i = 1; i < setlist.length; i++) if (setlist[i].tuning !== setlist[i - 1].tuning) n++;
  return n;
}

/** The career screens: the week's hub, building a gig's setlist, the report after a gig. */
export class CareerScreen {
  private career: Career | null = null;
  private offer: Offer | null = null;
  private setlist: (string | null)[] = [];
  private query = '';
  private confirmReset = false;
  /** The guitar, gear or musician whose purchase awaits a second click. */
  private confirmBuy: string | null = null;
  /** The band being drawn in the editor. */
  private draft: Band = defaultBand('');

  constructor(
    private readonly root: HTMLElement,
    private readonly hooks: CareerHooks,
  ) {
    root.addEventListener('click', (e) => this.onClick(e));
    root.addEventListener('input', (e) => {
      const input = e.target as HTMLInputElement;
      if (input.dataset.el === 'band-name') {
        this.draft = { ...this.draft, name: input.value };
        this.renderBand();
      }
      if (input.dataset.el !== 'search') return;
      this.query = input.value;
      this.renderPicks();
    });
  }

  showHub(career: Career): void {
    this.career = career;
    this.offer = null;
    this.confirmReset = false;
    const act = playingAct(career);
    const goal = objective(career);
    const panel = el('div', 'panel career-panel');
    const head = el('header', 'screen-head');
    head.append(
      button(t('← Menu'), { career: 'back' }, 'action small'),
      el('h2', '', t('Carrière')),
      el('span', 'career-when', t('Saison {season} · semaine {week}/{weeks} · {level}', { season: career.season, week: career.week, weeks: WEEKS, level: levelOf(career.difficulty).label })),
    );
    const stats = el('dl', 'career-stats');
    const stat = (k: string, v: string) => {
      const cell = el('div');
      cell.append(el('dt', '', k), el('dd', '', v));
      stats.append(cell);
    };
    stat(t('Acte {n}', { n: act }), ACTS[act].name);
    stat(t('Fans'), num(career.fans));
    stat(t('Argent'), euros(career.money));
    stat(t('Concerts'), String(career.history.length));
    stat(t('Hype'), String(career.hype));
    stat(t('Classement'), t('{n}e', { n: this.rank(career) }));
    const goalBox = el('div', 'career-goal');
    const bar = el('div', 'career-bar');
    const fill = el('i');
    fill.style.width = width(goal.progress);
    fill.style.setProperty('--fill', width(goal.progress));
    bar.append(fill);
    goalBox.append(el('small', '', t('Objectif')), el('b', '', goal.text), bar);
    const list = el('div', 'career-offers');
    for (const [i, o] of offers(career).entries()) list.append(this.offerCard(o, i));
    for (const v of lockedVenues(career).slice(0, 2)) {
      const card = el('article', 'offer locked');
      card.append(el('b', '', v.name), el('p', '', v.blurb), el('span', 'offer-lock', t('À partir de {n} fans', { n: num(v.fans) })));
      list.append(card);
    }
    const nav = el('nav', 'career-nav');
    nav.append(
      button(t('Répertoire · {n}', { n: this.known(career).length }), { career: 'repertoire' }),
      button(t('Le groupe · {names}', { names: career.members.map((m) => m.name.split(' ')[0]).join(', ') }), { career: 'members' }),
      button(t('Boutique · {money}', { money: euros(career.money) }), { career: 'shop' }),
      button(t('Album souvenirs · {n}', { n: career.souvenirs.length }), { career: 'album' }),
      button(t('Ta fiche · {n}', { n: overall(career.skills) ?? '—' }), { career: 'card' }),
      button(t('La scène · {n}e', { n: this.rank(career) }), { career: 'scene' }),
      button(career.sponsor ? t('Affaires · {brand}', { brand: career.sponsor.brand }) : t('Affaires'), { career: 'business' }),
      button(t('Réseaux · {n}', { n: num(career.followers) }), { career: 'social' }),
    );
    const foot = el('div', 'career-foot');
    foot.append(button(t('Nouvelle carrière'), { career: 'reset' }, 'action small subtle'));
    panel.append(head, this.bandCard(career));
    if (career.moment) panel.append(this.momentCard(career.moment));
    if (isSigned(career) && !career.contract) panel.append(this.contractCard());
    panel.append(el('p', 'career-act', ACTS[act].blurb));
    for (const n of career.news.slice(0, 1)) panel.append(el('p', 'career-news', n));
    if (!career.history.length && career.season === 1 && career.week === 1) {
      const level = el('p', 'career-level');
      level.append(el('span', '', t('Exigence : {level}. ', { level: levelOf(career.difficulty).label })), button(t('Changer'), { career: 'difficulty' }, 'action small'));
      panel.append(level);
    }
    if (career.report !== null) panel.append(this.seasonReport(career, career.report));
    panel.append(stats, nav, goalBox);
    if (isSigned(career)) panel.append(this.labelBox(career));
    const event = weekEvent(career.season, career.week);
    if (event) {
      const box = el('section', 'career-event');
      box.append(el('b', '', EVENTS[event].title), el('span', '', EVENTS[event].text));
      panel.append(box);
    }
    panel.append(this.challengeCard(career), this.weekBar(career));
    if (career.act >= 2) {
      const stolen = offers(career).find((o) => o.stolen);
      const fans = num(rivalFans(career.fans, weekIndex(career)));
      panel.append(el('p', 'career-rival', stolen ? t('{rival} · {n} fans · ils ont pris {venue} cette semaine', { rival: RIVAL, n: fans, venue: venueIn(stolen.venue.name) }) : `${RIVAL} · ${fans} fans`));
    }
    panel.append(list, foot);
    if (career.history.length) {
      const history = el('section', 'career-history');
      history.append(el('h3', '', t('Derniers concerts')));
      for (const r of career.history.slice(0, 3)) history.append(this.recordLine(r));
      panel.append(history);
    }
    this.root.replaceChildren(panel);
  }

  /** The week's slots: used and left, and what to do with one besides a gig. */
  private weekBar(career: Career): HTMLElement {
    const bar = el('section', 'week-bar');
    const dots = el('span', 'week-slots');
    const names: Record<string, string> = { rest: t('Repos'), rehearsal: t('Répétition'), studio: t('Studio'), learn: t('Apprentissage'), training: t('Entraînement') };
    for (let i = 0; i < SLOTS; i++) {
      const used = career.slots[i];
      const dot = el('span', `slot-dot${used ? ` used ${used.startsWith('gig') ? 'gig' : used}` : ''}`);
      dot.title = used ? (used.startsWith('gig') ? t('Concert') : names[used]) : t('Libre');
      dots.append(dot);
    }
    const head = el('div', 'week-head');
    const left = slotsLeft(career);
    const gigs = gigsPerWeek(career);
    head.append(el('h3', '', t('La semaine')), dots, el('small', '', `${tn(left, '{n} créneau sur {slots}', '{n} créneaux sur {slots}', { slots: SLOTS })} · ${tn(gigs, '{n} concert par semaine', '{n} concerts par semaine')}`));
    const actions = el('div', 'week-actions');
    const free = slotsLeft(career) > 0;
    const rehearse = button(t('Répétition du groupe'), { career: 'rehearse' });
    rehearse.title = t('Un créneau : chaque morceau du répertoire reprend un peu de forme, le moral monte un peu.');
    const restSlot = button(t('Repos'), { career: 'rest-slot' });
    restSlot.title = t('Un créneau : le moral du groupe remonte en fin de semaine.');
    rehearse.disabled = restSlot.disabled = !free;
    if (isSigned(career) && career.contract) {
      const studio = button(t('Studio · {n}/{total}', { n: Object.keys(career.album.takes).length, total: ALBUM_TRACKS }), { career: 'studio' });
      studio.title = t('Enregistrer des prises pour le prochain album : une séance (un créneau) en fait deux.');
      actions.append(studio);
    }
    const focus = weakest(career.skills);
    const train = button(t('Entraînement · {skill}', { skill: SKILLS.find((k) => k.id === focus)!.label }), { career: 'train', value: focus });
    train.title = t('Un créneau : une séance sur le point faible de ta fiche.');
    train.disabled = !free;
    actions.append(train, rehearse, restSlot, button(t('Semaine suivante'), { career: 'rest' }, 'action primary'));
    bar.append(head, actions);
    return bar;
  }

  /** This week's challenge: the song, the difficulty, the prizes, the tier reached. */
  private challengeCard(career: Career): HTMLElement {
    const box = el('section', 'challenge');
    const songs = this.hooks.songs();
    const ch = weeklyChallenge(career, songs);
    const song = ch ? songs.find((s) => s.id === ch.song) : undefined;
    if (!ch || !song) {
      box.append(el('p', 'help', t('Le défi de la semaine arrive avec les morceaux de la bibliothèque.')));
      return box;
    }
    const best = bestTier(career, ch);
    const text = el('div', 'challenge-text');
    text.append(el('small', '', t('Défi de la semaine · Score Attack {level}', { level: attackLevel(ch.level).label })), el('b', '', song.title), el('span', '', `${song.artist} · ${song.tuning} · ${formatTime(song.duration)}`));
    const tiers = el('div', 'challenge-tiers');
    TIERS.forEach((level, i) => {
      const tier = el('span', `tier tier-${i + 1}${best > i ? ' won' : ''}`);
      tier.append(el('b', '', level.name), el('span', '', `${pct(level.accuracy)} · ${euros(tierPrize(ch, i + 1))}`));
      tiers.append(tier);
    });
    text.append(tiers);
    const action =
      best >= TIERS.length
        ? el('span', 'challenge-done', t('Or décroché'))
        : button(best ? t('Viser plus haut') : t('Relever le défi'), { career: 'challenge' }, 'action primary small');
    box.append(coverElement(song.title, song.artist, this.hooks.coverUrl(song), 'challenge-cover'), text, action);
    return box;
  }

  /** The band at the top of the hub: its logo, or an invitation to name it. */
  private bandCard(career: Career): HTMLElement {
    const box = el('section', 'band-card');
    if (career.band) {
      const logo = el('img', 'band-logo');
      logo.src = logoUrl(career.band);
      logo.alt = career.band.name;
      box.append(logo, button(t('Modifier le groupe'), { career: 'band' }, 'action small'));
    } else {
      box.classList.add('unnamed');
      box.append(el('p', '', t('Ton groupe n’a pas encore de nom. Donne-lui un nom et un logo : ils iront sur les affiches et en fond de scène.')), button(t('Créer le groupe'), { career: 'band' }, 'action primary small'));
    }
    return box;
  }

  /** The band editor: its name, emblem, lettering and colours, drawn as they change. */
  showBand(career: Career): void {
    this.career = career;
    this.draft = career.band ?? defaultBand('');
    const panel = el('div', 'panel career-panel band-panel');
    const head = el('header', 'screen-head');
    head.append(button(t('← Carrière'), { career: 'hub' }, 'action small'), el('h2', '', career.band ? t('Ton groupe') : t('Créer le groupe')));
    const preview = el('canvas', 'band-preview');
    preview.width = 960;
    preview.height = 400;
    const name = el('input', 'band-name');
    name.type = 'text';
    name.maxLength = NAME_MAX;
    name.placeholder = t('Nom du groupe');
    name.value = this.draft.name;
    name.dataset.el = 'band-name';
    const choices = (title: string, items: HTMLElement[]) => {
      const row = el('div', 'band-choices');
      row.append(el('small', '', title), ...items);
      return row;
    };
    const emblems = EMBLEMS.map((e) => button(e.label, { career: 'band-emblem', value: e.id }, 'chip'));
    const letterings = LETTERINGS.map((l) => {
      const b = button(l.label, { career: 'band-lettering', value: l.id }, 'chip');
      b.style.fontFamily = l.font;
      return b;
    });
    const palettes = PALETTES.map((p, i) => {
      const b = button('', { career: 'band-palette', value: String(i) }, 'chip swatch');
      b.title = p.label;
      b.setAttribute('aria-label', p.label);
      b.style.background = `linear-gradient(135deg, ${p.fill}, ${p.accent})`;
      return b;
    });
    const foot = el('div', 'buttons');
    foot.append(button(t('Enregistrer'), { career: 'band-save' }, 'action primary'), button(t('Annuler'), { career: 'hub' }, 'action'));
    panel.append(
      head,
      el('p', 'help', t('Le nom et le logo du groupe vont sur l’affiche de chaque concert et sur une bannière dans le décor. Les affiches déjà rangées dans l’album gardent l’ancien logo.')),
      preview,
      name,
      choices(t('Emblème'), emblems),
      choices(t('Lettrage'), letterings),
      choices(t('Couleurs'), palettes),
      foot,
    );
    this.root.replaceChildren(panel);
    this.renderBand();
    name.focus();
  }

  private renderBand(): void {
    const preview = this.root.querySelector<HTMLCanvasElement>('.band-preview');
    if (!preview) return;
    const d = this.draft;
    if (d.name.trim()) drawLogo(preview, { ...d, name: d.name.trim() });
    else preview.getContext('2d')?.clearRect(0, 0, preview.width, preview.height);
    for (const b of this.root.querySelectorAll<HTMLElement>('.band-choices .chip')) {
      const kind = b.dataset.career;
      const on = (kind === 'band-emblem' && b.dataset.value === d.emblem) || (kind === 'band-lettering' && b.dataset.value === d.lettering) || (kind === 'band-palette' && Number(b.dataset.value) === d.palette);
      b.classList.toggle('on', on);
    }
    const save = this.root.querySelector<HTMLButtonElement>('[data-career="band-save"]');
    if (save) save.disabled = !d.name.trim();
  }

  /** Every gig's poster, the newest first; a click shows one up close. */
  showAlbum(career: Career): void {
    this.career = career;
    const panel = el('div', 'panel career-panel album-panel');
    const head = el('header', 'screen-head');
    head.append(button(t('← Carrière'), { career: 'hub' }, 'action small'), el('h2', '', t('Album souvenirs')), el('span', 'career-when', tn(career.souvenirs.length, '{n} affiche', '{n} affiches')));
    const wall = el('div', 'album-wall');
    career.souvenirs.forEach((s, i) => {
      const p = poster(s);
      p.dataset.career = 'poster';
      p.dataset.value = String(i);
      p.tabIndex = 0;
      wall.append(p);
    });
    panel.append(head, career.souvenirs.length ? wall : el('p', 'help', t('Chaque concert laisse ici son affiche : la salle, le soir, la setlist et le rappel.')));
    this.root.replaceChildren(panel);
  }

  /** One poster up close, over the album; a click puts it back. */
  private zoomPoster(i: number): void {
    const s = this.career?.souvenirs[i];
    if (!s) return;
    const zoom = el('div', 'poster-zoom');
    zoom.dataset.career = 'unzoom';
    zoom.append(poster(s));
    this.root.append(zoom);
  }

  /** The repertoire's songs found in the library (with audio), best rated first. */
  private known(career: Career): { song: SongEntry; learned: Learned; form: number; rating: number }[] {
    const now = weekIndex(career);
    const progress = this.hooks.progress();
    const out: { song: SongEntry; learned: Learned; form: number; rating: number }[] = [];
    for (const song of this.hooks.songs()) {
      const learned = career.repertoire[song.id];
      if (!learned) continue;
      const form = formOf(learned, now);
      out.push({ song, learned, form, rating: rating(progress[song.id]?.mastery ?? 0, form) });
    }
    return out.sort((a, b) => b.rating - a.rating || a.song.title.localeCompare(b.song.title));
  }

  /** The band's songs as cards (rating out of 99, form, tuning), and the scout's proposals. */
  showRepertoire(career: Career): void {
    this.career = career;
    const now = weekIndex(career);
    const known = this.known(career);
    const panel = el('div', 'panel career-panel repertoire-panel');
    const head = el('header', 'screen-head');
    head.append(button(t('← Carrière'), { career: 'hub' }, 'action small'), el('h2', '', t('Répertoire')), el('span', 'career-when', tn(known.length, '{n} morceau', '{n} morceaux')));
    const cards = el('div', 'song-cards');
    for (const k of known) {
      const card = el('article', `song-card ${ratingTier(k.rating)}`);
      const text = el('div', 'song-card-text');
      text.append(el('b', '', k.song.title), el('span', '', `${k.song.artist} · ${k.song.tuning}`), el('span', `form ${formClass(k.form)}`, `${formLabel(k.form)} · ${k.learned.played === k.learned.since ? learnedAgo(now - k.learned.since) : ago(now - k.learned.played)}`));
      card.append(el('b', `song-rating ${ratingTier(k.rating)}`, String(k.rating)), coverElement(k.song.title, k.song.artist, this.hooks.coverUrl(k.song), 'song-card-cover'), text);
      cards.append(card);
    }
    const proposals = scout(
      this.hooks.songs(),
      career.repertoire,
      playingAct(career),
      now,
      MIN_SONG,
    );
    const scoutBox = el('div', 'song-cards scout');
    for (const song of proposals) {
      const card = el('article', 'song-card proposal');
      const text = el('div', 'song-card-text');
      text.append(el('b', '', song.title), el('span', '', `${song.artist} · ${song.tuning} · ${formatTime(song.duration)}`), el('span', '', t('≈ {n} notes par minute', { n: Math.round(density(song)) })));
      const learnButton = button(t('Apprendre · 1 créneau'), { career: 'learn', song: song.id }, 'action primary small');
      learnButton.disabled = slotsLeft(career) <= 0;
      card.append(coverElement(song.title, song.artist, this.hooks.coverUrl(song), 'song-card-cover'), text, learnButton);
      scoutBox.append(card);
    }
    panel.append(
      head,
      el(
        'p',
        'help',
        t('Chaque morceau a sa note sur 99, comme une carte de joueur : sa maîtrise et sa forme. La forme tient deux semaines, puis baisse ; rejoue le morceau (en jeu libre, en Score Attack, au Loop Trainer à pleine vitesse ou en concert) pour la remonter. Une setlist en forme rapporte jusqu’à ×1,1 en fans et en cachet, une setlist rouillée ×0,85.'),
      ),
      cards,
      el('h3', '', t('Le dénicheur')),
      el('p', 'help', proposals.length ? t('Cette semaine, des morceaux à ta portée pour l’acte en cours. Un morceau appris entre au répertoire, à toi de le faire monter.') : t('Le dénicheur n’a plus rien à te proposer : toute ta bibliothèque est au répertoire.')),
      scoutBox,
    );
    this.root.replaceChildren(panel);
  }

  /** The label's objectives for the season, and what each pays. */
  /** The band's place in the scene. */
  private rank(career: Career): number {
    return rankOf(sceneChart(career.world, career.band?.name ?? t('Ton groupe'), career.fans, weekIndex(career)));
  }

  /** A moment waiting for a choice: what happened, and what each choice will do. */
  private momentCard(m: Moment): HTMLElement {
    const box = el('section', 'career-moment');
    box.append(el('b', '', m.title), el('p', '', m.text));
    const choices = el('div', 'moment-choices');
    for (const c of m.choices) {
      const b = button(c.label, { career: 'moment', value: c.id }, 'action small');
      b.append(el('small', '', c.hint));
      choices.append(b);
    }
    box.append(choices);
    return box;
  }

  /** The showcase won: the label contracts on the table. */
  private contractCard(): HTMLElement {
    const box = el('section', 'career-contract');
    box.append(el('b', '', t('Le showcase est gagné : choisis ton label.')));
    const list = el('div', 'contract-choices');
    for (const c of CONTRACTS) {
      const card = el('article', 'gear-card');
      const top = el('header');
      top.append(el('b', '', c.name), el('span', 'guitar-price', c.advance ? t('Avance {money}', { money: euros(c.advance) }) : t('Sans avance')));
      card.append(top, el('p', '', c.blurb), button(t('Signer'), { career: 'contract', value: c.id }, 'action primary small'));
      list.append(card);
    }
    box.append(list);
    return box;
  }

  /** The guitarist's card: six ratings measured on what is played, the weakest to train. */
  showCard(career: Career): void {
    this.career = career;
    const all = overall(career.skills);
    const month = overallSince(career.skills, 30);
    const panel = el('div', 'panel career-panel card-panel');
    const head = el('header', 'screen-head');
    head.append(
      button(t('← Carrière'), { career: 'hub' }, 'action small'),
      el('h2', '', t('Ta fiche')),
      el('span', 'career-when', all !== null && month !== null && all !== month ? t('{sign}{n} en 30 jours', { sign: all > month ? '+' : '−', n: Math.abs(all - month) }) : ''),
    );
    const card = el('div', 'player-card');
    const top = el('div', 'player-top');
    top.append(el('b', 'player-overall', all === null ? '—' : String(all)), el('span', 'player-name', career.band?.name ?? t('Ton groupe')));
    card.append(top);
    const focus = weakest(career.skills);
    for (const k of SKILLS) {
      const r = ratingOf(career.skills, k.id);
      const row = el('div', `player-skill${k.id === focus ? ' weakest' : ''}`);
      const bar = el('i', 'skill-bar');
      bar.style.setProperty('--fill', width(r === null ? 0 : (r - 40) / 59));
      const measured = career.skills.values[k.id]?.notes ?? 0;
      row.append(
        el('b', 'skill-short', k.short),
        el('span', `skill-rating ${r === null ? '' : ratingTier(r)}`, r === null ? '—' : String(r)),
        bar,
        el('span', 'skill-label', k.label),
        el('small', '', r === null ? t('à mesurer : encore {n} notes', { n: Math.max(0, MEASURED - measured) }) : k.blurb),
      );
      card.append(row);
    }
    const train = button(t('S’entraîner : {skill} · 1 créneau', { skill: SKILLS.find((k) => k.id === focus)!.label }), { career: 'train', value: focus }, 'action primary');
    train.disabled = slotsLeft(career) <= 0;
    panel.append(
      head,
      card,
      el('p', 'help', t('Mesurée sur ce que tu joues : morceaux, concerts, leçons, entraînements. Elle te suit d’une carrière à l’autre, comme tes guitares.')),
      train,
    );
    this.root.replaceChildren(panel);
  }

  /** The scene: every band by fans, the awards won. */
  showScene(career: Career): void {
    this.career = career;
    const name = career.band?.name ?? t('Ton groupe');
    const chart = sceneChart(career.world, name, career.fans, weekIndex(career));
    const panel = el('div', 'panel career-panel scene-panel');
    const head = el('header', 'screen-head');
    head.append(button(t('← Carrière'), { career: 'hub' }, 'action small'), el('h2', '', t('La scène')), el('span', 'career-when', t('{n}e sur {total}', { n: rankOf(chart), total: chart.length })));
    const table = el('ol', 'scene-chart');
    for (const line of chart) {
      const li = el('li', line.you ? 'you' : line.rival ? 'rival' : '');
      li.append(el('span', '', line.you || line.rival ? line.name : bandName(line.name)), el('b', '', num(line.fans)));
      table.append(li);
    }
    const awards = el('ul', 'scene-awards');
    for (const a of career.world.awards) awards.append(el('li', '', t('Saison {season} · {award}', { season: a.season, award: AWARDS[a.id] })));
    panel.append(
      head,
      el('p', 'help', t('Les fans de chaque groupe, semaine après semaine. Un groupe juste au-dessus de toi t’invite parfois à faire sa première partie : une offre de plus dans la semaine, devant un public venu pour lui.')),
      table,
      el('h3', '', t('Les prix')),
      career.world.awards.length ? awards : el('p', 'help', t('En fin de saison : groupe de l’année (premier du classement), meilleur live, révélation (fans ×3 en une saison), album de l’année.')),
    );
    this.root.replaceChildren(panel);
  }

  /** The business: wages, the sponsor, the label contract. */
  showBusiness(career: Career): void {
    this.career = career;
    const act = playingAct(career);
    const panel = el('div', 'panel career-panel business-panel');
    const head = el('header', 'screen-head');
    head.append(button(t('← Carrière'), { career: 'hub' }, 'action small'), el('h2', '', t('Affaires')), el('span', 'career-when', t('{money} en poche', { money: euros(career.money) })));
    panel.append(head, el('h3', '', t('Les salaires')));
    const wages = payroll(career.members, act);
    if (!wages) panel.append(el('p', 'help', t('Les copains jouent pour rien jusqu’aux clubs : à partir de l’acte 3, chaque musicien est payé chaque semaine.')));
    else {
      const list = el('ul', 'business-list');
      for (const m of career.members) list.append(el('li', '', t('{name} · {money} par semaine', { name: m.name, money: euros(wageOf(m, act)) })));
      panel.append(el('p', 'help', t('{money} par semaine en tout, payés en fin de semaine : sans assez d’argent, le moral baisse.', { money: euros(wages) })), list);
    }
    panel.append(el('h3', '', t('Le sponsor')));
    if (career.sponsor) {
      const s = career.sponsor;
      const box = el('article', 'gear-card owned');
      const top = el('header');
      top.append(el('b', '', s.brand), el('span', 'guitar-price', t('{money} par semaine', { money: euros(s.pay) })));
      box.append(
        top,
        el('p', '', `${sponsorGoal(s)} · ${t('prime {money}', { money: euros(s.bonus) })}`),
        el('span', 'guitar-state', s.goal === 'gigs' ? t('{done} sur {n} · encore {weeks} semaines', { done: s.done, n: s.target, weeks: s.weeksLeft }) : t('Encore {weeks} semaines', { weeks: s.weeksLeft })),
      );
      panel.append(box);
    } else {
      const deals = sponsorOffers(act, career.season, career.week, career.fans, this.rank(career), career.followers);
      if (!deals.length) panel.append(el('p', 'help', t('Pas d’offre cette semaine : les marques passent toutes les quatre semaines, à partir des bars.')));
      const grid = el('div', 'gear-grid');
      deals.forEach((o, i) => {
        const card = el('article', 'gear-card');
        const top = el('header');
        top.append(el('b', '', o.brand), el('span', 'guitar-price', t('{money} par semaine', { money: euros(o.pay) })));
        card.append(top, el('p', '', `${sponsorGoal(o)} · ${t('prime {money}', { money: euros(o.bonus) })}`), button(t('Signer'), { career: 'sponsor', value: String(i) }, 'action primary small'));
        grid.append(card);
      });
      panel.append(grid);
    }
    panel.append(el('h3', '', t('Le label')));
    if (career.contract) {
      const c = CONTRACTS.find((x) => x.id === career.contract!.id)!;
      panel.append(el('p', 'help', `${c.name} · ${c.blurb}`));
    } else if (isSigned(career)) panel.append(this.contractCard());
    else panel.append(el('p', 'help', t('Un label fera son offre au showcase de l’acte 3 : une major, un indépendant, ou l’autoproduction.')));
    this.root.replaceChildren(panel);
  }

  /** The networks: followers, this week's post, the communications manager, good causes. */
  showSocial(career: Career): void {
    this.career = career;
    const act = playingAct(career);
    const panel = el('div', 'panel career-panel social-panel');
    const head = el('header', 'screen-head');
    head.append(button(t('← Carrière'), { career: 'hub' }, 'action small'), el('h2', '', t('Réseaux')), el('span', 'career-when', t('{n} abonnés · hype {hype}', { n: num(career.followers), hype: career.hype })));
    panel.append(head, el('p', 'help', t('Une publication par semaine. Les abonnés suivent la hype et tes fans ; les marques paient plus un groupe suivi, et les appels aux dons viennent d’ici.')));
    const posted = career.posted === `${career.season}-${career.week}`;
    const grid = el('div', 'gear-grid');
    const kinds: [PostKind, string, string, number][] = [
      ['coulisses', t('Les coulisses'), t('Photos et vidéos de la route, gratuites.'), 0],
      ['clip', t('Un clip'), t('Un vrai clip tourné pour un morceau.'), clipCost(act)],
    ];
    for (const [kind, name, blurb, cost] of kinds) {
      const e = postEffect(kind, career.followers, career.fans, career.comms, career.hype);
      const card = el('article', 'gear-card');
      const top = el('header');
      top.append(el('b', '', name), el('span', 'guitar-price', cost ? euros(cost) : t('Gratuit')));
      const go = button(posted ? t('Déjà publié cette semaine') : t('Publier'), { career: 'post', value: kind }, 'action primary small');
      go.disabled = posted || career.money < cost;
      card.append(top, el('p', '', `${blurb} ${t('≈ {n} abonnés, hype +{hype}', { n: num(e.followers), hype: e.hype })}`), go);
      grid.append(card);
    }
    panel.append(grid, el('h3', '', t('La chargée de communication')));
    const wage = commsWage(act);
    if (!wage) panel.append(el('p', 'help', t('Une chargée de communication te rejoint à partir des clubs : la hype retombe moins, les publications portent plus, la presse t’appelle plus souvent.')));
    else {
      const card = el('article', `gear-card solo${career.comms ? ' owned' : ''}`);
      const top = el('header');
      top.append(el('b', '', t('Inès, chargée de communication')), el('span', 'guitar-price', t('{money} par semaine', { money: euros(wage) })));
      card.append(
        top,
        el('p', '', t('La hype retombe vers 55 au lieu de 40, les publications et les interviews portent moitié plus, la presse t’appelle plus souvent.')),
        button(career.comms ? t('Se séparer d’elle') : t('L’embaucher'), { career: career.comms ? 'fire-comms' : 'hire-comms' }, career.comms ? 'action small' : 'action primary small'),
      );
      panel.append(card);
    }
    panel.append(el('h3', '', t('Les bonnes causes')), el('p', 'help', t('De temps en temps, tes abonnés relaient un appel : un don, ou un concert caritatif sans cachet et avec des frais, mais qui rapporte beaucoup de fans et de hype. Trois concerts caritatifs valent un trophée.')));
    this.root.replaceChildren(panel);
  }

  private labelBox(career: Career): HTMLElement {
    const box = el('section', 'label-box');
    box.append(el('small', '', t('{label} · objectifs de la saison · {money} chacun', { label: LABEL, money: euros(objectiveBonus(career.act)) })));
    const list = el('ul');
    for (const o of labelObjectives(career)) {
      const li = el('li', o.done >= o.target ? 'done' : '');
      li.append(el('span', '', o.text), el('b', '', o.done >= o.target ? '✓' : `${num(o.done)} / ${num(o.target)}`));
      list.append(li);
    }
    box.append(list);
    return box;
  }

  /** A new career: how demanding it is. */
  private showDifficulty(): void {
    const panel = el('div', 'panel career-panel');
    const head = el('header', 'screen-head');
    head.append(button(t('← Carrière'), { career: 'hub' }, 'action small'), el('h2', '', t('Nouvelle carrière')));
    const cards = el('div', 'gear-grid');
    for (const d of DIFFICULTIES) {
      const card = el('article', 'gear-card');
      const top = el('header');
      top.append(el('b', '', d.label));
      card.append(top, el('p', '', d.blurb), button(t('Commencer en {level}', { level: d.label }), { career: 'level', value: d.id }, d.id === 'pro' ? 'action primary small' : 'action small'));
      cards.append(card);
    }
    panel.append(head, el('p', 'help', t('Le groupe, l’album, les guitares, les trophées et le Hall of Fame restent ; tout le reste repart du garage.')), cards);
    this.root.replaceChildren(panel);
  }

  /** The studio: takes recorded for the next album, songs to record, the album to release. */
  showStudio(career: Career): void {
    this.career = career;
    const panel = el('div', 'panel career-panel repertoire-panel');
    const head = el('header', 'screen-head');
    const takes = career.album.takes;
    const n = Object.keys(takes).length;
    head.append(button(t('← Carrière'), { career: 'hub' }, 'action small'), el('h2', '', t('Studio')), el('span', 'career-when', t('{n}/{total} morceaux · qualité {quality}', { n, total: ALBUM_TRACKS, quality: pct(albumQuality(career.album)) })));
    const cards = el('div', 'song-cards');
    const free = slotsLeft(career) > 0 || (career.album.session ?? 0) > 0;
    for (const k of this.known(career)) {
      const card = el('article', `song-card${k.song.id in takes ? ' gold' : ''}`);
      const text = el('div', 'song-card-text');
      text.append(el('b', '', k.song.title), el('span', '', k.song.id in takes ? t('Meilleure prise : {take}', { take: pct(takes[k.song.id]) }) : t('Pas encore enregistré')));
      const take = button(k.song.id in takes ? t('Refaire') : lang() === 'en' ? 'Record' : 'Enregistrer', { career: 'take', song: k.song.id }, 'action small');
      take.disabled = !free;
      card.append(coverElement(k.song.title, k.song.artist, this.hooks.coverUrl(k.song), 'song-card-cover'), text, take);
      cards.append(card);
    }
    const toRecord = ALBUM_TRACKS - n;
    const release = button(n >= ALBUM_TRACKS ? t('Sortir l’album {n}', { n: career.album.released.length + 1 }) : tn(toRecord, 'Encore {n} morceau à enregistrer', 'Encore {n} morceaux à enregistrer'), { career: 'release' }, 'action primary');
    release.disabled = n < ALBUM_TRACKS;
    panel.append(
      head,
      el(
        'p',
        'help',
        t('Une séance de studio prend un créneau de la semaine et enregistre deux prises (trois dans ton propre studio) : tu joues le morceau en entier, sa précision fait la prise, la meilleure est gardée. Huit morceaux font un album : {label} le sort, les ventes suivent sa qualité et tes fans.', { label: LABEL }) +
          ((career.album.session ?? 0) > 0
            ? ` ${tn(career.album.session!, 'Séance en cours : encore {n} prise sans créneau.', 'Séance en cours : encore {n} prises sans créneau.')}`
            : free
              ? ''
              : ` ${t('Plus de créneau cette semaine')}.`),
      ),
      cards,
      release,
    );
    if (career.album.released.length) {
      const past = el('section', 'career-history');
      past.append(el('h3', '', t('Discographie')));
      for (const r of [...career.album.released].reverse()) past.append(el('p', 'gig-note', t('{name} · saison {season} · qualité {quality} · {copies} exemplaires', { name: r.name, season: r.season, quality: pct(r.quality), copies: num(r.copies) })));
      panel.append(past);
    }
    this.root.replaceChildren(panel);
  }

  /** The band: each member's ratings and morale, and this week's market. */
  showMembers(career: Career): void {
    this.career = career;
    this.confirmBuy = null;
    const panel = el('div', 'panel career-panel members-panel');
    const head = el('header', 'screen-head');
    head.append(button(t('← Carrière'), { career: 'hub' }, 'action small'), el('h2', '', t('Le groupe')), el('span', 'career-when', `${euros(career.money)} · ${num(career.fans)} fans`));
    const members = el('div', 'member-cards');
    for (const m of career.members) members.append(this.memberCard(m));
    const offers = el('div', 'member-cards');
    for (const c of market(playingAct(career), weekIndex(career))) {
      const current = career.members.find((m) => m.role === c.role)!;
      const hired = current.name === c.name && current.precision === c.precision && current.energy === c.energy;
      const card = this.memberCard(c);
      card.classList.add('candidate');
      const why = hired ? t('Dans le groupe') : career.fans < c.fans ? t('Il faut {n} fans', { n: num(c.fans) }) : career.money < c.fee ? t('Encore {money}', { money: euros(c.fee - career.money) }) : null;
      const action = button(why ?? t('Recruter à la place de {name} · {money}', { name: current.name.split(' ')[0], money: euros(c.fee) }), { career: 'hire', value: c.role }, why ? 'action small' : 'action primary small');
      action.disabled = !!why;
      card.append(action);
      offers.append(card);
    }
    panel.append(
      head,
      el(
        'p',
        'help',
        t('La précision du groupe pèse sur les fans et le cachet, son énergie fait démarrer le public plus chaud. Un musicien peu fiable peut manquer une date (un remplaçant joue). Le moral monte avec les bons concerts et le repos, baisse avec les mauvais concerts et les semaines sans repos ; à bout, un musicien part chez Les Vautours.'),
      ),
      members,
      el('h3', '', t('Le marché de la semaine')),
      el('p', 'help', t('Un musicien par rôle, meilleur à chaque acte. Le recruter remplace celui qui tient ce rôle.')),
      offers,
    );
    this.root.replaceChildren(panel);
  }

  private memberCard(m: Musician): HTMLElement {
    const card = el('article', 'member-card');
    const top = el('header');
    top.append(el('small', '', ROLES.find((r) => r.id === m.role)!.label), el('b', '', m.name));
    const stats = el('div', 'member-stats');
    for (const [label, value] of [
      [t('Précision'), m.precision],
      [t('Énergie'), m.energy],
      [t('Fiabilité'), m.reliability],
    ] as const) {
      const row = el('div', 'member-stat');
      const bar = el('i');
      bar.style.width = `${value}%`;
      const track = el('span', 'member-bar');
      track.append(bar);
      row.append(el('span', '', label), track, el('b', '', String(value)));
      stats.append(row);
    }
    const morale = el('div', `member-morale ${m.morale >= 0.75 ? 'up' : m.morale >= 0.45 ? 'flat' : 'down'}`);
    morale.append(el('span', '', t('Moral : {mood}', { mood: moraleLabel(m.morale) })), el('span', '', pct(m.morale)));
    card.append(top, stats, morale);
    return card;
  }

  /** The guitar shop: bought once with the gigs' fees, kept for good, played in every mode. */
  showShop(career: Career): void {
    this.career = career;
    this.confirmBuy = null;
    const panel = el('div', 'panel career-panel shop-panel');
    const head = el('header', 'screen-head');
    head.append(button(t('← Carrière'), { career: 'hub' }, 'action small'), el('h2', '', t('Boutique')), el('span', 'career-when', t('{money} en poche', { money: euros(career.money) })));
    const gear = el('div', 'gear-grid');
    for (const g of GEAR) {
      const owned = career.gear.includes(g.id);
      const card = el('article', `gear-card${owned ? ' owned' : ''}`);
      const top = el('header');
      top.append(el('b', '', g.name), el('span', 'guitar-price', owned ? t('Acquis') : euros(g.price)));
      card.append(top, el('p', '', g.blurb));
      if (owned) card.append(el('span', 'guitar-state', t('Dans le van')));
      else if (career.money >= g.price) card.append(button(t('Acheter · {money}', { money: euros(g.price) }), { career: 'buy-gear', value: g.id }, 'action primary small'));
      else {
        const short = button(t('Encore {money} de cachets', { money: euros(g.price - career.money) }), {}, 'action small');
        short.disabled = true;
        card.append(short);
      }
      gear.append(card);
    }
    const grid = el('div', 'shop-grid');
    for (const g of GUITARS) grid.append(this.guitarCard(career, g));
    grid.addEventListener('pointerleave', () => {
      grid.querySelectorAll('.guitar-card.trying').forEach((c) => c.classList.remove('trying'));
      this.hooks.preview(null);
    });
    panel.append(
      head,
      el('h3', '', t('Le matos')),
      el('p', 'help', t('Pour cette carrière : chaque pièce change les concerts. Une nouvelle carrière repart sans.')),
      gear,
      el('h3', '', t('Les guitares')),
      el('p', 'help', t('Achetées avec les cachets des concerts ou gagnées avec un trophée, les guitares restent, même en recommençant la carrière, et se jouent dans tous les modes. Réglages → Jeu pour en changer hors de la boutique.')),
      grid,
    );
    this.root.replaceChildren(panel);
  }

  private guitarCard(career: Career, g: Guitar): HTMLElement {
    const played = career.guitar === g.id;
    const card = el('article', `guitar-card${played ? ' played' : ''}`);
    // Tried on the neck behind the rack while hovered, lit from where the pointer is.
    card.addEventListener('pointerenter', () => {
      this.root.querySelectorAll('.guitar-card.trying').forEach((c) => c.classList.remove('trying'));
      card.classList.add('trying');
      this.hooks.preview(g.id);
    });
    card.addEventListener('pointermove', (e) => {
      const r = card.getBoundingClientRect();
      card.style.setProperty('--mx', `${((e.clientX - r.left) / r.width) * 100}%`);
      card.style.setProperty('--my', `${((e.clientY - r.top) / r.height) * 100}%`);
    });
    const picture = el('canvas', 'guitar-picture');
    picture.width = 560;
    picture.height = 150;
    drawGuitar(picture, g);
    const head = el('header');
    head.append(el('b', '', g.name), el('span', 'guitar-price', g.trophy ? (ownsGuitar(career, g.id) ? t('Gagnée') : t('À gagner')) : g.price ? euros(g.price) : t('De série')));
    card.append(picture, head, el('p', '', g.blurb));
    if (played) card.append(el('span', 'guitar-state', t('Sur scène')));
    else if (ownsGuitar(career, g.id)) card.append(button(t('Jouer avec'), { career: 'equip', guitar: g.id }, 'action small'));
    else if (g.trophy) {
      card.classList.add('won-only');
      card.append(el('span', 'guitar-trophy', t('Trophée « {name} »', { name: TROPHIES.find((x) => x.id === g.trophy)?.name ?? '' })));
    } else if (career.money >= g.price) card.append(button(t('Acheter · {money}', { money: euros(g.price) }), { career: 'buy', guitar: g.id }, 'action primary small'));
    else {
      const short = button(t('Encore {money} de cachets', { money: euros(g.price - career.money) }), {}, 'action small');
      short.disabled = true;
      card.append(short);
    }
    return card;
  }

  showResult(career: Career, record: GigRecord, actUp: boolean): void {
    this.career = career;
    const panel = el('div', 'panel career-panel gig-result');
    const when = el('small', 'career-when', t('Saison {season} · semaine {week}', { season: record.season, week: record.week }));
    const title = el('h2', '', record.venue);
    const outcome =
      record.outcome === 'booed'
        ? t('Sorti de scène par le public')
        : record.outcome === 'abandoned'
          ? t('Concert abandonné')
          : record.grade !== '—'
            ? t('Public conquis à {crowd} · note {grade} ({accuracy} de notes justes)', { crowd: pct(record.satisfaction), grade: record.grade, accuracy: pct(record.accuracy) })
            : t('Public conquis à {crowd}', { crowd: pct(record.satisfaction) });
    const crowd = el('div', 'gig-crowd');
    const fill = el('i');
    fill.style.width = width(record.satisfaction);
    fill.style.setProperty('--fill', width(record.satisfaction));
    crowd.append(fill);
    const songs = el('ol', 'gig-songs');
    for (const s of record.songs) {
      const li = el('li');
      const perMinute = s.seconds > 0 ? Math.round(s.notes / (s.seconds / 60)) : 0;
      li.append(
        el('span', '', s.title),
        el('b', `grade-${s.grade === '—' ? 'none' : s.grade}`, s.grade),
        el('span', 'gig-song-crowd', t('public {crowd} · {n} notes/min · {effort}', { crowd: pct(s.crowd), n: perMinute, effort: times(songEffort(s)) })),
      );
      songs.append(li);
    }
    if (record.encore) {
      const li = el('li', 'gig-encore');
      li.append(
        el('span', '', t('Rappel : {title}', { title: record.encore.title })),
        el('b', '', '♪'),
        el('span', 'gig-song-crowd', t('public {crowd} · {fans} fans · {money} en plus', { crowd: pct(record.encore.crowd), fans: signed(record.encore.fans), money: euros(record.encore.money) })),
      );
      songs.append(li);
    }
    const gains = el('dl', 'career-stats');
    for (const [k, v] of [
      [t('Fans'), signed(record.fans)],
      [t('Cachet'), euros(record.money)],
      [t('Exigence'), times(record.effort)],
      [t('Forme'), times(record.form)],
      [t('Groupe'), times(record.band)],
      [t('Total fans'), num(career.fans)],
    ]) {
      const cell = el('div');
      cell.append(el('dt', '', k), el('dd', '', v));
      gains.append(cell);
    }
    const notes: string[] = [];
    if (record.missing.length) notes.push(tn(record.missing.length, '{names} a manqué la date : un remplaçant a joué.', '{names} ont manqué la date : un remplaçant a joué.', { names: joined(record.missing) }));
    if (record.merch) notes.push(t('Merch : {money} de ventes au stand.', { money: euros(record.merch) }));
    if (record.charity) notes.push(t('Concert caritatif pour {cause} : {money} de frais, et des fans en plus.', { cause: CAUSES[record.charity] ?? record.charity, money: euros(record.costs ?? 0) }));
    else if (record.costs) notes.push(t('Frais de tournée : {money} (équipe, camions, hôtels).', { money: euros(record.costs) }));
    const souvenir = el('div', 'gig-souvenir');
    if (career.souvenirs[0]) souvenir.append(poster(career.souvenirs[0]), el('span', '', t('L’affiche de la soirée rejoint l’album souvenirs.')));
    panel.append(
      when,
      title,
      el('p', 'gig-outcome', outcome),
      crowd,
      el('p', 'review', record.review),
      ...notes.map((n) => el('p', 'gig-note', n)),
      souvenir,
      songs,
      gains,
      el('p', 'help', t('L’exigence vient des notes jouées par minute, au niveau joué : des morceaux plus denses, joués plus complets, rapportent plus de fans et de cachet. La forme vient des répétitions : un morceau rejoué dans les deux semaines reste en forme.')),
    );
    if (actUp) {
      const next = ACTS[career.act];
      const banner = el('div', 'act-up');
      banner.append(el('small', '', t('Acte {n}', { n: career.act })), el('b', '', next.name), el('span', '', next.blurb));
      panel.append(banner);
    }
    const foot = el('div', 'buttons');
    foot.append(button(t('Continuer'), { career: 'hub' }, 'action primary'));
    panel.append(foot);
    this.root.replaceChildren(panel);
  }

  /** The season just over: gigs, fans, money, the best night, then on to the next. */
  private seasonReport(career: Career, season: number): HTMLElement {
    const s = seasonSummary(career, season);
    const box = el('section', 'season-report');
    box.append(el('small', '', t('Bilan de la saison {n}', { n: season })));
    const line = s.gigs
      ? tn(s.gigs, '{n} concert, {fans} fans, {money} de cachets.', '{n} concerts, {fans} fans, {money} de cachets.', { fans: signed(s.fans), money: euros(s.money) })
      : t('Aucun concert cette saison : le public ne t’a pas encore vu.');
    box.append(el('b', '', line));
    if (s.best) box.append(el('span', '', t('Meilleur concert : {venue}, public à {crowd}.', { venue: s.best.venue, crowd: pct(s.best.satisfaction) })));
    const act = ACTS[playingAct(career)].name;
    const actName = lang() === 'en' ? act.charAt(0).toLowerCase() + act.slice(1) : act.toLowerCase();
    box.append(el('span', '', t('Te voilà dans l’acte {n}, {name}, avec {fans} fans.', { n: playingAct(career), name: actName, fans: num(career.fans) })));
    if (career.labelReport?.season === season) {
      const l = career.labelReport;
      const bonus = l.bonus ? t(', {money} de prime', { money: euros(l.bonus) }) : '';
      box.append(el('span', '', tn(l.met, '{label} : {n} objectif sur 3 atteint{bonus}.', '{label} : {n} objectifs sur 3 atteints{bonus}.', { label: LABEL, bonus })));
    }
    box.append(button(t('Attaquer la saison {n}', { n: season + 1 }), { career: 'report-read' }, 'action primary small'));
    return box;
  }

  private offerCard(o: Offer, i: number): HTMLElement {
    const card = el('article', `offer${o.venue.decisive ? ' decisive' : ''}`);
    const head = el('header');
    head.append(el('b', '', o.venue.name));
    if (o.venue.decisive) head.append(el('span', 'badge decisive-badge', o.venue.rival ? t('Décisive · contre les Vautours') : o.venue.complete ? t('Décisive · {pct} % des notes', { pct: Math.round(o.venue.complete * 100) }) : t('Date décisive')));
    else if (o.headliner) head.append(el('span', 'badge opening-badge', t('Remplace {name}', { name: o.headliner })));
    else if (o.invited) head.append(el('span', 'badge opening-badge', t('Première partie de {name}', { name: bandName(o.invited) })));
    else if (o.charity) head.append(el('span', 'badge event-badge', t('Concert caritatif')));
    else if (o.venue.opening) head.append(el('span', 'badge opening-badge', t('Première partie')));
    if (o.scout) head.append(el('span', 'badge event-badge', t('Dénicheur · fans ×2')));
    if (o.acoustic) head.append(el('span', 'badge event-badge', t('Panne · acoustique')));
    const facts = el('dl', 'offer-facts');
    for (const [k, v] of [
      [t('Public'), `${o.audience}`],
      [
        t('Cachet'),
        o.charity
          ? t('aucun · {money} de frais', { money: euros(charityCost(o.venue.act)) })
          : o.venue.fee
            ? t('jusqu’à {money}', { money: euros(Math.round(feeFor(o.venue, 1) * (o.headliner ? 2 : o.invited ? 0.6 : 1))) })
            : t('pour la gloire'),
      ],
      [t('Setlist'), tn(o.songs, '{n} morceau', '{n} morceaux')],
    ]) {
      const cell = el('div');
      cell.append(el('dt', '', k), el('dd', '', v));
      facts.append(cell);
    }
    const career = this.career!;
    const known = this.known(career).length;
    const gig = canGig(career);
    const why = o.stolen
      ? t('Prise par {rival}', { rival: RIVAL })
      : !gig
      ? slotsLeft(career) > 0
        ? gigsPerWeek(career) > 1
          ? t('Deux concerts cette semaine : c’est le maximum')
          : gigsPerWeek(career) === 0
            ? t('Le van est en panne cette semaine')
            : t('Un concert par semaine (le van en permet deux)')
        : t('Plus de créneau cette semaine')
      : known < o.songs
        ? tn(o.songs, 'Il te faut {n} morceau au répertoire ({known})', 'Il te faut {n} morceaux au répertoire ({known})', { known })
        : null;
    const pick = button(why ?? t('Choisir'), { career: 'pick', offer: String(i) }, 'action primary small');
    pick.disabled = !!why;
    const about = o.charity ? t('Pour {cause} : un public venu pour la bonne cause, beaucoup de fans et de hype.', { cause: CAUSES[o.charity] ?? o.charity }) : o.venue.blurb;
    card.append(head, el('p', '', about), facts, pick);
    return card;
  }

  private recordLine(r: GigRecord): HTMLElement {
    const line = el('div', 'career-record');
    const facts = `${r.outcome === 'played' ? t('Public {crowd}', { crowd: pct(r.satisfaction) }) : r.outcome === 'booed' ? t('Sorti de scène') : t('Abandonné')} · ${signed(r.fans)} fans · ${euros(r.money)}`;
    line.append(el('b', '', r.venue), el('span', '', facts), el('em', '', r.review));
    return line;
  }

  private showSetlist(offer: Offer): void {
    this.offer = offer;
    this.setlist = Array.from({ length: offer.songs }, () => null);
    this.query = '';
    const panel = el('div', 'panel career-panel setlist-panel');
    const head = el('header', 'screen-head');
    head.append(button(t('← Carrière'), { career: 'hub' }, 'action small'), el('h2', '', `Setlist · ${offer.venue.name}`));
    const cols = el('div', 'setlist-cols');
    const pick = el('section', 'setlist-pick');
    const search = el('input');
    search.type = 'search';
    search.placeholder = t('Chercher un morceau…');
    search.dataset.el = 'search';
    pick.append(search, el('div', 'pick-list'));
    const side = el('section', 'setlist-side');
    side.append(el('ol', 'setlist-slots'), el('p', 'setlist-warn'), button(t('Monter sur scène'), { career: 'go' }, 'action primary'));
    cols.append(pick, side);
    const missing = this.career ? gigLineUp(this.career, offer).missing : [];
    if (missing.length) side.prepend(el('p', 'gig-note', tn(missing.length, 'Coup dur : {names} manquera ce concert. Un remplaçant jouera.', 'Coup dur : {names} manqueront ce concert. Un remplaçant jouera.', { names: joined(missing.map((m) => m.name)) })));
    panel.append(
      head,
      el(
        'p',
        'help',
        t('{n} morceaux de ton répertoire, au moins {time} de musique, dans l’ordre où tu les joueras. Chaque changement d’accordage et chaque pause refroidissent la salle ; des morceaux plus denses, joués plus complets et en forme rapportent plus.', { n: offer.songs, time: formatTime(minSetlist(offer)) }),
      ),
      cols,
    );
    this.root.replaceChildren(panel);
    this.renderPicks();
    this.renderSlots();
  }

  private renderPicks(): void {
    const list = this.root.querySelector('.pick-list');
    if (!list) return;
    const words = fold(this.query).split(/\s+/).filter(Boolean);
    const chosen = new Set(this.setlist.filter(Boolean));
    const songs = this.known(this.career!).filter(({ song: s }) => words.every((w) => fold(`${s.title} ${s.artist} ${s.album ?? ''}`).includes(w)));
    list.replaceChildren(
      ...songs.map(({ song: s, rating: r, form }) => {
        const row = el('button', 'pick');
        row.type = 'button';
        row.dataset.career = 'add';
        row.dataset.song = s.id;
        row.disabled = chosen.has(s.id);
        row.append(coverElement(s.title, s.artist, this.hooks.coverUrl(s), 'pick-cover'));
        const text = el('span', 'pick-text');
        text.append(el('b', '', s.title), el('span', '', `${s.artist} · ${s.tuning} · ${formatTime(s.duration)}`));
        const score = el('span', 'pick-mastery');
        score.append(el('b', `song-rating small ${ratingTier(r)}`, String(r)), el('span', `form ${formClass(form)}`, formLabel(form)));
        row.append(text, score);
        return row;
      }),
    );
  }

  private renderSlots(): void {
    const slots = this.root.querySelector('.setlist-slots');
    if (!slots) return;
    const byId = new Map(this.hooks.songs().map((s) => [s.id, s]));
    slots.replaceChildren(
      ...this.setlist.map((id, i) => {
        const li = el('li', id ? 'slot' : 'slot empty');
        const song = id ? byId.get(id) : undefined;
        if (!song) {
          li.append(el('span', 'slot-name', t('Morceau {n} : choisis-le à gauche', { n: i + 1 })));
          return li;
        }
        const name = el('span', 'slot-name');
        name.append(el('b', '', song.title), el('span', '', ` · ${song.tuning}`));
        const tools = el('span', 'slot-tools');
        tools.append(button('↑', { career: 'up', slot: String(i) }, 'action small'), button('↓', { career: 'down', slot: String(i) }, 'action small'), button('×', { career: 'remove', slot: String(i) }, 'action small'));
        li.append(name, tools);
        return li;
      }),
    );
    const chosen = this.setlist.map((id) => (id ? byId.get(id) : undefined)).filter((s): s is SongEntry => !!s);
    const changes = this.career ? retunes(chosen.map((s) => s.tuning), guitarsOf(this.career)).filter(Boolean).length : tuningChanges(chosen);
    const total = chosen.reduce((sum, s) => sum + s.duration, 0);
    const warn = this.root.querySelector('.setlist-warn')!;
    const min = this.offer ? minSetlist(this.offer) : 0;
    const full = chosen.length === this.setlist.length;
    const short = full && total < min;
    warn.textContent = [
      chosen.length ? t('Durée {total} (minimum {min})', { total: formatTime(total), min: formatTime(min) }) : '',
      short ? t('trop court pour cette salle : prends des morceaux plus longs') : '',
      changes
        ? tn(changes, '{n} changement d’accordage : la salle refroidit pendant que tu t’accordes', '{n} changements d’accordage : la salle refroidit pendant que tu t’accordes')
        : tuningChanges(chosen)
          ? t('Les changements d’accordage passent par la deuxième guitare : la salle ne refroidit pas')
          : chosen.length > 1
            ? t('Même accordage du début à la fin')
            : '',
    ]
      .filter(Boolean)
      .join(' · ');
    (this.root.querySelector('[data-career="go"]') as HTMLButtonElement).disabled = !full || short;
  }

  private onClick(e: MouseEvent): void {
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-career]');
    if (!target) return;
    const career = this.career;
    const slot = Number(target.dataset.slot);
    switch (target.dataset.career) {
      case 'back':
        this.hooks.back();
        break;
      case 'hub':
        this.hooks.preview(null);
        if (career) this.showHub(career);
        break;
      case 'rest':
        this.hooks.rest();
        break;
      case 'rest-slot':
        this.hooks.restSlot();
        break;
      case 'rehearse':
        this.hooks.rehearseBand();
        break;
      case 'members':
        if (career) this.showMembers(career);
        break;
      case 'buy-gear':
      case 'hire': {
        const id = `${target.dataset.career}:${target.dataset.value}`;
        if (this.confirmBuy === id) {
          if (target.dataset.career === 'buy-gear') this.hooks.buyGear(target.dataset.value as GearId);
          else if (career) {
            const m = market(playingAct(career), weekIndex(career)).find((x) => x.role === target.dataset.value);
            if (m) this.hooks.hire(m);
          }
        } else {
          this.confirmBuy = id;
          target.textContent = t('Confirmer · {price}', { price: target.textContent?.split('·').pop()?.trim() ?? '' });
        }
        break;
      }
      case 'reset':
        if (!this.confirmReset) {
          this.confirmReset = true;
          target.textContent = t('Confirmer : tout recommencer ? (les guitares restent)');
          target.classList.add('danger');
        } else this.showDifficulty();
        break;
      case 'difficulty':
        this.showDifficulty();
        break;
      case 'level':
        this.hooks.reset(target.dataset.value as Difficulty);
        break;
      case 'studio':
        if (career) this.showStudio(career);
        break;
      case 'card':
        if (career) this.showCard(career);
        break;
      case 'scene':
        if (career) this.showScene(career);
        break;
      case 'business':
        if (career) this.showBusiness(career);
        break;
      case 'social':
        if (career) this.showSocial(career);
        break;
      case 'post':
        this.hooks.post(target.dataset.value as PostKind);
        break;
      case 'hire-comms':
      case 'fire-comms':
        this.hooks.comms(target.dataset.career === 'hire-comms');
        break;
      case 'train':
        if (target.dataset.value) this.hooks.train(target.dataset.value as SkillId);
        break;
      case 'moment':
        if (target.dataset.value) this.hooks.choose(target.dataset.value);
        break;
      case 'contract':
        if (target.dataset.value) this.hooks.sign(target.dataset.value as LabelId);
        break;
      case 'sponsor': {
        const deal = career && sponsorOffers(playingAct(career), career.season, career.week, career.fans, this.rank(career), career.followers)[Number(target.dataset.value)];
        if (deal) this.hooks.sponsor(deal);
        break;
      }
      case 'take':
        if (target.dataset.song) this.hooks.record(target.dataset.song);
        break;
      case 'release':
        this.hooks.release();
        break;
      case 'pick':
        if (career) this.showSetlist(offers(career)[Number(target.dataset.offer)]);
        break;
      case 'add': {
        const free = this.setlist.indexOf(null);
        if (free >= 0 && target.dataset.song) this.setlist[free] = target.dataset.song;
        this.renderPicks();
        this.renderSlots();
        break;
      }
      case 'remove':
        this.setlist.splice(slot, 1);
        this.setlist.push(null);
        this.renderPicks();
        this.renderSlots();
        break;
      case 'up':
      case 'down': {
        const to = target.dataset.career === 'up' ? slot - 1 : slot + 1;
        if (to >= 0 && to < this.setlist.length && this.setlist[to]) {
          [this.setlist[slot], this.setlist[to]] = [this.setlist[to], this.setlist[slot]];
          this.renderSlots();
        }
        break;
      }
      case 'go':
        if (this.offer && this.setlist.every(Boolean)) this.hooks.play(this.offer, this.setlist as string[]);
        break;
      case 'report-read':
        this.hooks.readReport();
        break;
      case 'shop':
        if (career) this.showShop(career);
        break;
      case 'buy': {
        const id = target.dataset.guitar ?? '';
        if (this.confirmBuy === id) this.hooks.buy(id);
        else if (career) {
          // One purchase awaiting confirmation at a time.
          this.showShop(career);
          this.confirmBuy = id;
          const again = this.root.querySelector<HTMLElement>(`[data-career="buy"][data-guitar="${id}"]`);
          if (again) again.textContent = t('Confirmer l’achat · {money}', { money: euros(guitarOf(id).price) });
        }
        break;
      }
      case 'equip':
        this.hooks.equip(target.dataset.guitar ?? '');
        break;
      case 'band':
        if (career) this.showBand(career);
        break;
      case 'band-emblem':
      case 'band-lettering':
      case 'band-palette': {
        const v = target.dataset.value ?? '';
        if (target.dataset.career === 'band-emblem') this.draft = { ...this.draft, emblem: v as Band['emblem'] };
        else if (target.dataset.career === 'band-lettering') this.draft = { ...this.draft, lettering: v as Band['lettering'] };
        else this.draft = { ...this.draft, palette: Number(v) };
        this.renderBand();
        break;
      }
      case 'band-save':
        if (this.draft.name.trim()) this.hooks.saveBand(this.draft);
        break;
      case 'album':
        if (career) this.showAlbum(career);
        break;
      case 'repertoire':
        if (career) this.showRepertoire(career);
        break;
      case 'learn':
        if (target.dataset.song) this.hooks.learn(target.dataset.song);
        break;
      case 'challenge': {
        const ch = career && weeklyChallenge(career, this.hooks.songs());
        if (ch) this.hooks.challenge(ch);
        break;
      }
      case 'poster':
        this.zoomPoster(Number(target.dataset.value));
        break;
      case 'unzoom':
        target.remove();
        break;
    }
  }
}
