import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { randomId } from '../model/ids';
import { resolveTag } from '../model/tags';
import type { Connection } from '../model/types';
import { makeSampleProgramme } from '../programme/sample';
import { SimulatedTransport } from '../relay/transport';
import { getConnection, putConnection, putScheduleItem, resetDatabaseForTests } from '../storage/db';
import { alsoGoing, demoSessionIds, handleSessionsMessage, namesList, shareSessionsIfChanged } from './overlap';

let n = 0;
beforeEach(async () => {
  await resetDatabaseForTests(`ovl-${n++}`);
});

function real(name: string, sharing: boolean): Connection {
  return {
    id: randomId(),
    profile: { displayName: name },
    state: 'connected',
    mailboxId: randomId(),
    sharedSecret: randomId() + randomId(), // any base64url works for the simulated relay
    scheduleSharing: sharing,
    sharedSessionIds: [],
    demo: false,
    via: 'face-to-face',
  };
}

function countingRelay() {
  const relay = new SimulatedTransport();
  const sent: string[] = [];
  const send = relay.send.bind(relay);
  relay.send = async (box, ct, ttl) => {
    sent.push(box);
    return send(box, ct, ttl);
  };
  return { relay, sent };
}

const save = (pid: string) => putScheduleItem({ id: randomId(), type: 'session', source: 'user', title: pid, start: 1, end: 2, programmeSessionId: pid });

describe('sharing my saved sessions', () => {
  it('sends only to people I share with, once per change, and takes it back when I stop', async () => {
    const sam = real('Sam', true);
    const eve = real('Eve', false);
    await putConnection(sam);
    await putConnection(eve);
    await save('s1');
    const { relay, sent } = countingRelay();

    expect(await shareSessionsIfChanged(relay, 1000)).toBe(1);
    expect(sent).toEqual([sam.mailboxId]);
    expect(await shareSessionsIfChanged(relay, 2000)).toBe(0); // unchanged

    await save('s2');
    expect(await shareSessionsIfChanged(relay, 3000)).toBe(1); // changed

    await putConnection({ ...(await getConnection(sam.id))!, scheduleSharing: false });
    expect(await shareSessionsIfChanged(relay, 4000)).toBe(1); // empty list: taken back
    expect(await shareSessionsIfChanged(relay, 5000)).toBe(0);
    expect(sent.every((b) => b === sam.mailboxId)).toBe(true);
  });

  it('never sends to demo people or people not connected', async () => {
    await putConnection({ ...real('Demo', true), demo: true, via: 'demo' });
    await putConnection({ ...real('Pending', true), state: 'pending-sent' });
    await save('s1');
    const { relay, sent } = countingRelay();
    expect(await shareSessionsIfChanged(relay)).toBe(0);
    expect(sent).toEqual([]);
  });
});

describe('seeing who is going', () => {
  it('stores a list that arrives and shows overlaps', async () => {
    const sam = real('Sam', false);
    await putConnection(sam);
    await handleSessionsMessage(sam, ['sample-1-2-1']);
    const p = makeSampleProgramme(new Date(2027, 3, 12).getTime());
    const stored = (await getConnection(sam.id))!;
    expect(alsoGoing('sample-1-2-1', [stored], p).map((c) => c.profile.displayName)).toEqual(['Sam']);
    expect(alsoGoing('sample-1-2-2', [stored], p)).toEqual([]);
  });

  it('gives demo people stable, topic-matched sessions', () => {
    const p = makeSampleProgramme(new Date(2027, 3, 12).getTime());
    const mina: Connection = { ...real('Mina', false), id: 'demo-mina', demo: true, profile: { displayName: 'Mina', tags: [resolveTag('Haptics')!, resolveTag('VR')!] } };
    const ids = demoSessionIds(mina, p);
    expect(ids.length).toBeGreaterThan(0);
    expect(demoSessionIds(mina, p)).toEqual(ids);
    for (const id of ids) {
      const s = p.sessions.find((x) => x.id === id)!;
      expect(s.topics.some((t) => t === 'haptics' || t === 'vr')).toBe(true);
    }
  });

  it('lists names naturally', () => {
    const c = (name: string, demo = false) => ({ ...real(name, false), demo });
    expect(namesList([c('Sam')])).toBe('Sam');
    expect(namesList([c('Sam'), c('Mina', true)])).toBe('Sam and Mina (demo)');
    expect(namesList([c('A'), c('B'), c('C')])).toBe('A, B and C');
  });
});
