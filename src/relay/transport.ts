import { mailboxIdFor } from './crypto';

// How the app talks to the relay. Two implementations behind one interface:
//  - RelayTransport: the real relay over HTTPS.
//  - SimulatedTransport: in memory, for tests and for clearly labelled simulations.

export interface Box {
  id: string;
  token: string;
}
export interface InboxMessage {
  id: string;
  ct: string;
  created: number;
}

export type RelayProblem = 'offline' | 'slow-down' | 'taken' | 'rejected' | 'server';

export class RelayError extends Error {
  constructor(readonly problem: RelayProblem) {
    super(problem);
  }
}

export interface Transport {
  readonly kind: 'relay' | 'simulated';
  claim(box: Box): Promise<void>;
  send(mailboxId: string, ct: string, ttlSeconds: number): Promise<void>;
  inbox(boxes: Box[]): Promise<Record<string, InboxMessage[]>>;
  ack(acks: (Box & { messageIds: string[] })[]): Promise<void>;
  /** Store a payload under a six-digit code. Throws RelayError('taken') if the code is in use. */
  createCode(code: string, ct: string): Promise<{ expiresAt: number }>;
  /** One-time read. Null if there is no such code (or it expired). */
  redeemCode(code: string): Promise<string | null>;
}

const TIMEOUT_MS = 10_000;

/**
 * A signal that aborts after `ms`. AbortSignal.timeout is newer than the rest of what the app uses (missing on
 * older iOS Safari: verify), so fall back to AbortController + setTimeout, or no timeout at all.
 */
export function timeoutSignal(ms: number): AbortSignal | undefined {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  if (typeof AbortController === 'undefined') return undefined;
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}
const MAX_BOXES = 100;
/** Largest relay reply we read. The relay caps an inbox reply at 512 KB of ciphertext. */
const MAX_REPLY_BYTES = 1024 * 1024;
const ID = /^[A-Za-z0-9_-]{22}$/;
const CT = /^[A-Za-z0-9_-]{1,16384}$/;

