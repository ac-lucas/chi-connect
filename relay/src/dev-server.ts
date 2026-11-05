// Local relay for development: the same HomeCore / CodesCore over Node's built-in SQLite (in memory) and HTTP,
// with one database per home and per code shard, as on Cloudflare.
// Run from the repository root:  node relay/src/dev-server.ts   (then set VITE_RELAY_URL=http://localhost:8787)
// Not for production: no TLS, data is lost on restart.
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { clientPrefix, codeShard, CodesCore, HomeCore, type RelayResponse, type Sql } from './core.ts';

const PORT = Number(process.env.PORT ?? 8787);
// Local dev origins: the usual dev and preview ports, plus 5176/5177 for testing two "phones" side by side.
const ALLOWED = new Set(
  [5173, 4173, 5176, 5177].flatMap((port) => [`http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`]),
);
const MAX_BODY = 16 * 1024;

function memorySql(): Sql {
  const db = new DatabaseSync(':memory:');
  return {
    all: <T>(q: string, ...p: (string | number | null)[]) => db.prepare(q).all(...p) as T[],
    run: (q: string, ...p: (string | number | null)[]) => {
      db.prepare(q).run(...p);
    },
  };
}

const homes = new Map<string, HomeCore>();
const shards = new Map<string, CodesCore>();
const home = (id: string) => {
  let h = homes.get(id);
  if (!h) {
    h = new HomeCore(memorySql(), id);
    h.migrate();
    homes.set(id, h);
  }
  return h;
};
const shard = (code: string) => {
  const key = codeShard(code);
  let c = shards.get(key);
  if (!c) {
    c = new CodesCore(memorySql());
    c.migrate();
    shards.set(key, c);
  }
  return c;
};
setInterval(() => {
  const now = Date.now();
  for (const h of homes.values()) h.purge(now);
  for (const c of shards.values()) c.purge(now);
}, 60_000).unref();

async function route(path: string, body: unknown, ip: string): Promise<RelayResponse> {
  const now = Date.now();
  let m: RegExpExecArray | null;
  if ((m = /^\/v2\/homes\/([A-Za-z0-9_-]{22})\/sync$/.exec(path))) return home(m[1]!).sync(body, now);
  if ((m = /^\/v2\/homes\/([A-Za-z0-9_-]{22})\/boxes\/([A-Za-z0-9_-]{22})\/messages$/.exec(path))) return home(m[1]!).send(m[2]!, body, now);
  if (path === '/v2/codes' || path === '/v2/codes/redeem') {
    const code = (body as { code?: unknown } | undefined)?.code;
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return { status: 400, body: { error: 'bad-request' } };
    return path === '/v2/codes' ? shard(code).create(body, clientPrefix(ip), now) : shard(code).redeem(body, clientPrefix(ip), now);
  }
  return { status: 404, body: { error: 'not-found' } };
}

createServer((req, res) => {
  const origin = req.headers.origin;
  const headers: Record<string, string> = { Vary: 'Origin', 'Cache-Control': 'no-store', 'Content-Type': 'application/json' };
  if (origin && ALLOWED.has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type';
  }
  const reply = (status: number, body: unknown) => {
    res.writeHead(status, headers);
    res.end(JSON.stringify(body));
  };
  if (origin && !ALLOWED.has(origin)) return reply(403, { error: 'origin' });
  if (req.method === 'OPTIONS') {
    res.writeHead(204, headers);
    return res.end();
  }
  if (req.method !== 'POST') return reply(405, { error: 'method' });
  let size = 0;
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => {
    size += c.length;
    if (size > MAX_BODY) req.destroy();
    else chunks.push(c);
  });
  req.on('end', async () => {
    let body: unknown;
    try {
      const text = Buffer.concat(chunks).toString('utf8');
      body = text ? JSON.parse(text) : undefined;
    } catch {
      return reply(400, { error: 'bad-json' });
    }
    const out = await route(new URL(req.url ?? '/', 'http://localhost').pathname, body, req.socket.remoteAddress ?? 'local');
    reply(out.status, out.body);
  });
}).listen(PORT, () => console.log(`Local relay on http://localhost:${PORT}`));
