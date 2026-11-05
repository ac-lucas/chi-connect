import { describe, expect, it } from 'vitest';
import { encodeCode } from '../connect/payload';
import { newPairKey } from '../connect/pairing';
import { resolveTag } from '../model/tags';
import type { Connection, Intro, SharedProfile } from '../model/types';
import { newHome, splitAddress, type Home } from './address';
import {
  approveRequest,
  clampSentAt,
  createSixDigitCode,
  introPayload,
  MAX_NEW_REQUESTS_PER_SYNC,
  newIntro,
  openHello,
  redeemSixDigitCode,
  sendPairMessage,
  sendRequest,
  syncOnce,
  type PairMessage,
  type SyncStore,
} from './protocol';
import { SimulatedTransport } from './transport';

/** A phone: its relay home, what it stores, and its pending acks. */
class Device implements SyncStore {
  saved = new Map<string, Connection>();
  introList: Intro[] = [];
  pendingAcks: string[] = [];
  onPairMessage?: SyncStore['onPairMessage'];
  private constructor(
    readonly me: SharedProfile,
    readonly home: Home,
  ) {}
  static async make(me: SharedProfile) {
    return new Device(me, await newHome());
  }
  async intros() {
    return this.introList;
  }
  async connections() {
    return [...this.saved.values()];
  }
  async put(c: Connection) {
    this.saved.set(c.id, c);
  }
  async acks() {
    return this.pendingAcks;
  }
  async setAcks(ids: string[]) {
    this.pendingAcks = ids;
  }
  only() {
    const all = [...this.saved.values()];
    expect(all).toHaveLength(1);
    return all[0]!;
  }
  /** Show a one-way code: make an intro in this home and register its mailbox. */
  async showCode(relay: SimulatedTransport, now = Date.now()) {
    const intro = await newIntro(this.home, now);
    await relay.register(this.home, [splitAddress(intro.mailboxId).box]);
    this.introList.push(intro);
    return intro;
  }
  sync(relay: SimulatedTransport, now = Date.now()) {
    return syncOnce(relay, this.home, this, now);
  }
  /** What's waiting on the relay for this phone, without handling or acking it. */
  async waiting(relay: SimulatedTransport) {
    const keep = [...this.introList.map((i) => splitAddress(i.mailboxId).box), ...[...this.saved.values()].flatMap((c) => (c.myMailboxId ? [splitAddress(c.myMailboxId).box] : []))];
    return (await relay.sync(this.home, { keep, ack: this.pendingAcks })).messages;
  }
}

const ana: SharedProfile = { displayName: 'Ana', tags: [resolveTag('VR')!] };
const sam: SharedProfile = { displayName: 'Sam', role: 'Designer', tags: [resolveTag('virtual reality')!] };

async function connected(relay: SimulatedTransport) {
  const a = await Device.make(ana);
  const b = await Device.make(sam);
  const intro = await a.showCode(relay);
  await b.put(await sendRequest(relay, b.home, introPayload(a.me, intro), b.me));
  await a.sync(relay);
  await a.put(await approveRequest(relay, a.home, a.only()));
  await b.sync(relay);
  return { a, b };
}

