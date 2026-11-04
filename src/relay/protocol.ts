// One-way connecting through the relay (F01 QR, F02 six-digit code, F03 link).
//
//  A shows a code: an "intro" with a fresh nonce, a P-256 public key and its own mailbox. A keeps the private key.
//  B reads it, sees A's profile and taps "Send request":
//    B makes a nonce, a key pair and a mailbox for this connection, and sends a "hello" to A's intro mailbox:
//    B's public key in the clear, then B's own code sealed with a key from ECDH(B's private key, A's public key).
//    Only A can open it: not people who saw A's code, and not the relay. B is now "pending-sent".
//  A's phone finds the hello, opens it, and shows a request (pending-received). Nothing is sent back yet.
//  If A approves: A makes its own mailbox for this connection and sends "accept" to B's mailbox,
//    encrypted with the pair secret (ECDH of the two keys, bound to both codes). Both are now "connected".
//  If A ignores or declines, nothing is sent. B is never told (quiet by default).

import { randomId } from '../model/ids';
import type { Connection, Intro, MeetingSpot, SharedProfile } from '../model/types';
import { cleanText } from '../model/text';
import { cleanSpot } from '../schedule/spot';
import { LIMITS_INVITE, parseWireInvite, type WireInvite } from './invites';
import { decodeCode, encodeCode, type ConnectPayload } from '../connect/payload';
import { helloSecret, isPublicKeyText, newPairKey, pairSecret, PUBLIC_KEY_CHARS } from '../connect/pairing';
import { codeKey, mailboxIdFor, mailboxKey, open, seal } from './crypto';
import type { Box, Transport } from './transport';

/** One-way codes last a little under a day, leaving room for phone clocks that disagree. */
export const INTRO_TTL_MS = 20 * 60 * 60 * 1000;
/** Keep intros a while after they expire so late requests can still be read. */
export const INTRO_KEEP_MS = 48 * 60 * 60 * 1000;
const MESSAGE_TTL_S = 24 * 60 * 60;
const ID = /^[A-Za-z0-9_-]{22}$/;

/** A fresh mailbox: a random token, and the ID made from it (see mailboxIdFor). */
export async function newBox(): Promise<Box> {
  const token = randomId();
  return { id: await mailboxIdFor(token), token };
}

/**
 * A new one-way code. `exportable` is for browsers that can't store a CryptoKey: the private key is then kept
 * as JWK (see canStoreCryptoKeys in storage).
 */
export async function newIntro(now = Date.now(), { exportable = false } = {}): Promise<Intro> {
  const box = await newBox();
  const key = await newPairKey(exportable);
  const privateJwk = exportable ? await crypto.subtle.exportKey('jwk', key.privateKey) : undefined;
  return {
    ...(privateJwk ? { privateJwk } : {}),
    nonce: randomId(),
    publicKey: key.publicKey,
    privateKey: key.privateKey,
    mailboxId: box.id,
    mailboxToken: box.token,
    createdAt: now,
    expiresAt: now + INTRO_TTL_MS,
  };
}

/** An intro we can still use: made with a key pair (older ones, from before keys existed, can't open requests). */
export function hasKeys(i: Intro): i is Intro & { publicKey: string; privateKey: CryptoKey } {
  return !!i.publicKey && !!i.privateKey;
}

export function introPayload(profile: SharedProfile, intro: Intro): ConnectPayload {
  if (!hasKeys(intro)) throw new Error('intro-without-key');
  return { mode: 'r', nonce: intro.nonce, publicKey: intro.publicKey, mailboxId: intro.mailboxId, expiresAt: intro.expiresAt, profile };
}

const HELLO_VERSION = 2;

