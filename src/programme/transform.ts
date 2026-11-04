// Turn the programme feed (the conference system's native export, schemeVersion 7) into the app's small
// Programme shape. The feed is untrusted input: every field is type-checked, cleaned and size-limited,
// and anything malformed is dropped rather than shown.
import { KNOWN_TAGS } from '../data/tags';
import { normaliseTagText } from '../model/tags';
import { cleanText } from '../model/text';
import type { Programme, ProgrammeSession, SessionFormat } from './types';

export const MAX_SESSIONS = 5000;
export const PROGRAMME_CREDIT = 'Programme data © ACM CHI 2027, licensed under CC BY-NC-SA 4.0.';
const MAX_TITLE = 300;
const MAX_ROOM = 120;
const MAX_PAPERS = 12;
const MAX_DURATION_MS = 12 * 60 * 60 * 1000;

export interface FeedPaper {
  title: string;
  url: string;
}

export interface FeedProgramme extends Programme {
  edition: string;
  revision: number;
  /** IANA time zone the programme is in, if the feed gave a valid one. */
  timeZone?: string;
  credit: string;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) ? v : null);

/** Decode the few HTML entities that turn up in titles. The result is still rendered as text, never as HTML. */
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

const text = (v: unknown, max: number) => (typeof v === 'string' ? cleanText(decodeEntities(v), max) : '');

export function formatFor(typeName: string): SessionFormat {
  const n = typeName.toLowerCase();
  if (/keynote|plenary/.test(n)) return 'keynote';
  if (/panel/.test(n)) return 'panel';
  if (/workshop|course|symposium|consortium/.test(n)) return 'workshop';
  if (/poster|late.?breaking/.test(n)) return 'posters';
  if (/demo|interactiv/.test(n)) return 'demos';
  if (/paper|journal|case stud|talk|alt/.test(n)) return 'papers';
  return 'other';
}

// Topic matching from titles. Two-letter aliases (VR, AR, AI, UX) only count in capitals, so "ar" in other
// languages or inside words doesn't match. Everything else matches whole words after normalising.
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const topicPatterns = KNOWN_TAGS.flatMap((t) =>
  [t.label, ...t.aliases].map((name) => {
    const short = name.replace(/\s/g, '').length <= 2;
    return {
      id: t.id,
      re: short
        ? new RegExp(`(^|[^A-Za-z])${name.toUpperCase()}([^A-Za-z]|$)`)
        : // Whole words, with an optional plural "s" ("haptic" matches "Haptics", "wearable" matches "Wearables").
          new RegExp(`(^| )${escape(normaliseTagText(name).replace(/s$/, ''))}s?( |$)`),
      raw: short,
    };
  }),
);

export function topicsFromText(texts: string[], limit = 6): string[] {
  const raw = texts.join(' • ');
  const norm = ` ${normaliseTagText(raw)} `;
  const found: string[] = [];
  for (const p of topicPatterns) {
    if (found.includes(p.id)) continue;
    if (p.raw ? p.re.test(raw) : p.re.test(norm)) found.push(p.id);
    if (found.length >= limit) break;
  }
  return found;
}

/**
 * A session's topics: anything its own title names, then topics at least two of its papers mention
 * (one paper mentioning VR doesn't make a whole session about VR). At most six.
 */
export function sessionTopics(title: string, paperTitles: string[], limit = 6): string[] {
  const out = topicsFromText([title], limit);
  const counts = new Map<string, number>();
  for (const pt of paperTitles.slice(0, 40)) for (const id of topicsFromText([pt])) counts.set(id, (counts.get(id) ?? 0) + 1);
  const fromPapers = [...counts].filter(([id, n]) => n >= 2 && !out.includes(id)).sort((a, b) => b[1] - a[1]);
  for (const [id] of fromPapers) if (out.length < limit) out.push(id);
  return out;
}

function safeLink(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 300) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    if (!['doi.org', 'dl.acm.org'].includes(u.hostname)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

function validTimeZone(tz: unknown): string | undefined {
  if (typeof tz !== 'string' || tz.length > 64) return undefined;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return tz;
  } catch {
    return undefined;
  }
}

/** Throws if the feed isn't recognisably a programme. Otherwise returns what could be kept. */
export function transformFeed(raw: unknown, edition: string, revision: number): FeedProgramme {
  const feed = obj(raw);
  if (!feed || int(feed.schemeVersion) === null || !Array.isArray(feed.sessions)) throw new Error('not-a-programme');
  const conf = obj(feed.conference) ?? {};
  const year = int(conf.year);
  const name = text(conf.name, 60) || 'the programme';

  const byId = <T>(list: unknown, f: (o: Obj) => T | null) => {
    const m = new Map<number, T>();
    for (const x of arr(list)) {
      const o = obj(x);
      const id = o && int(o.id);
      if (o && id !== null) {
        const v = f(o);
        if (v !== null) m.set(id, v);
      }
    }
    return m;
  };
  const slots = byId(feed.timeSlots, (o) => {
    const s = int(o.startDate);
    const e = int(o.endDate);
    return s !== null && e !== null ? { start: s, end: e } : null;
  });
  const rooms = byId(feed.rooms, (o) => text(o.name, MAX_ROOM) || null);
  const types = byId(feed.contentTypes, (o) => text(o.name, 80) || null);
  const contents = byId(feed.contents, (o) => {
    const title = text(o.title, MAX_TITLE);
    const doi = safeLink(obj(obj(o.addons)?.doi)?.url);
    return title ? { title, doi } : null;
  });

  const sessions: ProgrammeSession[] = [];
  const add = (o: Obj, kind: 'session' | 'event', start: number | null, end: number | null) => {
    const id = int(o.id);
    const title = text(o.name, MAX_TITLE);
    if (id === null || !title || start === null || end === null) return;
    if (end <= start || end - start > MAX_DURATION_MS) return;
    const typeName = types.get(int(o.typeId) ?? -1) ?? '';
    if (/^break$/i.test(typeName)) return; // official breaks: auto-breaks cover these
    const papers = arr(o.contentIds)
      .map((c) => contents.get(int(c) ?? -1))
      .filter((c): c is { title: string; doi: string | null } => !!c);
    const room = rooms.get(int(o.roomId) ?? -1);
    const s: ProgrammeSession = {
      id: `${kind === 'session' ? 's' : 'e'}${id}`,
      title,
      start,
      end,
      format: formatFor(typeName),
      topics: sessionTopics(title, papers.map((p) => p.title)),
    };
    if (room) s.room = room;
    const links = papers.filter((p) => p.doi).slice(0, MAX_PAPERS).map((p) => ({ title: p.title, url: p.doi! }));
    if (links.length) s.papers = links;
    sessions.push(s);
  };

  for (const x of arr(feed.sessions)) {
    const o = obj(x);
    if (!o) continue;
    const slot = slots.get(int(o.timeSlotId) ?? -1);
    add(o, 'session', slot?.start ?? null, slot?.end ?? null);
    if (sessions.length >= MAX_SESSIONS) break;
  }
  for (const x of arr(feed.events)) {
    const o = obj(x);
    if (!o || sessions.length >= MAX_SESSIONS) continue;
    add(o, 'event', int(o.startDate), int(o.endDate));
  }

  sessions.sort((a, b) => a.start - b.start || a.title.localeCompare(b.title));
  return {
    name: year ? name : 'Programme',
    sample: false,
    sessions,
    edition,
    revision,
    timeZone: validTimeZone(conf.timeZoneName),
    // The attribution line the data's licence file gives for this project.
    credit: PROGRAMME_CREDIT,
  };
}
