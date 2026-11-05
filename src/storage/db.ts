// On-device storage (IndexedDB via idb). Nothing in here is sent anywhere.
import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { importPrivateJwk } from '../connect/pairing';
// Bundled, not loaded on demand: a separately loaded file can go missing right after an update.
import { DEMO_CONNECTIONS, DEMO_NOTES } from '../data/demo';
import type { CatchUpItem, Connection, EnergySetting, FollowUp, Intro, Invite, Note, Profile, ScheduleItem } from '../model/types';

/** Typed key/value settings. Add new keys here. */
export interface Settings {
  energy: EnergySetting;
  persistRequested: boolean;
  demoSeeded: boolean;
  demoScheduleSeeded: boolean;
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
  /** A revision that was downloaded but couldn't be used (not downloaded again). */
  feedUnusable: { edition: string; revision: number };
  /** F18: no nudges or suggestions at all. */
  quietMode: boolean;
  /** F18: nudges snoozed until this time. */
  snoozeUntil: number;
  /** Suggestion cards dismissed, by key (wildcard:<day>, talk:<session>, nudge:<session>). Kept short. */
  dismissed: string[];
  /** Nudges shown per day, for the daily cap: { day key: count }. */
  nudgeCounts: Record<string, number>;
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

/** Set while everything is being deleted: nothing may open the database again until the page reloads. */
let wiping = false;

function db(): Promise<IDBPDatabase<PebbleSchema>> {
  if (wiping) return Promise.reject(new Error('wiping'));
  if (dbPromise) return dbPromise;
  const opening: Promise<IDBPDatabase<PebbleSchema>> = openDB<PebbleSchema>(dbName, VERSION, {
    // Step through versions, so a later VERSION bump adds to an existing database instead of failing.
    upgrade(d, oldVersion) {
      if (oldVersion >= 1) return;
      d.createObjectStore('profile');
      d.createObjectStore('settings');
      d.createObjectStore('connections', { keyPath: 'id' }).createIndex('byState', 'state');
      d.createObjectStore('notes', { keyPath: 'id' }).createIndex('byConnection', 'connectionId');
      d.createObjectStore('followUps', { keyPath: 'id' }).createIndex('byConnection', 'connectionId');
      d.createObjectStore('schedule', { keyPath: 'id' }).createIndex('byStart', 'start');
      d.createObjectStore('invites', { keyPath: 'id' });
      d.createObjectStore('catchUp', { keyPath: 'programmeSessionId' });
    },
    // Another tab (or a wipe) needs the database: close THIS connection, and open afresh on next use.
    blocking() {
      void opening.then((d) => d.close());
      if (dbPromise === opening) dbPromise = null;
    },
    // The browser closed this connection (it can, under storage pressure): open again on next use.
    terminated() {
      if (dbPromise === opening) dbPromise = null;
    },
  });
  dbPromise = opening;
  // A failed open isn't cached: the next call tries again.
  opening.catch(() => {
    if (dbPromise === opening) dbPromise = null;
  });
  return opening;
}

/** Tests only: switch to a fresh database name. */
export async function resetDatabaseForTests(name: string): Promise<void> {
  if (dbPromise) (await dbPromise).close();
  dbPromise = null;
  keyStorage = null;
  wiping = false;
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
/**
 * Change some fields of a connection, reading the current record inside the same transaction. Use this rather
 * than putConnection({ ...copy }): a copy held by a screen can be stale and would write over newer fields.
 */
export async function updateConnection(id: string, patch: Partial<Connection> | ((c: Connection) => Partial<Connection>)): Promise<Connection | null> {
  const tx = (await db()).transaction('connections', 'readwrite');
  const current = await tx.store.get(id);
  if (!current) {
    await tx.done;
    return null;
  }
  const next = { ...current, ...(typeof patch === 'function' ? patch(current) : patch), id };
  await tx.store.put(next);
  await tx.done;
  return next;
}

/**
 * Remove a connection and everything kept about them on this device: notes, follow-ups, invites from them (and
 * the meetups in your day that came from those), and their place in invites you sent.
 */
export async function removeConnection(id: string): Promise<void> {
  const tx = (await db()).transaction(['connections', 'notes', 'followUps', 'invites', 'schedule'], 'readwrite');
  await tx.objectStore('connections').delete(id);
  for (const store of ['notes', 'followUps'] as const) {
    const s = tx.objectStore(store);
    for (const key of await s.index('byConnection').getAllKeys(id)) await s.delete(key);
  }
  const invites = tx.objectStore('invites');
  const schedule = tx.objectStore('schedule');
  for (const inv of await invites.getAll()) {
    const fromThem = !inv.outgoing && inv.fromConnectionId === id;
    const toThem = inv.outgoing && inv.recipientIds.includes(id);
    if (!fromThem && !toThem) continue;
    const recipientIds = inv.recipientIds.filter((r) => r !== id);
    if (fromThem || recipientIds.length === 0) {
      await invites.delete(inv.id);
      await schedule.delete(`inv-${inv.id}`);
    } else {
      await invites.put({ ...inv, recipientIds, acceptedIds: inv.acceptedIds.filter((r) => r !== id) });
    }
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

export async function listAllNotes(): Promise<Note[]> {
  return (await db()).getAll('notes');
}
export async function deleteNote(id: string): Promise<void> {
  await (await db()).delete('notes', id);
}

// Follow-ups (F09)
export async function listFollowUps(connectionId?: string): Promise<FollowUp[]> {
  const d = await db();
  const all = connectionId ? await d.getAllFromIndex('followUps', 'byConnection', connectionId) : await d.getAll('followUps');
  return all.sort((a, b) => Number(a.done) - Number(b.done) || (a.due ?? Infinity) - (b.due ?? Infinity));
}
export async function putFollowUp(f: FollowUp): Promise<void> {
  await (await db()).put('followUps', f);
}
export async function deleteFollowUp(id: string): Promise<void> {
  await (await db()).delete('followUps', id);
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

/**
 * Drop intros whose time is up (their private keys go with them). Judged on the stored record, where a key may
 * be held as a CryptoKey or, on browsers that can't store one, as JWK. One transaction, so a code being made at
 * the same moment can't be lost.
 */
export async function pruneIntros(keepUntil: (i: Intro) => number, now = Date.now()): Promise<void> {
  await updateSetting('intros', (saved = []) => {
    const kept = saved.filter((i) => !!i.publicKey && (!!i.privateKey || !!i.privateJwk) && keepUntil(i) > now);
    return kept.length === saved.length ? saved : kept; // nothing expired: no write
  });
}

export async function saveIntros(intros: Intro[]): Promise<void> {
  // An intro with a JWK copy is stored without its CryptoKey, so saving works where keys can't be stored.
  await setSetting(
    'intros',
    intros.map((i) => (i.privateJwk ? { ...i, privateKey: undefined } : i)),
  );
}

/** Put the ready-made demo schedule in place, once ever. Removing any of it sticks. */
export async function seedDemoScheduleOnce(items: ScheduleItem[]): Promise<boolean> {
  if (!items.length) return false;
  const tx = (await db()).transaction(['settings', 'schedule'], 'readwrite');
  if (await tx.objectStore('settings').get('demoScheduleSeeded')) {
    await tx.done;
    return false;
  }
  for (const item of items) await tx.objectStore('schedule').put(item);
  await tx.objectStore('settings').put(true, 'demoScheduleSeeded');
  await tx.done;
  return true;
}

/** Add the demo connections once. Removing them later is respected: they are not re-added. */
export async function seedDemoOnce(now = Date.now()): Promise<void> {
  if (await getSetting('demoSeeded')) return;
  const tx = (await db()).transaction(['connections', 'notes', 'settings'], 'readwrite');
  for (const c of DEMO_CONNECTIONS) await tx.objectStore('connections').put({ ...c, connectedAt: now });
  for (const n of DEMO_NOTES) await tx.objectStore('notes').put({ ...n, createdAt: now });
  await tx.objectStore('settings').put(true, 'demoSeeded');
  await tx.done;
}

// Catch up later (F23)
export async function listCatchUp(): Promise<CatchUpItem[]> {
  return (await (await db()).getAll('catchUp')).sort((a, b) => a.start - b.start);
}
export async function putCatchUp(c: CatchUpItem): Promise<void> {
  await (await db()).put('catchUp', c);
}
export async function deleteCatchUp(programmeSessionId: string): Promise<void> {
  await (await db()).delete('catchUp', programmeSessionId);
}

/** Read and change one setting inside a single transaction, so two quick changes can't lose one of them. */
async function updateSetting<K extends keyof Settings>(key: K, fn: (current: Settings[K] | undefined) => Settings[K]): Promise<void> {
  const tx = (await db()).transaction('settings', 'readwrite');
  const current = (await tx.store.get(key)) as Settings[K] | undefined;
  const next = fn(current);
  if (next !== current) await tx.store.put(next, key); // returning the same value means "no change": no write
  await tx.done;
}

/** Remember a dismissed suggestion. */
export async function dismiss(key: string): Promise<void> {
  await updateSetting('dismissed', (list) => (list?.includes(key) ? list : [...(list ?? []), key].slice(-300)));
}

// Invites
export async function listInvites(): Promise<Invite[]> {
  return (await db()).getAll('invites');
}
export async function getInvite(id: string): Promise<Invite | null> {
  return (await (await db()).get('invites', id)) ?? null;
}
export async function putInvite(i: Invite): Promise<void> {
  await (await db()).put('invites', i);
}
export async function deleteInvite(id: string): Promise<void> {
  await (await db()).delete('invites', id);
}
/** The schedule entry for an invite we sent or accepted, if any. */
/** The day a preview programme starts on (its first day is moved here). */
export async function getPreviewAnchor(now = Date.now()): Promise<number> {
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
/**
 * Keep saved sessions in step with the programme: a session that moved, changed room or was renamed is updated
 * in your day. Returns how many changed.
 */
export async function syncSavedSessions(sessions: { id: string; start: number; end: number; title: string; room?: string }[]): Promise<number> {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const tx = (await db()).transaction('schedule', 'readwrite');
  let changed = 0;
  for (const item of await tx.store.getAll()) {
    if (item.type !== 'session' || !item.programmeSessionId) continue;
    const s = byId.get(item.programmeSessionId);
    if (!s) continue;
    if (s.start !== item.start || s.end !== item.end || s.title !== item.title || s.room !== item.place) {
      await tx.store.put({ ...item, start: s.start, end: s.end, title: s.title, place: s.room });
      changed++;
    }
  }
  await tx.done;
  return changed;
}

/** Remove sessions saved from a programme that has been replaced by another edition (their IDs mean nothing now). */
export async function removeProgrammeSessions(): Promise<number> {
  const tx = (await db()).transaction('schedule', 'readwrite');
  let n = 0;
  for (const item of await tx.store.getAll()) {
    if (item.type === 'session' && item.programmeSessionId) {
      await tx.store.delete(item.id);
      n++;
    }
  }
  await tx.done;
  return n;
}

export async function skipBreak(key: string): Promise<void> {
  await updateSetting('skippedBreaks', (list) => (list?.includes(key) ? list : [...(list ?? []), key].slice(-500)));
}

/**
 * Delete everything this app keeps on this device. Other open tabs are asked to let go first (see `blocking`);
 * if one still holds on, this gives up after a few seconds rather than waiting forever.
 */
export async function wipeEverything(): Promise<void> {
  if (dbPromise) {
    try {
      (await dbPromise).close();
    } catch {
      // never opened: nothing to close
    }
  }
  dbPromise = null;
  keyStorage = null;
  wiping = true; // syncs or refreshes still running can't reopen it and write data back
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('blocked')), 5000);
    deleteDB(dbName, { blocked: () => {} }).then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  }).catch((e) => {
    wiping = false; // didn't work: let the app carry on
    throw e;
  });
  try {
    sessionStorage.clear();
  } catch {
    // storage blocked: nothing kept there anyway
  }
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
