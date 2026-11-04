import { describe, expect, it } from 'vitest';
import { formatFor, sessionTopics, topicsFromText, transformFeed } from './transform';

const H = 3_600_000;
const T0 = 1_776_157_200_000;

const feed = {
  schemeVersion: 7,
  conference: { name: 'Example 2026', year: 2026, timeZoneName: 'Europe/Brussels' },
  timeSlots: [
    { id: 1, startDate: T0, endDate: T0 + 1.5 * H },
    { id: 2, startDate: T0 + 2 * H, endDate: T0 + 1.5 * H }, // ends before it starts
    { id: 3, startDate: T0, endDate: T0 + 30 * H }, // too long
  ],
  rooms: [{ id: 10, name: 'P1 - Room 111' }],
  contentTypes: [
    { id: 20, name: 'Paper' },
    { id: 21, name: 'Break' },
    { id: 22, name: 'Plenary and Keynote' },
  ],
  contents: [
    { id: 30, title: 'Haptic maps for blind travellers in VR', addons: { doi: { url: 'https://doi.org/10.1145/1' } } },
    { id: 33, title: 'Haptic gloves in VR', addons: {} },
    { id: 31, title: 'Sneaky link', addons: { doi: { url: 'javascript:alert(1)' } } },
    { id: 32, title: 'Elsewhere', addons: { doi: { url: 'https://evil.example/x' } } },
  ],
  sessions: [
    { id: 100, name: 'Touch &amp; Feel', typeId: 20, roomId: 10, timeSlotId: 1, contentIds: [30, 31, 32, 33, 999] },
    { id: 101, name: 'Coffee', typeId: 21, roomId: 10, timeSlotId: 1, contentIds: [] },
    { id: 102, name: 'Backwards', typeId: 20, timeSlotId: 2 },
    { id: 103, name: 'Marathon', typeId: 20, timeSlotId: 3 },
    { id: 104, name: 'No slot', typeId: 20 },
    { id: 105, name: null, typeId: 20, timeSlotId: 1 },
    { id: 106, name: '<img src=x onerror=alert(1)>‮', typeId: 22, roomId: null, timeSlotId: 1 },
    'junk',
    null,
  ],
  events: [{ id: 200, name: 'Reception', typeId: 99, startDate: T0 + 8 * H, endDate: T0 + 10 * H }],
};

describe('transformFeed', () => {
  const p = transformFeed(feed, 'example', 3);

  it('keeps valid sessions and events, drops breaks and broken times', () => {
    expect(p.sessions.map((s) => s.id)).toEqual(['s106', 's100', 'e200']);
    expect(p.edition).toBe('example');
    expect(p.revision).toBe(3);
    expect(p.timeZone).toBe('Europe/Brussels');
    expect(p.sample).toBe(false);
    expect(p.credit).toMatch(/CC BY-NC-SA 4\.0/);
  });

  it('cleans text, maps formats and rooms, and keeps only safe paper links', () => {
    const s = p.sessions.find((x) => x.id === 's100')!;
    expect(s.title).toBe('Touch & Feel');
    expect(s.room).toBe('P1 - Room 111');
    expect(s.format).toBe('papers');
    expect(s.papers).toEqual([{ title: 'Haptic maps for blind travellers in VR', url: 'https://doi.org/10.1145/1' }]);
    expect(s.topics).toEqual(expect.arrayContaining(['haptics', 'vr']));
    const odd = p.sessions.find((x) => x.id === 's106')!;
    expect(odd.title).toBe('<img src=x onerror=alert(1)>'); // kept as plain text, rendered as text
    expect(odd.room).toBeUndefined();
    expect(odd.format).toBe('keynote');
  });

  it('refuses things that are not a programme', () => {
    expect(() => transformFeed(null, 'x', 1)).toThrow();
    expect(() => transformFeed({ sessions: [] }, 'x', 1)).toThrow();
    expect(() => transformFeed({ schemeVersion: 7, sessions: 'no' }, 'x', 1)).toThrow();
    expect(transformFeed({ schemeVersion: 7, sessions: [] }, 'x', 1).sessions).toEqual([]);
  });

  it('ignores an invalid time zone', () => {
    expect(transformFeed({ ...feed, conference: { timeZoneName: 'Not/AZone' } }, 'x', 1).timeZone).toBeUndefined();
  });
});

describe('topicsFromText', () => {
  it('matches labels and aliases as whole words', () => {
    expect(topicsFromText(['Data visualisation for everyone'])).toContain('visualization');
    expect(topicsFromText(['Accessible VR beyond the headset'])).toContain('vr');
  });
  it('needs capitals for two-letter aliases, so ordinary words do not match', () => {
    expect(topicsFromText(['Arte y ar en la calle'])).not.toContain('ar');
    expect(topicsFromText(['AR on the street'])).toContain('ar');
    expect(topicsFromText(['Avatars and variety'])).not.toContain('vr');
  });
});

describe('sessionTopics', () => {
  it('uses the session title, plus topics at least two papers share', () => {
    expect(sessionTopics('Touch', ['Haptic maps in VR', 'Haptic gloves', 'A robot'])).toEqual(['haptics']);
    expect(sessionTopics('Accessible VR', ['Robots at home'])).toEqual(expect.arrayContaining(['accessibility', 'vr']));
  });
});

describe('formatFor', () => {
  it('maps feed type names', () => {
    expect(formatFor('Plenary and Keynote')).toBe('keynote');
    expect(formatFor('Late-Breaking Work')).toBe('posters');
    expect(formatFor('Interactive Demos')).toBe('demos');
    expect(formatFor('Remote Paper')).toBe('papers');
    expect(formatFor('Course')).toBe('workshop');
    expect(formatFor('Meet-Ups')).toBe('other');
  });
});
