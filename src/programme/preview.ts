// Preview mode: when a programme is already over (for example last year's), move its days so the first one
// is the preview's anchor day, keeping each session's wall-clock time from the programme's own time zone.
// A 9:00 session in Barcelona shows at 9:00 on the matching preview day, wherever the phone is.
// Labelled as a preview wherever it shows.
import type { Programme } from './types';

interface Wall {
  y: number;
  m: number;
  d: number;
  h: number;
  min: number;
}

function wallClock(ts: number, timeZone?: string): Wall {
  if (!timeZone) {
    const d = new Date(ts);
    return { y: d.getFullYear(), m: d.getMonth(), d: d.getDate(), h: d.getHours(), min: d.getMinutes() };
  }
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
      .formatToParts(new Date(ts))
      .map((p) => [p.type, p.value]),
  );
  return { y: Number(parts.year), m: Number(parts.month) - 1, d: Number(parts.day), h: Number(parts.hour) % 24, min: Number(parts.minute) };
}

/** Whole days between two calendar dates. */
function dayDiff(a: Wall, b: Wall): number {
  return Math.round((Date.UTC(b.y, b.m, b.d) - Date.UTC(a.y, a.m, a.d)) / 86_400_000);
}

export function isOver(p: Programme, now = Date.now()): boolean {
  return p.sessions.length > 0 && p.sessions.every((s) => s.end < now);
}

/** The programme with its first day moved to `anchor` (local midnight). Times keep their wall-clock values. */
export function shiftToAnchor(p: Programme, anchor: number, timeZone?: string): Programme {
  if (!p.sessions.length) return p;
  const first = wallClock(Math.min(...p.sessions.map((s) => s.start)), timeZone);
  const a = new Date(anchor);
  const move = (ts: number) => {
    const w = wallClock(ts, timeZone);
    const day = dayDiff(first, w);
    return new Date(a.getFullYear(), a.getMonth(), a.getDate() + day, w.h, w.min).getTime();
  };
  const firstLocal = new Date(first.y, first.m, first.d).getTime();
  return {
    ...p,
    shiftedFrom: firstLocal,
    sessions: p.sessions.map((s) => {
      const start = move(s.start);
      // Keep the duration exactly (and sessions that cross midnight still end after they start).
      return { ...s, start, end: start + (s.end - s.start) };
    }),
  };
}
