import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { homeIdFor as appHomeIdFor } from '../../src/relay/crypto';
import { BUDGETS, clientPrefix, codeShard, CodesCore, HomeCore, homeIdFor, LIMITS, RateLimiter, type RelayResponse, type Sql } from './core';

function memorySql(): Sql {
  const db = new DatabaseSync(':memory:');
  return {
    all: <T>(q: string, ...p: (string | number | null)[]) => db.prepare(q).all(...p) as T[],
    run: (q: string, ...p: (string | number | null)[]) => {
      db.prepare(q).run(...p);
    },
  };
}

const id = (c: string) => c.repeat(22);
const NOW = 1_800_000_000_000;
const errorOf = (r: RelayResponse) => (r.body as { error?: string }).error;
const messagesOf = (r: RelayResponse) => (r.body as { messages: Record<string, { id: string; ct: string }[]>; more?: boolean });

let sql: Sql;
let home: HomeCore;
let token: string;

beforeEach(async () => {
  token = id('t');
  sql = memorySql();
  home = new HomeCore(sql, await homeIdFor(token));
  home.migrate();
});

describe('a device home', () => {
  it('makes the app and the relay agree on home IDs', async () => {
    expect(await appHomeIdFor(id('t'))).toBe(await homeIdFor(id('t')));
  });

  it('only its own token can sync it', async () => {
    expect(errorOf(await home.sync({ token: id('x') }, NOW))).toBe('not-yours');
    expect((await home.sync({ token }, NOW)).status).toBe(200);
  });

  it('takes mail only for mailboxes it registered, and delivers it on the next sync', async () => {
    expect(errorOf(home.send(id('a'), { ct: 'abc', ttl: 60 }, NOW))).toBe('no-such-mailbox');
    await home.sync({ token, add: [id('a')] }, NOW);
    expect(home.send(id('a'), { ct: 'c2VhbGVk', ttl: 60 }, NOW).status).toBe(201);
    const got = messagesOf(await home.sync({ token }, NOW));
    expect(got.messages[id('a')]).toEqual([expect.objectContaining({ ct: 'c2VhbGVk' })]);
  });

  it('acks, keeps and fetches in one call', async () => {
    await home.sync({ token, add: [id('a'), id('b')] }, NOW);
    const first = (home.send(id('a'), { ct: 'b25l', ttl: 60 }, NOW).body as { id: string }).id;
    home.send(id('b'), { ct: 'dHdv', ttl: 60 }, NOW);
    // Ack the first message and stop using mailbox b, in the same call that fetches.
    const r = messagesOf(await home.sync({ token, ack: [first], keep: [id('a')] }, NOW));
    expect(r.messages).toEqual({});
    expect(errorOf(home.send(id('b'), { ct: 'abc', ttl: 60 }, NOW))).toBe('no-such-mailbox'); // b was dropped
  });

  it('expires messages, and forgets an idle home after 45 days', async () => {
    await home.sync({ token, add: [id('a')] }, NOW);
    home.send(id('a'), { ct: 'abc', ttl: 60 }, NOW);
    home.purge(NOW + 61_000);
    expect(messagesOf(await home.sync({ token }, NOW + 61_000)).messages).toEqual({});
    home.purge(NOW + 61_000 + LIMITS.homeIdleMs);
    expect(sql.all('SELECT * FROM boxes')).toEqual([]);
  });

  it('wakes only when there is something to clean up', async () => {
    expect(home.nextWake(NOW)).toBeNull(); // brand new and empty: never woken
    await home.sync({ token, add: [id('a')] }, NOW);
    home.send(id('a'), { ct: 'abc', ttl: 60 }, NOW);
    expect(home.nextWake(NOW)).toBe(NOW + 60_000);
  });

  it('writes "last used" about once a day, not on every sync', async () => {
    await home.sync({ token }, NOW);
    await home.sync({ token }, NOW + 60_000);
    const used = () => sql.all<{ v: number }>("SELECT v FROM meta WHERE k = 'used'")[0]!.v;
    expect(used()).toBe(NOW);
    await home.sync({ token }, NOW + 25 * 3_600_000);
    expect(used()).toBe(NOW + 25 * 3_600_000);
  });

  it('gives every mailbox its share of a reply', async () => {
    await home.sync({ token, add: [id('a'), id('b')] }, NOW);
    for (let i = 0; i < 50; i++) home.send(id('a'), { ct: 'a'.repeat(LIMITS.ctChars), ttl: 60 }, NOW + i);
    home.send(id('b'), { ct: 'aW52aXRl', ttl: 60 }, NOW);
    const r = messagesOf(await home.sync({ token }, NOW));
    expect(r.messages[id('b')]).toHaveLength(1);
    expect(r.more).toBe(true);
  });

  it('limits mail into one mailbox and one home, from anyone', async () => {
    await home.sync({ token, add: [id('a')] }, NOW);
    const statuses = Array.from({ length: 70 }, (_, i) => home.send(id('a'), { ct: 'abc', ttl: 60 }, NOW + i).status);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  });

  it('rejects bad input', async () => {
    await home.sync({ token, add: [id('a')] }, NOW);
    for (const body of [{ ct: '<script>', ttl: 60 }, { ct: 'a'.repeat(LIMITS.ctChars + 1), ttl: 60 }, { ct: 'abc', ttl: 10 }, { ct: 'abc', ttl: 60.5 }]) {
      expect(home.send(id('a'), body, NOW).status).toBe(400);
    }
    for (const body of [{ token, add: ['short'] }, { token, keep: 'x' }, { token, ack: [1] }, 'nope']) {
      expect([400, 403]).toContain((await home.sync(body, NOW)).status);
    }
  });

  it('caps syncs per device in a window', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < BUDGETS.sync + 2; i++) statuses.push((await home.sync({ token }, NOW)).status);
    expect(statuses.slice(-2)).toEqual([429, 429]);
  });
});

