// One-way connecting through the relay (F01 QR, F02 six-digit code, F03 link).
//
//  A shows a code: an "intro" with a fresh nonce and its own mailbox.
//  B reads it, sees A's profile and taps "Send request":
//    B makes a nonce and a mailbox for this connection, and sends a "hello" to A's intro mailbox,
//    encrypted with a key from A's nonce (only people who read A's code have it). B is now "pending-sent".
//  A's phone finds the hello, opens it, and shows a request (pending-received). Nothing is sent back yet.
//  If A approves: A makes its own mailbox for this connection and sends "accept" to B's mailbox,
//    encrypted with the pair secret (from both nonces). Both are now "connected".
//  If A ignores or declines, nothing is sent. B is never told (quiet by default).

import { randomId } from '../model/ids';
import type { Connection, Intro, SharedProfile } from '../model/types';
import { decodeCode, encodeCode, type ConnectPayload } from '../connect/payload';
import { pairSecret } from '../connect/pairing';
import { codeKey, mailboxKey, open, seal } from './crypto';
import type { Box, Transport } from './transport';

/** One-way codes last a little under a day, leaving room for phone clocks that disagree. */
export const INTRO_TTL_MS = 20 * 60 * 60 * 1000;
/** Keep intros a while after they expire so late requests can still be read. */
export const INTRO_KEEP_MS = 48 * 60 * 60 * 1000;
const MESSAGE_TTL_S = 24 * 60 * 60;
const ID = /^[A-Za-z0-9_-]{22}$/;

export function newBox(): Box {
  return { id: randomId(), token: randomId() };
}

export function newIntro(now = Date.now()): Intro {
  const box = newBox();
  return { nonce: randomId(), mailboxId: box.id, mailboxToken: box.token, createdAt: now, expiresAt: now + INTRO_TTL_MS };
}

export function introPayload(profile: SharedProfile, intro: Intro): ConnectPayload {
  return { mode: 'r', nonce: intro.nonce, mailboxId: intro.mailboxId, expiresAt: intro.expiresAt, profile };
}

/** B: send a request to the person whose one-way code we read. Returns our pending connection. */
export async function sendRequest(t: Transport, theirs: ConnectPayload, me: SharedProfile, now = Date.now()): Promise<Connection> {
  if (theirs.mode !== 'r' || !theirs.mailboxId) throw new Error('not-a-request-code');
  const nonce = randomId();
  const box = newBox();
  await t.claim(box);
  const myCode = await encodeCode({ mode: 'r', nonce, mailboxId: box.id, expiresAt: now + INTRO_TTL_MS, profile: me });
  const hello = await seal(await mailboxKey(theirs.nonce, 'hello', theirs.mailboxId), { t: 'hello', v: 1, code: myCode }, theirs.mailboxId);
  await t.send(theirs.mailboxId, hello, MESSAGE_TTL_S);
  return {
    id: randomId(),
    profile: theirs.profile,
    state: 'pending-sent',
    requestedAt: now,
    myMailboxId: box.id,
    myMailboxToken: box.token,
    theirNonce: theirs.nonce,
    sharedSecret: await pairSecret(nonce, theirs.nonce),
    via: 'request',
    scheduleSharing: false,
    sharedSessionIds: [],
    demo: false,
  };
}

/** A: open a hello that arrived in an intro mailbox. Null if it isn't a valid request. */
export async function openHello(intro: Intro, ct: string, now = Date.now()): Promise<Connection | null> {
  const msg = (await open(await mailboxKey(intro.nonce, 'hello', intro.mailboxId), ct, intro.mailboxId)) as {
    t?: unknown;
    v?: unknown;
    code?: unknown;
  } | null;
  if (!msg || msg.t !== 'hello' || msg.v !== 1 || typeof msg.code !== 'string') return null;
  let theirs: ConnectPayload;
  try {
    theirs = await decodeCode(msg.code, now);
  } catch {
    return null;
  }
  if (theirs.mode !== 'r' || !theirs.mailboxId || theirs.nonce === intro.nonce) return null;
  return {
    id: randomId(),
    profile: theirs.profile,
    state: 'pending-received',
    requestedAt: now,
    mailboxId: theirs.mailboxId,
    theirNonce: theirs.nonce,
    sharedSecret: await pairSecret(intro.nonce, theirs.nonce),
    via: 'request',
    scheduleSharing: false,
    sharedSessionIds: [],
    demo: false,
  };
}

/** A: approve a request. Sends "accept" to B and returns the connected connection. */
export async function approveRequest(t: Transport, c: Connection, now = Date.now()): Promise<Connection> {
  if (c.state !== 'pending-received' || !c.mailboxId || !c.sharedSecret) throw new Error('not-pending');
  const box = newBox();
  await t.claim(box);
  const ct = await seal(await mailboxKey(c.sharedSecret, 'msg', c.mailboxId), { t: 'accept', v: 1, mailbox: box.id }, c.mailboxId);
  await t.send(c.mailboxId, ct, MESSAGE_TTL_S);
  return { ...c, state: 'connected', connectedAt: now, myMailboxId: box.id, myMailboxToken: box.token };
}

