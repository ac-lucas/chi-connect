import { readTextCapped, timeoutSignal } from '../util/stream';
import { ADDRESS, splitAddress, type Home } from './address';
import { homeIdFor } from './crypto';

// How the app talks to the relay. Two implementations behind one interface:
//  - RelayTransport: the real relay over HTTPS.
//  - SimulatedTransport: in memory, for tests, with the same rules.
// A device has one home on the relay; a sync is one request (register, drop, ack and fetch at once).

export interface InboxMessage {
  id: string;
  ct: string;
  created: number;
}

export interface SyncReply {
  /** New messages, by mailbox (the box part of the address). */
  messages: Record<string, InboxMessage[]>;
  /** The relay held back some messages (reply size cap): sync again soon. */
  more: boolean;
}

export type RelayProblem = 'offline' | 'slow-down' | 'taken' | 'rejected' | 'server';

export class RelayError extends Error {
  constructor(readonly problem: RelayProblem) {
    super(problem);
  }
}

export interface Transport {
  readonly kind: 'relay' | 'simulated';
  /** Start taking mail in these mailboxes (box IDs in this home). */
  register(home: Home, boxes: string[]): Promise<void>;
  /** The one sync call: ack what was handled last time, keep only these mailboxes, and fetch new mail. */
  sync(home: Home, req: { keep: string[]; ack: string[] }): Promise<SyncReply>;
  /** Leave a message at a mailbox address. */
  send(address: string, ct: string, ttlSeconds: number): Promise<void>;
  /** Store a payload under a six-digit code. Throws RelayError('taken') if the code is in use. */
  createCode(code: string, ct: string): Promise<{ expiresAt: number }>;
  /** One-time read. Null if there is no such code (or it expired). */
  redeemCode(code: string): Promise<string | null>;
}

export { timeoutSignal } from '../util/stream';

const TIMEOUT_MS = 10_000;
/** Largest relay reply we read. The relay caps a sync reply at 512 KB of ciphertext. */
const MAX_REPLY_BYTES = 1024 * 1024;
const ID = /^[A-Za-z0-9_-]{22}$/;
const CT = /^[A-Za-z0-9_-]{1,16384}$/;

/**
 * Check a sync reply message by message. The relay is not trusted with structure either: anything malformed is
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
        // text/plain is a "simple" request type, so the browser sends no CORS preflight first: half the requests.
        // The body is still JSON; the relay parses it from text either way.
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
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
      data = JSON.parse(await readTextCapped(res, MAX_REPLY_BYTES)) as T;
    } catch {
      throw new RelayError('server');
    }
    if (res.status === 429) throw new RelayError('slow-down');
    if (res.status >= 500) throw new RelayError('server');
    return { status: res.status, data };
  }

  async register(home: Home, boxes: string[]) {
    const r = await this.post(`/v2/homes/${home.id}/sync`, { token: home.token, add: boxes });
    if (r.status !== 200) throw new RelayError('rejected');
  }
  async sync(home: Home, req: { keep: string[]; ack: string[] }) {
    const r = await this.post<{ messages?: unknown; more?: unknown }>(`/v2/homes/${home.id}/sync`, { token: home.token, keep: req.keep, ack: req.ack });
    if (r.status !== 200) throw new RelayError('rejected');
    return { messages: cleanInbox(r.data?.messages), more: r.data?.more === true };
  }
  async send(address: string, ct: string, ttl: number) {
    if (!ADDRESS.test(address)) throw new RelayError('rejected');
    const { home, box } = splitAddress(address);
    const r = await this.post(`/v2/homes/${home}/boxes/${box}/messages`, { ct, ttl });
    if (r.status !== 201) throw new RelayError('rejected');
  }
  async createCode(code: string, ct: string) {
    const r = await this.post<{ expiresAt?: number }>('/v2/codes', { code, ct });
    if (r.status === 409) throw new RelayError('taken');
    if (r.status !== 201 || typeof r.data.expiresAt !== 'number') throw new RelayError('rejected');
    return { expiresAt: r.data.expiresAt };
  }
  async redeemCode(code: string) {
    const r = await this.post<{ ct?: string }>('/v2/codes/redeem', { code });
    if (r.status === 404) return null;
    if (r.status !== 200 || typeof r.data.ct !== 'string') throw new RelayError('rejected');
    return r.data.ct;
  }
}

/** In-memory relay with the same rules that matter to the app (home ownership, registered mailboxes, one-time codes). */
export class SimulatedTransport implements Transport {
  readonly kind = 'simulated' as const;
  private homes = new Map<string, { boxes: Set<string>; messages: (InboxMessage & { box: string; expires: number })[] }>();
  private codes = new Map<string, { ct: string; expires: number }>();
  private seq = 0;
  constructor(private now: () => number = Date.now) {}

  private async homeFor(home: Home) {
    if ((await homeIdFor(home.token)) !== home.id) throw new RelayError('rejected'); // same rule as the relay
    let h = this.homes.get(home.id);
    if (!h) {
      h = { boxes: new Set(), messages: [] };
      this.homes.set(home.id, h);
    }
    return h;
  }
  async register(home: Home, boxes: string[]) {
    const h = await this.homeFor(home);
    for (const b of boxes) h.boxes.add(b);
  }
  /** Tests only: treat this address as registered by its (unknown) owner. */
  acceptMailFor(...addresses: string[]) {
    for (const a of addresses) {
      const { home, box } = splitAddress(a);
      const h = this.homes.get(home) ?? { boxes: new Set<string>(), messages: [] };
      h.boxes.add(box);
      this.homes.set(home, h);
    }
  }
  async sync(home: Home, req: { keep: string[]; ack: string[] }) {
    const h = await this.homeFor(home);
    const keep = new Set(req.keep);
    for (const b of [...h.boxes]) if (!keep.has(b)) h.boxes.delete(b);
    h.messages = h.messages.filter((m) => !req.ack.includes(m.id) && h.boxes.has(m.box) && m.expires > this.now());
    const messages: Record<string, InboxMessage[]> = {};
    for (const m of h.messages) (messages[m.box] ??= []).push({ id: m.id, ct: m.ct, created: m.created });
    return { messages, more: false };
  }
  async send(address: string, ct: string, ttl: number) {
    const { home, box } = splitAddress(address);
    const h = this.homes.get(home);
    if (!h?.boxes.has(box)) throw new RelayError('rejected'); // registered mailboxes only, as on the relay
    h.messages.push({ id: `m${String(++this.seq).padStart(21, '0')}`, box, ct, created: this.now(), expires: this.now() + ttl * 1000 });
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
    if (!c || c.expires <= this.now() || c.ct === '') return null;
    this.codes.set(code, { ...c, ct: '' }); // reserved until it expires, like the relay's tombstone
    return c.ct;
  }
}

/** The relay for this build, or null when none is configured (relay features are then hidden). */
export function relayFromEnv(): Transport | null {
  const url = import.meta.env.VITE_RELAY_URL as string | undefined;
  return url ? new RelayTransport(url) : null;
}
