// C Wrapped (F26): a recap of your own conference, made on this phone from your own data only.
// No rankings, no comparisons with anyone else, nothing about what you skipped.
import { KNOWN_TAGS } from '../data/tags';
import type { CatchUpItem, Connection, Invite, ScheduleItem } from '../model/types';
import type { Programme } from '../programme/types';

export interface Recap {
  days: number;
  sessions: number;
  topics: { label: string; count: number }[];
  wildcards: string[];
  meetups: number;
  people: number;
  demoPeople: number;
  breathers: number;
  catchUp: number;
  papers: number;
}

export function buildRecap(
  p: Programme,
  items: ScheduleItem[],
  invites: Invite[],
  connections: Connection[],
  catchUp: CatchUpItem[],
  breathersTaken: number,
): Recap {
  const sessions = items.filter((i) => i.type === 'session');
  const topicCounts = new Map<string, number>();
  for (const s of sessions) {
    const ps = p.sessions.find((x) => x.id === s.programmeSessionId);
    for (const t of ps?.topics ?? []) topicCounts.set(t, (topicCounts.get(t) ?? 0) + 1);
  }
  const topics = [...topicCounts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id, count]) => ({ label: KNOWN_TAGS.find((t) => t.id === id)?.label ?? id, count }));
  const meetups = invites.filter((i) => (i.outgoing ? i.acceptedIds.length > 0 && i.status !== 'cancelled' : i.status === 'accepted')).length;
  return {
    days: new Set(sessions.map((s) => new Date(s.start).toDateString())).size,
    sessions: sessions.length,
    topics,
    wildcards: sessions.filter((s) => s.fromWildcard).map((s) => s.title),
    meetups,
    people: connections.filter((c) => !c.demo && c.state === 'connected').length,
    demoPeople: connections.filter((c) => c.demo).length,
    breathers: breathersTaken,
    catchUp: catchUp.length,
    papers: catchUp.reduce((n, c) => n + (c.papers?.length ?? 0), 0),
  };
}

/** Plain-text version to copy and keep (own data only, no names). */
export function recapText(r: Recap): string {
  const lines = [
    'My week, in rhythm',
    `${r.sessions} sessions over ${r.days} ${r.days === 1 ? 'day' : 'days'}.`,
    r.topics.length ? `Mostly: ${r.topics.map((t) => t.label).join(', ')}.` : '',
    r.wildcards.length ? `Wildcards tried: ${r.wildcards.length}.` : '',
    r.meetups ? `${r.meetups} ${r.meetups === 1 ? 'meetup' : 'meetups'}.` : '',
    r.people ? `${r.people} new ${r.people === 1 ? 'connection' : 'connections'}.` : '',
    r.catchUp ? `${r.catchUp} to catch up on later${r.papers ? `, ${r.papers} papers` : ''}.` : '',
    'Made with Pebble.',
  ];
  return lines.filter(Boolean).join('\n');
}
