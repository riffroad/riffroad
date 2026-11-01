import { invoke } from '@tauri-apps/api/core';
import { cloudError } from './account';
import { ACTS } from './career/career';
import { lang, t, tn } from './i18n';
import type { LiveEvent } from './events';
import { attackLevel, type AttackDifficulty } from './score-attack';

/**
 * The weekly challenge, the same for every player: a song shipped with the game (never one
 * someone imported) at a Score Attack level, a new one each Monday, and its board online. The
 * server (cloud/api) works out the same week from the same lists. Without an account it is
 * played all the same, just off the board.
 */

/** cloud/api's SHIPPED and CHALLENGE_LEVELS: the same lists, in the same order. */
export const SHIPPED = [
  'Shane Ivers - Hard Sell Hotel/song_chart.json',
  'Shane Ivers - Apple For The Preacher/song_chart.json',
  'Shane Ivers - Wave Rider/song_chart.json',
  'OpenSmith - First Riff/song_chart.json',
  'Shane Ivers - Later Alligator/song_chart.json',
];
export const CHALLENGE_LEVELS: AttackDifficulty[] = ['medium', 'hard', 'easy'];

export interface Challenge {
  week: number;
  song: string;
  level: AttackDifficulty;
}

export interface Entry {
  rank: number;
  name: string;
  score: number;
  accuracy: number;
  me: boolean;
}

/** What friends see of a career (cloud/api Card). */
export interface Card {
  band: string;
  act: number;
  fans: number;
  week: number;
  weekFans: number;
}

export interface Friend {
  code: string;
  name: string | null;
  card: Card | null;
}

export interface Friends {
  code: string;
  me: Card | null;
  friends: Friend[];
}

/** The battle of the bands: the player and their friends, the most fans won this week first. */
export function battle(f: Friends, week: number, myName: string): { name: string; band: string; act: number; weekFans: number; code: string | null }[] {
  const row = (name: string, card: Card | null, code: string | null) => ({
    name,
    band: card?.band ?? '',
    act: card?.act ?? 1,
    weekFans: card && card.week === week ? card.weekFans : 0,
    code,
  });
  return [row(myName, f.me, null), ...f.friends.map((x) => row(x.name ?? x.code, x.card, x.code))].sort((a, b) => b.weekFans - a.weekFans);
}

export interface Board {
  challenge: Challenge;
  /** When the week ends (Unix seconds). */
  ends: number;
  players: number;
  top: Entry[];
  me: Entry | null;
}

/** Weeks run from Monday 00:00 UTC, numbered from the one of 5 January 1970. */
export const weekOf = (unixSeconds: number): number => Math.floor((Math.floor(unixSeconds / 86_400) - 4) / 7);
export const weekStart = (week: number): number => (week * 7 + 4) * 86_400;
const mod = (a: number, n: number) => ((a % n) + n) % n;

/** The challenge of week `week`; an event starting with that week may pick another (cloud/api). */
export function challengeOf(week: number, events: readonly LiveEvent[] = []): Challenge {
  const pick = events.find((e) => e.starts === weekStart(week))?.challenge;
  if (pick) return { week, song: pick.song, level: pick.level };
  const n = SHIPPED.length;
  return { week, song: SHIPPED[mod(week, n)], level: CHALLENGE_LEVELS[mod(Math.floor(week / n), CHALLENGE_LEVELS.length)] };
}

export const thisWeek = (events: readonly LiveEvent[] = []): Challenge => challengeOf(weekOf(Date.now() / 1000), events);

export interface WorldHooks {
  /** The events known (one may pick the week's song). */
  events(): readonly LiveEvent[];
  /** The song in this Mac's library, if it is there. */
  song(id: string): { title: string; artist: string } | null;
  cover(id: string): HTMLElement | null;
  signedIn(): Promise<boolean>;
  play(challenge: Challenge): void;
  /** Settings → Account. */
  account(): void;
}

const numbers = () => (lang() === 'en' ? 'en-US' : 'fr-FR');
const points = (n: number) => n.toLocaleString(numbers());

/** The board a run reached, in a line for the results screen. */
export function runLine(board: Board): string {
  const me = board.me;
  if (!me) return '';
  return t('Défi mondial : {score} points, {rank} sur {players}.', { score: points(me.score), rank: rankLabel(me.rank), players: board.players });
}

const rankLabel = (n: number): string => (lang() === 'en' ? `#${n}` : n === 1 ? '1er' : `${n}e`);

/** Days and hours left, roughly. */
function left(ends: number): string {
  const s = Math.max(0, ends - Date.now() / 1000);
  const days = Math.floor(s / 86_400);
  return days >= 1 ? tn(days, 'encore {n} jour', 'encore {n} jours') : tn(Math.ceil(s / 3600), 'encore {n} heure', 'encore {n} heures');
}

