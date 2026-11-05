// Tier-2 suggestions, all pure: wildcard sessions (F15), clashes for Catch up later (F23), talk about the talk
// (F24) and session-aware nudges (F16). Nothing here stores, sends or decides on its own; the UI shows at most
// one card of each kind and every card can be dismissed.
import { KNOWN_TAGS } from '../data/tags';
import type { ScheduleItem } from '../model/types';
import type { Programme, ProgrammeSession } from '../programme/types';
import type { Busy } from './breaks';

const MIN = 60_000;

export interface Gap {
  start: number;
  end: number;
}

/** Free gaps of at least `minMinutes` between busy blocks, from `from` onwards, within the day's sessions. */
export function freeGaps(busy: Busy[], from: number, minMinutes = 30): Gap[] {
  const items = busy.filter((b) => b.end > from).sort((a, b) => a.start - b.start);
  const gaps: Gap[] = [];
  let cursor = from;
  for (const b of items) {
    if (b.start - cursor >= minMinutes * MIN) gaps.push({ start: cursor, end: b.start });
    cursor = Math.max(cursor, b.end);
  }
  return gaps;
}

const labelOf = (id: string) => KNOWN_TAGS.find((t) => t.id === id)?.label ?? id;

/**
 * A wildcard (F15): a session that fits a free gap, near your interests but outside your usual topics.
 * "Near" = its topics often appear alongside yours in this programme. Sessions on your own topics, or ones
 * you saved or skipped, are left out. Returns the best one, or null.
 */
export function pickWildcard(
  p: Programme,
  gaps: Gap[],
  myTopics: string[],
  exclude: ReadonlySet<string>,
): { session: ProgrammeSession; gap: Gap; near: string | null } | null {
  if (!gaps.length) return null;
  const mine = new Set(myTopics);
  // How often each topic shares a session with one of mine.
  const nearness = new Map<string, number>();
  for (const s of p.sessions) {
    if (!s.topics.some((t) => mine.has(t))) continue;
    for (const t of s.topics) if (!mine.has(t)) nearness.set(t, (nearness.get(t) ?? 0) + 1);
  }
  let best: { session: ProgrammeSession; gap: Gap; near: string | null; score: number } | null = null;
  for (const s of p.sessions) {
    if (exclude.has(s.id) || s.topics.length === 0 || s.topics.some((t) => mine.has(t))) continue;
    const gap = gaps.find((g) => s.start >= g.start + 5 * MIN && s.end <= g.end - 5 * MIN);
    if (!gap) continue;
    const near = s.topics.reduce<{ t: string | null; n: number }>((acc, t) => ((nearness.get(t) ?? 0) > acc.n ? { t, n: nearness.get(t)! } : acc), { t: null, n: 0 });
    const score = near.n * 10 - (s.start - gap.start) / (15 * MIN); // nearer topics first, then sooner
    if (!best || score > best.score) best = { session: s, gap, near: near.t, score };
  }
  if (!best) return null;
  // The near topic is one of *my* topics it sits next to, which reads better: "near your interest in Haptics".
  const myNear = myTopics.find((m) => p.sessions.some((s) => s.topics.includes(m) && best!.session.topics.some((t) => s.topics.includes(t)))) ?? null;
  return { session: best.session, gap: best.gap, near: myNear ? labelOf(myNear) : null };
}

/** Pairs of saved sessions that overlap, earliest first (F23). */
export function findClashes(saved: ScheduleItem[]): [ScheduleItem, ScheduleItem][] {
  const s = saved.filter((x) => x.type === 'session').sort((a, b) => a.start - b.start);
  const out: [ScheduleItem, ScheduleItem][] = [];
  for (let i = 0; i < s.length; i++) {
    for (let j = i + 1; j < s.length && s[j]!.start < s[i]!.end; j++) out.push([s[i]!, s[j]!]);
  }
  return out;
}

/** The saved session that ended most recently, within the last `windowMinutes` (F16, F24). */
export function recentlyEnded(saved: ScheduleItem[], now: number, windowMinutes = 25): ScheduleItem | null {
  const done = saved.filter((x) => x.type === 'session' && x.end <= now && now - x.end <= windowMinutes * MIN).sort((a, b) => b.end - a.end);
  return done[0] ?? null;
}

/** True when `now` is inside a saved session or protected block: nudges never interrupt those. */
export function inSomething(items: ScheduleItem[], now: number): boolean {
  return items.some((i) => i.start <= now && i.end > now && (i.type === 'session' || i.type === 'protected' || i.type === 'invite'));
}

/** A line about a session's topic that is true of the programme data: a real count, never a guess about people. */
export function topicLine(p: Programme, session: Pick<ProgrammeSession, 'topics'>): string | null {
  const t = session.topics[0];
  if (!t) return null;
  const n = p.sessions.filter((s) => s.topics.includes(t)).length;
  if (n < 2) return null;
  return `${labelOf(t)} comes up in ${n} sessions in this program.`;
}
