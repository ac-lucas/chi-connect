import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { randomId } from '../model/ids';
import { resolveTag } from '../model/tags';
import type { Connection } from '../model/types';
import { SimulatedTransport } from '../relay/transport';
import { getConnection, putConnection, putScheduleItem, resetDatabaseForTests } from '../storage/db';
import { alsoGoing, handleSessionsMessage, namesList, shareSessionsIfChanged } from './overlap';

let n = 0;
beforeEach(async () => {
  await resetDatabaseForTests(`ovl-${n++}`);
});

function real(name: string, sharing: boolean): Connection {
  return {
    id: randomId(),
    profile: { displayName: name },
    state: 'connected',
    mailboxId: `${randomId()}.${randomId()}`,
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
  it('takes the list back even when the switch is flipped from an out-of-date copy', async () => {
    const sam = real('Sam', true);
    await putConnection(sam);
    await save('s1');
    const { relay, sent } = countingRelay();
    relay.acceptMailFor(sam.mailboxId!);
    const screenCopy = (await getConnection(sam.id))!; // held by a screen before the list went out
    expect(await shareSessionsIfChanged(relay, 1000)).toBe(1);
    // The screen now switches sharing off using its old copy: only that field may change.
    const { updateConnection } = await import('../storage/db');
    await updateConnection(screenCopy.id, { scheduleSharing: false });
    expect(await shareSessionsIfChanged(relay, 2000)).toBe(1); // the empty list goes out
    expect(sent).toEqual([sam.mailboxId, sam.mailboxId]);
  });

  it('sends only to people I share with, once per change, and takes it back when I stop', async () => {
    const sam = real('Sam', true);
    const eve = real('Eve', false);
    await putConnection(sam);
    await putConnection(eve);
    await save('s1');
    const { relay, sent } = countingRelay();
    relay.acceptMailFor(sam.mailboxId!, eve.mailboxId!);

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
    await handleSessionsMessage(sam, ['t-1']);
    const stored = (await getConnection(sam.id))!;
    expect(alsoGoing('t-1', [stored]).map((c) => c.profile.displayName)).toEqual(['Sam']);
    expect(alsoGoing('t-2', [stored])).toEqual([]);
  });

  it('shows demo people at the sessions they saved', () => {
    const mina: Connection = { ...real('Mina', false), id: 'demo-mina', demo: true, sharedSessionIds: ['t-3'] };
    expect(alsoGoing('t-3', [mina]).map((c) => c.profile.displayName)).toEqual(['Mina']);
  });

  it('lists names naturally', () => {
    const c = (name: string, demo = false) => ({ ...real(name, false), demo });
    expect(namesList([c('Sam')])).toBe('Sam');
    expect(namesList([c('Sam'), c('Mina', true)])).toBe('Sam and Mina (demo)');
    expect(namesList([c('A'), c('B'), c('C')])).toBe('A, B and C');
  });
});
