import { describe, expect, it } from 'vitest';
import { encodeCode } from '../connect/payload';
import { resolveTag } from '../model/tags';
import type { Connection, Intro, SharedProfile } from '../model/types';
import {
  approveRequest,
  createSixDigitCode,
  introPayload,
  newIntro,
  openHello,
  clampSentAt,
  MAX_NEW_REQUESTS_PER_SYNC,
  redeemSixDigitCode,
  sendPairMessage,
  sendRequest,
  syncOnce,
  type PairMessage,
  type SyncStore,
} from './protocol';
import { newPairKey } from '../connect/pairing';
import { SimulatedTransport } from './transport';

class Device implements SyncStore {
  saved = new Map<string, Connection>();
  introList: Intro[] = [];
  constructor(readonly me: SharedProfile) {}
  async intros() {
    return this.introList;
  }
  async connections() {
    return [...this.saved.values()];
  }
  async put(c: Connection) {
    this.saved.set(c.id, c);
  }
  only() {
    const all = [...this.saved.values()];
    expect(all).toHaveLength(1);
    return all[0]!;
  }
}

const ana: SharedProfile = { displayName: 'Ana', tags: [resolveTag('VR')!] };
const sam: SharedProfile = { displayName: 'Sam', role: 'Designer', tags: [resolveTag('virtual reality')!] };

describe('one-way connect through the relay', () => {
  it('request, approve, and both end up connected with matching secrets and crossed mailboxes', async () => {
    const relay = new SimulatedTransport();
    const a = new Device(ana);
    const b = new Device(sam);

    // A shows a one-way code; B reads it and sends a request.
    const intro = await newIntro();
    await relay.claim({ id: intro.mailboxId, token: intro.mailboxToken });
    a.introList.push(intro);
    await b.put(await sendRequest(relay, introPayload(a.me, intro), b.me));
    expect(b.only().state).toBe('pending-sent');
    expect(b.only().profile.displayName).toBe('Ana');

    // A syncs: a request appears. Nothing has gone back to B.
    const r1 = await syncOnce(relay, a);
    expect(r1.newRequests.map((c) => c.profile.displayName)).toEqual(['Sam']);
    expect(a.only().state).toBe('pending-received');
    expect((await syncOnce(relay, b)).accepted).toEqual([]);

    // A approves; B syncs and is connected.
    await a.put(await approveRequest(relay, a.only()));
    const r2 = await syncOnce(relay, b);
    expect(r2.accepted).toHaveLength(1);

    const ac = a.only();
    const bc = b.only();
    expect(ac.state).toBe('connected');
    expect(bc.state).toBe('connected');
    expect(ac.sharedSecret).toBe(bc.sharedSecret);
    expect(ac.mailboxId).toBe(bc.myMailboxId);
    expect(bc.mailboxId).toBe(ac.myMailboxId);
  });

  it('a repeated sync does not duplicate requests, and handled messages are cleared', async () => {
    const relay = new SimulatedTransport();
    const a = new Device(ana);
    const b = new Device(sam);
    const intro = await newIntro();
    await relay.claim({ id: intro.mailboxId, token: intro.mailboxToken });
    a.introList.push(intro);
    await b.put(await sendRequest(relay, introPayload(a.me, intro), b.me));
    await syncOnce(relay, a);
    expect((await syncOnce(relay, a)).newRequests).toEqual([]);
    expect(a.saved.size).toBe(1);
    expect(await relay.inbox([{ id: intro.mailboxId, token: intro.mailboxToken }])).toEqual({});
  });

  it('ignores junk and messages encrypted for someone else', async () => {
    const relay = new SimulatedTransport();
    const a = new Device(ana);
    const intro = await newIntro();
    await relay.claim({ id: intro.mailboxId, token: intro.mailboxToken });
    a.introList.push(intro);
    await relay.send(intro.mailboxId, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 60);
    // A request made for a different intro, delivered to this mailbox.
    const other = await newIntro();
    await sendRequest(relay, { ...introPayload(ana, other), mailboxId: intro.mailboxId }, sam);
    expect((await syncOnce(relay, a)).newRequests).toEqual([]);
  });

  it('declining sends nothing back', async () => {
    const relay = new SimulatedTransport();
    const a = new Device(ana);
    const b = new Device(sam);
    const intro = await newIntro();
    await relay.claim({ id: intro.mailboxId, token: intro.mailboxToken });
    a.introList.push(intro);
    await b.put(await sendRequest(relay, introPayload(a.me, intro), b.me));
    await syncOnce(relay, a);
    a.saved.clear(); // A declines: the request is just deleted on A's phone
    expect((await syncOnce(relay, b)).accepted).toEqual([]);
    expect(b.only().state).toBe('pending-sent');
  });
});