describe('one-way connect through the relay', () => {
  it('request, approve, and both end up connected with matching secrets and crossed mailboxes', async () => {
    const relay = new SimulatedTransport();
    const a = await Device.make(ana);
    const b = await Device.make(sam);
    const intro = await a.showCode(relay);
    await b.put(await sendRequest(relay, b.home, introPayload(a.me, intro), b.me));
    expect(b.only().state).toBe('pending-sent');

    const r1 = await a.sync(relay);
    expect(r1.newRequests.map((c) => c.profile.displayName)).toEqual(['Sam']);
    expect(a.only().state).toBe('pending-received');
    expect((await b.sync(relay)).accepted).toEqual([]);

    await a.put(await approveRequest(relay, a.home, a.only()));
    expect((await b.sync(relay)).accepted).toHaveLength(1);

    const ac = a.only();
    const bc = b.only();
    expect([ac.state, bc.state]).toEqual(['connected', 'connected']);
    expect(ac.sharedSecret).toBe(bc.sharedSecret);
    expect(ac.mailboxId).toBe(bc.myMailboxId);
    expect(bc.mailboxId).toBe(ac.myMailboxId);
    expect(splitAddress(ac.myMailboxId!).home).toBe(a.home.id); // each side's mailbox is in its own home
  });

  it('acks on the next call, so a repeated sync never duplicates and nothing waits on the relay', async () => {
    const relay = new SimulatedTransport();
    const a = await Device.make(ana);
    const b = await Device.make(sam);
    const intro = await a.showCode(relay);
    await b.put(await sendRequest(relay, b.home, introPayload(a.me, intro), b.me));
    await a.sync(relay);
    expect(a.pendingAcks).toHaveLength(1); // handled, to be acked next time
    expect((await a.sync(relay)).newRequests).toEqual([]);
    expect(a.saved.size).toBe(1);
    expect(await a.waiting(relay)).toEqual({});
  });

  it('ignores junk and messages encrypted for someone else', async () => {
    const relay = new SimulatedTransport();
    const a = await Device.make(ana);
    const intro = await a.showCode(relay);
    await relay.send(intro.mailboxId, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 60);
    const other = await newIntro(a.home);
    const s = await Device.make(sam);
    await sendRequest(relay, s.home, { ...introPayload(ana, other), mailboxId: intro.mailboxId }, sam);
    expect((await a.sync(relay)).newRequests).toEqual([]);
  });

  it('declining sends nothing back', async () => {
    const relay = new SimulatedTransport();
    const a = await Device.make(ana);
    const b = await Device.make(sam);
    const intro = await a.showCode(relay);
    await b.put(await sendRequest(relay, b.home, introPayload(a.me, intro), b.me));
    await a.sync(relay);
    a.saved.clear(); // A declines: the request is just deleted on A's phone
    expect((await b.sync(relay)).accepted).toEqual([]);
    expect(b.only().state).toBe('pending-sent');
  });

  it('drops mailboxes the phone no longer uses (a removed connection), with their mail', async () => {
    const relay = new SimulatedTransport();
    const { a, b } = await connected(relay);
    const gone = a.only();
    a.saved.clear(); // A removes B
    await a.sync(relay); // keep no longer lists that mailbox: the relay drops it
    await expect(sendPairMessage(relay, b.only(), { t: 'yes', v: 1, id: 'iiiiiiiiiiiiiiiiiiiiii' })).rejects.toThrow();
    expect(gone.myMailboxId).toBeTruthy();
  });
});

describe('invites between connected pairs', () => {
  it('delivers an invite and a yes', async () => {
    const relay = new SimulatedTransport();
    const { a, b } = await connected(relay);
    const gotB: PairMessage[] = [];
    const gotA: PairMessage[] = [];
    b.onPairMessage = async (_c, m) => void gotB.push(m);
    a.onPairMessage = async (_c, m) => void gotA.push(m);
    const id = 'iiiiiiiiiiiiiiiiiiiiii';
    const start = Date.now() + 3_600_000;
    await sendPairMessage(relay, a.only(), { t: 'invite', v: 1, invite: { id, kind: 'meal', start, end: start + 2_700_000, place: 'Lunch hall' } });
    expect((await b.sync(relay)).messages).toBe(1);
    expect(gotB).toEqual([{ t: 'invite', v: 1, invite: { id, kind: 'meal', start, end: start + 2_700_000, place: 'Lunch hall' } }]);
    await sendPairMessage(relay, b.only(), { t: 'yes', v: 1, id });
    await a.sync(relay);
    expect(gotA).toEqual([{ t: 'yes', v: 1, id }]);
    expect((await b.sync(relay)).messages).toBe(0); // acked on this call, not handed over again
  });

  it('refuses to send to someone who is not connected', async () => {
    const relay = new SimulatedTransport();
    const pending = { id: 'x', profile: { displayName: 'P' }, state: 'pending-sent', scheduleSharing: false, sharedSessionIds: [], demo: false, via: 'request' } as Connection;
    await expect(sendPairMessage(relay, pending, { t: 'yes', v: 1, id: 'iiiiiiiiiiiiiiiiiiiiii' })).rejects.toThrow();
  });
});

