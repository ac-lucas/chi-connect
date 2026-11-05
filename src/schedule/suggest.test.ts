import { describe, expect, it } from 'vitest';
import { openerFor, personOpeners, talkOpeners, pickLine } from '../data/icebreakers';
import type { ScheduleItem } from '../model/types';
import type { Programme, ProgrammeSession } from '../programme/types';
import { findClashes, freeGaps, inSomething, pickWildcard, recentlyEnded, topicLine } from './suggest';

const M = 60_000;
const T0 = new Date(2027, 3, 12, 0, 0).getTime();
const at = (h: number, m = 0) => T0 + (h * 60 + m) * M;
const ses = (id: string, from: number, to: number, topics: string[]): ProgrammeSession => ({ id, title: id, start: from, end: to, format: 'papers', topics });
const item = (id: string, from: number, to: number, type: ScheduleItem['type'] = 'session'): ScheduleItem => ({ id, type, source: 'user', title: id, start: from, end: to, programmeSessionId: id });

const programme: Programme = {
  name: 'x',
  sessions: [
    ses('mine', at(9), at(10, 30), ['haptics']),
    ses('haptics-vr', at(11), at(12), ['haptics', 'vr']),
    ses('vr-only', at(14), at(15), ['vr']),
    ses('robots-only', at(14), at(15), ['robots']),
    ses('vr-late', at(16), at(17), ['vr']),
    ses('no-topics', at(14), at(15), []),
  ],
};

describe('freeGaps', () => {
  it('finds gaps of at least the minimum, from now on', () => {
    const busy = [{ id: 'a', start: at(9), end: at(10), kind: 'session' as const }, { id: 'b', start: at(10, 20), end: at(11), kind: 'session' as const }, { id: 'c', start: at(13), end: at(14), kind: 'session' as const }];
    expect(freeGaps(busy, at(8, 50))).toEqual([{ start: at(11), end: at(13) }]);
    expect(freeGaps(busy, at(8, 0)).at(0)).toEqual({ start: at(8), end: at(9) });
  });
});

describe('pickWildcard', () => {
  it('picks a session next to my topics, not on them, that fits a gap', () => {
    const w = pickWildcard(programme, [{ start: at(13, 50), end: at(15, 30) }], ['haptics'], new Set());
    expect(w?.session.id).toBe('vr-only'); // VR sits next to haptics in this programme; robots doesn't
    expect(w?.near).toBe('Haptics');
  });
  it('leaves out sessions that do not fit, are excluded, or are on my own topics', () => {
    expect(pickWildcard(programme, [{ start: at(14, 30), end: at(15, 30) }], ['haptics'], new Set())).toBeNull();
    expect(pickWildcard(programme, [{ start: at(13, 50), end: at(15, 30) }], ['haptics'], new Set(['vr-only']))?.session.id).toBe('robots-only');
    expect(pickWildcard(programme, [], ['haptics'], new Set())).toBeNull();
  });
});

describe('clashes, recently ended, in something', () => {
  it('finds overlapping saved sessions', () => {
    const c = findClashes([item('a', at(9), at(10)), item('b', at(9, 30), at(10, 30)), item('c', at(11), at(12))]);
    expect(c.map(([x, y]) => `${x.id}+${y.id}`)).toEqual(['a+b']);
  });
  it('keeps finding clashes when several sessions share a slot, until one is left', () => {
    let saved = ['a', 'b', 'c', 'd'].map((id) => item(id, at(13, 15), at(14, 45)));
    // Keep the first of each clash shown, as someone tapping "Keep this one" would: every pair gets asked about.
    for (let i = 0; i < 3; i++) {
      const [keep, drop] = findClashes(saved)[0]!;
      expect(keep.id).toBe('a');
      saved = saved.filter((x) => x.id !== drop.id);
    }
    expect(findClashes(saved)).toEqual([]);
    expect(saved.map((x) => x.id)).toEqual(['a']);
  });
  it('finds the session that just ended', () => {
    const saved = [item('a', at(9), at(10)), item('b', at(10), at(11))];
    expect(recentlyEnded(saved, at(11, 10))?.id).toBe('b');
    expect(recentlyEnded(saved, at(12))).toBeNull();
  });
  it('knows when something is on', () => {
    expect(inSomething([item('a', at(9), at(10))], at(9, 30))).toBe(true);
    expect(inSomething([item('p', at(9), at(10), 'protected')], at(9, 30))).toBe(true);
    expect(inSomething([item('a', at(9), at(10))], at(10, 30))).toBe(false);
  });
});

describe('lines', () => {
  it('only states real counts from the programme', () => {
    expect(topicLine(programme, { topics: ['vr'] })).toBe('Virtual reality comes up in 3 sessions in this program.');
    expect(topicLine(programme, { topics: ['robots'] })).toBeNull(); // only once: not worth saying
    expect(topicLine(programme, { topics: [] })).toBeNull();
  });
  it('builds openers from the title and topic only, and picks lines steadily', () => {
    const o = talkOpeners('Haptics + XR', 'Haptics');
    expect(o[0]).toBe('What did you make of “Haptics + XR”?');
    expect(o).toHaveLength(3);
    expect(pickLine('lunch', 'k1')).toBe(pickLine('lunch', 'k1'));
  });
});

describe('conversation starters', () => {
  it('builds person lines from shared topics, their topics and shared sessions, at most three', () => {
    const lines = personOpeners({ shared: ['Haptics'], theirs: ['Haptics', 'VR'], bothSessions: ['Touch and Feel'], key: 'x' });
    expect(lines).toEqual([
      'You’re both into Haptics. What got you into it?',
      'What are you working on in VR at the moment?',
      'You’re both going to “Touch and Feel”. Compare notes after?',
    ]);
    expect(personOpeners({ shared: [], theirs: [], bothSessions: [], key: 'x' })).toHaveLength(1);
  });
  it('picks a steady line per meetup kind', () => {
    expect(openerFor('meal', 'a')).toBe(openerFor('meal', 'a'));
    expect(openerFor('sit-together', 'a')).toBeTruthy();
  });
});
