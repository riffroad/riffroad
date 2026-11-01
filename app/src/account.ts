/**
 * Settings → Account (desktop app, once the online service exists): sign in by e-mail, the saves
 * synced, sign out, the account deleted. And the question asked when a save changed both on this
 * Mac and on another one.
 */

import { invoke } from '@tauri-apps/api/core';
import { SLOTS, type Choice, type CloudApi, type CloudStatus, type OldSave, type OnlineSave, type Slot } from './cloud';
import { lang, t } from './i18n';

/** The desktop app's side (src-tauri/src/cloud.rs). */
export const tauriCloud: CloudApi & { check(): Promise<CloudStatus> } = {
  status: () => invoke<CloudStatus>('cloud_status'),
  check: () => invoke<CloudStatus>('cloud_check'),
  pull: (slot) => invoke<OnlineSave | null>('cloud_pull', { slot }),
  push: (slot, data, baseVersion) => invoke('cloud_push', { slot, data, baseVersion }),
  history: (slot) => invoke<OldSave[]>('cloud_history', { slot }),
  restore: (slot, version) => invoke<OnlineSave>('cloud_restore', { slot, version }),
};

/** A refusal from the desktop app, in words. */
export function cloudError(code: unknown): string {
  switch (String(code)) {
    case 'email-exists':
      return t('Un compte existe déjà avec cet e-mail : connecte-toi.');
    case 'invalid-credentials':
      return t('E-mail ou mot de passe incorrect.');
    case 'weak-password':
      return t('Choisis un mot de passe d’au moins 6 caractères.');
    case 'invalid-email':
      return t('Cette adresse e-mail n’est pas valide.');
    case 'too-many-attempts':
      return t('Trop d’essais : réessaie dans quelques minutes.');
    case 'network':
      return t('Pas de réponse du serveur : vérifie ta connexion Internet.');
    case 'signed-out':
      return t('Ta session a expiré : reconnecte-toi.');
    case 'too-many-requests':
      return t('Trop de synchronisations d’un coup : réessaie dans une minute.');
    case 'too-large':
      return t('Sauvegarde trop grosse pour être envoyée.');
    case 'cancelled':
      return t('Connexion avec Google annulée.');
    case 'account-exists':
      return t('Un compte avec mot de passe existe déjà pour cet e-mail : connecte-toi avec lui.');
    case 'unverified':
      return t('Confirme ton e-mail (le lien reçu) pour envoyer tes sauvegardes.');
    default:
      return t('Le service en ligne ne répond pas pour l’instant.');
  }
}

const when = (iso: string): string =>
  new Date(iso).toLocaleString(lang() === 'en' ? 'en-US' : 'fr-FR', { dateStyle: 'medium', timeStyle: 'short' });

/** Which save to keep, asked over everything (the menu waits for the answer). */
export function askWhichSave(slot: Slot, online: OnlineSave): Promise<Choice> {
  return new Promise((resolve) => {
    const box = document.createElement('div');
    box.className = 'cloud-ask';
    box.innerHTML = `
      <div class="panel" role="dialog" aria-modal="true">
        <h3>${slot === 'career' ? t('Ta carrière a avancé sur un autre Mac') : t('Ta progression a avancé sur un autre Mac')}</h3>
        <p>${t('Elle a aussi changé sur ce Mac depuis la dernière synchronisation. Celle en ligne date du {date}. Laquelle garder ? L’autre sera remplacée.', { date: when(online.updatedAt) })}</p>
        <div class="row-actions">
          <button class="action primary" data-choice="local">${t('Garder celle de ce Mac')}</button>
          <button class="action" data-choice="online">${t('Prendre celle en ligne')}</button>
        </div>
      </div>`;
    box.addEventListener('click', (e) => {
      const choice = (e.target as HTMLElement).closest<HTMLElement>('[data-choice]')?.dataset.choice;
      if (choice !== 'local' && choice !== 'online') return;
      box.remove();
      resolve(choice);
    });
    document.body.append(box);
  });
}

/** Google's "G", for its sign-in button (Google's branding guidelines). */
const GOOGLE_G = `<svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>`;

/** The account's round picture: Google's photo, else the first letter of the name or e-mail. */
export function avatar(status: CloudStatus, className = 'avatar'): HTMLElement {
  const box = document.createElement('span');
  box.className = className;
  const letter = (status.name || status.email || '?').trim().charAt(0).toUpperCase();
  box.textContent = status.email ? letter : '';
  if (!status.email) box.classList.add('signed-out');
  if (status.photo) {
    const img = document.createElement('img');
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.src = status.photo;
    img.onload = () => box.replaceChildren(img);
  }
  return box;
}

/** The account button at the top right of the menus: the player's picture, or a sign-in. */
export class AccountChip {
  private readonly el: HTMLButtonElement;

