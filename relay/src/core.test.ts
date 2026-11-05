import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { mailboxIdFor as appMailboxIdFor } from '../../src/relay/crypto';
import { clientPrefix, LIMITS, mailboxIdFor, RateLimiter, RelayCore, type RelayResponse, type Sql } from './core';

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
let relay: RelayCore;
let sql: Sql;
let client = 0;
/** A token and the mailbox ID made from it. */
const owned = async (c: string) => {
  const token = id(c);
  return { token, box: await mailboxIdFor(token) };
};

beforeEach(() => {
  sql = memorySql();
  relay = new RelayCore(sql);
  relay.migrate();
  client++;
});

const call = (path: string, body: unknown, now = NOW, clientKey = `c${client}`): Promise<RelayResponse> =>
  relay.handle({ method: 'POST', path, body, clientKey }, now);
const errorOf = (r: RelayResponse) => (r.body as { error?: string }).error;

describe('mailboxes and messages', () => {
  it('delivers a message to the owner, then deletes it on ack', async () => {
    const { box, token } = await owned('t');
    expect((await call('/v1/mailboxes/claim', { id: box, token })).status).toBe(200);
    const sent = await call(`/v1/mailboxes/${box}/messages`, { ct: 'c2VhbGVk', ttl: 3600 });
    expect(sent.status).toBe(201);
    const msgId = (sent.body as { id: string }).id;

    const got = await call('/v1/inbox', { boxes: [{ id: box, token }] });
    expect((got.body as { messages: Record<string, { id: string; ct: string }[]> }).messages[box]).toEqual([
      expect.objectContaining({ id: msgId, ct: 'c2VhbGVk' }),
    ]);

    await call('/v1/inbox/ack', { boxes: [{ id: box, token, messageIds: [msgId] }] });
    const after = await call('/v1/inbox', { boxes: [{ id: box, token }] });
    expect((after.body as { messages: object }).messages).toEqual({});
  });

  it('never shows a mailbox to the wrong token, and a second claim fails', async () => {
    const { box } = await owned('t');
    await call('/v1/mailboxes/claim', { id: box, token: id('t') });
    expect(errorOf(await call('/v1/mailboxes/claim', { id: box, token: id('x') }))).toBe('taken');
    await call(`/v1/mailboxes/${box}/messages`, { ct: 'abc', ttl: 60 });
    const peek = await call('/v1/inbox', { boxes: [{ id: box, token: id('x') }] });
    expect((peek.body as { messages: object }).messages).toEqual({});
    await call('/v1/inbox/ack', { boxes: [{ id: box, token: id('x'), messageIds: [] }] });
    const real = await call('/v1/inbox', { boxes: [{ id: box, token: id('t') }] });
    expect(Object.keys((real.body as { messages: object }).messages)).toEqual([box]);
  });

  it('makes the app and the relay agree on mailbox IDs', async () => {
    expect(await appMailboxIdFor(id('t'))).toBe(await mailboxIdFor(id('t')));
  });

  it('only lets the token a mailbox ID was made from claim it', async () => {
    // Someone who saw the ID in a QR code can't take the mailbox, by claiming or by reading first.
    const { box, token } = await owned('t');
    expect(errorOf(await call('/v1/mailboxes/claim', { id: box, token: id('x') }))).toBe('taken');
    await call(`/v1/mailboxes/${box}/messages`, { ct: 'abc', ttl: 60 });
    const peek = await call('/v1/inbox', { boxes: [{ id: box, token: id('x') }] });
    expect((peek.body as { messages: object }).messages).toEqual({});
    expect((await call('/v1/mailboxes/claim', { id: box, token })).status).toBe(200);
    // A random ID that wasn't made from any token can't be claimed at all.
    expect(errorOf(await call('/v1/mailboxes/claim', { id: id('r'), token }))).toBe('taken');
  });

  it('keeps working for mailboxes claimed before IDs were made from tokens', async () => {
    const token = id('t');
    const hash = Buffer.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))).toString('base64url');
    sql.run('INSERT INTO mailboxes (id, token_hash, last_used) VALUES (?, ?, ?)', id('o'), hash, NOW);
    expect((await call('/v1/mailboxes/claim', { id: id('o'), token })).status).toBe(200);
    expect(errorOf(await call('/v1/mailboxes/claim', { id: id('o'), token: id('x') }))).toBe('taken');
  });

  it('only takes mail for a mailbox someone has claimed (first read claims it)', async () => {
    const { box, token } = await owned('t');
    expect(errorOf(await call(`/v1/mailboxes/${box}/messages`, { ct: 'abc', ttl: 60 }))).toBe('no-such-mailbox');
    await call('/v1/inbox', { boxes: [{ id: box, token }] }); // first read claims it
    await call(`/v1/mailboxes/${box}/messages`, { ct: 'abc', ttl: 60 });
    const first = await call('/v1/inbox', { boxes: [{ id: box, token }] });
    expect(Object.keys((first.body as { messages: object }).messages)).toEqual([box]);
    expect(errorOf(await call('/v1/mailboxes/claim', { id: box, token: id('x') }))).toBe('taken');
  });

  it('caps one inbox reply and says there is more', async () => {
    const boxes = [];
    for (const c of 'abcdefghijklm') {
      const { box, token } = await owned(c);
      await call('/v1/mailboxes/claim', { id: box, token });
      for (let i = 0; i < 10; i++) await call(`/v1/mailboxes/${box}/messages`, { ct: 'a'.repeat(LIMITS.ctChars), ttl: 60 }, NOW, `s${c}${i}`);
      boxes.push({ id: box, token });
    }
    const r = (await call('/v1/inbox', { boxes })).body as { messages: Record<string, { ct: string }[]>; more?: boolean };
    const chars = Object.values(r.messages).flat().reduce((n, m) => n + m.ct.length, 0);
    expect(chars).toBeLessThanOrEqual(LIMITS.inboxReplyChars);
    expect(r.more).toBe(true);
  });

  it('limits how fast one mailbox can be sent to, from any number of addresses', async () => {
    const { box, token } = await owned('t');
    await call('/v1/mailboxes/claim', { id: box, token });
    const statuses: number[] = [];
    for (let i = 0; i < 70; i++) {
      statuses.push((await call(`/v1/mailboxes/${box}/messages`, { ct: 'abc', ttl: 60 }, NOW, `addr${i}`)).status);
      if (i % 40 === 39) await call('/v1/inbox/ack', { boxes: [{ id: box, token, messageIds: [] }] });
    }
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  });

  it('expires messages after their lifetime', async () => {
    const { box, token } = await owned('t');
    await call(`/v1/mailboxes/${box}/messages`, { ct: 'abc', ttl: 60 });
    const later = await call('/v1/inbox', { boxes: [{ id: box, token }] }, NOW + 61_000);
    expect((later.body as { messages: object }).messages).toEqual({});
  });

  it('caps waiting messages per mailbox', async () => {
    const { box, token } = await owned('e');
    await call('/v1/mailboxes/claim', { id: box, token });
    for (let i = 0; i < LIMITS.messagesPerMailbox; i++) {
      expect((await call(`/v1/mailboxes/${box}/messages`, { ct: 'abc', ttl: 60 }, NOW, `sender${i}`)).status).toBe(201);
    }
    expect(errorOf(await call(`/v1/mailboxes/${box}/messages`, { ct: 'abc', ttl: 60 }, NOW, 'another'))).toBe('mailbox-full');
  });

  it('rejects bad input', async () => {
    const box = id('f');
    const bad = [
      ['/v1/mailboxes/claim', { id: 'short', token: id('t') }],
      ['/v1/mailboxes/claim', { id: box }],
      [`/v1/mailboxes/${box}/messages`, { ct: '<script>', ttl: 60 }],
      [`/v1/mailboxes/${box}/messages`, { ct: 'a'.repeat(LIMITS.ctChars + 1), ttl: 60 }],
      [`/v1/mailboxes/${box}/messages`, { ct: 'abc', ttl: 10 }],
      [`/v1/mailboxes/${box}/messages`, { ct: 'abc', ttl: 999_999 }],
      [`/v1/mailboxes/${box}/messages`, { ct: 'abc', ttl: 60.5 }],
      ['/v1/inbox', { boxes: [] }],
      ['/v1/inbox', { boxes: Array.from({ length: LIMITS.boxesPerInbox + 1 }, () => ({ id: box, token: id('t') })) }],
      ['/v1/inbox', 'nope'],
      ['/v1/codes', { code: '123456', ct: '' }],
      ['/v1/codes', { code: '1234', ct: 'abc' }],
      ['/v1/codes/redeem', { code: '12345' }],
      ['/v1/codes/redeem', { code: '12345a' }],
    ] as const;
    for (const [path, body] of bad) expect((await call(path, body)).status, `${path} ${JSON.stringify(body).slice(0, 60)}`).toBe(400);
    expect((await call('/v1/elsewhere', {})).status).toBe(404);
    expect((await relay.handle({ method: 'GET', path: '/v1/inbox', body: undefined, clientKey: 'x' }, NOW)).status).toBe(405);
  });
});

