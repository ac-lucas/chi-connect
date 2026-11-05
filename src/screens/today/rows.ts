// The day plan's rows and their labels: saved sessions, protected time, suggested breaks and meetups.
import type { Invite, ProtectedKind, ScheduleItem } from '../../model/types';
import type { PlannedBreak } from '../../schedule/breaks';
import { KIND_INFO } from '../../schedule/invites';
import { describeSpot } from '../../schedule/spot';

export type Row =
  /** `meetup`: sitting together at this very session, shown in the same block rather than as a second row. */
  | { kind: 'session'; item: ScheduleItem; meetup?: { item: ScheduleItem; invite: Invite } }
  | { kind: 'protected'; item: ScheduleItem }
  | { kind: 'break'; brk: PlannedBreak }
  | { kind: 'invite'; item: ScheduleItem; invite?: Invite };

export type InviteRow = Extract<Row, { kind: 'invite' }>;

export const PROTECT_LABELS: Record<Exclude<ProtectedKind, 'focus'>, { label: string; glyph: string; line: string }> = {
  recharge: { label: 'Recharge', glyph: '■', line: 'Downtime. Invites wait until it’s over.' },
  off: { label: 'Off', glyph: '⏸', line: 'Time off.' }, // no longer offered; kept so older blocks still show
};

/** Put the day's items and planned breaks in time order. */
export function buildRows(dayItems: ScheduleItem[], breaks: PlannedBreak[], invitesById: Map<string, Invite>): Row[] {
  const rows: Row[] = [];
  const sessionRows = new Map<string, Extract<Row, { kind: 'session' }>>();
  for (const item of dayItems) {
    if (item.type !== 'session') continue;
    const row = { kind: 'session' as const, item };
    rows.push(row);
    if (item.programmeSessionId && !sessionRows.has(item.programmeSessionId)) sessionRows.set(item.programmeSessionId, row);
  }
  for (const item of dayItems) {
    if (item.type === 'protected') rows.push({ kind: 'protected', item });
    else if (item.type === 'invite') {
      const invite = item.inviteId ? invitesById.get(item.inviteId) : undefined;
      // Sitting together at a session you saved: one block. Anything else (lunch, a break, arriving or walking
      // over together beforehand, sitting together at a session you haven't saved) keeps its own row.
      const host = invite?.kind === 'sit-together' && item.programmeSessionId ? sessionRows.get(item.programmeSessionId) : undefined;
      if (host && invite && !host.meetup) host.meetup = { item, invite };
      else rows.push({ kind: 'invite', item, invite });
    }
  }
  for (const brk of breaks) rows.push({ kind: 'break', brk });
  return rows.sort((a, b) => rowStart(a) - rowStart(b));
}

export const rowStart = (r: Row) => (r.kind === 'break' ? r.brk.start : r.item.start);
export const rowEnd = (r: Row) => (r.kind === 'break' ? r.brk.end : r.item.end);
export const rowKey = (r: Row) => (r.kind === 'break' ? r.brk.key : r.item.id);

export function rowGlyph(r: Row): string {
  if (r.kind === 'invite') return '◆';
  if (r.kind === 'session') return '▲';
  if (r.kind === 'protected') return PROTECT_LABELS[r.item.protectedKind as 'recharge' | 'off']?.glyph ?? '■';
  return r.brk.kind === 'meal' ? '◒' : '○';
}

export function rowKindLabel(r: Row): string {
  if (r.kind === 'invite') return r.invite ? `Social · ${KIND_INFO[r.invite.kind].label}` : 'Social';
  if (r.kind === 'session') return 'Sprint';
  if (r.kind === 'protected') return 'Protected';
  return r.brk.kind === 'meal' ? 'Lunch' : 'Breather';
}

export function rowTitle(r: Row): string {
  if (r.kind !== 'break') return r.item.title;
  return r.brk.kind === 'meal' ? 'Lunch. Eat something good.' : 'Water, air, or nothing.';
}

export function rowClass(r: Row): string {
  return r.kind === 'session' ? 'is-session' : r.kind === 'protected' ? 'is-protected' : r.kind === 'invite' ? 'is-social' : 'is-break';
}

/** The meetup in a row: an invite row, or a session with a sit-together merged into it. */
export function meetupOf(r: Row): InviteRow | undefined {
  if (r.kind === 'invite') return r;
  if (r.kind === 'session' && r.meetup) return { kind: 'invite', item: r.meetup.item, invite: r.meetup.invite };
  return undefined;
}

/** A meetup you're part of (you said yes, or you sent it and someone did): it has a shape to find each other by. */
export const isOnMeetup = (r: InviteRow): boolean => !!r.invite && (!r.invite.outgoing || r.invite.acceptedIds.length > 0);

/** "Lunch hall · Back left, by the door" for a meetup. */
export function meetupContext(item: ScheduleItem, inv: Invite): string {
  return [item.place ?? inv.place, describeSpot(inv.meetingSpot)].filter(Boolean).join(' · ') || KIND_INFO[inv.kind].label;
}