/** B: send a request to the person whose one-way code we read. Returns our pending connection. */
export async function sendRequest(t: Transport, theirs: ConnectPayload, me: SharedProfile, now = Date.now()): Promise<Connection> {
  if (theirs.mode !== 'r' || !theirs.mailboxId) throw new Error('not-a-request-code');
  const nonce = randomId();
  const key = await newPairKey();
  const box = await newBox();
  await t.claim(box);
  const mine = { mode: 'r' as const, nonce, publicKey: key.publicKey, mailboxId: box.id, expiresAt: now + INTRO_TTL_MS, profile: me };
  const myCode = await encodeCode(mine);
  const hs = await helloSecret(key.privateKey, theirs, key.publicKey, theirs.publicKey);
  const sealed = await seal(await mailboxKey(hs, 'hello', theirs.mailboxId), { t: 'hello', v: HELLO_VERSION, code: myCode }, theirs.mailboxId);
  // Our public key goes first, in the clear: A needs it to work out the key that opens the rest.
  await t.send(theirs.mailboxId, key.publicKey + sealed, MESSAGE_TTL_S);
  return {
    id: randomId(),
    profile: theirs.profile,
    state: 'pending-sent',
    requestedAt: now,
    myMailboxId: box.id,
    myMailboxToken: box.token,
    theirNonce: theirs.nonce,
    // The private key is used once, here, and then dropped: later messages use the pair secret.
    sharedSecret: await pairSecret(key.privateKey, mine, theirs),
    via: 'request',
    scheduleSharing: false,
    sharedSessionIds: [],
    demo: false,
  };
}

/**
 * A: open a hello that arrived in an intro mailbox. Null if it isn't a valid request.
 * `sentAt` is when the relay received it: the sender's code inside is checked against that time, so a request
 * still waiting on the relay (up to a day) isn't dropped just because the code inside has since expired.
 */
export async function openHello(intro: Intro, ct: string, now = Date.now(), sentAt = now): Promise<Connection | null> {
  if (!hasKeys(intro) || ct.length <= PUBLIC_KEY_CHARS) return null;
  const senderKey = ct.slice(0, PUBLIC_KEY_CHARS);
  if (!isPublicKeyText(senderKey)) return null;
  let hs: string;
  try {
    hs = await helloSecret(intro.privateKey, intro, senderKey, senderKey);
  } catch {
    return null; // not a valid public key
  }
  const msg = (await open(await mailboxKey(hs, 'hello', intro.mailboxId), ct.slice(PUBLIC_KEY_CHARS), intro.mailboxId)) as {
    t?: unknown;
    v?: unknown;
    code?: unknown;
  } | null;
  if (!msg || msg.t !== 'hello' || msg.v !== HELLO_VERSION || typeof msg.code !== 'string') return null;
  let theirs: ConnectPayload;
  try {
    theirs = await decodeCode(msg.code, Math.min(sentAt, now));
  } catch {
    return null;
  }
  // The key inside must be the one the hello was sealed with, so nobody can wrap someone else's code.
  if (theirs.mode !== 'r' || !theirs.mailboxId || theirs.nonce === intro.nonce || theirs.publicKey !== senderKey) return null;
  return {
    id: randomId(),
    profile: theirs.profile,
    state: 'pending-received',
    requestedAt: now,
    mailboxId: theirs.mailboxId,
    theirNonce: theirs.nonce,
    sharedSecret: await pairSecret(intro.privateKey, intro, theirs),
    via: 'request',
    scheduleSharing: false,
    sharedSessionIds: [],
    demo: false,
  };
}

/** A: approve a request. Sends "accept" to B and returns the connected connection. */
export async function approveRequest(t: Transport, c: Connection, now = Date.now()): Promise<Connection> {
  if (c.state !== 'pending-received' || !c.mailboxId || !c.sharedSecret) throw new Error('not-pending');
  const box = await newBox();
  await t.claim(box);
  const ct = await seal(await mailboxKey(c.sharedSecret, 'msg', c.mailboxId), { t: 'accept', v: 1, mailbox: box.id }, c.mailboxId);
  await t.send(c.mailboxId, ct, MESSAGE_TTL_S);
  return { ...c, state: 'connected', connectedAt: now, myMailboxId: box.id, myMailboxToken: box.token };
}

/**
 * Messages between connected (or pending-sent) pairs, after the hello. Invites go to connected pairs only.
 * There is deliberately no "no" reply: declining or ignoring an invite sends nothing (quiet by default).
 */
export type PairMessage =
  | { t: 'accept'; v: 1; mailbox: string }
  | { t: 'invite'; v: 1; invite: WireInvite }
  | { t: 'yes'; v: 1; id: string }
  | { t: 'cancel'; v: 1; id: string }
  | { t: 'update'; v: 1; id: string; place?: string; spot?: MeetingSpot };