describe('six-digit code shards', () => {
  let codes: CodesCore;
  beforeEach(() => {
    codes = new CodesCore(memorySql());
    codes.migrate();
  });

  it('shards by first digit', () => {
    expect(codeShard('123456')).toBe('codes-1');
    expect(codeShard('987654')).toBe('codes-9');
  });

  it('redeems once and keeps a redeemed code reserved until it expires', () => {
    const code = '424242';
    expect(codes.create({ code, ct: 'cmVhbA' }, 'owner', NOW).status).toBe(201);
    expect(codes.redeem({ code }, 'eavesdropper', NOW).body).toEqual({ ct: 'cmVhbA' });
    expect(errorOf(codes.create({ code, ct: 'ZmFrZQ' }, 'eavesdropper', NOW + 1000))).toBe('taken');
    expect(errorOf(codes.redeem({ code }, 'victim', NOW + 2000))).toBe('no-such-code');
    expect(codes.create({ code, ct: 'bmV3' }, 'someone', NOW + LIMITS.codeTtlMs + 1).status).toBe(201);
  });

  it('stops online guessing in a shard once misses pass its budget', () => {
    let refused = 0;
    for (let i = 0; i < BUDGETS['code-miss'] + 100; i++) if (codes.redeem({ code: String(400000 + i) }, `g${i % 50}`, NOW).status === 429) refused++;
    expect(refused).toBeGreaterThan(0);
  });

  it('allows a whole venue behind one address to make and redeem codes', () => {
    let ok = 0;
    for (let i = 0; i < 200; i++) if (codes.create({ code: String(500000 + i), ct: 'abc' }, 'venue-wifi', NOW).status === 201) ok++;
    expect(ok).toBe(200);
  });
});

describe('rate limiter', () => {
  it('stays bounded under a flood of new keys without locking anyone out', () => {
    const limiter = new RateLimiter();
    let refused = 0;
    for (let i = 0; i < 150_000; i++) if (!limiter.hit(`ip${i}`, 'edge', NOW)) refused++;
    expect(refused).toBe(0);
    expect(limiter.tracked).toBeLessThanOrEqual(100_000);
  });

  it('treats one IPv6 /64 as one client, and IPv4 addresses as themselves', () => {
    expect(clientPrefix('203.0.113.7')).toBe('203.0.113.7');
    expect(clientPrefix('::ffff:203.0.113.7')).toBe('203.0.113.7');
    const a = clientPrefix('2001:db8:aa:1:1111:2222:3333:4444');
    expect(clientPrefix('2001:0db8:00aa:0001:ffff::1')).toBe(a);
    expect(clientPrefix('2001:db8:aa:2::1')).not.toBe(a);
  });
});
