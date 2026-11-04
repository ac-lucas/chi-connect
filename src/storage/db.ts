// On-device storage (IndexedDB via idb). Nothing in here is sent anywhere.
import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { importPrivateJwk } from '../connect/pairing';
import type { CatchUpItem, Connection, EnergySetting, FollowUp, Intro, Invite, Note, Profile, ScheduleItem } from '../model/types';

/** Typed key/value settings. Add new keys here. */
export interface Settings {
  energy: EnergySetting;
  persistRequested: boolean;
  demoSeeded: boolean;
  /** One-way connect codes we've shown recently. */
  intros: Intro[];
  /** Day 1 of the sample programme (local midnight), fixed the first time the app is opened. */
  sampleAnchor: number;
  /** Auto-break suggestions the person skipped (keys from planDay). */
  skippedBreaks: string[];
  /** The last programme downloaded from the feed, in the app's small shape. */
  programmeFeed: import('../programme/transform').FeedProgramme;
  /** When the feed was last asked about (so reloads don't poll faster than once a minute). */
  feedCheckedAt: number;
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
  keyStorage = null;
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

// One-way codes we've shown

let keyStorage: Promise<boolean> | null = null;

/**
 * Whether this browser can keep a CryptoKey in IndexedDB (expected in current browsers; verify per device).
 * Checked once by storing and reading back a throwaway key. If not, intro keys are saved as JWK instead.
 */
export function canStoreCryptoKeys(): Promise<boolean> {
  keyStorage ??= (async () => {
    try {
      const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
      const d = await db();
      await d.put('settings', kp.privateKey, 'keyProbe');
      const back = (await d.get('settings', 'keyProbe')) as CryptoKey | undefined;
      await d.delete('settings', 'keyProbe');
      return !!back && typeof back === 'object' && 'algorithm' in back && back.type === 'private';
    } catch {
      return false;
    }
  })();
  return keyStorage;
}

export async function getIntros(): Promise<Intro[]> {
  const saved = (await getSetting('intros')) ?? [];
  const out: Intro[] = [];
  for (const i of saved) {
    if (i.privateKey || !i.privateJwk) {
      out.push(i);
      continue;
    }
    try {
      out.push({ ...i, privateKey: await importPrivateJwk(i.privateJwk) });
    } catch {
      // A damaged key can't open requests: leave this intro out.
    }
  }
  return out;
}

export async function saveIntros(intros: Intro[]): Promise<void> {
  // An intro with a JWK copy is stored without its CryptoKey, so saving works where keys can't be stored.
  await setSetting(
    'intros',
    intros.map((i) => (i.privateJwk ? { ...i, privateKey: undefined } : i)),
  );
}

/** Add the demo connections once. Removing them later is respected: they are not re-added. */
export async function seedDemoOnce(now = Date.now()): Promise<void> {
  if (await getSetting('demoSeeded')) return;
  const { DEMO_CONNECTIONS, DEMO_NOTES } = await import('../data/demo');
  const tx = (await db()).transaction(['connections', 'notes', 'settings'], 'readwrite');
  for (const c of DEMO_CONNECTIONS) await tx.objectStore('connections').put({ ...c, connectedAt: now });
  for (const n of DEMO_NOTES) await tx.objectStore('notes').put({ ...n, createdAt: now });
  await tx.objectStore('settings').put(true, 'demoSeeded');
  await tx.done;
}

/** Day 1 of the sample programme: today, the first time this is asked, and the same day after that. */
export async function getSampleAnchor(now = Date.now()): Promise<number> {
  const saved = await getSetting('sampleAnchor');
  if (saved) return saved;
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  await setSetting('sampleAnchor', d.getTime());
  return d.getTime();
}

export async function listAllSchedule(): Promise<ScheduleItem[]> {
  return (await db()).getAllFromIndex('schedule', 'byStart');
}

/** Drop saved sessions from the sample programme once a real programme is in use. */
export async function removeSampleSessions(): Promise<number> {
  const d = await db();
  const stale = (await d.getAll('schedule')).filter((s) => s.programmeSessionId?.startsWith('sample-'));
  for (const s of stale) await d.delete('schedule', s.id);
  return stale.length;
}

export async function skipBreak(key: string): Promise<void> {
  const list = (await getSetting('skippedBreaks')) ?? [];
  if (!list.includes(key)) await setSetting('skippedBreaks', [...list, key].slice(-500));
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