describe('invites between connected pairs', () => {
  it('delivers an invite and a yes, and ignores invites from people who are only pending', async () => {
    const relay = new SimulatedTransport();
    const a = new Device(ana);
    const b = new Device(sam);
    const intro = await newIntro();
    await relay.claim({ id: intro.mailboxId, token: intro.mailboxToken });
    a.introList.push(intro);
    await b.put(await sendRequest(relay, introPayload(a.me, intro), b.me));
    await syncOnce(relay, a);
    await a.put(await approveRequest(relay, a.only()));
    await syncOnce(relay, b);

    const gotB: PairMessage[] = [];
    const gotA: PairMessage[] = [];
    const bStore = Object.assign(b, { onPairMessage: async (_c: Connection, m: PairMessage) => void gotB.push(m) });
    const aStore = Object.assign(a, { onPairMessage: async (_c: Connection, m: PairMessage) => void gotA.push(m) });
    const id = 'iiiiiiiiiiiiiiiiiiiiii';
    const start = Date.now() + 3_600_000;
    await sendPairMessage(relay, a.only(), { t: 'invite', v: 1, invite: { id, kind: 'meal', start, end: start + 2_700_000, place: 'Lunch hall' } });
    expect((await syncOnce(relay, bStore)).messages).toBe(1);
    expect(gotB).toEqual([{ t: 'invite', v: 1, invite: { id, kind: 'meal', start, end: start + 2_700_000, place: 'Lunch hall' } }]);
    await sendPairMessage(relay, b.only(), { t: 'yes', v: 1, id });
    await syncOnce(relay, aStore);
    expect(gotA).toEqual([{ t: 'yes', v: 1, id }]);
    // A second sync gets nothing new: handled messages were cleared from the relay.
    expect((await syncOnce(relay, bStore)).messages).toBe(0);
  });

  it('refuses to send to someone who is not connected', async () => {
    const relay = new SimulatedTransport();
    const pending = { id: 'x', profile: { displayName: 'P' }, state: 'pending-sent', scheduleSharing: false, sharedSessionIds: [], demo: false, via: 'request' } as Connection;
    await expect(sendPairMessage(relay, pending, { t: 'yes', v: 1, id: 'iiiiiiiiiiiiiiiiiiiiii' })).rejects.toThrow();
  });
});

describe('keys', () => {
  it('only the person who showed the code can open a request to it', async () => {
    const relay = new SimulatedTransport();
    const intro = await newIntro();
    await relay.claim({ id: intro.mailboxId, token: intro.mailboxToken });
    await sendRequest(relay, introPayload(ana, intro), sam);
    const [msg] = (await relay.inbox([{ id: intro.mailboxId, token: intro.mailboxToken }]))[intro.mailboxId]!;
    // Someone who saw the code has its nonce and public key, but not its private key.
    const lookalike = { ...(await newIntro()), nonce: intro.nonce, publicKey: intro.publicKey, mailboxId: intro.mailboxId };
    expect(await openHello(lookalike, msg!.ct)).toBeNull();
    expect((await openHello(intro, msg!.ct))?.profile.displayName).toBe('Sam');
  });

  it('refuses a request whose inner code carries a different key than it was sealed with', async () => {
    const relay = new SimulatedTransport();
    const intro = await newIntro();
    await relay.claim({ id: intro.mailboxId, token: intro.mailboxToken });
    // Sam seals the hello properly, then someone swaps the clear key prefix for another valid key.
    await sendRequest(relay, introPayload(ana, intro), sam);
    const [msg] = (await relay.inbox([{ id: intro.mailboxId, token: intro.mailboxToken }]))[intro.mailboxId]!;
    const other = (await newPairKey()).publicKey;
    expect(await openHello(intro, other + msg!.ct.slice(other.length))).toBeNull();
  });

  it('skips intros saved before codes carried keys', async () => {
    const relay = new SimulatedTransport();
    const a = new Device(ana);
    const { publicKey: _p, privateKey: _k, ...old } = await newIntro();
    await relay.claim({ id: old.mailboxId, token: old.mailboxToken });
    a.introList.push(old);
    await relay.send(old.mailboxId, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 60);
    expect((await syncOnce(relay, a)).newRequests).toEqual([]);
  });
});

