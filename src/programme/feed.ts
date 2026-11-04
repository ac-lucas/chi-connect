// Programme feed client. Follows the feed's own rules:
//  - poll the small version.json (with a unique ?t= so no cache answers), at most once a minute;
//  - download a programme only when the revision changes, from its revision file (immutable once published);
//  - keep the last programme on the device so the app works offline.
// Prefers the newest edition that exists (the 2027 programme once it's published), else the 2026 one.
import { transformFeed, type FeedProgramme } from './transform';

export const FEED_BASE = 'https://chidigitalexperience.org/data';
export const EDITIONS = ['chi2027', 'chi2026'] as const;
/** Never poll faster than this. The feed asks for no more than every 30 s; once a minute is plenty. */
export const POLL_MS = 60_000;
/** Refuse a programme download bigger than this (the full programme is about 12 MB). */
export const MAX_FEED_BYTES = 40 * 1024 * 1024;
const MAX_VERSION_BYTES = 16 * 1024;
const TIMEOUT_MS = 60_000;

type Fetch = typeof fetch;

function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

/** Read and parse JSON without ever holding more than `max` bytes. */
async function readJson(res: Response, max: number): Promise<unknown> {
  const declared = Number(res.headers.get('Content-Length') ?? '0');
  if (declared > max) throw new Error('too-large');
  if (!res.body) return JSON.parse(await res.text());
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
  return JSON.parse(new TextDecoder('utf-8').decode(bytes));
}

/** The revision file must be on the feed's own host, under that edition's revisions folder. */
export function isRevisionUrl(url: unknown, edition: string, base = FEED_BASE): url is string {
  if (typeof url !== 'string' || url.length > 300) return false;
  try {
    const u = new URL(url);
    const b = new URL(base);
    return u.protocol === 'https:' && u.host === b.host && new RegExp(`^${b.pathname.replace(/\/$/, '')}/${edition}/revisions/\\d{1,6}\\.json$`).test(u.pathname) && !u.search && !u.hash;
  } catch {
    return false;
  }
}

export interface CheckResult {
  /** A new programme, if the revision moved (or none was held). */
  programme: FeedProgramme | null;
  /** Whether a check was actually made (false when it was too soon). */
  checked: boolean;
}

/**
 * Check for a newer programme. Returns { programme: null } when nothing changed, when it is too soon to ask
 * again, or when the feed can't be reached (the caller keeps what it has).
 */
export async function checkFeed(
  held: Pick<FeedProgramme, 'edition' | 'revision'> | null,
  lastCheckedAt: number,
  { now = Date.now(), fetchImpl = fetch as Fetch, base = FEED_BASE } = {},
): Promise<CheckResult> {
  if (now - lastCheckedAt < POLL_MS) return { programme: null, checked: false };
  for (const edition of EDITIONS) {
    let version: Record<string, unknown>;
    try {
      const res = await fetchImpl(`${base}/${edition}/version.json?t=${now}`, { cache: 'no-store', credentials: 'omit', signal: timeoutSignal(TIMEOUT_MS) });
      if (res.status === 404) continue; // this edition isn't published yet
      if (!res.ok) return { programme: null, checked: true };
      version = (await readJson(res, MAX_VERSION_BYTES)) as Record<string, unknown>;
    } catch {
      return { programme: null, checked: true }; // offline or blocked: keep what we have
    }
    const revision = version?.revision;
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) return { programme: null, checked: true };
    if (held && held.edition === edition && held.revision === revision) return { programme: null, checked: true };
    if (!isRevisionUrl(version.revision_url, edition, base)) return { programme: null, checked: true };
    try {
      // Revision files never change once published, so normal HTTP caching is fine here.
      const res = await fetchImpl(version.revision_url, { credentials: 'omit', signal: timeoutSignal(TIMEOUT_MS) });
      if (!res.ok) return { programme: null, checked: true };
      return { programme: transformFeed(await readJson(res, MAX_FEED_BYTES), edition, revision), checked: true };
    } catch {
      return { programme: null, checked: true };
    }
  }
  return { programme: null, checked: true };
}
