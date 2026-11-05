// Relay logic, independent of the hosting platform. Storage is SQLite through a tiny adapter, so the same SQL
// runs in Cloudflare Durable Objects and in tests (node:sqlite). Every input is untrusted: validated,
// size-limited and rate-limited before it touches storage.
//
// Layout, built for a venue of thousands:
//  - One small "home" object per device (HomeCore). A device's mailboxes all live in its home, and a mailbox
//    address is "<home>.<box>", so a sender's message goes straight to one object. A sync is one request to one
//    object: register new mailboxes, drop old ones, ack what was handled last time, and fetch new mail.
//  - Six-digit codes in 10 shards by first digit (CodesCore), so guessing limits are per shard, not global.
//  - Rate limits per device (inside its home) and per target mailbox; per-address limits only as a high
//    ceiling at the edge (worker.ts), because a whole venue shares a few Wi-Fi addresses.

export interface Sql {
  all<T = Record<string, unknown>>(query: string, ...params: (string | number | null)[]): T[];
  run(query: string, ...params: (string | number | null)[]): void;
}

export interface RelayResponse {
  status: number;
  body: unknown;
}

export const ID = /^[A-Za-z0-9_-]{22}$/;
const CT = /^[A-Za-z0-9_-]+$/;
const CODE = /^\d{6}$/;

export const LIMITS = {
  ctChars: 12_000,
  ttlMinS: 60,
  ttlMaxS: 86_400,
  messagesPerBox: 50,
  messagesPerHome: 1000,
  boxesPerHome: 1000,
  idsPerAck: 500,
  /** Cap on one sync reply; anything left comes on the next sync, after the client acks. */
  replyChars: 512 * 1024,
  codeTtlMs: 2 * 60 * 1000,
  homeIdleMs: 45 * 24 * 60 * 60 * 1000,
  maxCodesPerShard: 20_000,
} as const;

const WINDOW_MS = 10 * 60 * 1000;

/** Requests per key per 10-minute window, by kind. */
export const BUDGETS = {
  /** Syncs by one device (its home). A phone makes 1 to 10 in 10 minutes. */
  sync: 300,
  /** Messages into one mailbox, from anyone. */
  'send-box': 60,
  /** Messages into one device's home, from anyone. */
  'send-home': 600,
  /** Six-digit codes made or redeemed per client address (a venue shares addresses, so generous). */
  'code-create': 300,
  'code-redeem': 300,
  /** Failed redeems in one code shard, from everyone: online guessing stops at this rate. */
  'code-miss': 2000,
  /** Edge ceiling per client address (an IPv4 address or an IPv6 /64), for floods only. */
  edge: 30_000,
} as const;
export type Bucket = keyof typeof BUDGETS;

const SWEEP_AT = 50_000;
const MAX_TRACKED = 100_000;

/** In-memory fixed-window limiter, bounded in size. Nothing here is persisted. */
export class RateLimiter {
  private counts = new Map<string, { n: number; start: number }>();
  private lastSweep = 0;
  /** Count one request; false once `key` has used up `bucket` in this window. */
  hit(key: string, bucket: Bucket, now: number): boolean {
    const k = `${bucket}:${key}`;
    const e = this.counts.get(k);
    if (!e || now - e.start >= WINDOW_MS) {
      if (this.counts.size >= SWEEP_AT && now - this.lastSweep >= 1000) this.sweep(now);
      if (!e && this.counts.size >= MAX_TRACKED) this.evictOldest(Math.ceil(MAX_TRACKED / 100));
      this.counts.delete(k);
      this.counts.set(k, { n: 1, start: now });
      return true;
    }
    e.n += 1;
    return e.n <= BUDGETS[bucket];
  }
  /** Has `key` already used up `bucket`? Doesn't count a request. */
  spent(key: string, bucket: Bucket, now: number): boolean {
    const e = this.counts.get(`${bucket}:${key}`);
    return !!e && now - e.start < WINDOW_MS && e.n >= BUDGETS[bucket];
  }
  get tracked(): number {
    return this.counts.size;
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

/**
 * The part of an address that identifies one client: the whole IPv4 address, or the first 64 bits of an IPv6
 * address (one network usually holds a whole /64).
 */
export function clientPrefix(ip: string): string {
  if (!ip.includes(':')) return ip;
  const v4tail = /:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (v4tail && /^::ffff:/i.test(ip)) return v4tail[1]!; // IPv4-mapped IPv6
  const [head = '', tail = ''] = ip.toLowerCase().split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return (
    groups
      .slice(0, 4)
      .map((g) => g.replace(/^0+(?=.)/, '') || '0')
      .join(':') + '::/64'
  );
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

/**
 * A device's home ID is made from its secret home token, so owning a home is a hash check, not a lookup.
 * Must match homeIdFor in the app (src/relay/crypto.ts).
 */
export async function homeIdFor(token: string): Promise<string> {
  return b64url((await sha256(`pebble-home-v1:${token}`)).slice(0, 16));
}

const randomId = () => b64url(crypto.getRandomValues(new Uint8Array(16)));

const idList = (v: unknown, max: number): string[] | null => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > max) return null;
  return v.every((x) => typeof x === 'string' && ID.test(x)) ? (v as string[]) : null;
};

/** One device's mailboxes and the messages waiting in them. */
export class HomeCore {
  private sql: Sql;
  private limiter = new RateLimiter();
  private homeId: string;
  constructor(sql: Sql, homeId: string) {
    this.sql = sql;
    this.homeId = homeId;
  }