describe('six-digit codes', () => {
  it('redeems a code exactly once', async () => {
    const code = '042917';
    const made = await call('/v1/codes', { code, ct: 'cGF5bG9hZA' });
    expect(made.status).toBe(201);
    expect((made.body as { expiresAt: number }).expiresAt).toBe(NOW + LIMITS.codeTtlMs);
    expect(errorOf(await call('/v1/codes', { code, ct: 'b3RoZXI' }))).toBe('taken');
    expect((await call('/v1/codes/redeem', { code })).body).toEqual({ ct: 'cGF5bG9hZA' });
    expect(errorOf(await call('/v1/codes/redeem', { code }))).toBe('no-such-code');
  });

  it('expires codes', async () => {
    const code = '123456';
    await call('/v1/codes', { code, ct: 'abc' });
    expect(errorOf(await call('/v1/codes/redeem', { code }, NOW + LIMITS.codeTtlMs + 1))).toBe('no-such-code');
  });

  it('limits guessing per client', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 32; i++) statuses.push((await call('/v1/codes/redeem', { code: String(100000 + i) }, NOW, 'guesser')).status);
    expect(statuses.slice(0, 30).every((s) => s === 404)).toBe(true);
    expect(statuses.slice(30)).toEqual([429, 429]);
    // A new window allows more.
    expect((await call('/v1/codes/redeem', { code: '999999' }, NOW + 10 * 60 * 1000, 'guesser')).status).toBe(404);
  });

  it('limits code creation per client', async () => {
    for (let i = 0; i < 60; i++) expect((await call('/v1/codes', { code: String(200000 + i), ct: 'abc' }, NOW, 'maker')).status).toBe(201);
    expect((await call('/v1/codes', { code: '300000', ct: 'abc' }, NOW, 'maker')).status).toBe(429);
  });

  it('keeps a redeemed code reserved, so nobody who overheard it can put up their own', async () => {
    const code = '424242';
    await call('/v1/codes', { code, ct: 'cmVhbA' }, NOW, 'owner');
    expect((await call('/v1/codes/redeem', { code }, NOW, 'eavesdropper')).body).toEqual({ ct: 'cmVhbA' });
    expect(errorOf(await call('/v1/codes', { code, ct: 'ZmFrZQ' }, NOW + 1000, 'eavesdropper'))).toBe('taken');
    expect(errorOf(await call('/v1/codes/redeem', { code }, NOW + 2000, 'victim'))).toBe('no-such-code');
    // Once its time is up the code is free again.
    expect((await call('/v1/codes', { code, ct: 'bmV3' }, NOW + LIMITS.codeTtlMs + 1, 'someone')).status).toBe(201);
  });

  it('stops online guessing across all clients once misses pass a shared budget', async () => {
    let refused = 0;
    for (let i = 0; i < 2100; i++) if ((await call('/v1/codes/redeem', { code: String(500000 + i) }, NOW, `g${i % 300}`)).status === 429) refused++;
    expect(refused).toBeGreaterThan(0);
  });
});

