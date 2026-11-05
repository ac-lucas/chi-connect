import 'fake-indexeddb/auto';
import { newHome, splitAddress } from '../relay/address';
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
  canStoreCryptoKeys,
  getIntros,
  pruneIntros,
  saveIntros,
  seedDemoOnce,
  setSetting,
  updateConnection,
  wipeEverything,
  putInvite,
  getInvite,
  listAllSchedule,
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
    const intro = await newIntro(await newHome());
    await saveIntros([intro]);
    const [back] = await getIntros();
    expect(back?.privateKey?.extractable).toBe(false);
    expect(back?.publicKey).toBe(intro.publicKey);
    await expect(crypto.subtle.exportKey('jwk', back!.privateKey!)).rejects.toThrow();
  });

  it('pruning keeps JWK-backed intros that are still in time, and drops expired ones', async () => {
    const { newIntro } = await import('../relay/protocol');
    const live = await newIntro(await newHome(), Date.now(), { exportable: true });
    const old = await newIntro(await newHome(), Date.now() - 100 * 3_600_000, { exportable: true });
    await saveIntros([live, old]);
    await pruneIntros((i) => i.expiresAt + 48 * 3_600_000);
    expect((await getIntros()).map((i) => i.nonce)).toEqual([live.nonce]);
  });

  it('makes the device home once and keeps it', async () => {
    const { getHome } = await import('./db');
    const [a, b] = await Promise.all([getHome(), getHome()]); // two at once (two tabs): still one home
    expect(a).toEqual(b);
    expect(await getHome()).toEqual(a);
    expect(a.id).toBe(await (await import('../relay/crypto')).homeIdFor(a.token));
  });

  it('detects that keys can be stored here', async () => {
    expect(await canStoreCryptoKeys()).toBe(true);
  });

  it("falls back to JWK where keys can't be stored, and the reloaded key still opens requests", async () => {
    const { newIntro, introPayload, sendRequest, openHello } = await import('../relay/protocol');
    const { SimulatedTransport } = await import('../relay/transport');
    const home = await newHome();
    const intro = await newIntro(home, Date.now(), { exportable: true });
    await saveIntros([intro]);
    // What was written holds no CryptoKey, only the JWK.
    const raw = (await getSetting('intros'))!;
    expect(raw[0]!.privateKey).toBeUndefined();
    expect(raw[0]!.privateJwk?.d).toBeTruthy();
    const [back] = await getIntros();
    expect(back!.privateKey!.extractable).toBe(false);
    const relay = new SimulatedTransport();
    const box = splitAddress(intro.mailboxId).box;
    await relay.register(home, [box]);
    await sendRequest(relay, await newHome(), introPayload({ displayName: 'Ana' }, intro), { displayName: 'Sam' });
    const [msg] = (await relay.sync(home, { keep: [box], ack: [] })).messages[box]!;
    expect((await openHello(back!, msg!.ct))?.profile.displayName).toBe('Sam');
  });

  it('updateConnection changes only the given fields of the stored record', async () => {
    await putConnection({ ...conn('a'), sharedSessionIds: ['s1'] });
    const stale = (await getConnection('a'))!;
    await updateConnection('a', { sharedSessionIds: ['s1', 's2'] }); // something newer arrives
    await updateConnection(stale.id, { scheduleSharing: true }); // a screen toggles from its old copy
    const now = (await getConnection('a'))!;
    expect(now.sharedSessionIds).toEqual(['s1', 's2']);
    expect(now.scheduleSharing).toBe(true);
    expect(await updateConnection('missing', { scheduleSharing: true })).toBeNull();
  });

  it('removing a person also removes their invites, the meetups from them, and them from invites I sent', async () => {
    await putConnection(conn('a'));
    await putConnection(conn('b'));
    const base = { kind: 'meal' as const, start: 1, end: 2, createdAt: 1, expiresAt: 1, acceptedIds: [], status: 'accepted' as const, senderName: 'x' };
    await putInvite({ ...base, id: 'fromA', outgoing: false, fromConnectionId: 'a', recipientIds: [], meetingSpot: { row: 'front' } });
    await putInvite({ ...base, id: 'toA', outgoing: true, recipientIds: ['a'], acceptedIds: [] });
    await putInvite({ ...base, id: 'toAB', outgoing: true, recipientIds: ['a', 'b'], acceptedIds: ['a', 'b'] });
    await putScheduleItem({ id: 'inv-fromA', type: 'invite', source: 'invite', title: 'Lunch with a', start: 1, end: 2, inviteId: 'fromA' });
    await removeConnection('a');
    expect(await getInvite('fromA')).toBeNull();
    expect(await getInvite('toA')).toBeNull();
    expect((await getInvite('toAB'))!.recipientIds).toEqual(['b']);
    expect((await getInvite('toAB'))!.acceptedIds).toEqual(['b']);
    expect((await listAllSchedule()).map((i) => i.id)).not.toContain('inv-fromA');
  });

  it('wipes everything, even with another connection open, and starts empty afterwards', async () => {
    await saveProfile(createProfile({ ...emptyDraft(), displayName: 'Ana' }));
    await putConnection(conn('a'));
    // A second "tab": the open database is asked to let go rather than blocking the delete.
    const before = (await indexedDB.databases()).length;
    await wipeEverything();
    expect((await indexedDB.databases()).length).toBe(before - 1); // the whole database is gone
    // Until the page reloads, nothing (a sync still running, say) can reopen it and write data back.
    await expect(putConnection(conn('late'))).rejects.toThrow('wiping');
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
