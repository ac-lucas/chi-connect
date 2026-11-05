import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { onStoresChanged, type StoreName } from './changes';
import { putConnection, putScheduleItem, resetDatabaseForTests, setSetting } from './db';

let n = 0;
beforeEach(() => resetDatabaseForTests(`changes-${n++}`));

describe('change notices', () => {
  it('writes announce what they changed, joined into one notice per moment', async () => {
    const seen: StoreName[][] = [];
    const off = onStoresChanged((s) => seen.push([...s].sort()));
    await putScheduleItem({ id: 'a', type: 'session', source: 'user', title: 'A', start: 1, end: 2 });
    await new Promise((r) => setTimeout(r, 0));
    await Promise.all([
      setSetting('quietMode', true),
      putConnection({ id: 'c', profile: { displayName: 'C' }, state: 'connected', scheduleSharing: false, sharedSessionIds: [], demo: false, via: 'face-to-face' }),
    ]);
    await new Promise((r) => setTimeout(r, 0));
    off();
    expect(seen[0]).toEqual(['schedule']);
    expect(seen.flat()).toEqual(expect.arrayContaining(['settings', 'connections']));
  });
});
