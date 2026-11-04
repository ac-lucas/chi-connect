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
const MAX_BOXES = 100;

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
        signal: AbortSignal.timeout(TIMEOUT_MS),
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
    } catch {
      throw new RelayError('offline');
    }
    let data: T;
    try {
      data = (await res.json()) as T;
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
    const out: Record<string, InboxMessage[]> = {};
    for (let i = 0; i < boxes.length; i += MAX_BOXES) {
      const r = await this.post<{ messages?: Record<string, InboxMessage[]> }>('/v1/inbox', { boxes: boxes.slice(i, i + MAX_BOXES) });
      if (r.status !== 200) throw new RelayError('rejected');
      Object.assign(out, r.data.messages ?? {});
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
  async send(mailboxId: string, ct: string, ttl: number) {
    const list = this.messages.get(mailboxId) ?? [];
    list.push({ id: `m${++this.seq}`.padEnd(22, '0'), ct, created: this.now(), expires: this.now() + ttl * 1000 });
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
