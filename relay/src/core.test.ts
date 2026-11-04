import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { LIMITS, RelayCore, type RelayResponse, type Sql } from './core';

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
let client = 0;

beforeEach(() => {
  relay = new RelayCore(memorySql());
  relay.migrate();
  client++;
});

const call = (path: string, body: unknown, now = NOW, clientKey = `c${client}`): Promise<RelayResponse> =>
  relay.handle({ method: 'POST', path, body, clientKey }, now);
const errorOf = (r: RelayResponse) => (r.body as { error?: string }).error;

describe('mailboxes and messages', () => {
  it('delivers a message to the owner, then deletes it on ack', async () => {
    const box = id('a');
    const token = id('t');
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
    const box = id('b');
    await call('/v1/mailboxes/claim', { id: box, token: id('t') });
    expect(errorOf(await call('/v1/mailboxes/claim', { id: box, token: id('x') }))).toBe('taken');
    await call(`/v1/mailboxes/${box}/messages`, { ct: 'abc', ttl: 60 });
    const peek = await call('/v1/inbox', { boxes: [{ id: box, token: id('x') }] });
    expect((peek.body as { messages: object }).messages).toEqual({});
    await call('/v1/inbox/ack', { boxes: [{ id: box, token: id('x'), messageIds: [] }] });
    const real = await call('/v1/inbox', { boxes: [{ id: box, token: id('t') }] });
    expect(Object.keys((real.body as { messages: object }).messages)).toEqual([box]);
  });

  it('claims an unclaimed mailbox on first read', async () => {
    const box = id('c');
    await call(`/v1/mailboxes/${box}/messages`, { ct: 'abc', ttl: 60 });
    const first = await call('/v1/inbox', { boxes: [{ id: box, token: id('t') }] });
    expect(Object.keys((first.body as { messages: object }).messages)).toEqual([box]);
    expect(errorOf(await call('/v1/mailboxes/claim', { id: box, token: id('x') }))).toBe('taken');
  });

  it('expires messages after their lifetime', async () => {
    const box = id('d');
    const token = id('t');
    await call(`/v1/mailboxes/${box}/messages`, { ct: 'abc', ttl: 60 });
    const later = await call('/v1/inbox', { boxes: [{ id: box, token }] }, NOW + 61_000);
    expect((later.body as { messages: object }).messages).toEqual({});
  });

  it('caps waiting messages per mailbox', async () => {
    const box = id('e');
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
    for (let i = 0; i < 12; i++) statuses.push((await call('/v1/codes/redeem', { code: String(100000 + i) }, NOW, 'guesser')).status);
    expect(statuses.slice(0, 10).every((s) => s === 404)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
    // A new window allows more.
    expect((await call('/v1/codes/redeem', { code: '999999' }, NOW + 10 * 60 * 1000, 'guesser')).status).toBe(404);
  });

  it('limits code creation per client', async () => {
    for (let i = 0; i < 10; i++) expect((await call('/v1/codes', { code: String(200000 + i), ct: 'abc' }, NOW, 'maker')).status).toBe(201);
    expect((await call('/v1/codes', { code: '300000', ct: 'abc' }, NOW, 'maker')).status).toBe(429);
  });
});

describe('purge', () => {
  it('removes expired messages, codes and idle mailboxes', async () => {
    const box = id('g');
    await call('/v1/mailboxes/claim', { id: box, token: id('t') });
    await call(`/v1/mailboxes/${box}/messages`, { ct: 'abc', ttl: 60 });
    await call('/v1/codes', { code: '555555', ct: 'abc' });
    relay.purge(NOW + LIMITS.mailboxIdleMs + 1);
    // An idle mailbox can be claimed fresh by anyone after purge, which shows it was deleted.
    expect((await call('/v1/mailboxes/claim', { id: box, token: id('x') }, NOW + LIMITS.mailboxIdleMs + 2)).status).toBe(200);
  });
});
