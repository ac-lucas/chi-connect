import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { describe, expect, it } from 'vitest';
import { getConnection, getInvite, getProfile, getSetting, listAllSchedule, listCatchUp, resetDatabaseForTests } from './db';

describe('storage upgrade from version 1', () => {
  it('moves British spellings in stored data to US ones without losing anything', async () => {
    const name = `upgrade-${Date.now()}`;
    await resetDatabaseForTests(name);
    // A version 1 database, exactly as the first release made it, with a few records in it.
    const old = await openDB(name, 1, {
      upgrade(d) {
        d.createObjectStore('profile');
        d.createObjectStore('settings');
        d.createObjectStore('connections', { keyPath: 'id' }).createIndex('byState', 'state');
        d.createObjectStore('notes', { keyPath: 'id' }).createIndex('byConnection', 'connectionId');
        d.createObjectStore('followUps', { keyPath: 'id' }).createIndex('byConnection', 'connectionId');
        d.createObjectStore('schedule', { keyPath: 'id' }).createIndex('byStart', 'start');
        d.createObjectStore('invites', { keyPath: 'id' });
        d.createObjectStore('catchUp', { keyPath: 'programmeSessionId' });
      },
    });
    const ageing = [{ key: 'ageing', label: 'Ageing' }, { key: 'haptics', label: 'Haptics' }];
    await old.put('profile', { displayName: 'Ana', role: '', company: '', links: [], tags: ageing, share: {} }, 'me');
    await old.put('connections', { id: 'c1', profile: { displayName: 'Sam', tags: ageing }, state: 'connected', scheduleSharing: false, sharedSessionIds: [], via: 'face-to-face' });
    await old.put('schedule', { id: 's1', type: 'session', source: 'user', programmeSessionId: 'p1', start: 1, end: 2, title: 'A talk' });
    await old.put('invites', {
      id: 'i1',
      senderName: 'Ana',
      outgoing: true,
      kind: 'sit-together',
      start: 1,
      end: 2,
      programmeSessionId: 'p1',
      meetingSpot: { row: 'back', side: 'centre' },
      createdAt: 1,
      expiresAt: 1,
      recipientIds: [],
      acceptedIds: [],
      status: 'cancelled',
    });
    await old.put('catchUp', { programmeSessionId: 'p1', title: 'A talk', start: 1, reason: 'clash', addedAt: 1 });
    await old.put('settings', { name: 'Cached program', sessions: [], edition: 'x', revision: 3 }, 'programmeFeed');
    old.close();

    // Opening through the app upgrades it.
    const me = await getProfile();
    expect(me?.tags).toEqual([{ key: 'aging', label: 'Aging' }, { key: 'haptics', label: 'Haptics' }]);
    expect((await getConnection('c1'))?.profile.tags?.[0]).toEqual({ key: 'aging', label: 'Aging' });

    const [item] = await listAllSchedule();
    expect(item?.programSessionId).toBe('p1');
    expect(item).not.toHaveProperty('programmeSessionId');

    const inv = await getInvite('i1');
    expect(inv?.status).toBe('canceled');
    expect(inv?.meetingSpot).toEqual({ row: 'back', side: 'center' });
    expect(inv?.programSessionId).toBe('p1');

    expect(await listCatchUp()).toEqual([{ programSessionId: 'p1', title: 'A talk', start: 1, reason: 'clash', addedAt: 1 }]);
    expect((await getSetting('programFeed'))?.name).toBe('Cached program');
  });
});