/** Messages between connected (or pending-sent) pairs, after the hello. */
export type PairMessage = { t: 'accept'; v: 1; mailbox: string };

export async function openPairMessage(c: Connection, ct: string): Promise<PairMessage | null> {
  if (!c.sharedSecret || !c.myMailboxId) return null;
  const msg = (await open(await mailboxKey(c.sharedSecret, 'msg', c.myMailboxId), ct, c.myMailboxId)) as Record<string, unknown> | null;
  if (msg && msg.t === 'accept' && msg.v === 1 && typeof msg.mailbox === 'string' && ID.test(msg.mailbox)) {
    return { t: 'accept', v: 1, mailbox: msg.mailbox };
  }
  return null;
}

export interface SyncStore {
  intros(): Promise<Intro[]>;
  connections(): Promise<Connection[]>;
  put(c: Connection): Promise<void>;
}

export interface SyncResult {
  newRequests: Connection[];
  accepted: Connection[];
}

/** Fetch every mailbox we own, apply what arrived, and clear handled or unreadable messages from the relay. */
export async function syncOnce(t: Transport, store: SyncStore, now = Date.now()): Promise<SyncResult> {
  const intros = (await store.intros()).filter((i) => i.expiresAt + INTRO_KEEP_MS > now);
  const conns = await store.connections();
  const owned = conns.filter((c) => c.myMailboxId && c.myMailboxToken && !c.demo);
  const boxes: Box[] = [
    ...intros.map((i) => ({ id: i.mailboxId, token: i.mailboxToken })),
    ...owned.map((c) => ({ id: c.myMailboxId!, token: c.myMailboxToken! })),
  ];
  const result: SyncResult = { newRequests: [], accepted: [] };
  if (boxes.length === 0) return result;

  const inbox = await t.inbox(boxes);
  const acks = new Map<string, Box & { messageIds: string[] }>();
  const ackOne = (box: Box, id: string) => {
    const a = acks.get(box.id) ?? { ...box, messageIds: [] };
    a.messageIds.push(id);
    acks.set(box.id, a);
  };
  const knownNonces = new Set(conns.map((c) => c.theirNonce).filter(Boolean));

  for (const intro of intros) {
    const box = { id: intro.mailboxId, token: intro.mailboxToken };
    for (const m of inbox[intro.mailboxId] ?? []) {
      const pending = await openHello(intro, m.ct, now);
      if (pending && !knownNonces.has(pending.theirNonce)) {
        knownNonces.add(pending.theirNonce);
        await store.put(pending);
        result.newRequests.push(pending);
      }
      ackOne(box, m.id); // handled, repeated, or junk: clear it either way
    }
  }

  for (const c of owned) {
    const box = { id: c.myMailboxId!, token: c.myMailboxToken! };
    for (const m of inbox[c.myMailboxId!] ?? []) {
      const msg = await openPairMessage(c, m.ct);
      if (msg?.t === 'accept') {
        if (c.state === 'pending-sent') {
          const done: Connection = { ...c, state: 'connected', connectedAt: now, mailboxId: msg.mailbox };
          await store.put(done);
          result.accepted.push(done);
        }
        ackOne(box, m.id);
      }
      // Anything else is left alone: it may be a newer message type, and it expires on its own.
    }
  }

  if (acks.size) await t.ack([...acks.values()]);
  return result;
}

// Six-digit codes (F02)

const CODE_AAD = 'pebble-code';

function randomSixDigits(): string {
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0]! < 4_294_000_000) return String(buf[0]! % 1_000_000).padStart(6, '0');
  }
}

/** A: put our one-way code behind a fresh six-digit code. */
export async function createSixDigitCode(t: Transport, connectCode: string): Promise<{ code: string; expiresAt: number }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomSixDigits();
    const ct = await seal(await codeKey(code), { t: 'code', v: 1, code: connectCode }, CODE_AAD);
    try {
      return { code, ...(await t.createCode(code, ct)) };
    } catch (e) {
      if ((e as Error).message !== 'taken') throw e;
    }
  }
  throw new Error('busy');
}

/** B: swap a six-digit code for the connect code it holds. Null if wrong, used or expired. */
export async function redeemSixDigitCode(t: Transport, code: string, now = Date.now()): Promise<ConnectPayload | null> {
  if (!/^\d{6}$/.test(code)) return null;
  const ct = await t.redeemCode(code);
  if (!ct) return null;
  const msg = (await open(await codeKey(code), ct, CODE_AAD)) as { t?: unknown; v?: unknown; code?: unknown } | null;
  if (!msg || msg.t !== 'code' || msg.v !== 1 || typeof msg.code !== 'string') return null;
  try {
    const p = await decodeCode(msg.code, now);
    return p.mode === 'r' ? p : null;
  } catch {
    return null;
  }
}
