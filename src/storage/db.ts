// On-device storage (IndexedDB via idb). Nothing in here is sent anywhere.
import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { CatchUpItem, Connection, EnergySetting, FollowUp, Invite, Note, Profile, ScheduleItem } from '../model/types';

/** Typed key/value settings. Add new keys here. */
export interface Settings {
  energy: EnergySetting;
  persistRequested: boolean;
}

interface PebbleSchema extends DBSchema {
  profile: { key: 'me'; value: Profile };
  settings: { key: string; value: unknown };
  connections: { key: string; value: Connection; indexes: { byState: string } };
  notes: { key: string; value: Note; indexes: { byConnection: string } };
  followUps: { key: string; value: FollowUp; indexes: { byConnection: string } };
  schedule: { key: string; value: ScheduleItem; indexes: { byStart: number } };
  invites: { key: string; value: Invite };
  catchUp: { key: string; value: CatchUpItem };
}

const VERSION = 1;
let dbName = 'pebble';
let dbPromise: Promise<IDBPDatabase<PebbleSchema>> | null = null;

function db(): Promise<IDBPDatabase<PebbleSchema>> {
  dbPromise ??= openDB<PebbleSchema>(dbName, VERSION, {
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
  return dbPromise;
}

/** Tests only: switch to a fresh database name. */
export async function resetDatabaseForTests(name: string): Promise<void> {
  if (dbPromise) (await dbPromise).close();
  dbPromise = null;
  dbName = name;
  await deleteDB(name);
}

// Profile
export async function getProfile(): Promise<Profile | null> {
  return (await (await db()).get('profile', 'me')) ?? null;
}
export async function saveProfile(p: Profile): Promise<void> {
  await (await db()).put('profile', p, 'me');
}

// Settings
export async function getSetting<K extends keyof Settings>(key: K): Promise<Settings[K] | undefined> {
  return (await (await db()).get('settings', key)) as Settings[K] | undefined;
}
export async function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void> {
  await (await db()).put('settings', value, key);
}

// Connections
export async function listConnections(): Promise<Connection[]> {
  return (await db()).getAll('connections');
}
export async function getConnection(id: string): Promise<Connection | null> {
  return (await (await db()).get('connections', id)) ?? null;
}
export async function putConnection(c: Connection): Promise<void> {
  await (await db()).put('connections', c);
}
/** Remove a connection and everything kept about them on this device. */
export async function removeConnection(id: string): Promise<void> {
  const tx = (await db()).transaction(['connections', 'notes', 'followUps'], 'readwrite');
  await tx.objectStore('connections').delete(id);
  for (const store of ['notes', 'followUps'] as const) {
    const s = tx.objectStore(store);
    for (const key of await s.index('byConnection').getAllKeys(id)) await s.delete(key);
  }
  await tx.done;
}

// Notes
export async function listNotes(connectionId: string): Promise<Note[]> {
  return (await db()).getAllFromIndex('notes', 'byConnection', connectionId);
}
export async function putNote(n: Note): Promise<void> {
  await (await db()).put('notes', n);
}

// Schedule
export async function listSchedule(from: number, to: number): Promise<ScheduleItem[]> {
  return (await db()).getAllFromIndex('schedule', 'byStart', IDBKeyRange.bound(from, to, false, true));
}
export async function putScheduleItem(item: ScheduleItem): Promise<void> {
  await (await db()).put('schedule', item);
}
export async function deleteScheduleItem(id: string): Promise<void> {
  await (await db()).delete('schedule', id);
}

/** Delete everything this app keeps on this device. */
export async function wipeEverything(): Promise<void> {
  if (dbPromise) (await dbPromise).close();
  dbPromise = null;
  await deleteDB(dbName);
}

/**
 * Ask the browser to keep our data when storage runs low. Support and behaviour differ by browser (verify);
 * the answer is not shown to anyone, and refusal is fine.
 */
export async function requestPersistentStorage(): Promise<void> {
  try {
    if ((await getSetting('persistRequested')) || !navigator.storage?.persist) return;
    await navigator.storage.persist();
    await setSetting('persistRequested', true);
  } catch {
    // Not available here. Data still saves, it just may be cleared under storage pressure.
  }
}