export class WorldScreen {
  private challenge: Challenge = thisWeek();
  private name: string | null = null;
  private signedIn = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly hooks: WorldHooks,
  ) {
    root.addEventListener('click', (e) => {
      const button = (e.target as HTMLElement).closest<HTMLElement>('[data-world]');
      const action = button?.dataset.world;
      if (action === 'play') this.play();
      else if (action === 'name') void this.chooseName();
      else if (action === 'account') this.hooks.account();
      else if (action === 'add-friend') void this.friendsCall('cloud_add_friend', this.el<HTMLInputElement>('friend')?.value ?? '');
      else if (action === 'remove-friend' && button?.dataset.code) void this.friendsCall('cloud_remove_friend', button.dataset.code);
      else if (action === 'copy-code') void navigator.clipboard?.writeText(button?.dataset.code ?? '').then(() => this.say(t('Code copié : envoie-le à tes amis.')));
    });
  }

  private el<T extends HTMLElement>(name: string): T | null {
    return this.root.querySelector<T>(`[data-el="${name}"]`);
  }

  async show(): Promise<void> {
    this.challenge = thisWeek(this.hooks.events());
    const song = this.hooks.song(this.challenge.song);
    this.root.innerHTML = `
      <div class="panel world-panel">
        <header class="screen-head">
          <button class="action small" type="button" data-action="menu">${t('← Menu')}</button>
          <h2>${t('Défi mondial')}</h2>
          <span class="world-left" data-el="left"></span>
        </header>
        <p class="help">${t('Un morceau du jeu par semaine, le même pour tout le monde, en Score Attack. Ta meilleure partie de la semaine compte ; le classement repart à zéro chaque lundi.')}</p>
        <section class="world-song">
          <div class="world-art" data-el="art"></div>
          <div class="world-what">
            <b data-el="title"></b>
            <span data-el="level"></span>
            <button class="action primary" data-world="play">${t('Jouer le défi')}</button>
          </div>
        </section>
        <section class="world-board" data-el="board"><p class="help">${t('Chargement…')}</p></section>
        <section class="world-friends" data-el="friends"></section>
        <p class="status" data-el="message"></p>
      </div>`;
    this.el('title')!.textContent = song ? `${song.title} · ${song.artist}` : t('Morceau absent de ta bibliothèque');
    this.el('level')!.textContent = t('Score Attack · {level}', { level: attackLevel(this.challenge.level).label });
    const art = this.hooks.cover(this.challenge.song);
    if (art) this.el('art')!.append(art);
    this.root.querySelector<HTMLButtonElement>('[data-world="play"]')!.disabled = !song;
    this.el('left')!.textContent = left(weekStart(this.challenge.week + 1));
    await this.refresh();
  }

  /** The board, or why there is none. */
  private async refresh(): Promise<void> {
    const box = this.el('board');
    if (!box) return;
    this.signedIn = await this.hooks.signedIn();
    if (!this.signedIn) {
      box.innerHTML = `<p class="help">${t('Le classement est en ligne : connecte-toi pour y entrer.')}</p>
        <button class="action small" data-world="account">${t('Réglages → Compte')}</button>`;
      return;
    }
    try {
      const [board, profile] = await Promise.all([invoke<Board>('cloud_board'), invoke<{ name: string | null }>('cloud_profile')]);
      this.name = profile.name;
      // The server's week rules (an event this Mac has not heard of yet).
      if (board.challenge.song !== this.challenge.song || board.challenge.level !== this.challenge.level) {
        this.challenge = board.challenge;
        return this.show();
      }
      this.drawBoard(box, board);
      void this.friendsCall('cloud_friends');
    } catch (e) {
      box.innerHTML = `<p class="help"></p>`;
      box.querySelector('p')!.textContent = cloudError(e);
    }
  }

  private drawBoard(box: HTMLElement, board: Board): void {
    box.replaceChildren();
    const who = document.createElement('div');
    who.className = 'world-name';
    who.innerHTML = `<label>${t('Ton pseudo')} <input data-el="name" maxlength="20" /></label>
      <button class="action small" data-world="name">${this.name ? t('Changer') : t('Choisir')}</button>`;
    box.append(who);
    this.el<HTMLInputElement>('name')!.value = this.name ?? '';
    const head = document.createElement('h3');
    head.textContent = tn(board.players, '{n} joueur cette semaine', '{n} joueurs cette semaine');
    box.append(head);
    if (!board.top.length) {
      const empty = document.createElement('p');
      empty.className = 'help';
      empty.textContent = t('Personne encore : la première place est à prendre.');
      box.append(empty);
      return;
    }
    const list = document.createElement('ol');
    list.className = 'world-top';
    const rows = [...board.top];
    if (board.me && !rows.some((e) => e.me)) rows.push(board.me);
    for (const e of rows) {
      const li = document.createElement('li');
      li.classList.toggle('me', e.me);
      const rank = document.createElement('b');
      rank.textContent = String(e.rank);
      const name = document.createElement('span');
      name.textContent = e.name;
      const score = document.createElement('span');
      score.className = 'world-score';
      score.textContent = `${points(e.score)} · ${Math.round(e.accuracy * 100)} %`;
      li.append(rank, name, score);
      list.append(li);
    }
    box.append(list);
  }

  /** The friends, after `command` (a code added or removed, or just read). */
  private async friendsCall(command: string, code?: string): Promise<void> {
    const box = this.el('friends');
    if (!box) return;
    try {
      const friends = await invoke<Friends>(command, code === undefined ? {} : { code });
      this.drawFriends(box, friends);
      if (command === 'cloud_add_friend') this.say(t('Ami ajouté.'));
    } catch (e) {
      const why = String(e);
      this.say(
        why === 'server-404' ? t('Aucun joueur avec ce code.') : why === 'server-400' ? t('C’est ton propre code.') : why === 'server-409' ? t('50 amis au plus.') : cloudError(e),
        true,
      );
    }
  }

  private drawFriends(box: HTMLElement, f: Friends): void {
    const week = weekOf(Date.now() / 1000);
    box.innerHTML = `
      <h3>${t('Bataille des groupes')}</h3>
      <p class="help">${t('Tes amis et toi, classés par fans gagnés cette semaine en carrière. Donne ton code, ajoute le leur.')}</p>
      <div class="world-name">
        <span>${t('Ton code ami')} <b data-el="code"></b></span>
        <button class="action small" data-world="copy-code">${t('Copier')}</button>
      </div>
      <div class="world-name">
        <input data-el="friend" maxlength="6" placeholder="${t('Code d’un ami')}" />
        <button class="action small" data-world="add-friend">${t('Ajouter')}</button>
      </div>`;
    this.el('code')!.textContent = f.code;
    this.root.querySelector<HTMLElement>('[data-world="copy-code"]')!.dataset.code = f.code;
    const list = document.createElement('ol');
    list.className = 'world-top';
    battle(f, week, this.name ?? t('toi')).forEach((r, i) => {
      const li = document.createElement('li');
      li.classList.toggle('me', r.code === null);
      const rank = document.createElement('b');
      rank.textContent = String(i + 1);
      const who = document.createElement('span');
      who.textContent = r.band ? `${r.band} · ${r.name} · ${ACTS[r.act]?.name ?? ''}` : r.name;
      const fans = document.createElement('span');
      fans.className = 'world-score';
      fans.textContent = tn(r.weekFans, '+{n} fan', '+{n} fans');
      li.append(rank, who, fans);
      if (r.code) {
        const remove = document.createElement('button');
        remove.className = 'action small';
        remove.dataset.world = 'remove-friend';
        remove.dataset.code = r.code;
        remove.title = t('Retirer cet ami');
        remove.textContent = '✕';
        li.append(remove);
      }
      list.append(li);
    });
    box.append(list);
  }

  private say(text: string, error = false): void {
    const line = this.el('message');
    if (!line) return;
    line.textContent = text;
    line.classList.toggle('error', error);
  }

  private async chooseName(): Promise<void> {
    const name = (this.el<HTMLInputElement>('name')?.value ?? '').trim();
    try {
      this.name = (await invoke<{ name: string | null }>('cloud_set_name', { name })).name;
      this.say(t('Pseudo enregistré.'));
      await this.refresh();
    } catch (e) {
      this.say(String(e) === 'server-400' ? t('2 à 20 lettres, chiffres, espaces ou - _ . ’') : cloudError(e), true);
    }
  }

  private play(): void {
    // On the board, a run needs a name: asked before, not lost after.
    if (this.signedIn && !this.name) {
      this.say(t('Choisis d’abord un pseudo pour le classement.'), true);
      this.el<HTMLInputElement>('name')?.focus();
      return;
    }
    this.hooks.play(this.challenge);
  }

  /** A run of the challenge ended: sent to the board, a line for the results screen. */
  async submit(challenge: Challenge, score: number, accuracy: number, failed: boolean, trace: readonly number[] = []): Promise<string> {
    if (failed) return t('Défi mondial : partie ratée, rien d’envoyé au classement.');
    if (!(await this.hooks.signedIn())) return t('Défi mondial : connecte-toi (Réglages → Compte) pour entrer au classement.');
    try {
      const board = await invoke<Board>('cloud_submit', { run: { ...challenge, score, accuracy, trace } });
      return runLine(board);
    } catch (e) {
      return String(e) === 'server-400' ? t('Défi mondial : la semaine a changé, ce score ne compte plus.') : cloudError(e);
    }
  }
}
