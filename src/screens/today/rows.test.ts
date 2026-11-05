import { describe, expect, it } from 'vitest';
import type { Invite, ScheduleItem } from '../../model/types';
import { buildRows, meetupOf } from './rows';

const T = (h: number) => new Date(2027, 3, 12, h).getTime();
const session = (id: string, psid: string): ScheduleItem => ({ id, type: 'session', source: 'user', title: id, start: T(11), end: T(12), programmeSessionId: psid });
const invite = (id: string, kind: Invite['kind'], psid?: string): Invite =>
  ({ id, kind, start: T(11), end: T(12), outgoing: true, senderName: 'Me', recipientIds: ['a'], acceptedIds: ['a'], status: 'sent', programmeSessionId: psid }) as unknown as Invite;
const meetupItem = (inv: Invite): ScheduleItem => ({ id: `inv-${inv.id}`, type: 'invite', source: 'invite', inviteId: inv.id, title: 'Meetup', start: inv.start, end: inv.end, programmeSessionId: inv.programmeSessionId });

describe('buildRows', () => {
  it('puts sitting together at a saved session into that session’s block', () => {
    const inv = invite('i1', 'sit-together', 'p1');
    const rows = buildRows([session('s1', 'p1'), meetupItem(inv)], [], new Map([[inv.id, inv]]));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('session');
    expect(meetupOf(rows[0]!)?.invite?.id).toBe('i1');
  });

  it('keeps other meetups as their own rows', () => {
    const walk = invite('i2', 'walk-over', 'p1');
    const other = invite('i3', 'sit-together', 'p-not-saved');
    const lunch = invite('i4', 'meal');
    const all = [walk, other, lunch];
    const rows = buildRows([session('s1', 'p1'), ...all.map(meetupItem)], [], new Map(all.map((i) => [i.id, i])));
    expect(rows.map((r) => r.kind).sort()).toEqual(['invite', 'invite', 'invite', 'session']);
    expect(meetupOf(rows.find((r) => r.kind === 'session')!)).toBeUndefined();
  });
});
