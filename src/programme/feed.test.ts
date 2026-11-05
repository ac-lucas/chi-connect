import { describe, expect, it } from 'vitest';
import { checkFeed, isRevisionUrl, POLL_MS } from './feed';
import { isOver, shiftToAnchor } from './preview';
import type { Programme } from './types';

const BASE = 'https://feed.example/data';
const T0 = 1_776_157_200_000;
const programmeFile = {
  schemeVersion: 7,
  conference: { name: 'Example 2026', year: 2026 },
  timeSlots: [{ id: 1, startDate: T0, endDate: T0 + 5_400_000 }],
  contentTypes: [{ id: 20, name: 'Paper' }],
  sessions: [{ id: 100, name: 'Touch and feel', typeId: 20, timeSlotId: 1 }],
};
const emptyFile = { schemeVersion: 7, conference: { name: 'Example 2026', year: 2026 }, sessions: [] };

function fakeFetch(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: string[] = [];
  const f = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    if (!key) return new Response('{}', { status: 404 });
    const r = routes[key]!;
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as typeof fetch;
  return { f, calls };
}

const version = (edition: string, revision: number) => ({
  edition,
  revision,
  revision_url: `${BASE}/${edition}/revisions/${String(revision).padStart(3, '0')}.json`,
});

describe('checkFeed', () => {
  it('falls back to 2026 while 2027 is unpublished, and downloads the revision file', async () => {
    const { f, calls } = fakeFetch({
      [`${BASE}/chi2026/version.json`]: { body: version('chi2026', 1) },
      [`${BASE}/chi2026/revisions/001.json`]: { body: programmeFile },
    });
    const r = await checkFeed(null, 0, { now: 1e12, fetchImpl: f, base: BASE });
    expect(r.programme?.edition).toBe('chi2026');
    expect(r.programme?.revision).toBe(1);
    expect(calls[0]).toBe(`${BASE}/chi2027/version.json?t=1000000000000`);
    expect(calls[1]).toBe(`${BASE}/chi2026/version.json?t=1000000000000`);
  });

  it("remembers a revision it can't use, and skips it until the revision moves on", async () => {
    const routes = {
      [`${BASE}/chi2027/version.json`]: { body: version('chi2027', 3) },
      [`${BASE}/chi2027/revisions/003.json`]: { body: emptyFile },
    };
    const first = fakeFetch(routes);
    const r = await checkFeed(null, 0, { now: 1e12, fetchImpl: first.f, base: BASE });
    expect(r.unusable).toEqual({ edition: 'chi2027', revision: 3 });
    const again = fakeFetch(routes);
    await checkFeed(null, 0, { now: 1e12 + POLL_MS, fetchImpl: again.f, base: BASE, skip: r.unusable });
    expect(again.calls.some((c) => c.includes('/revisions/'))).toBe(false); // not downloaded again
  });

  it('falls back to 2026 when 2027 errors, not only when it is missing', async () => {
    const { f } = fakeFetch({
      [`${BASE}/chi2027/version.json`]: { status: 503, body: {} },
      [`${BASE}/chi2026/version.json`]: { body: version('chi2026', 1) },
      [`${BASE}/chi2026/revisions/001.json`]: { body: programmeFile },
    });
    expect((await checkFeed(null, 0, { now: 1e12, fetchImpl: f, base: BASE })).programme?.edition).toBe('chi2026');
  });

  it('never swaps a held 2027 programme for 2026 when 2027 has a hiccup', async () => {
    const { f, calls } = fakeFetch({
      [`${BASE}/chi2027/version.json`]: { status: 503, body: {} },
      [`${BASE}/chi2026/version.json`]: { body: version('chi2026', 1) },
      [`${BASE}/chi2026/revisions/001.json`]: { body: programmeFile },
    });
    const r = await checkFeed({ edition: 'chi2027', revision: 5 }, 0, { now: 1e12, fetchImpl: f, base: BASE });
    expect(r.programme).toBeNull();
    expect(calls.some((c) => c.includes('chi2026'))).toBe(false);
  });

  it('only downloads when the revision moves', async () => {
    const { f, calls } = fakeFetch({ [`${BASE}/chi2027/version.json`]: { body: version('chi2027', 17) } });
    const r = await checkFeed({ edition: 'chi2027', revision: 17 }, 0, { now: 1e12, fetchImpl: f, base: BASE });
    expect(r).toEqual({ programme: null, checked: true });
    expect(calls).toHaveLength(1);
  });

  it('never asks more than once a minute', async () => {
    const { f, calls } = fakeFetch({});
    const r = await checkFeed(null, 1e12 - POLL_MS + 1, { now: 1e12, fetchImpl: f, base: BASE });
    expect(r).toEqual({ programme: null, checked: false });
    expect(calls).toHaveLength(0);
  });

  it('refuses a revision URL that points anywhere else', async () => {
    const { f, calls } = fakeFetch({ [`${BASE}/chi2027/version.json`]: { body: { revision: 2, revision_url: 'https://evil.example/x.json' } } });
    expect((await checkFeed(null, 0, { now: 1e12, fetchImpl: f, base: BASE })).programme).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('keeps what it has when offline or the feed is broken', async () => {
    const offline = (async () => {
      throw new TypeError('offline');
    }) as typeof fetch;
    expect((await checkFeed(null, 0, { now: 1e12, fetchImpl: offline, base: BASE })).programme).toBeNull();
    const { f } = fakeFetch({
      [`${BASE}/chi2027/version.json`]: { body: version('chi2027', 3) },
      [`${BASE}/chi2027/revisions/003.json`]: { body: { not: 'a programme' } },
    });
    expect((await checkFeed(null, 0, { now: 1e12, fetchImpl: f, base: BASE })).programme).toBeNull();
  });
});

describe('isRevisionUrl', () => {
  it('accepts only revision files for the same edition on the feed host', () => {
    expect(isRevisionUrl(`${BASE}/chi2026/revisions/001.json`, 'chi2026', BASE)).toBe(true);
    expect(isRevisionUrl(`${BASE}/chi2027/revisions/001.json`, 'chi2026', BASE)).toBe(false);
    expect(isRevisionUrl(`${BASE}/chi2026/revisions/001.json?x=1`, 'chi2026', BASE)).toBe(false);
    expect(isRevisionUrl(`http://feed.example/data/chi2026/revisions/001.json`, 'chi2026', BASE)).toBe(false);
    expect(isRevisionUrl(`${BASE}/chi2026/../../x.json`, 'chi2026', BASE)).toBe(false);
    expect(isRevisionUrl(42, 'chi2026', BASE)).toBe(false);
  });
});

describe('preview', () => {
  const H = 3_600_000;
  // 13 April 2026, 09:00 and 15:30 in the programme's time zone (UTC+2), and a session the next day.
  const p: Programme = {
    name: 'Example',
    sample: false,
    sessions: [
      { id: 'a', title: 'A', start: Date.UTC(2026, 3, 13, 7, 0), end: Date.UTC(2026, 3, 13, 8, 30), format: 'papers', topics: [] },
      { id: 'b', title: 'B', start: Date.UTC(2026, 3, 13, 13, 30), end: Date.UTC(2026, 3, 13, 15), format: 'papers', topics: [] },
      { id: 'c', title: 'C', start: Date.UTC(2026, 3, 14, 7, 0), end: Date.UTC(2026, 3, 14, 8), format: 'papers', topics: [] },
    ],
  };

  it('knows when a programme is over', () => {
    expect(isOver(p, Date.UTC(2026, 10, 4))).toBe(true);
    expect(isOver(p, Date.UTC(2026, 3, 13, 12))).toBe(false);
  });

  it('moves day 1 to the anchor, keeping the programme’s own wall-clock times and durations', () => {
    const anchor = new Date(2026, 10, 4).getTime(); // local midnight
    const s = shiftToAnchor(p, anchor, 'Europe/Madrid').sessions;
    const local = (t: number) => {
      const d = new Date(t);
      return `${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
    };
    expect(s.map((x) => local(x.start))).toEqual(['4 9:00', '4 15:30', '5 9:00']);
    expect(s[0]!.end - s[0]!.start).toBe(1.5 * H);
  });
});