  migrate(): void {
    this.sql.run('CREATE TABLE IF NOT EXISTS boxes (id TEXT PRIMARY KEY)');
    this.sql.run('CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, box TEXT NOT NULL, ct TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL)');
    this.sql.run('CREATE INDEX IF NOT EXISTS messages_box ON messages(box, created)');
    this.sql.run('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)');
  }

  /** When the platform should next wake this home: the next message expiry, or the idle clean-up. Null if empty. */
  nextWake(now: number): number | null {
    const next = this.sql.all<{ e: number | null }>('SELECT MIN(expires) AS e FROM messages')[0]?.e ?? null;
    const used = this.sql.all<{ v: number }>("SELECT v FROM meta WHERE k = 'used'")[0]?.v;
    const idle = used !== undefined ? used + LIMITS.homeIdleMs : null;
    const times = [next, idle].filter((t): t is number => t !== null).map((t) => Math.max(t, now + 1000));
    return times.length ? Math.min(...times) : null;
  }

  /** Delete expired messages; forget the whole home once it's been idle for 45 days. */
  purge(now: number): void {
    this.sql.run('DELETE FROM messages WHERE expires <= ?', now);
    const used = this.sql.all<{ v: number }>("SELECT v FROM meta WHERE k = 'used'")[0]?.v ?? 0;
    if (now - used >= LIMITS.homeIdleMs) {
      this.sql.run('DELETE FROM messages');
      this.sql.run('DELETE FROM boxes');
      this.sql.run('DELETE FROM meta');
    }
  }

  /**
   * The device's one call: { token, add?, keep?, ack? }.
   *  - add: mailboxes to start taking mail;
   *  - keep: if given, the full list of mailboxes still in use (others are dropped, with their mail);
   *  - ack: messages handled since the last sync (deleted before anything is fetched).
   * Returns { messages: { <box>: [{ id, ct, created }] }, more? }.
   */
  async sync(body: unknown, now: number): Promise<RelayResponse> {
    const b = obj(body);
    const token = b?.token;
    if (typeof token !== 'string' || !ID.test(token) || (await homeIdFor(token)) !== this.homeId) return fail(403, 'not-yours');
    if (!this.limiter.hit('device', 'sync', now)) return fail(429, 'slow-down');
    const add = idList(b?.add, LIMITS.boxesPerHome);
    const keep = b?.keep === undefined ? null : idList(b.keep, LIMITS.boxesPerHome);
    const ack = idList(b?.ack, LIMITS.idsPerAck);
    if (!add || !ack || (b?.keep !== undefined && !keep)) return fail(400, 'bad-request');

    if (ack.length) this.sql.run(`DELETE FROM messages WHERE id IN (${ack.map(() => '?').join(',')})`, ...ack);
    if (keep) {
      const live = new Set([...keep, ...add]);
      for (const { id } of this.sql.all<{ id: string }>('SELECT id FROM boxes')) {
        if (!live.has(id)) {
          this.sql.run('DELETE FROM messages WHERE box = ?', id);
          this.sql.run('DELETE FROM boxes WHERE id = ?', id);
        }
      }
    }
    if (add.length) {
      const [{ n } = { n: 0 }] = this.sql.all<{ n: number }>('SELECT COUNT(*) AS n FROM boxes');
      if (n + add.length > LIMITS.boxesPerHome) return fail(409, 'too-many-boxes');
      for (const id of add) this.sql.run('INSERT OR IGNORE INTO boxes (id) VALUES (?)', id);
    }
    // "Last used", for the 45-day idle clean-up: written at most once a day.
    this.sql.run(
      "INSERT INTO meta (k, v) VALUES ('used', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v WHERE meta.v < ?",
      now,
      now - 24 * 60 * 60 * 1000,
    );

    const rows = this.sql.all<{ id: string; box: string; ct: string; created: number }>(
      'SELECT id, box, ct, created FROM messages WHERE expires > ? ORDER BY box, created',
      now,
    );
    const messages: Record<string, { id: string; ct: string; created: number }[]> = {};
    // Each mailbox gets a fair share of the reply, so one full mailbox can't crowd out the others.
    const boxCount = new Set(rows.map((r) => r.box)).size || 1;
    const share = Math.max(LIMITS.ctChars, Math.floor(LIMITS.replyChars / boxCount));
    const used = new Map<string, number>();
    let size = 0;
    let more = false;
    for (const r of rows) {
      const inBox = used.get(r.box) ?? 0;
      if (size + r.ct.length > LIMITS.replyChars || inBox + r.ct.length > share) {
        more = true;
        continue;
      }
      size += r.ct.length;
      used.set(r.box, inBox + r.ct.length);
      (messages[r.box] ??= []).push({ id: r.id, ct: r.ct, created: r.created });
    }
    return ok(more ? { messages, more } : { messages });
  }