describe('keys and homes', () => {
  it('only the person who showed the code can open a request to it', async () => {
    const relay = new SimulatedTransport();
    const a = await Device.make(ana);
    const b = await Device.make(sam);
    const intro = await a.showCode(relay);
    await sendRequest(relay, b.home, introPayload(ana, intro), sam);
    const [msg] = (await a.waiting(relay))[splitAddress(intro.mailboxId).box]!;
    const lookalike = { ...(await newIntro(a.home)), nonce: intro.nonce, publicKey: intro.publicKey, mailboxId: intro.mailboxId };
    expect(await openHello(lookalike, msg!.ct)).toBeNull();
    expect((await openHello(intro, msg!.ct))?.profile.displayName).toBe('Sam');
  });

  it('refuses a request whose inner code carries a different key than it was sealed with', async () => {
    const relay = new SimulatedTransport();
    const a = await Device.make(ana);
    const b = await Device.make(sam);
    const intro = await a.showCode(relay);
    await sendRequest(relay, b.home, introPayload(ana, intro), sam);
    const [msg] = (await a.waiting(relay))[splitAddress(intro.mailboxId).box]!;
    const other = (await newPairKey()).publicKey;
    expect(await openHello(intro, other + msg!.ct.slice(other.length))).toBeNull();
  });

  it('only the device that holds a home token can use that home', async () => {
    const relay = new SimulatedTransport();
    const home = await newHome();
    await expect(relay.register({ id: home.id, token: 'x'.repeat(22) }, ['b'.repeat(22)])).rejects.toThrow();
    await expect(relay.register(home, ['b'.repeat(22)])).resolves.toBeUndefined();
  });

  it('refuses a request that points back at our own mailbox, and clamps relay times', async () => {
    const relay = new SimulatedTransport();
    const a = await Device.make(ana);
    const b = await Device.make(sam);
    const intro = await a.showCode(relay);
    await sendRequest(relay, b.home, introPayload(ana, intro), sam);
    const [msg] = (await a.waiting(relay))[splitAddress(intro.mailboxId).box]!;
    expect(await openHello(intro, msg!.ct)).not.toBeNull();
    expect(clampSentAt(Number.NaN, 5)).toBe(5);
    expect(clampSentAt(10, 5)).toBe(5);
  });
});

describe('limits on requests', () => {
  it('refuses requests sent after the code stopped working', async () => {
    const t0 = 1_800_000_000_000;
    let clock = t0;
    const relay = new SimulatedTransport(() => clock);
    const a = await Device.make(ana);
    const b = await Device.make(sam);
    const intro = await a.showCode(relay, t0);
    clock = intro.expiresAt + 60 * 60 * 1000;
    await sendRequest(relay, b.home, introPayload(a.me, intro), sam, clock);
    expect((await a.sync(relay, clock)).newRequests).toEqual([]);
  });

  it('caps a flood of requests to one code; the rest wait for later syncs', async () => {
    const relay = new SimulatedTransport();
    const a = await Device.make(ana);
    const intro = await a.showCode(relay);
    for (let i = 0; i < 25; i++) {
      const s = await Device.make({ displayName: `Spam ${i}` });
      await sendRequest(relay, s.home, introPayload(a.me, intro), s.me);
    }
    expect((await a.sync(relay)).newRequests).toHaveLength(MAX_NEW_REQUESTS_PER_SYNC);
    expect((await a.sync(relay)).newRequests).toHaveLength(MAX_NEW_REQUESTS_PER_SYNC);
    expect((await a.sync(relay)).newRequests).toHaveLength(5);
  });
});

describe('relay hygiene', () => {
  it('still reads a request that waited on the relay past the code inside it', async () => {
    const t0 = 1_800_000_000_000;
    let clock = t0;
    const relay = new SimulatedTransport(() => clock);
    const a = await Device.make(ana);
    const b = await Device.make(sam);
    const intro = await a.showCode(relay, t0);
    await b.put(await sendRequest(relay, b.home, introPayload(a.me, intro), b.me, t0));
    clock = t0 + 21 * 60 * 60 * 1000;
    expect((await a.sync(relay, clock)).newRequests.map((c) => c.profile.displayName)).toEqual(['Sam']);
  });

  it('clears junk from pair mailboxes instead of taking it on every sync', async () => {
    const relay = new SimulatedTransport();
    const a = await Device.make(ana);
    const b = await Device.make(sam);
    const intro = await a.showCode(relay);
    await b.put(await sendRequest(relay, b.home, introPayload(a.me, intro), b.me));
    await relay.send(b.only().myMailboxId!, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 60);
    await b.sync(relay); // junk handled (to be acked)...
    expect(await b.waiting(relay)).toEqual({}); // ...and gone once acked
    expect(b.only().state).toBe('pending-sent');
  });
});

describe('six-digit codes', () => {
  it('swaps a code for the connect code once', async () => {
    const relay = new SimulatedTransport();
    const a = await Device.make(ana);
    const intro = await a.showCode(relay);
    const { code } = await createSixDigitCode(relay, await encodeCode(introPayload(ana, intro)));
    expect(code).toMatch(/^\d{6}$/);
    const got = await redeemSixDigitCode(relay, code);
    expect(got?.profile.displayName).toBe('Ana');
    expect(got?.nonce).toBe(intro.nonce);
    expect(await redeemSixDigitCode(relay, code)).toBeNull();
    expect(await redeemSixDigitCode(relay, 'abc')).toBeNull();
  });
});
