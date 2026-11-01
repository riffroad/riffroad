/**
 * Settings → Account (desktop app, once the online service exists): sign in by e-mail, the saves
 * synced, sign out, the account deleted. And the question asked when a save changed both on this
 * Mac and on another one.
 */

import { invoke } from '@tauri-apps/api/core';
import type { Choice, CloudApi, CloudStatus, OnlineSave, Slot } from './cloud';
import { lang, t } from './i18n';

/** The desktop app's side (src-tauri/src/cloud.rs). */
export const tauriCloud: CloudApi = {
  status: () => invoke<CloudStatus>('cloud_status'),
  pull: (slot) => invoke<OnlineSave | null>('cloud_pull', { slot }),
  push: (slot, data, baseVersion) => invoke('cloud_push', { slot, data, baseVersion }),
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

export interface AccountHooks {
  /** A full sync now (after signing in, or asked): its outcome in words. */
  sync(): Promise<string>;
  /** Signed out or deleted: this Mac forgets what it synced. */
  signedOut(): void;
}

export class AccountPanel {
  private status: CloudStatus = { available: false, email: null };
  private confirmDelete = 0;

  constructor(
    private readonly root: HTMLElement,
    private readonly hooks: AccountHooks,
  ) {
    root.addEventListener('click', (e) => {
      const action = (e.target as HTMLElement).closest<HTMLElement>('[data-account]')?.dataset.account;
      if (action) {
        e.preventDefault();
        void this.act(action);
      }
    });
  }

  async open(): Promise<void> {
    this.status = await tauriCloud.status().catch(() => ({ available: false, email: null }));
    this.render();
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
          <h3>${t('Ton compte OpenSmith')}</h3>
          <p class="help">${intro}</p>
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
    this.root.innerHTML = `
      <section class="account">
        <h3>${t('Ton compte OpenSmith')}</h3>
        <p>${t('Connecté :')} <b data-el="who"></b></p>
        <p class="help">${intro} ${t('Sur un autre Mac, connecte-toi avec le même compte.')}</p>
        <div class="row-actions">
          <button class="action primary small" data-account="sync">${t('Synchroniser maintenant')}</button>
          <button class="action small" data-account="sign-out">${t('Se déconnecter')}</button>
        </div>
        <p class="status" data-el="message"></p>
      </section>
      <section class="account">
        <h3>${t('Supprimer le compte')}</h3>
        <p class="help">${t('Tes sauvegardes en ligne et ton compte sont effacés ; celles de ce Mac restent.')}</p>
        <button class="action small danger" data-account="delete">${t('Supprimer mon compte')}</button>
      </section>`;
    this.el('who').textContent = this.status.email;
  }

  private async act(action: string): Promise<void> {
    const email = this.el<HTMLInputElement>('email')?.value ?? '';
    const password = this.el<HTMLInputElement>('password')?.value ?? '';
    try {
      if (action === 'sign-in' || action === 'create') {
        this.say(t('Connexion…'));
        this.status = await invoke<CloudStatus>('cloud_sign_in', { email, password, create: action === 'create' });
        this.render();
        this.say(await this.hooks.sync());
      } else if (action === 'reset') {
        await invoke('cloud_reset_password', { email });
        this.say(t('Un e-mail pour choisir un nouveau mot de passe est parti.'));
      } else if (action === 'sync') {
        this.say(t('Synchronisation…'));
        this.say(await this.hooks.sync());
      } else if (action === 'sign-out') {
        await invoke('cloud_sign_out');
        this.hooks.signedOut();
        await this.open();
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
