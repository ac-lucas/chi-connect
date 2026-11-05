// Programme feed client. Follows the feed's own rules:
//  - poll the small version.json (with a unique ?t= so no cache answers), at most once a minute;
//  - download a programme only when the revision changes, from its revision file (immutable once published);
//  - keep the last programme on the device so the app works offline.
// Only the newest edition is ever polled. Until it's published (April 2027), last year's programme is shown as a
// preview; that edition is frozen, so it's fetched once and never asked about again.
import { readTextCapped, timeoutSignal } from '../util/stream';
import { transformFeed, type FeedProgramme } from './transform';

export const FEED_BASE = 'https://chidigitalexperience.org/data';
/** The edition the app is for: polled for changes once POLL_NEWEST is switched on. */
export const NEWEST = 'chi2027';
/**
 * Off until the owner says to start (the 2027 programme arrives in April 2027). While off, the feed is never
 * polled: the frozen preview is downloaded once and that's all.
 */
export const POLL_NEWEST = false;
/** Frozen real data shown as a preview until NEWEST is out: fetched once, never polled. */
export const PREVIEW = 'chi2026';
/** Never poll faster than this. The feed asks for no more than every 30 s; once a minute is plenty. */
export const POLL_MS = 60_000;
/** Refuse a programme download bigger than this (the full programme is about 12 MB). */
export const MAX_FEED_BYTES = 40 * 1024 * 1024;
const MAX_VERSION_BYTES = 16 * 1024;
const TIMEOUT_MS = 60_000;

type Fetch = typeof fetch;
type Edition = { edition: string; revision: number };

const readJson = async (res: Response, max: number): Promise<unknown> => JSON.parse(await readTextCapped(res, max));

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
  unusable?: Edition;
}

/** An edition's current revision, 'missing' if it isn't published yet, or null if the feed couldn't be read. */
async function versionOf(edition: string, now: number, fetchImpl: Fetch, base: string): Promise<{ revision: number; url: unknown } | 'missing' | null> {
  try {
    const res = await fetchImpl(`${base}/${edition}/version.json?t=${now}`, { cache: 'no-store', credentials: 'omit', signal: timeoutSignal(TIMEOUT_MS) });
    if (res.status === 404) return 'missing';
    if (!res.ok) return null;
    const v = (await readJson(res, MAX_VERSION_BYTES)) as Record<string, unknown> | null;
    const revision = v?.revision;
    return typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0 ? { revision, url: v?.revision_url } : null;
  } catch {
    return null; // offline or garbled
  }
}

/** Download and transform one revision file. */
async function download(edition: string, revision: number, url: unknown, fetchImpl: Fetch, base: string): Promise<CheckResult> {
  if (!isRevisionUrl(url, edition, base)) return { programme: null, checked: true };
  let res: Response;
  try {
    // no-store: the app keeps its own (much smaller) copy, so the browser needn't keep another 12 MB in its cache.
    res = await fetchImpl(url, { cache: 'no-store', credentials: 'omit', signal: timeoutSignal(TIMEOUT_MS) });
  } catch {
    return { programme: null, checked: true }; // network trouble: try again later
  }
  if (!res.ok) return { programme: null, checked: true };
  try {
    const programme = transformFeed(await readJson(res, MAX_FEED_BYTES), edition, revision);
    return programme.sessions.length ? { programme, checked: true } : { programme: null, checked: true, unusable: { edition, revision } };
  } catch {
    return { programme: null, checked: true, unusable: { edition, revision } }; // too big or not a programme
  }
}

/**
 * Check for a newer programme: ask the newest edition for its revision and download it if it moved. If nothing is
 * held yet and the newest edition isn't out, fetch the frozen preview edition once. Returns { programme: null }
 * when nothing changed, when it's too soon to ask again, or when the feed can't be reached.
 */
export async function checkFeed(
  held: Edition | null,
  lastCheckedAt: number,
  { now = Date.now(), fetchImpl = fetch as Fetch, base = FEED_BASE, skip = undefined as Edition | undefined, pollNewest = POLL_NEWEST } = {},
): Promise<CheckResult> {
  if (now - lastCheckedAt < POLL_MS) return { programme: null, checked: false };
  if (!pollNewest && held) return { programme: null, checked: false }; // preview held and frozen: nothing to ask
  const isNew = (e: string, r: number) => !(held?.edition === e && held.revision === r) && !(skip?.edition === e && skip.revision === r);

  const newest = pollNewest ? await versionOf(NEWEST, now, fetchImpl, base) : 'missing';
  if (newest && newest !== 'missing') {
    return isNew(NEWEST, newest.revision) ? download(NEWEST, newest.revision, newest.url, fetchImpl, base) : { programme: null, checked: true };
  }
  // The newest edition isn't out (or didn't answer). Anything already held stays: the preview never changes.
  if (held) return { programme: null, checked: true };
  const preview = await versionOf(PREVIEW, now, fetchImpl, base);
  if (!preview || preview === 'missing' || !isNew(PREVIEW, preview.revision)) return { programme: null, checked: true };
  return download(PREVIEW, preview.revision, preview.url, fetchImpl, base);
}
