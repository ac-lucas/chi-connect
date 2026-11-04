import { describe, expect, it } from 'vitest';
import { encodeCode } from '../connect/payload';
import { resolveTag } from '../model/tags';
import type { Connection, Intro, SharedProfile } from '../model/types';
import {
  approveRequest,
  createSixDigitCode,
  introPayload,
  newIntro,
  redeemSixDigitCode,
  sendRequest,
  syncOnce,
  type SyncStore,
} from './protocol';
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
    const intro = newIntro();
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
    const intro = newIntro();
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
    const intro = newIntro();
    a.introList.push(intro);
    await relay.send(intro.mailboxId, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 60);
    // A request made for a different intro, delivered to this mailbox.
    const other = newIntro();
    await sendRequest(relay, { ...introPayload(ana, other), mailboxId: intro.mailboxId }, sam);
    expect((await syncOnce(relay, a)).newRequests).toEqual([]);
  });

  it('declining sends nothing back', async () => {
    const relay = new SimulatedTransport();
    const a = new Device(ana);
    const b = new Device(sam);
    const intro = newIntro();
    a.introList.push(intro);
    await b.put(await sendRequest(relay, introPayload(a.me, intro), b.me));
    await syncOnce(relay, a);
    a.saved.clear(); // A declines: the request is just deleted on A's phone
    expect((await syncOnce(relay, b)).accepted).toEqual([]);
    expect(b.only().state).toBe('pending-sent');
  });
});

describe('six-digit codes', () => {
  it('swaps a code for the connect code once', async () => {
    const relay = new SimulatedTransport();
    const intro = newIntro();
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