  /** Anyone holding a mailbox address can leave a message: { ct, ttl }. */
  send(box: string, body: unknown, now: number): RelayResponse {
    const b = obj(body);
    const ct = b?.ct;
    const ttl = b?.ttl;
    if (typeof ct !== 'string' || ct.length === 0 || ct.length > LIMITS.ctChars || !CT.test(ct)) return fail(400, 'bad-request');
    if (typeof ttl !== 'number' || !Number.isInteger(ttl) || ttl < LIMITS.ttlMinS || ttl > LIMITS.ttlMaxS) return fail(400, 'bad-request');
    if (!this.sql.all('SELECT 1 FROM boxes WHERE id = ?', box).length) return fail(404, 'no-such-mailbox');
    if (!this.limiter.hit(box, 'send-box', now) || !this.limiter.hit('home', 'send-home', now)) return fail(429, 'mailbox-full');
    const [{ n } = { n: 0 }] = this.sql.all<{ n: number }>('SELECT COUNT(*) AS n FROM messages WHERE box = ? AND expires > ?', box, now);
    if (n >= LIMITS.messagesPerBox) return fail(429, 'mailbox-full');
    const [{ total } = { total: 0 }] = this.sql.all<{ total: number }>('SELECT COUNT(*) AS total FROM messages');
    if (total >= LIMITS.messagesPerHome) return fail(429, 'mailbox-full');
    const id = randomId();
    this.sql.run('INSERT INTO messages (id, box, ct, created, expires) VALUES (?, ?, ?, ?, ?)', id, box, ct, now, now + ttl * 1000);
    return ok({ id }, 201);
  }
}

/** One shard of six-digit codes (all codes starting with the same digit). */
export class CodesCore {
  private sql: Sql;
  private limiter = new RateLimiter();
  constructor(sql: Sql) {
    this.sql = sql;
  }

  migrate(): void {
    this.sql.run('CREATE TABLE IF NOT EXISTS codes (code TEXT PRIMARY KEY, ct TEXT NOT NULL, expires INTEGER NOT NULL)');
    this.sql.run('CREATE INDEX IF NOT EXISTS codes_expires ON codes(expires)');
  }

  purge(now: number): void {
    this.sql.run('DELETE FROM codes WHERE expires <= ?', now);
  }

  nextWake(now: number): number | null {
    const e = this.sql.all<{ e: number | null }>('SELECT MIN(expires) AS e FROM codes')[0]?.e ?? null;
    return e === null ? null : Math.max(e, now + 1000);
  }

  /** The phone picks the code (it encrypts the payload with a key made from it); the relay refuses one in use. */
  create(body: unknown, clientKey: string, now: number): RelayResponse {
    if (!this.limiter.hit(clientKey, 'code-create', now)) return fail(429, 'slow-down');
    const b = obj(body);
    const code = b?.code;
    const ct = b?.ct;
    if (typeof code !== 'string' || !CODE.test(code)) return fail(400, 'bad-request');
    if (typeof ct !== 'string' || ct.length === 0 || ct.length > LIMITS.ctChars || !CT.test(ct)) return fail(400, 'bad-request');
    this.sql.run('DELETE FROM codes WHERE expires <= ?', now);
    if (this.sql.all('SELECT 1 FROM codes WHERE code = ?', code).length) return fail(409, 'taken');
    const [{ n } = { n: 0 }] = this.sql.all<{ n: number }>('SELECT COUNT(*) AS n FROM codes');
    if (n >= LIMITS.maxCodesPerShard) return fail(503, 'busy');
    const expiresAt = now + LIMITS.codeTtlMs;
    this.sql.run('INSERT INTO codes (code, ct, expires) VALUES (?, ?, ?)', code, ct, expiresAt);
    return ok({ expiresAt }, 201);
  }

  /**
   * One-time read. A redeemed code is kept as an empty "tombstone" until it would have expired, so nobody who
   * overheard it can create the same code again with their own payload.
   */
  redeem(body: unknown, clientKey: string, now: number): RelayResponse {
    if (!this.limiter.hit(clientKey, 'code-redeem', now)) return fail(429, 'slow-down');
    if (this.limiter.spent('shard', 'code-miss', now)) return fail(429, 'slow-down');
    const code = obj(body)?.code;
    if (typeof code !== 'string' || !CODE.test(code)) return fail(400, 'bad-request');
    const row = this.sql.all<{ ct: string }>('SELECT ct FROM codes WHERE code = ? AND expires > ?', code, now)[0];
    if (!row || row.ct === '') {
      this.limiter.hit('shard', 'code-miss', now);
      return fail(404, 'no-such-code');
    }
    this.sql.run("UPDATE codes SET ct = '' WHERE code = ?", code);
    return ok({ ct: row.ct });
  }
}

/** Which code shard a code belongs to. */
export const codeShard = (code: string): string => `codes-${code[0]}`;