  constructor(open: () => void) {
    this.el = document.createElement('button');
    this.el.type = 'button';
    this.el.className = 'account-chip';
    this.el.hidden = true;
    this.el.addEventListener('click', open);
    document.body.append(this.el);
  }

  /** Shown in the menus, once there is an online service; the HUD makes room for it. */
  show(on: boolean, status: CloudStatus | null): void {
    const visible = on && !!status?.available;
    this.el.hidden = !visible;
    document.body.classList.toggle('with-account-chip', visible);
    if (!visible || !status) return;
    this.el.title = status.email ? t('Compte : {who}', { who: status.name || status.email }) : t('Se connecter');
    this.el.replaceChildren(avatar(status));
  }
}

export interface AccountHooks {
  /** A full sync now (after signing in, or asked): its outcome in words. */
  sync(): Promise<string>;
  /** Signed out or deleted: this Mac forgets what it synced. */
  signedOut(): void;
  /** An old save put back (the page then reloads). */
  restore(slot: Slot, version: number): Promise<void>;
  /** Signed in, out, or the account deleted: the status now (the account button follows). */
  changed(status: CloudStatus): void;
}

export class AccountPanel {
  private status: CloudStatus = { available: false, email: null, verified: null };
  private confirmDelete = 0;
  /** The old save asked to go back to, until a second click confirms it. */
  private confirmRestore = { key: '', at: 0 };

  constructor(
    private readonly root: HTMLElement,
    private readonly hooks: AccountHooks,
  ) {
    root.addEventListener('click', (e) => {
      const button = (e.target as HTMLElement).closest<HTMLElement>('[data-account]');
      if (button?.dataset.account) {
        e.preventDefault();
        void this.act(button.dataset.account, button);
      }
    });
  }

  async open(): Promise<void> {
    this.status = await tauriCloud.status().catch(() => ({ available: false, email: null, verified: null }));
    // Signed in: whether the e-mail is confirmed by now.
    if (this.status.email && this.status.verified !== true) this.status = await tauriCloud.check().catch(() => this.status);
    this.render();
    this.hooks.changed(this.status);
  }

  private el<T extends HTMLElement>(name: string): T {
    return this.root.querySelector<T>(`[data-el="${name}"]`)!;
  }

  private say(text: string, error = false): void {
    const line = this.el('message');
    line.textContent = text;
    line.classList.toggle('error', error);
  }

  private render(): void {
    const intro = t('Ta carrière et ta progression, sur tous tes Mac. Les réglages (latence, entrée audio, accordage) restent sur chaque Mac.');
    if (!this.status.email) {
      this.root.innerHTML = `
        <section class="account">
          <h3>${t('Ton compte Riffroad')}</h3>
          <p class="help">${intro}</p>
          ${this.status.google ? `<button class="google-button" data-account="google">${GOOGLE_G}<span>${t('Continuer avec Google')}</span></button><p class="help or">${t('ou avec un e-mail')}</p>` : ''}
          <label class="row">${t('E-mail')} <input type="email" data-el="email" autocomplete="email" /></label>
          <label class="row">${t('Mot de passe')} <input type="password" data-el="password" autocomplete="current-password" /></label>
          <div class="row-actions">
            <button class="action primary small" data-account="sign-in">${t('Se connecter')}</button>
            <button class="action small" data-account="create">${t('Créer un compte')}</button>
            <button class="action small" data-account="reset">${t('Mot de passe oublié')}</button>
          </div>
          <p class="status" data-el="message"></p>
        </section>`;
      return;
    }
    const confirm =
      this.status.verified === false
        ? `<div class="cloud-verify">
            <p>${t('Confirme ton adresse : un lien vient de partir à {email}. Tes sauvegardes partent en ligne dès que c’est fait.', { email: '<b data-el="to"></b>' })}</p>
            <div class="row-actions">
              <button class="action primary small" data-account="check">${t('J’ai confirmé')}</button>
              <button class="action small" data-account="resend">${t('Renvoyer l’e-mail')}</button>
            </div>
          </div>`
        : '';
    this.root.innerHTML = `
      <section class="account">
        <h3>${t('Ton compte Riffroad')}</h3>
        ${confirm}
        <p class="account-who"><span data-el="avatar"></span>${t('Connecté :')} <b data-el="who"></b></p>
        <p class="help">${intro} ${t('Sur un autre Mac, connecte-toi avec le même compte.')}</p>
        <div class="row-actions">
          <button class="action primary small" data-account="sync">${t('Synchroniser maintenant')}</button>
          <button class="action small" data-account="sign-out">${t('Se déconnecter')}</button>
        </div>
        <p class="status" data-el="message"></p>
      </section>
      <section class="account">
        <h3>${t('Revenir en arrière')}</h3>
        <p class="help">${t('Les cinq sauvegardes d’avant, en ligne : un mauvais choix se rattrape. Celle d’aujourd’hui rejoint la liste.')}</p>
        <div data-el="history"><p class="help">${t('Chargement…')}</p></div>
      </section>
      <section class="account">
        <h3>${t('Supprimer le compte')}</h3>
        <p class="help">${t('Tes sauvegardes en ligne et ton compte sont effacés ; celles de ce Mac restent.')}</p>
        <button class="action small danger" data-account="delete">${t('Supprimer mon compte')}</button>
      </section>`;
    this.el('who').textContent = this.status.name ? `${this.status.name} (${this.status.email})` : this.status.email;
    this.el('avatar').replaceWith(avatar(this.status, 'avatar large'));
    this.el('to')?.replaceChildren(this.status.email ?? '');
    void this.showHistory();
  }