describe('purge', () => {
  it('removes expired messages, codes and idle mailboxes', async () => {
    const { box, token } = await owned('t');
    await call('/v1/mailboxes/claim', { id: box, token });
    await call(`/v1/mailboxes/${box}/messages`, { ct: 'abc', ttl: 60 });
    await call('/v1/codes', { code: '555555', ct: 'abc' });
    relay.purge(NOW + LIMITS.mailboxIdleMs + 1);
    const count = (table: string) => sql.all<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)[0]!.n;
    expect([count('mailboxes'), count('messages'), count('codes')]).toEqual([0, 0, 0]);
  });
});

describe('rate limiter', () => {
  it('stays bounded under a flood of new clients without locking anyone out', () => {
    const limiter = new RateLimiter();
    let refused = 0;
    for (let i = 0; i < 250_000; i++) if (!limiter.hit(`ip${i}`, 'any', NOW)) refused++;
    expect(refused).toBe(0);
    expect(limiter.tracked).toBeLessThanOrEqual(200_000);
    expect(limiter.hit('newcomer', 'any', NOW)).toBe(true);
  });

  it('treats one IPv6 /64 as one client, and IPv4 addresses as themselves', () => {
    expect(clientPrefix('203.0.113.7')).toBe('203.0.113.7');
    expect(clientPrefix('::ffff:203.0.113.7')).toBe('203.0.113.7');
    const a = clientPrefix('2001:db8:aa:1:1111:2222:3333:4444');
    expect(clientPrefix('2001:0db8:00aa:0001:ffff::1')).toBe(a);
    expect(clientPrefix('2001:db8:aa:1::')).toBe(a);
    expect(clientPrefix('2001:db8:aa:2::1')).not.toBe(a);
    expect(clientPrefix('2001:db8::1')).toBe('2001:db8:0:0::/64');
  });
});
