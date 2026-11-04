import { describe, expect, it } from 'vitest';
import type { Connection, FollowUp, Note } from '../model/types';
import { toCsv, toIcs, toVCard } from './exports';

const c = (id: string, over: Partial<Connection['profile']> = {}, extra: Partial<Connection> = {}): Connection => ({
  id,
  profile: { displayName: 'Sam Lee', role: 'Designer', company: 'Acme, Inc; Ltd', links: ['https://example.com/sam'], ...over },
  state: 'connected',
  connectedAt: Date.UTC(2027, 3, 12),
  scheduleSharing: false,
  sharedSessionIds: [],
  demo: false,
  via: 'face-to-face',
  ...extra,
});
const notes: Note[] = [{ id: 'n', connectionId: 'a', text: 'Line one\nline two', chips: ['Same session'], createdAt: 1 }];
const fus: FollowUp[] = [
  { id: 'f1', connectionId: 'a', text: 'Send the paper, today; please', due: new Date(2027, 3, 14).getTime(), done: false },
  { id: 'f2', connectionId: 'a', text: 'No date', done: false },
  { id: 'f3', connectionId: 'a', text: 'Already done', due: new Date(2027, 3, 15).getTime(), done: true },
];

describe('vCard', () => {
  it('escapes commas, semicolons and newlines, and skips people who are not connected', () => {
    const v = toVCard([c('a'), c('b', {}, { state: 'pending-sent' })], notes);
    expect(v.match(/BEGIN:VCARD/g)).toHaveLength(1);
    expect(v).toContain('ORG:Acme\\, Inc\\; Ltd');
    expect(v).toContain('NOTE:Same session: Line one\\nline two');
    expect(v).toContain('URL:https://example.com/sam');
  });
});

describe('CSV', () => {
  it('quotes cells and neutralises formulas', () => {
    const csv = toCsv([c('a', { displayName: '=HYPERLINK("x")', role: '+1', company: '-bad' })], notes, fus);
    const [, line] = csv.split('\r\n');
    expect(line).toMatch(/^"'=HYPERLINK\(""x""\)","'\+1","'-bad"/);
    expect(line).toContain('Same session: Line one\nline two');
    expect(line).toContain('[done] Already done');
  });
});

describe('ICS', () => {
  it('makes one all-day reminder per open follow-up with a date, escaped and folded', () => {
    const long = { ...fus[0]!, id: 'f4', text: 'x'.repeat(120) };
    const ics = toIcs([...fus, long], [c('a')], Date.UTC(2027, 3, 1));
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(ics).toContain('SUMMARY:Send the paper\\, today\\; please');
    expect(ics).toContain('DTSTART;VALUE=DATE:20270414');
    expect(ics).toContain('DESCRIPTION:Follow-up with Sam Lee');
    for (const line of ics.split('\r\n')) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(ics.startsWith('BEGIN:VCALENDAR')).toBe(true);
  });
});