  /** Each slot's old saves, newest first, each one a button to go back to it. */
  private async showHistory(): Promise<void> {
    const box = this.el('history');
    const label: Record<Slot, string> = { career: t('Carrière'), progress: t('Progression') };
    try {
      const lists = await Promise.all(SLOTS.map(async (slot) => [slot, await tauriCloud.history(slot)] as const));
      const rows = lists.flatMap(([slot, olds]) =>
        olds.map((old) => {
          const b = document.createElement('button');
          b.className = 'action small';
          b.dataset.account = 'restore';
          b.dataset.slot = slot;
          b.dataset.version = String(old.version);
          b.textContent = `${label[slot]} · ${when(old.updatedAt)}`;
          return b;
        }),
      );
      box.replaceChildren(...(rows.length ? rows : [Object.assign(document.createElement('p'), { className: 'help', textContent: t('Rien encore : elles arrivent avec les prochaines sauvegardes.') })]));
      box.className = 'cloud-versions';
    } catch (e) {
      box.textContent = cloudError(e);
    }
  }

  private async act(action: string, target: HTMLElement): Promise<void> {
    const email = this.el<HTMLInputElement>('email')?.value ?? '';
    const password = this.el<HTMLInputElement>('password')?.value ?? '';
    try {
      if (action === 'google') {
        this.say(t('Connexion avec Google dans ton navigateur…'));
        this.status = await invoke<CloudStatus>('cloud_sign_in_google', { lang: lang() });
        this.render();
        this.hooks.changed(this.status);
        this.say(await this.hooks.sync());
      } else if (action === 'sign-in' || action === 'create') {
        this.say(t('Connexion…'));
        this.status = await invoke<CloudStatus>('cloud_sign_in', { email, password, create: action === 'create', lang: lang() });
        this.render();
        this.hooks.changed(this.status);
        this.say(this.status.verified === false ? t('Compte créé : confirme ton e-mail pour envoyer tes sauvegardes.') : await this.hooks.sync());
      } else if (action === 'check') {
        this.status = await tauriCloud.check();
        this.render();
        this.say(this.status.verified ? await this.hooks.sync() : t('Pas encore confirmé : ouvre le lien de l’e-mail, puis réessaie.'), !this.status.verified);
      } else if (action === 'resend') {
        await invoke('cloud_send_verification', { lang: lang() });
        this.say(t('E-mail renvoyé.'));
      } else if (action === 'reset') {
        await invoke('cloud_reset_password', { email, lang: lang() });
        this.say(t('Un e-mail pour choisir un nouveau mot de passe est parti.'));
      } else if (action === 'sync') {
        this.say(t('Synchronisation…'));
        this.say(await this.hooks.sync());
      } else if (action === 'sign-out') {
        await invoke('cloud_sign_out');
        this.hooks.signedOut();
        await this.open();
      } else if (action === 'restore') {
        const button = target as HTMLElement;
        const slot = button.dataset.slot as Slot;
        const version = Number(button.dataset.version);
        // A second click within five seconds confirms.
        const key = `${slot}:${version}`;
        if (this.confirmRestore.key !== key || Date.now() - this.confirmRestore.at > 5000) {
          this.confirmRestore = { key, at: Date.now() };
          button.textContent = t('Confirmer : revenir à celle-ci');
          return;
        }
        this.say(t('Retour à cette sauvegarde…'));
        await this.hooks.restore(slot, version);
      } else if (action === 'delete') {
        // A second click within five seconds confirms.
        if (Date.now() - this.confirmDelete > 5000) {
          this.confirmDelete = Date.now();
          this.root.querySelector<HTMLElement>('[data-account="delete"]')!.textContent = t('Confirmer la suppression');
          return;
        }
        await invoke('cloud_delete_account');
        this.hooks.signedOut();
        await this.open();
        this.say(t('Compte supprimé.'));
      }
    } catch (e) {
      this.say(cloudError(e), true);
    }
  }
}
