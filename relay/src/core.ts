// Relay logic, independent of the hosting platform. Storage is SQLite through a tiny adapter,
// so the same SQL runs in a Cloudflare Durable Object and in tests (node:sqlite).
// Every input is untrusted: validated, size-limited and rate-limited before it touches storage.

export interface Sql {
  all<T = Record<string, unknown>>(query: string, ...params: (string | number | null)[]): T[];
  run(query: string, ...params: (string | number | null)[]): void;
}

export interface RelayRequest {
  method: string;
  path: string;
  /** Parsed JSON body, or undefined. */
  body: unknown;
  /** Salted hash of the client IP, made by the edge worker. Never stored. */
  clientKey: string;
}

export interface RelayResponse {
  status: number;
  body: unknown;
}

const ID = /^[A-Za-z0-9_-]{22}$/;
const CT = /^[A-Za-z0-9_-]+$/;
const CODE = /^\d{6}$/;

export const LIMITS = {
  ctChars: 12_000,
  messagesPerMailbox: 50,
  ttlMinS: 60,
  ttlMaxS: 86_400,
  boxesPerInbox: 100,
  idsPerAck: 200,
  codeTtlMs: 2 * 60 * 1000,
  mailboxIdleMs: 45 * 24 * 60 * 60 * 1000,
  maxActiveCodes: 50_000,
  maxMessages: 200_000,
  /** Cap on one inbox reply; anything left comes on the next sync, after the client acks. */
  inboxReplyChars: 512 * 1024,
} as const;

/**
 * Requests per client per 10-minute window, by kind. A "client" is one IPv4 address or one IPv6 /64 (see
 * clientPrefix). Budgets leave room for a whole venue behind one shared Wi-Fi address: each phone makes roughly
 * 10 to 20 inbox calls per 10 minutes.
 */
const BUDGETS = {
  any: 3000,
  claim: 300,
  send: 600,
  inbox: 1200,
  'code-create': 60,
  'code-redeem': 30,
  /** Per target mailbox, whoever sends: stops one mailbox being flooded from many addresses. */
  'send-to': 60,
  /** Failed code redeems across ALL clients: online guessing of six-digit codes stops at this rate. */
  'code-miss': 2000,
} as const;
/** Key used for budgets that are shared by everyone. */
const EVERYONE = '*';
type Bucket = keyof typeof BUDGETS;
const WINDOW_MS = 10 * 60 * 1000;

/** Sweep expired limiter entries above this size; above MAX_TRACKED evict the oldest, so memory stays bounded. */
const SWEEP_AT = 100_000;
const MAX_TRACKED = 200_000;

/**
 * The part of an address that identifies one client: the whole IPv4 address, or the first 64 bits of an IPv6
 * address (one network usually holds a whole /64, so per-address budgets would be endless there).
 */
export function clientPrefix(ip: string): string {
  if (!ip.includes(':')) return ip;
  const v4tail = /:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (v4tail && /^::ffff:/i.test(ip)) return v4tail[1]!; // IPv4-mapped IPv6
  const [head = '', tail = ''] = ip.toLowerCase().split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, '') || '0')
    .join(':') + '::/64';
}

/** In-memory fixed-window limiter. Nothing here is persisted. */
export class RateLimiter {
  /** Per-client counters: the only ones a flood can fill, so the only ones that are ever evicted. */
  private counts = new Map<string, { n: number; start: number }>();
  /** Shared counters (everyone, per target mailbox): kept apart, so a flood of new clients can't reset them. */
  private shared = new Map<string, { n: number; start: number }>();
  private lastSweep = 0;
  hit(clientKey: string, bucket: Bucket, now: number): boolean {
    if (clientKey === EVERYONE || bucket === 'send-to') return this.hitShared(`${bucket}:${clientKey}`, bucket, now);
    const key = `${bucket}:${clientKey}`;
    const e = this.counts.get(key);
    if (!e || now - e.start >= WINDOW_MS) {
      // Sweep at most once a second, so a flood of new clients can't make every request walk the whole map.
      if (this.counts.size >= SWEEP_AT && now - this.lastSweep >= 1000) this.sweep(now);
      // Still full under a flood: drop the oldest entries rather than refusing everyone new.
      if (!e && this.counts.size >= MAX_TRACKED) this.evictOldest(Math.ceil(MAX_TRACKED / 100));
      this.counts.delete(key); // re-insert so Map order stays oldest-first
      this.counts.set(key, { n: 1, start: now });
      return true;
    }
    e.n += 1;
    return e.n <= BUDGETS[bucket];
  }
  private hitShared(key: string, bucket: Bucket, now: number): boolean {
    const e = this.shared.get(key);
    if (!e || now - e.start >= WINDOW_MS) {
      if (this.shared.size >= SWEEP_AT) for (const [k, v] of this.shared) if (now - v.start >= WINDOW_MS) this.shared.delete(k);
      this.shared.set(key, { n: 1, start: now });
      return true;
    }
    e.n += 1;
    return e.n <= BUDGETS[bucket];
  }
  /** How many limiter entries are held (tests). */
  get tracked(): number {
    return this.counts.size;
  }
  /** Has this client already used up `bucket`? Doesn't count a request. */
  spent(clientKey: string, bucket: Bucket, now: number): boolean {
    const map = clientKey === EVERYONE || bucket === 'send-to' ? this.shared : this.counts;
    const e = map.get(`${bucket}:${clientKey}`);
    return !!e && now - e.start < WINDOW_MS && e.n >= BUDGETS[bucket];
  }
  private evictOldest(n: number) {
    for (const k of this.counts.keys()) {
      if (n-- <= 0) break;
      this.counts.delete(k);
    }
  }
  private sweep(now: number) {
    this.lastSweep = now;
    for (const [k, v] of this.counts) if (now - v.start >= WINDOW_MS) this.counts.delete(k);
  }
}

