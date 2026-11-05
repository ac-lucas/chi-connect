// Cloudflare Workers entry. The edge worker handles CORS, size limits and a high per-address ceiling, then
// routes each request to one small SQLite-backed Durable Object: the device's home (its mailboxes) or one shard
// of six-digit codes. Each object is strongly consistent, so a code can only be redeemed once. Platform
// behaviour (limits, billing, alarms): verify against current docs.
import { DurableObject } from 'cloudflare:workers';
import { clientPrefix, codeShard, CodesCore, HomeCore, RateLimiter, type RelayResponse, type Sql } from './core';

export interface Env {
  HOME: DurableObjectNamespace<HomeObject>;
  CODES: DurableObjectNamespace<CodesObject>;
  /** Comma-separated list of origins allowed to call the relay from a browser. */
  ALLOWED_ORIGINS: string;
}

const MAX_BODY_BYTES = 16 * 1024;

function sqlOf(ctx: DurableObjectState): Sql {
  const sql = ctx.storage.sql;
  return {
    all: <T>(q: string, ...p: (string | number | null)[]) => sql.exec(q, ...p).toArray() as T[],
    run: (q: string, ...p: (string | number | null)[]) => {
      sql.exec(q, ...p);
    },
  };
}

type Reply = { status: number; json: string };
const reply = (r: RelayResponse): Reply => ({ status: r.status, json: JSON.stringify(r.body) });

/**
 * Wake the object when there's something to clean up (the next expiry), and only then: an idle relay costs
 * nothing. The alarm is only moved when it would come sooner, so most requests don't touch it.
 */
async function wakeFor(ctx: DurableObjectState, next: number | null): Promise<void> {
  if (next === null) return;
  const current = await ctx.storage.getAlarm();
  if (current === null || next < current) await ctx.storage.setAlarm(next);
}

/** One device's home: its mailboxes and the messages waiting in them. */
export class HomeObject extends DurableObject<Env> {
  private core: HomeCore | null = null;
  private coreHome = '';

  private homeCore(homeId: string): HomeCore {
    if (!this.core || this.coreHome !== homeId) {
      this.core = new HomeCore(sqlOf(this.ctx), homeId);
      this.coreHome = homeId;
      this.core.migrate();
    }
    return this.core;
  }

  async sync(homeId: string, body: unknown): Promise<Reply> {
    const core = this.homeCore(homeId);
    const r = await core.sync(body, Date.now());
    await wakeFor(this.ctx, core.nextWake(Date.now()));
    return reply(r);
  }

  async send(homeId: string, box: string, body: unknown): Promise<Reply> {
    const core = this.homeCore(homeId);
    const r = core.send(box, body, Date.now());
    if (r.status === 201) await wakeFor(this.ctx, core.nextWake(Date.now()));
    return reply(r);
  }

  override async alarm(): Promise<void> {
    // Clean-up doesn't need the home ID (only ownership checks do), so a core made here is never used to sync.
    const core = this.core ?? new HomeCore(sqlOf(this.ctx), '');
    core.migrate();
    const now = Date.now();
    core.purge(now);
    const next = core.nextWake(now);
    if (next === null) await this.ctx.storage.deleteAll(); // nothing left: the home is gone entirely
    else await this.ctx.storage.setAlarm(next);
  }
}

/** One shard of six-digit codes. */
export class CodesObject extends DurableObject<Env> {
  private core: CodesCore;
  /** Random salt for client keys, in memory only: keys can't be turned back into IP addresses. */
  private salt = Array.from(crypto.getRandomValues(new Uint8Array(16))).join('.');

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.core = new CodesCore(sqlOf(ctx));
    this.core.migrate();
  }

  private async clientKey(ip: string): Promise<string> {
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${this.salt}|${clientPrefix(ip)}`)));
    return Array.from(h.slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  async create(body: unknown, ip: string): Promise<Reply> {
    const r = this.core.create(body, await this.clientKey(ip), Date.now());
    if (r.status === 201) await wakeFor(this.ctx, this.core.nextWake(Date.now()));
    return reply(r);
  }

  async redeem(body: unknown, ip: string): Promise<Reply> {
    return reply(this.core.redeem(body, await this.clientKey(ip), Date.now()));
  }

  override async alarm(): Promise<void> {
    this.core.purge(Date.now());
    const next = this.core.nextWake(Date.now());
    if (next !== null) await this.ctx.storage.setAlarm(next);
  }
}

/** Per-isolate flood ceiling per client address. Approximate by design: a coarse guard, not the real limits. */
const edge = new RateLimiter();

/**
 * Read the body without ever holding more than MAX_BODY_BYTES: a missing or false Content-Length
 * (chunked uploads) can't make the worker buffer a large upload. Null if it is too big or not UTF-8.
 */
async function readBody(request: Request): Promise<string | null> {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

function corsHeaders(origin: string | null, env: Env): Record<string, string> {
  const allowed = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim());
  const h: Record<string, string> = { Vary: 'Origin' };
  if (origin && allowed.includes(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Content-Type';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}

function json(status: number, body: unknown, extra: Record<string, string>): Response {
  return raw(status, JSON.stringify(body), extra);
}

function raw(status: number, text: string, extra: Record<string, string>): Response {
  return new Response(text, {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extra,
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin');
    const cors = corsHeaders(origin, env);
    if (origin && !cors['Access-Control-Allow-Origin']) return json(403, { error: 'origin' }, cors);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return json(405, { error: 'method' }, cors);
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    if (!edge.hit(clientPrefix(ip), 'edge', Date.now())) return json(429, { error: 'slow-down' }, cors);

    const declared = Number(request.headers.get('Content-Length') ?? '0');
    if (declared > MAX_BODY_BYTES) return json(413, { error: 'too-large' }, cors);
    const text = await readBody(request);
    if (text === null) return json(413, { error: 'too-large' }, cors);
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      return json(400, { error: 'bad-json' }, cors);
    }

    const path = new URL(request.url).pathname;
    let res: Reply | null = null;
    let m: RegExpExecArray | null;
    if ((m = /^\/v2\/homes\/([A-Za-z0-9_-]{22})\/sync$/.exec(path))) {
      res = await env.HOME.get(env.HOME.idFromName(m[1]!)).sync(m[1]!, body);
    } else if ((m = /^\/v2\/homes\/([A-Za-z0-9_-]{22})\/boxes\/([A-Za-z0-9_-]{22})\/messages$/.exec(path))) {
      res = await env.HOME.get(env.HOME.idFromName(m[1]!)).send(m[1]!, m[2]!, body);
    } else if (path === '/v2/codes' || path === '/v2/codes/redeem') {
      const code = (body as { code?: unknown } | undefined)?.code;
      if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return json(400, { error: 'bad-request' }, cors);
      const shard = env.CODES.get(env.CODES.idFromName(codeShard(code)));
      res = path === '/v2/codes' ? await shard.create(body, ip) : await shard.redeem(body, ip);
    }
    if (!res) return json(404, { error: 'not-found' }, cors);
    return raw(res.status, res.json, cors);
  },
} satisfies ExportedHandler<Env>;