/** Read a reply body without holding more than `max` bytes. */
async function readText(res: Response, max: number): Promise<string> {
  if (Number(res.headers.get('Content-Length') ?? '0') > max) throw new Error('too-large');
  if (!res.body) return res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new Error('too-large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Check an inbox reply message by message. The relay is not trusted with structure either: anything malformed is
 * dropped, and the result has no prototype, so a key like "__proto__" is just a key.
 */
export function cleanInbox(raw: unknown): Record<string, InboxMessage[]> {
  const out = Object.create(null) as Record<string, InboxMessage[]>;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [box, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!ID.test(box) || !Array.isArray(list)) continue;
    const good: InboxMessage[] = [];
    for (const m of list.slice(0, 200)) {
      const r = m as Record<string, unknown> | null;
      if (r && typeof r.id === 'string' && ID.test(r.id) && typeof r.ct === 'string' && CT.test(r.ct) && typeof r.created === 'number' && Number.isFinite(r.created)) {
        good.push({ id: r.id, ct: r.ct, created: r.created });
      }
    }
    if (good.length) out[box] = good;
  }
  return out;
}

export class RelayTransport implements Transport {
  readonly kind = 'relay' as const;
  constructor(private base: string) {}

  private async post<T>(path: string, body: unknown): Promise<{ status: number; data: T }> {
    let res: Response;
    try {
      res = await fetch(new URL(path, this.base), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: timeoutSignal(TIMEOUT_MS),
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
    } catch {
      throw new RelayError('offline');
    }
    let data: T;
    try {
      data = JSON.parse(await readText(res, MAX_REPLY_BYTES)) as T;
    } catch {
      throw new RelayError('server');
    }
    if (res.status === 429) throw new RelayError('slow-down');
    if (res.status >= 500) throw new RelayError('server');
    return { status: res.status, data };
  }

  async claim(box: Box) {
    const r = await this.post('/v1/mailboxes/claim', box);
    if (r.status === 409) throw new RelayError('taken');
    if (r.status !== 200) throw new RelayError('rejected');
  }
  async send(mailboxId: string, ct: string, ttl: number) {
    const r = await this.post(`/v1/mailboxes/${encodeURIComponent(mailboxId)}/messages`, { ct, ttl });
    if (r.status !== 201) throw new RelayError('rejected');
  }
  async inbox(boxes: Box[]) {
    const out = Object.create(null) as Record<string, InboxMessage[]>;
    for (let i = 0; i < boxes.length; i += MAX_BOXES) {
      const r = await this.post<{ messages?: unknown }>('/v1/inbox', { boxes: boxes.slice(i, i + MAX_BOXES) });
      if (r.status !== 200) throw new RelayError('rejected');
      Object.assign(out, cleanInbox(r.data?.messages));
    }
    return out;
  }
  async ack(acks: (Box & { messageIds: string[] })[]) {
    for (let i = 0; i < acks.length; i += MAX_BOXES) {
      const r = await this.post('/v1/inbox/ack', { boxes: acks.slice(i, i + MAX_BOXES) });
      if (r.status !== 200) throw new RelayError('rejected');
    }
  }
  async createCode(code: string, ct: string) {
    const r = await this.post<{ expiresAt?: number }>('/v1/codes', { code, ct });
    if (r.status === 409) throw new RelayError('taken');
    if (r.status !== 201 || typeof r.data.expiresAt !== 'number') throw new RelayError('rejected');
    return { expiresAt: r.data.expiresAt };
  }
  async redeemCode(code: string) {
    const r = await this.post<{ ct?: string }>('/v1/codes/redeem', { code });
    if (r.status === 404) return null;
    if (r.status !== 200 || typeof r.data.ct !== 'string') throw new RelayError('rejected');
    return r.data.ct;
  }
}

/** In-memory relay with the same rules that matter to the app (ownership, one-time codes, expiry). */
export class SimulatedTransport implements Transport {
  readonly kind = 'simulated' as const;
  private owners = new Map<string, string>();
  private messages = new Map<string, (InboxMessage & { expires: number })[]>();
  private codes = new Map<string, { ct: string; expires: number }>();
  private seq = 0;
  constructor(private now: () => number = Date.now) {}

  /** Same rule as the relay: a mailbox belongs to the token its ID was made from. */
  private async owns({ id, token }: Box): Promise<boolean> {
    const owner = this.owners.get(id);
    if (owner !== undefined) return owner === token;
    if ((await mailboxIdFor(token)) !== id) return false;
    this.owners.set(id, token);
    return true;
  }
  async claim(box: Box) {
    if (!(await this.owns(box))) throw new RelayError('taken');
  }
  /** Tests only: treat these mailboxes as claimed by someone else (for connections built by hand). */
  acceptMailFor(...ids: string[]) {
    for (const id of ids) if (!this.owners.has(id)) this.owners.set(id, '\u0000someone-else');
  }
  async send(mailboxId: string, ct: string, ttl: number) {
    if (!this.owners.has(mailboxId)) throw new RelayError('rejected'); // same rule as the relay: claimed mailboxes only
    const list = this.messages.get(mailboxId) ?? [];
    list.push({ id: `m${String(++this.seq).padStart(21, '0')}` /* unique: padEnd made m1 and m10 equal */, ct, created: this.now(), expires: this.now() + ttl * 1000 });
    this.messages.set(mailboxId, list);
  }
  async inbox(boxes: Box[]) {
    const out: Record<string, InboxMessage[]> = {};
    for (const b of boxes) {
      if (!(await this.owns(b))) continue;
      const live = (this.messages.get(b.id) ?? []).filter((m) => m.expires > this.now());
      if (live.length) out[b.id] = live.map(({ id, ct, created }) => ({ id, ct, created }));
    }
    return out;
  }
  async ack(acks: (Box & { messageIds: string[] })[]) {
    for (const a of acks) {
      if (!(await this.owns(a))) continue;
      this.messages.set(a.id, (this.messages.get(a.id) ?? []).filter((m) => !a.messageIds.includes(m.id)));
    }
  }
  async createCode(code: string, ct: string) {
    const existing = this.codes.get(code);
    if (existing && existing.expires > this.now()) throw new RelayError('taken');
    const expiresAt = this.now() + 2 * 60 * 1000;
    this.codes.set(code, { ct, expires: expiresAt });
    return { expiresAt };
  }
  async redeemCode(code: string) {
    const c = this.codes.get(code);
    this.codes.delete(code);
    return c && c.expires > this.now() ? c.ct : null;
  }
}

/** The relay for this build, or null when none is configured (relay features are then hidden). */
export function relayFromEnv(): Transport | null {
  const url = import.meta.env.VITE_RELAY_URL as string | undefined;
  return url ? new RelayTransport(url) : null;
}