const ok = (body: unknown = { ok: true }, status = 200): RelayResponse => ({ status, body });
const fail = (status: number, error: string): RelayResponse => ({ status, body: { error } });

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}

async function sha256b64url(s: string): Promise<string> {
  return b64url(await sha256(s));
}

/**
 * A mailbox ID is made from its owner's token, so only the token holder can claim it. Mailbox IDs travel
 * in QR codes and links; without this, anyone who saw one could claim the mailbox first and take its mail.
 * Must match mailboxIdFor in the app (src/relay/crypto.ts).
 */
export async function mailboxIdFor(token: string): Promise<string> {
  return b64url((await sha256(`pebble-box-v1:${token}`)).slice(0, 16));
}

function randomId(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  let bin = '';
  for (const x of b) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export class RelayCore {
  private sql: Sql;
  private limiter: RateLimiter;
  /** Cached total message count, so a send doesn't count the whole table every time. */
  private total = { n: 0, at: -Infinity };
  // Plain fields (no parameter properties) so Node can run this file directly for the local dev server.
  constructor(sql: Sql, limiter = new RateLimiter()) {
    this.sql = sql;
    this.limiter = limiter;
  }

  migrate(): void {
    this.sql.run('CREATE TABLE IF NOT EXISTS mailboxes (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, last_used INTEGER NOT NULL)');
    this.sql.run(
      'CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, mailbox TEXT NOT NULL, ct TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL)',
    );
    this.sql.run('CREATE INDEX IF NOT EXISTS messages_mailbox ON messages(mailbox)');
    this.sql.run('CREATE INDEX IF NOT EXISTS messages_expires ON messages(expires)');
    this.sql.run('CREATE TABLE IF NOT EXISTS codes (code TEXT PRIMARY KEY, ct TEXT NOT NULL, expires INTEGER NOT NULL)');
    this.sql.run('CREATE INDEX IF NOT EXISTS mailboxes_last_used ON mailboxes(last_used)');
  }

  private totalMessages(now: number): number {
    if (now - this.total.at > 30_000) {
      this.total = { n: this.sql.all<{ n: number }>('SELECT COUNT(*) AS n FROM messages')[0]?.n ?? 0, at: now };
    }
    return this.total.n;
  }

  /** Delete everything past its lifetime. Run on a timer and occasionally on requests. */
  purge(now: number): void {
    this.sql.run('DELETE FROM messages WHERE expires <= ?', now);
    this.sql.run('DELETE FROM codes WHERE expires <= ?', now);
    this.sql.run('DELETE FROM mailboxes WHERE last_used <= ?', now - LIMITS.mailboxIdleMs);
    this.total.at = -Infinity;
  }

  async handle(req: RelayRequest, now = Date.now()): Promise<RelayResponse> {
    if (!this.limiter.hit(req.clientKey, 'any', now)) return fail(429, 'slow-down');
    if (req.method !== 'POST') return fail(405, 'method');
    if (Math.random() < 0.02) this.purge(now);

    const p = req.path;
    if (p === '/v1/mailboxes/claim') return this.claim(req, now);
    if (p === '/v1/inbox') return this.inbox(req, now);
    if (p === '/v1/inbox/ack') return this.ack(req, now);
    if (p === '/v1/codes') return this.createCode(req, now);
    if (p === '/v1/codes/redeem') return this.redeem(req, now);
    const m = /^\/v1\/mailboxes\/([A-Za-z0-9_-]{22})\/messages$/.exec(p);
    if (m) return this.send(m[1]!, req, now);
    return fail(404, 'not-found');
  }

  /**
   * Returns true if the token owns the mailbox. A mailbox whose ID is made from the token is claimed on
   * first use. Older mailboxes (random IDs, claimed before IDs were made from tokens) still work for the
   * token that claimed them, but an unclaimed random ID can no longer be claimed by anyone.
   */
  private async owns(id: string, token: string, now: number): Promise<boolean> {
    const hash = await sha256b64url(token);
    const row = this.sql.all<{ token_hash: string }>('SELECT token_hash FROM mailboxes WHERE id = ?', id)[0];
    if (row) {
      if (row.token_hash !== hash) return false;
      this.sql.run('UPDATE mailboxes SET last_used = ? WHERE id = ?', now, id);
      return true;
    }
    if ((await mailboxIdFor(token)) !== id) return false;
    this.sql.run('INSERT INTO mailboxes (id, token_hash, last_used) VALUES (?, ?, ?)', id, hash, now);
    return true;
  }

  private async claim(req: RelayRequest, now: number): Promise<RelayResponse> {
    if (!this.limiter.hit(req.clientKey, 'claim', now)) return fail(429, 'slow-down');
    const b = obj(req.body);
    const id = b?.id;
    const token = b?.token;
    if (typeof id !== 'string' || !ID.test(id) || typeof token !== 'string' || !ID.test(token)) return fail(400, 'bad-request');
    return (await this.owns(id, token, now)) ? ok() : fail(409, 'taken');
  }

  private send(mailbox: string, req: RelayRequest, now: number): RelayResponse {
    if (!this.limiter.hit(req.clientKey, 'send', now)) return fail(429, 'slow-down');
    const b = obj(req.body);
    const ct = b?.ct;
    const ttl = b?.ttl;
    if (typeof ct !== 'string' || ct.length === 0 || ct.length > LIMITS.ctChars || !CT.test(ct)) return fail(400, 'bad-request');
    if (typeof ttl !== 'number' || !Number.isInteger(ttl) || ttl < LIMITS.ttlMinS || ttl > LIMITS.ttlMaxS) return fail(400, 'bad-request');
    // Only mailboxes someone has claimed take mail, so made-up IDs can't be used to fill storage.
    // (A mailbox ID is random and 128 bits, so this says nothing useful about anyone.)
    if (!this.sql.all('SELECT 1 FROM mailboxes WHERE id = ?', mailbox).length) return fail(404, 'no-such-mailbox');
    if (!this.limiter.hit(mailbox, 'send-to', now)) return fail(429, 'mailbox-full');
    const [{ n } = { n: 0 }] = this.sql.all<{ n: number }>('SELECT COUNT(*) AS n FROM messages WHERE mailbox = ? AND expires > ?', mailbox, now);
    if (n >= LIMITS.messagesPerMailbox) return fail(429, 'mailbox-full');
    if (this.totalMessages(now) >= LIMITS.maxMessages) {
      this.purge(now);
      return fail(503, 'busy');
    }
    const id = randomId();
    this.sql.run('INSERT INTO messages (id, mailbox, ct, created, expires) VALUES (?, ?, ?, ?, ?)', id, mailbox, ct, now, now + ttl * 1000);
    this.total.n += 1;
    return ok({ id }, 201);
  }

  private parseBoxes(body: unknown, max: number): { id: string; token: string; messageIds?: unknown }[] | null {
    const boxes = obj(body)?.boxes;
    if (!Array.isArray(boxes) || boxes.length === 0 || boxes.length > max) return null;
    const out: { id: string; token: string; messageIds?: unknown }[] = [];
    for (const raw of boxes) {
      const b = obj(raw);
      if (!b || typeof b.id !== 'string' || !ID.test(b.id) || typeof b.token !== 'string' || !ID.test(b.token)) return null;
      out.push({ id: b.id, token: b.token, messageIds: b.messageIds });
    }
    return out;
  }

  private async inbox(req: RelayRequest, now: number): Promise<RelayResponse> {
    if (!this.limiter.hit(req.clientKey, 'inbox', now)) return fail(429, 'slow-down');
    const boxes = this.parseBoxes(req.body, LIMITS.boxesPerInbox);
    if (!boxes) return fail(400, 'bad-request');
    const messages: Record<string, { id: string; ct: string; created: number }[]> = {};
    let size = 0;
    let more = false;
    // Each mailbox gets a fair share of the reply (at least one full message), so one mailbox full of large
    // messages can't crowd out mail for the others.
    const share = Math.max(LIMITS.ctChars, Math.floor(LIMITS.inboxReplyChars / boxes.length));
    for (const { id, token } of boxes) {
      if (!(await this.owns(id, token, now))) continue; // not yours: say nothing about it
      const rows = this.sql.all<{ id: string; ct: string; created: number }>(
        'SELECT id, ct, created FROM messages WHERE mailbox = ? AND expires > ? ORDER BY created',
        id,
        now,
      );
      const out: { id: string; ct: string; created: number }[] = [];
      let boxSize = 0;
      for (const r of rows) {
        if (size + r.ct.length > LIMITS.inboxReplyChars || boxSize + r.ct.length > share) {
          more = true; // skip it: it comes on a later sync, once what was sent is acked
          continue;
        }
        size += r.ct.length;
        boxSize += r.ct.length;
        out.push({ id: r.id, ct: r.ct, created: r.created });
      }
      if (out.length) messages[id] = out;
    }
    return ok(more ? { messages, more } : { messages });
  }

  private async ack(req: RelayRequest, now: number): Promise<RelayResponse> {
    if (!this.limiter.hit(req.clientKey, 'inbox', now)) return fail(429, 'slow-down');
    const boxes = this.parseBoxes(req.body, LIMITS.boxesPerInbox);
    if (!boxes) return fail(400, 'bad-request');
    // Check the whole request before deleting anything, so a bad entry can't leave it half applied.
    if (boxes.some((b) => !Array.isArray(b.messageIds) || b.messageIds.length > LIMITS.idsPerAck)) return fail(400, 'bad-request');
    for (const { id, token, messageIds } of boxes) {
      if (!(await this.owns(id, token, now))) continue;
      for (const mid of messageIds as unknown[]) {
        if (typeof mid === 'string' && ID.test(mid)) this.sql.run('DELETE FROM messages WHERE id = ? AND mailbox = ?', mid, id);
      }
    }
    return ok();
  }

  /** The phone picks the code (it encrypts the payload with a key made from it); the relay refuses one in use. */
  private createCode(req: RelayRequest, now: number): RelayResponse {
    if (!this.limiter.hit(req.clientKey, 'code-create', now)) return fail(429, 'slow-down');
    const b = obj(req.body);
    const code = b?.code;
    const ct = b?.ct;
    if (typeof code !== 'string' || !CODE.test(code)) return fail(400, 'bad-request');
    if (typeof ct !== 'string' || ct.length === 0 || ct.length > LIMITS.ctChars || !CT.test(ct)) return fail(400, 'bad-request');
    this.sql.run('DELETE FROM codes WHERE expires <= ?', now);
    if (this.sql.all('SELECT 1 FROM codes WHERE code = ?', code).length) return fail(409, 'taken');
    const [{ n } = { n: 0 }] = this.sql.all<{ n: number }>('SELECT COUNT(*) AS n FROM codes');
    if (n >= LIMITS.maxActiveCodes) return fail(503, 'busy');
    const expiresAt = now + LIMITS.codeTtlMs;
    this.sql.run('INSERT INTO codes (code, ct, expires) VALUES (?, ?, ?)', code, ct, expiresAt);
    return ok({ expiresAt }, 201);
  }

  /**
   * One-time read. A redeemed code is kept as an empty "tombstone" until it would have expired, so nobody can
   * create the same code again in that time: otherwise someone who overheard a code could redeem it and put up
   * their own payload under it for the real person to type in.
   */
  private redeem(req: RelayRequest, now: number): RelayResponse {
    if (!this.limiter.hit(req.clientKey, 'code-redeem', now)) return fail(429, 'slow-down');
    if (this.limiter.spent(EVERYONE, 'code-miss', now)) return fail(429, 'slow-down');
    const code = obj(req.body)?.code;
    if (typeof code !== 'string' || !CODE.test(code)) return fail(400, 'bad-request');
    const row = this.sql.all<{ ct: string }>('SELECT ct FROM codes WHERE code = ? AND expires > ?', code, now)[0];
    if (!row || row.ct === '') {
      this.limiter.hit(EVERYONE, 'code-miss', now);
      return fail(404, 'no-such-code');
    }
    this.sql.run("UPDATE codes SET ct = '' WHERE code = ?", code);
    return ok({ ct: row.ct });
  }
}