/** Send a message to a connection's mailbox, sealed with the pair's key. */
export async function sendPairMessage(t: Transport, c: Connection, msg: PairMessage, ttlSeconds = MESSAGE_TTL_S): Promise<void> {
  if (c.state !== 'connected' || !c.mailboxId || !c.sharedSecret) throw new Error('not-connected');
  const ttl = Math.max(60, Math.min(MESSAGE_TTL_S, Math.round(ttlSeconds)));
  const ct = await seal(await mailboxKey(c.sharedSecret, 'msg', c.mailboxId), msg, c.mailboxId);
  await t.send(c.mailboxId, ct, ttl);
}

/** Decrypt a message to one of our pair mailboxes. Null if it doesn't open (wrong key, tampered or junk). */
async function openPair(c: Connection, ct: string): Promise<unknown> {
  if (!c.sharedSecret || !c.myMailboxId) return null;
  return open(await mailboxKey(c.sharedSecret, 'msg', c.myMailboxId), ct, c.myMailboxId);
}

function parsePairMessage(value: unknown): PairMessage | null {
  const msg = value as Record<string, unknown> | null;
  if (!msg || typeof msg !== 'object' || msg.v !== 1) return null;
  if (msg.t === 'accept' && typeof msg.mailbox === 'string' && ID.test(msg.mailbox)) return { t: 'accept', v: 1, mailbox: msg.mailbox };
  if (msg.t === 'invite') {
    const invite = parseWireInvite(msg.invite);
    return invite ? { t: 'invite', v: 1, invite } : null;
  }
  if ((msg.t === 'yes' || msg.t === 'cancel') && typeof msg.id === 'string' && ID.test(msg.id)) return { t: msg.t, v: 1, id: msg.id };
  if (msg.t === 'update' && typeof msg.id === 'string' && ID.test(msg.id)) {
    const place = cleanText(msg.place, LIMITS_INVITE.place) || undefined;
    return { t: 'update', v: 1, id: msg.id, place, spot: cleanSpot(msg.spot) };
  }
  return null;
}

export async function openPairMessage(c: Connection, ct: string): Promise<PairMessage | null> {
  return parsePairMessage(await openPair(c, ct));
}

export interface SyncStore {
  intros(): Promise<Intro[]>;
  connections(): Promise<Connection[]>;
  put(c: Connection): Promise<void>;
  /** Invites and replies from a connected pair. `sentAt` is when the relay received it. */
  onPairMessage?(c: Connection, msg: Exclude<PairMessage, { t: 'accept' }>, sentAt: number): Promise<void>;
}

export interface SyncResult {
  newRequests: Connection[];
  accepted: Connection[];
  /** Invite messages handled. */
  messages: number;
}

/** Fetch every mailbox we own, apply what arrived, and clear handled or unreadable messages from the relay. */
export async function syncOnce(t: Transport, store: SyncStore, now = Date.now()): Promise<SyncResult> {
  const intros = (await store.intros()).filter((i) => hasKeys(i) && i.expiresAt + INTRO_KEEP_MS > now);
  const conns = await store.connections();
  const owned = conns.filter((c) => c.myMailboxId && c.myMailboxToken && !c.demo);
  const boxes: Box[] = [
    ...intros.map((i) => ({ id: i.mailboxId, token: i.mailboxToken })),
    ...owned.map((c) => ({ id: c.myMailboxId!, token: c.myMailboxToken! })),
  ];
  const result: SyncResult = { newRequests: [], accepted: [], messages: 0 };
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
      const pending = await openHello(intro, m.ct, now, m.created);
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
      const opened = await openPair(c, m.ct);
      if (opened === null) {
        // Doesn't open with our key: junk, or meant for someone else. Clear it, or it would be downloaded and
        // tried again on every sync until it expires (mailbox IDs are in QR codes, so anyone can post to one).
        ackOne(box, m.id);
        continue;
      }
      const msg = parsePairMessage(opened);
      if (msg?.t === 'accept') {
        if (c.state === 'pending-sent') {
          const done: Connection = { ...c, state: 'connected', connectedAt: now, mailboxId: msg.mailbox };
          await store.put(done);
          result.accepted.push(done);
        }
        ackOne(box, m.id);
      } else if (msg && c.state === 'connected' && store.onPairMessage) {
        await store.onPairMessage(c, msg, m.created);
        result.messages += 1;
        ackOne(box, m.id);
      }
      // Anything else that opened is left alone: it may be a newer message type, and it expires on its own.
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
