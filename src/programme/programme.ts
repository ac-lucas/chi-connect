import { knownTagById, normaliseTagText } from '../model/tags';
import { makeSampleProgramme } from './sample';
import type { Programme, ProgrammeSession } from './types';

/** Local calendar day key, YYYY-MM-DD. */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Midnight (local) at the start of the day containing `ts`. */
export function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function programmeDays(p: Programme): number[] {
  return [...new Set(p.sessions.map((s) => startOfDay(s.start)))].sort((a, b) => a - b);
}

export function loadProgramme(sampleAnchor: number): Programme {
  // The feed client replaces this when the programme feed is wired in.
  return makeSampleProgramme(sampleAnchor);
}

const MAX_RESULTS = 40;

/** Search titles, rooms, formats and topics. Empty query lists the day's sessions. */
export function searchSessions(p: Programme, query: string, day?: number): ProgrammeSession[] {
  const q = normaliseTagText(query);
  const words = q.split(' ').filter(Boolean);
  return p.sessions
    .filter((s) => day === undefined || startOfDay(s.start) === day)
    .filter((s) => {
      if (!words.length) return true;
      const hay = normaliseTagText(
        [s.title, s.room ?? '', s.format, ...s.topics.map((t) => knownTagById(t)?.label ?? t)].join(' '),
      );
      return words.every((w) => hay.includes(w));
    })
    .sort((a, b) => a.start - b.start || a.title.localeCompare(b.title))
    .slice(0, MAX_RESULTS);
}

export function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end;
}

export function timeRange(start: number, end: number): string {
  const f = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${f(start)} – ${f(end)}`;
}

/** Spoken form for screen readers ("10:30 AM to 12:00 PM"), since "–" is not always read as "to". */
export function timeRangeSpoken(start: number, end: number): string {
  const f = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${f(start)} to ${f(end)}`;
}

export function dayLabel(day: number, style: 'short' | 'long' = 'short'): string {
  return new Date(day).toLocaleDateString(undefined, style === 'short' ? { weekday: 'short', day: 'numeric' } : { weekday: 'long', day: 'numeric', month: 'long' });
}
