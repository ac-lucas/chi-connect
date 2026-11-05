// Local relay for development: the same RelayCore over Node's built-in SQLite (in memory) and HTTP.
// Run from the repository root:  node relay/src/dev-server.ts   (then set VITE_RELAY_URL=http://localhost:8787)
// Not for production: no TLS, data is lost on restart.
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { clientPrefix, RelayCore, type Sql } from './core.ts';

const PORT = Number(process.env.PORT ?? 8787);
const ALLOWED = new Set(['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:4173', 'http://127.0.0.1:4173']);
const MAX_BODY = 16 * 1024;

const db = new DatabaseSync(':memory:');
const sql: Sql = {
  all: <T>(q: string, ...p: (string | number | null)[]) => db.prepare(q).all(...p) as T[],
  run: (q: string, ...p: (string | number | null)[]) => {
    db.prepare(q).run(...p);
  },
};
const core = new RelayCore(sql);
core.migrate();
setInterval(() => core.purge(Date.now()), 60_000).unref();

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
    const out = await core.handle({
      method: req.method ?? 'GET',
      path: new URL(req.url ?? '/', 'http://localhost').pathname,
      body,
      clientKey: clientPrefix(req.socket.remoteAddress ?? 'local'),
    });
    reply(out.status, out.body);
  });
}).listen(PORT, () => console.log(`Local relay on http://localhost:${PORT}`));
