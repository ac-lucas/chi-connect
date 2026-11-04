import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createProfile, emptyDraft } from '../model/profile';
import type { Connection } from '../model/types';
import {
  getConnection,
  getProfile,
  getSetting,
  listConnections,
  listNotes,
  listSchedule,
  putConnection,
  putNote,
  putScheduleItem,
  removeConnection,
  resetDatabaseForTests,
  saveProfile,
  getIntros,
  saveIntros,
  seedDemoOnce,
  setSetting,
} from './db';

let n = 0;
beforeEach(async () => {
  await resetDatabaseForTests(`test-${n++}`);
});

const conn = (id: string): Connection => ({
  id,
  profile: { displayName: id },
  state: 'connected',
  scheduleSharing: false,
  sharedSessionIds: [],
  demo: false,
  via: 'face-to-face',
});

describe('storage', () => {
  it('starts with no profile, then saves and reloads one', async () => {
    expect(await getProfile()).toBeNull();
    const p = createProfile({ ...emptyDraft(), displayName: 'Ana' });
    await saveProfile(p);
    expect(await getProfile()).toEqual(p);
  });

  it("keeps an intro's private key usable but unreadable after a reload", async () => {
    const { newIntro } = await import('../relay/protocol');
    const intro = await newIntro();
    await saveIntros([intro]);
    const [back] = await getIntros();
    expect(back?.privateKey?.extractable).toBe(false);
    expect(back?.publicKey).toBe(intro.publicKey);
    await expect(crypto.subtle.exportKey('jwk', back!.privateKey!)).rejects.toThrow();
  });

  it('stores typed settings', async () => {
    expect(await getSetting('energy')).toBeUndefined();
    await setSetting('energy', { level: 'charged', setAt: 1 });
    expect(await getSetting('energy')).toEqual({ level: 'charged', setAt: 1 });
  });

  it('removing a connection deletes their notes and leaves others alone', async () => {
    await putConnection(conn('a'));
    await putConnection(conn('b'));
    await putNote({ id: 'n1', connectionId: 'a', text: 'met at lunch', chips: [], createdAt: 1 });
    await putNote({ id: 'n2', connectionId: 'b', text: 'haptics', chips: [], createdAt: 1 });
    await removeConnection('a');
    expect(await getConnection('a')).toBeNull();
    expect(await listNotes('a')).toEqual([]);
    expect((await listNotes('b')).map((x) => x.id)).toEqual(['n2']);
    expect((await listConnections()).map((c) => c.id)).toEqual(['b']);
  });

  it('lists schedule items in a time range', async () => {
    const base = { type: 'session' as const, title: 't', source: 'user' as const };
    await putScheduleItem({ ...base, id: 's1', start: 100, end: 200 });
    await putScheduleItem({ ...base, id: 's2', start: 300, end: 400 });
    expect((await listSchedule(0, 250)).map((s) => s.id)).toEqual(['s1']);
  });

  it('seeds demo connections once and respects removal', async () => {
    await seedDemoOnce();
    const demos = await listConnections();
    expect(demos.length).toBeGreaterThan(0);
    expect(demos.every((c) => c.demo && c.via === 'demo')).toBe(true);
    await removeConnection(demos[0]!.id);
    await seedDemoOnce();
    expect(await listConnections()).toHaveLength(demos.length - 1);
  });
});
