/**
 * The saves kept online (desktop app, signed in): the career and the progress go up when they
 * change and come down on another Mac. Each slot remembers the version it last synced and what
 * the save on this Mac was then, so that a change on both sides is never settled silently: the
 * player chooses which to keep.
 *
 * Saves come down only from the menu, the page reloaded right after (nothing in memory can then
 * write an older save over them).
 */

export type Slot = 'career' | 'progress';

export const SLOTS: Slot[] = ['career', 'progress'];

/** A part of a save, where this Mac keeps it (browser storage, or a file of the desktop app). */
export interface Part {
  read(): Promise<unknown>;
  write(value: unknown): Promise<void>;
}

/** Each slot's parts, by name (the career: `opensmith.career`; the progress: the scores and the
 * lessons). */
export type Parts = Record<Slot, Record<string, Part>>;

type Store = Pick<Storage, 'getItem' | 'setItem'>;

/** A part kept in browser storage under `key`, as JSON. */
export function storagePart(store: Store, key: string): Part {
  return {
    read: async () => {
      const raw = store.getItem(key);
      if (raw === null) return undefined;
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        // A value that is not JSON stays on this Mac.
        return undefined;
      }
    },
    write: async (value) => store.setItem(key, JSON.stringify(value)),
  };
}

/** Nothing worth syncing: absent, null, or an empty object or list (a Mac that never played). */
const empty = (v: unknown): boolean => v === undefined || v === null || (typeof v === 'object' && Object.keys(v).length === 0);

const META = 'opensmith.cloud';

export interface CloudStatus {
  available: boolean;
  email: string | null;
  /** Whether the e-mail is confirmed (saves go up only then); null until asked. */
  verified: boolean | null;
  /** The player's picture and name, from Google. */
  photo?: string | null;
  name?: string | null;
  /** Whether signing in with Google is offered. */
  google?: boolean;
}

export interface OnlineSave {
  version: number;
  updatedAt: string;
  data: unknown;
}

export type Pushed = { kind: 'saved' | 'conflict'; version: number; updatedAt: string };

/** A save kept before the current one, to go back to. */
export interface OldSave {
  version: number;
  updatedAt: string;
}

/** What the desktop app does online (src-tauri/src/cloud.rs). */
export interface CloudApi {
  status(): Promise<CloudStatus>;
  pull(slot: Slot): Promise<OnlineSave | null>;
  push(slot: Slot, data: unknown, baseVersion: number): Promise<Pushed>;
  /** The saves kept before the current one, newest first. */
  history(slot: Slot): Promise<OldSave[]>;
  /** An old save put back online as the current one: the save now online. */
  restore(slot: Slot, version: number): Promise<OnlineSave>;
}

/** Which save to keep when both changed. */
export type Choice = 'local' | 'online';

/** Per slot: the version last synced, and the fingerprint of this Mac's save then. */
type Meta = Partial<Record<Slot, { version: number; hash: string }>>;

export interface SyncResult {
  /** Saves that came down (the page must reload). */
  pulled: Slot[];
  pushed: Slot[];
  /** A save changed on both sides, left for the menu to settle. */
  conflict: boolean;
}

/** FNV-1a of a text, as hex. */
export function fingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16);
}

export class CloudSync {
  constructor(
    private readonly api: CloudApi,
    /** Where the sync state is kept (browser storage). */
    private readonly store: Store,
    private readonly parts: Parts,
    /** Asks the player which save to keep (online: when it was saved). */
    private readonly choose: (slot: Slot, online: OnlineSave) => Promise<Choice>,
  ) {}

  private meta(): Meta {
    try {
      return (JSON.parse(this.store.getItem(META) ?? '{}') as Meta) ?? {};
    } catch {
      return {};
    }
  }

  private remember(slot: Slot, version: number, local: string): void {
    this.store.setItem(META, JSON.stringify({ ...this.meta(), [slot]: { version, hash: fingerprint(local) } }));
  }

  /** This Mac's save in `slot`: its parts' values, null when it has none. */
  async local(slot: Slot): Promise<Record<string, unknown> | null> {
    const out: Record<string, unknown> = {};
    for (const [name, part] of Object.entries(this.parts[slot])) {
      const value = await part.read();
      if (!empty(value)) out[name] = value;
    }
    return Object.keys(out).length ? out : null;
  }

  private async write(slot: Slot, data: unknown): Promise<void> {
    if (!data || typeof data !== 'object') return;
    for (const [name, part] of Object.entries(this.parts[slot])) {
      const value = (data as Record<string, unknown>)[name];
      if (value !== undefined) await part.write(value);
    }
  }

  /** Whether the save on this Mac changed since it last synced. */
  async changed(slot: Slot): Promise<boolean> {
    const local = await this.local(slot);
    return local !== null && fingerprint(JSON.stringify(local)) !== (this.meta()[slot]?.hash ?? '');
  }

  /** Every slot synced: `pull` (from the menu only) also brings down what another Mac saved;
   * without it, only this Mac's changes go up. */
  async sync(pull: boolean): Promise<SyncResult> {
    const result: SyncResult = { pulled: [], pushed: [], conflict: false };
    for (const slot of SLOTS) {
      const known = this.meta()[slot] ?? { version: 0, hash: '' };
      const local = await this.local(slot);
      const text = local ? JSON.stringify(local) : '';
      const changed = local !== null && fingerprint(text) !== known.hash;
      if (pull) {
        const online = await this.api.pull(slot);
        if (online && online.version > known.version) {
          if (!changed || (await this.choose(slot, online)) === 'online') {
            await this.write(slot, online.data);
            this.remember(slot, online.version, JSON.stringify(await this.local(slot)));
            result.pulled.push(slot);
            continue;
          }
          // This Mac's save kept: it goes over the one online.
          const r = await this.api.push(slot, local, online.version);
          if (r.kind === 'saved') {
            this.remember(slot, r.version, text);
            result.pushed.push(slot);
          } else result.conflict = true;
          continue;
        }
      }
      if (!changed) continue;
      const r = await this.api.push(slot, local, known.version);
      if (r.kind === 'saved') {
        this.remember(slot, r.version, text);
        result.pushed.push(slot);
      } else result.conflict = true;
    }
    return result;
  }

  /** An old save of `slot` back on this Mac and online. This Mac's own changes go up first, so
   * that they join the history too: going back loses nothing. The page must reload. */
  async restore(slot: Slot, version: number): Promise<void> {
    await this.sync(false);
    const save = await this.api.restore(slot, version);
    await this.write(slot, save.data);
    this.remember(slot, save.version, JSON.stringify(await this.local(slot)));
  }

  /** Signed out or the account deleted: the next account starts from this Mac's saves. */
  forget(): void {
    this.store.setItem(META, '{}');
  }
}
