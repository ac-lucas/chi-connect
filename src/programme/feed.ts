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
  /** A revision that was downloaded but can't be used: remember it and don't download it again. */
  unusable?: { edition: string; revision: number };
}

/**
 * Check for a newer programme. Returns { programme: null } when nothing changed, when it is too soon to ask
 * again, or when the feed can't be reached (the caller keeps what it has).
 */
export async function checkFeed(
  held: Pick<FeedProgramme, 'edition' | 'revision'> | null,
  lastCheckedAt: number,
  {
    now = Date.now(),
    fetchImpl = fetch as Fetch,
    base = FEED_BASE,
    skip = undefined as { edition: string; revision: number } | undefined,
  } = {},
): Promise<CheckResult> {
  if (now - lastCheckedAt < POLL_MS) return { programme: null, checked: false };
  // Never go back to an older edition than the one held (a hiccup on the new one must not swap in last year's).
  const heldRank = held ? EDITIONS.indexOf(held.edition as (typeof EDITIONS)[number]) : -1;
  for (const [rank, edition] of EDITIONS.entries()) {
    if (heldRank >= 0 && rank > heldRank) break;
    let version: Record<string, unknown>;
    try {
      const res = await fetchImpl(`${base}/${edition}/version.json?t=${now}`, { cache: 'no-store', credentials: 'omit', signal: timeoutSignal(TIMEOUT_MS) });
      if (res.status === 404) continue; // not published yet: try the next (older) edition
      if (!res.ok) {
        // The newest edition is having trouble. Only fall back if we hold nothing at all yet (a new install).
        if (held) return { programme: null, checked: true };
        continue;
      }
      version = (await readJson(res, MAX_VERSION_BYTES)) as Record<string, unknown>;
    } catch {
      if (held) return { programme: null, checked: true }; // offline or garbled: keep what we have
      continue;
    }
    const revision = version?.revision;
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) return { programme: null, checked: true };
    if (held && held.edition === edition && held.revision === revision) return { programme: null, checked: true };
    // Already found unusable: don't download it again until the revision moves on.
    if (skip && skip.edition === edition && skip.revision === revision) return { programme: null, checked: true };
    if (!isRevisionUrl(version.revision_url, edition, base)) return { programme: null, checked: true };
    let res: Response;
    try {
      // Revision files never change once published, so normal HTTP caching is fine here.
      res = await fetchImpl(version.revision_url, { credentials: 'omit', signal: timeoutSignal(TIMEOUT_MS) });
    } catch {
      return { programme: null, checked: true }; // network trouble: worth trying again later
    }
    if (!res.ok) return { programme: null, checked: true };
    try {
      const programme = transformFeed(await readJson(res, MAX_FEED_BYTES), edition, revision);
      if (!programme.sessions.length) return { programme: null, checked: true, unusable: { edition, revision } };
      return { programme, checked: true };
    } catch {
      return { programme: null, checked: true, unusable: { edition, revision } }; // too big or not a programme
    }
  }
  return { programme: null, checked: true };
}
