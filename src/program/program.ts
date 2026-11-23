import { knownTagById, normalizeTagText } from '../model/tags';
import { isOver, shiftToAnchor } from './preview';
import type { FeedProgram } from './transform';
import type { Program, ProgramSession } from './types';

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

/** Midnight at the start of the next day. Not `+ 24 h`: days are 23 or 25 hours long when clocks change. */
export function nextDay(ts: number): number {
  const d = new Date(startOfDay(ts));
  d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** The wall-clock time `minutes` after midnight on the day containing `ts` (correct on clock-change days). */
export function atMinutes(ts: number, minutes: number): number {
  const d = new Date(startOfDay(ts));
  d.setHours(0, minutes, 0, 0);
  return d.getTime();
}

export function programDays(p: Program): number[] {
  return [...new Set(p.sessions.map((s) => startOfDay(s.start)))].sort((a, b) => a - b);
}

/**
 * The program to show: the feed's, if one has been downloaded, else the sample. A feed program that is
 * already over (last year's) is shown as a preview, its days moved to start on the anchor day.
 */
export function resolveProgram(anchor: number, feed: FeedProgram, now = Date.now()): Program {
  return isOver(feed, now) ? shiftToAnchor(feed, anchor, feed.timeZone) : feed;
}

export const MAX_RESULTS = 40;

/** Search titles, rooms, formats and topics. Empty query lists the day's sessions. */
export function searchSessions(p: Program, query: string, day?: number): ProgramSession[] {
  const q = normalizeTagText(query);
  const words = q.split(' ').filter(Boolean);
  return p.sessions
    .filter((s) => day === undefined || startOfDay(s.start) === day)
    .filter((s) => {
      if (!words.length) return true;
      const hay = normalizeTagText(
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

/** One shared formatter: building one per call is the slow part when a screen shows dozens of times. */
const CLOCK = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

/** A time of day in the device's style ("10:30 AM" or "10:30"). */
export const clockTime = (t: number): string => CLOCK.format(t);

export function timeRange(start: number, end: number): string {
  return `${clockTime(start)} – ${clockTime(end)}`;
}

/** Spoken form for screen readers ("10:30 AM to 12:00 PM"), since "–" is not always read as "to". */
export function timeRangeSpoken(start: number, end: number): string {
  return `${clockTime(start)} to ${clockTime(end)}`;
}

export function dayLabel(day: number, style: 'short' | 'long' = 'short'): string {
  return new Date(day).toLocaleDateString(undefined, style === 'short' ? { weekday: 'short', day: 'numeric' } : { weekday: 'long', day: 'numeric', month: 'long' });
}
