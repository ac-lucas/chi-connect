// Cloudflare Workers entry. The edge worker handles CORS, size limits and the client key,
// then calls one SQLite-backed Durable Object that owns all relay state (strongly consistent,
// so a six-digit code can only be redeemed once). Platform behaviour: verify against current docs.
import { DurableObject } from 'cloudflare:workers';
import { clientPrefix, RelayCore, type RelayRequest, type Sql } from './core';

export interface Env {
  RELAY: DurableObjectNamespace<RelayObject>;
  /** Comma-separated list of origins allowed to call the relay from a browser. */
  ALLOWED_ORIGINS: string;
}

const MAX_BODY_BYTES = 16 * 1024;
const PURGE_EVERY_MS = 5 * 60 * 1000;

/** What the edge worker passes to the Durable Object. The IP is hashed there and never stored. */
export interface EdgeRequest {
  path: string;
  body: unknown;
  ip: string;
}

export class RelayObject extends DurableObject<Env> {
  private core: RelayCore;
  /**
   * Random salt for client keys, held in memory by the one object that does the rate limiting. Keys can't be
   * turned back into IP addresses, stay the same whichever edge isolate a request came through (a per-isolate
   * salt would hand each isolate its own budget), and change when the object restarts.
   */
  private salt: string;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.salt = Array.from(crypto.getRandomValues(new Uint8Array(16))).join('.');
    const sql = ctx.storage.sql;
    const adapter: Sql = {
      all: <T>(q: string, ...p: (string | number | null)[]) => sql.exec(q, ...p).toArray() as T[],
      run: (q: string, ...p: (string | number | null)[]) => {
        sql.exec(q, ...p);
      },
    };
    this.core = new RelayCore(adapter);
    void ctx.blockConcurrencyWhile(async () => {
      this.core.migrate();
      if ((await ctx.storage.getAlarm()) === null) await ctx.storage.setAlarm(Date.now() + PURGE_EVERY_MS);
    });
  }

  /** Returns the status and a JSON string (plain values cross the Durable Object boundary cleanly). */
  async handle(req: EdgeRequest): Promise<{ status: number; json: string }> {
    const relayReq: RelayRequest = { method: 'POST', path: req.path, body: req.body, clientKey: await this.clientKey(req.ip) };
    const res = await this.core.handle(relayReq);
    return { status: res.status, json: JSON.stringify(res.body) };
  }

  private async clientKey(ip: string): Promise<string> {
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${this.salt}|${clientPrefix(ip)}`)));
    return Array.from(h.slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  override async alarm(): Promise<void> {
    this.core.purge(Date.now());
    await this.ctx.storage.setAlarm(Date.now() + PURGE_EVERY_MS);
  }
}

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

    const stub = env.RELAY.get(env.RELAY.idFromName('main'));
    const res = await stub.handle({
      path: new URL(request.url).pathname,
      body,
      ip: request.headers.get('CF-Connecting-IP') ?? 'unknown',
    });
    return raw(res.status, res.json, cors);
  },
} satisfies ExportedHandler<Env>;
