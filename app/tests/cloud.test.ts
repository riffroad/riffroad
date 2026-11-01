import { describe, expect, it } from 'vitest';
import { CloudSync, storagePart, type Choice, type CloudApi, type OnlineSave, type Slot } from '../src/cloud';

/** The server's rule (cloud/server): a save written only over the version it was based on. */
class Server {
  saves = new Map<Slot, OnlineSave>();
  api(): CloudApi {
    return {
      status: async () => ({ available: true, email: 'me@example.com' }),
      pull: async (slot) => structuredClone(this.saves.get(slot) ?? null),
      push: async (slot, data, baseVersion) => {
        const now = this.saves.get(slot);
        if (now && now.version !== baseVersion) return { kind: 'conflict', version: now.version, updatedAt: now.updatedAt };
        const next = { version: (now?.version ?? 0) + 1, updatedAt: `t${(now?.version ?? 0) + 1}`, data: structuredClone(data) };
        this.saves.set(slot, next);
        return { kind: 'saved', version: next.version, updatedAt: next.updatedAt };
      },
    };
  }
}

class Mac {
  store = new Map<string, string>();
  asked: Slot[] = [];
  answer: Choice = 'online';
  sync: CloudSync;
  constructor(server: Server) {
    const storage = { getItem: (k: string) => this.store.get(k) ?? null, setItem: (k: string, v: string) => void this.store.set(k, v) };
    const parts = {
      career: { 'opensmith.career': storagePart(storage, 'opensmith.career') },
      progress: { 'opensmith.progress': storagePart(storage, 'opensmith.progress'), 'opensmith.lessons': storagePart(storage, 'opensmith.lessons') },
    };
    this.sync = new CloudSync(server.api(), storage, parts, async (slot) => {
      this.asked.push(slot);
      return this.answer;
    });
  }
  career(act: number): void {
    this.store.set('opensmith.career', JSON.stringify({ act }));
  }
  act(): number | undefined {
    return (JSON.parse(this.store.get('opensmith.career') ?? 'null') as { act: number } | null)?.act;
  }
}

describe('saves kept online', () => {
  it('sends a save up once, and brings it down on another Mac', async () => {
    const server = new Server();
    const a = new Mac(server);
    a.career(2);
    a.store.set('opensmith.lessons', JSON.stringify({ done: ['intro'] }));
    expect(await a.sync.sync(true)).toEqual({ pulled: [], pushed: ['career', 'progress'], conflict: false });
    expect(await a.sync.sync(true)).toEqual({ pulled: [], pushed: [], conflict: false });

    const b = new Mac(server);
    expect((await b.sync.sync(true)).pulled).toEqual(['career', 'progress']);
    expect(b.act()).toBe(2);
    expect(b.store.get('opensmith.lessons')).toBe(JSON.stringify({ done: ['intro'] }));
    expect(b.asked).toEqual([]);
  });

  it('goes on from where the other Mac left off, without asking', async () => {
    const server = new Server();
    const a = new Mac(server);
    const b = new Mac(server);
    a.career(1);
    await a.sync.sync(true);
    await b.sync.sync(true);
    b.career(3);
    await b.sync.sync(false);
    expect((await a.sync.sync(true)).pulled).toEqual(['career']);
    expect(a.act()).toBe(3);
    expect(a.asked).toEqual([]);
  });

  it('asks which to keep when both Macs played, and keeps that one', async () => {
    const server = new Server();
    const a = new Mac(server);
    const b = new Mac(server);
    a.career(1);
    await a.sync.sync(true);
    await b.sync.sync(true);
    a.career(4);
    b.career(5);
    await b.sync.sync(false);
    // Without the menu, nothing is overwritten: the conflict waits.
    expect(await a.sync.sync(false)).toEqual({ pulled: [], pushed: [], conflict: true });
    expect(server.saves.get('career')!.data).toEqual({ 'opensmith.career': { act: 5 } });

    a.answer = 'local';
    expect(await a.sync.sync(true)).toEqual({ pulled: [], pushed: ['career'], conflict: false });
    expect(a.asked).toEqual(['career']);
    expect(server.saves.get('career')!.data).toEqual({ 'opensmith.career': { act: 4 } });

    b.career(6);
    b.answer = 'online';
    expect((await b.sync.sync(true)).pulled).toEqual(['career']);
    expect(b.act()).toBe(4);
  });

  it('starts a new account from this Mac once signed out', async () => {
    const server = new Server();
    const a = new Mac(server);
    a.career(2);
    await a.sync.sync(true);
    a.sync.forget();
    expect(await a.sync.changed('career')).toBe(true);
    expect(await a.sync.changed('progress')).toBe(false);
  });

  it('takes a Mac that never played for an empty one, not a save to keep', async () => {
    const server = new Server();
    const a = new Mac(server);
    a.store.set('opensmith.progress', JSON.stringify({ songs: { x: { best: 0.9 } } }));
    await a.sync.sync(true);
    const fresh = new Mac(server);
    fresh.store.set('opensmith.progress', '{}');
    expect((await fresh.sync.sync(true)).pulled).toEqual(['progress']);
    expect(fresh.asked).toEqual([]);
  });
});
