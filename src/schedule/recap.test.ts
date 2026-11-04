import { describe, expect, it } from 'vitest';
import type { CatchUpItem, Connection, Invite, ScheduleItem } from '../model/types';
import { makeSampleProgramme } from '../programme/sample';
import { buildRecap, recapText } from './recap';

const p = makeSampleProgramme(new Date(2027, 3, 12).getTime());
const s = (id: string, extra: Partial<ScheduleItem> = {}): ScheduleItem => {
  const ps = p.sessions.find((x) => x.id === id)!;
  return { id: `i-${id}`, type: 'session', source: 'user', title: ps.title, start: ps.start, end: ps.end, programmeSessionId: id, ...extra };
};

describe('buildRecap', () => {
  it('counts only your own plans, with top topics and no names', () => {
    const items = [s('sample-1-2-1'), s('sample-1-3-1', { fromWildcard: true }), s('sample-2-2-1')];
    const invites = [
      { outgoing: true, acceptedIds: ['x'], status: 'pending' },
      { outgoing: true, acceptedIds: [], status: 'pending' },
      { outgoing: false, acceptedIds: [], status: 'accepted' },
    ] as unknown as Invite[];
    const people = [{ demo: false, state: 'connected' }, { demo: true, state: 'connected' }] as Connection[];
    const catchUp = [{ papers: [{ title: 'a', url: 'https://doi.org/1' }] }] as CatchUpItem[];
    const r = buildRecap(p, items, invites, people, catchUp, 4);
    expect(r).toMatchObject({ sessions: 3, days: 2, meetups: 2, people: 1, demoPeople: 1, breathers: 4, catchUp: 1, papers: 1 });
    expect(r.wildcards).toHaveLength(1);
    // Accessibility and VR each come up in two of the three sessions.
    expect(r.topics.slice(0, 2).map((x) => [x.label, x.count])).toEqual(expect.arrayContaining([['Accessibility', 2], ['Virtual reality', 2]]));
    const text = recapText(r);
    expect(text).toContain('3 sessions over 2 days.');
    expect(text).not.toMatch(/skipp/i);
  });
});