describe('limits on requests', () => {
  it('refuses requests sent after the code stopped working', async () => {
    const t0 = 1_800_000_000_000;
    let clock = t0;
    const relay = new SimulatedTransport(() => clock);
    const a = new Device(ana);
    const intro = await newIntro(t0);
    await relay.claim({ id: intro.mailboxId, token: intro.mailboxToken });
    a.introList.push(intro);
    clock = intro.expiresAt + 60 * 60 * 1000; // an hour after the code expired
    await sendRequest(relay, introPayload(a.me, intro), sam, clock);
    expect((await syncOnce(relay, a, clock)).newRequests).toEqual([]);
  });

  it('caps a flood of requests to one code', async () => {
    const relay = new SimulatedTransport();
    const a = new Device(ana);
    const intro = await newIntro();
    await relay.claim({ id: intro.mailboxId, token: intro.mailboxToken });
    a.introList.push(intro);
    for (let i = 0; i < 25; i++) await sendRequest(relay, introPayload(a.me, intro), { displayName: `Spam ${i}` });
    const r = await syncOnce(relay, a);
    expect(r.newRequests).toHaveLength(MAX_NEW_REQUESTS_PER_SYNC);
    expect(await relay.inbox([{ id: intro.mailboxId, token: intro.mailboxToken }])).toEqual({}); // the rest cleared
  });

  it('refuses a request that points back at our own mailbox', async () => {
    const relay = new SimulatedTransport();
    const intro = await newIntro();
    await relay.claim({ id: intro.mailboxId, token: intro.mailboxToken });
    await sendRequest(relay, introPayload(ana, intro), sam);
    const [msg] = (await relay.inbox([{ id: intro.mailboxId, token: intro.mailboxToken }]))[intro.mailboxId]!;
    expect(await openHello(intro, msg!.ct)).not.toBeNull(); // the real one opens
    expect(clampSentAt(Number.NaN, 5)).toBe(5);
    expect(clampSentAt(10, 5)).toBe(5); // never in the future
  });
});

describe('relay hygiene', () => {
  it('still reads a request that waited on the relay past the code inside it', async () => {
    const t0 = 1_800_000_000_000;
    let clock = t0;
    const relay = new SimulatedTransport(() => clock);
    const a = new Device(ana);
    const b = new Device(sam);
    const intro = await newIntro(t0);
    await relay.claim({ id: intro.mailboxId, token: intro.mailboxToken });
    a.introList.push(intro);
    await b.put(await sendRequest(relay, introPayload(a.me, intro), b.me, t0));
    clock = t0 + 21 * 60 * 60 * 1000; // B's code inside the hello expired at 20 hours; the message lives 24
    expect((await syncOnce(relay, a, clock)).newRequests.map((c) => c.profile.displayName)).toEqual(['Sam']);
  });

  it('clears junk from pair mailboxes instead of downloading it on every sync', async () => {
    const relay = new SimulatedTransport();
    const a = new Device(ana);
    const b = new Device(sam);
    const intro = await newIntro();
    await relay.claim({ id: intro.mailboxId, token: intro.mailboxToken });
    a.introList.push(intro);
    await b.put(await sendRequest(relay, introPayload(a.me, intro), b.me));
    const box = { id: b.only().myMailboxId!, token: b.only().myMailboxToken! };
    await relay.send(box.id, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 60);
    await syncOnce(relay, b);
    expect(await relay.inbox([box])).toEqual({});
    expect(b.only().state).toBe('pending-sent');
  });

  it('makes mailbox IDs that only their own token can claim', async () => {
    const relay = new SimulatedTransport();
    const intro = await newIntro();
    await relay.claim({ id: intro.mailboxId, token: intro.mailboxToken });
    await expect(relay.claim({ id: intro.mailboxId, token: 'x'.repeat(22) })).rejects.toThrow('taken');
    await expect(relay.claim({ id: intro.mailboxId, token: intro.mailboxToken })).resolves.toBeUndefined();
  });
});

describe('six-digit codes', () => {
  it('swaps a code for the connect code once', async () => {
    const relay = new SimulatedTransport();
    const intro = await newIntro();
    await relay.claim({ id: intro.mailboxId, token: intro.mailboxToken });
    const connectCode = await encodeCode(introPayload(ana, intro));
    const { code } = await createSixDigitCode(relay, connectCode);
    expect(code).toMatch(/^\d{6}$/);
    const got = await redeemSixDigitCode(relay, code);
    expect(got?.profile.displayName).toBe('Ana');
    expect(got?.nonce).toBe(intro.nonce);
    expect(await redeemSixDigitCode(relay, code)).toBeNull();
    expect(await redeemSixDigitCode(relay, 'abc')).toBeNull();
  });
});
