import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { randomId } from '../model/ids';
import type { Connection } from '../model/types';
import { parseWireInvite } from '../relay/invites';
import { getInvite, listAllSchedule, putConnection, resetDatabaseForTests } from '../storage/db';
import { findMeCard } from './findme';
import { acceptInvite, cancelInvite, declineInvite, handleInviteMessage, pendingIncoming, sendInvite } from './invites';
import { describeSpot } from './spot';

const H = 3_600_000;
let n = 0;
beforeEach(async () => {
  await resetDatabaseForTests(`inv-${n++}`);
});

const conn = (name: string, demo = false): Connection => ({
  id: randomId(),
  profile: { displayName: name },
  state: 'connected',
  scheduleSharing: false,
  sharedSessionIds: [],
  demo,
  via: demo ? 'demo' : 'face-to-face',
});

const wire = (over: Record<string, unknown> = {}) => ({ id: randomId(), kind: 'meal', start: Date.now() + H, end: Date.now() + 2 * H, place: 'Lunch hall', ...over });

describe('parseWireInvite', () => {
  it('keeps valid invites and cleans text', () => {
    const w = parseWireInvite(wire({ note: 'See you‮ there', spot: { row: 'back', side: 'left', evil: 1 } }));
    expect(w?.note).toBe('See you there');
    expect(w?.spot).toEqual({ row: 'back', side: 'left' });
  });
  it('drops malformed invites', () => {
    for (const bad of [null, 'x', wire({ id: 'short' }), wire({ kind: 'party' }), wire({ end: Date.now() }), wire({ start: 'soon' }), wire({ end: Date.now() + 9 * H })]) {
      expect(parseWireInvite(bad)).toBeNull();
    }
  });
});

describe('receiving invites', () => {
  it('stores a new invite under the connection’s own name, ignores repeats and past ones', async () => {
    const sam = conn('Sam');
    const w = parseWireInvite(wire())!;
    expect(await handleInviteMessage(sam, { t: 'invite', v: 1, invite: w }, Date.now())).toBe('new');
    expect(await handleInviteMessage(sam, { t: 'invite', v: 1, invite: w }, Date.now())).toBeNull();
    const past = parseWireInvite(wire({ start: Date.now() - H, end: Date.now() + H }))!;
    expect(await handleInviteMessage(sam, { t: 'invite', v: 1, invite: past }, Date.now())).toBeNull();
    const [got] = await pendingIncoming();
    expect(got?.senderName).toBe('Sam');
    expect(got?.fromConnectionId).toBe(sam.id);
  });

  it('only the sender can cancel or change an invite', async () => {
    const sam = conn('Sam');
    const eve = conn('Eve');
    const w = parseWireInvite(wire())!;
    await handleInviteMessage(sam, { t: 'invite', v: 1, invite: w }, Date.now());
    expect(await handleInviteMessage(eve, { t: 'cancel', v: 1, id: w.id }, Date.now())).toBeNull();
    expect(await handleInviteMessage(eve, { t: 'update', v: 1, id: w.id, place: 'Elsewhere' }, Date.now())).toBeNull();
    expect((await getInvite(w.id))?.place).toBe('Lunch hall');
    expect(await handleInviteMessage(sam, { t: 'update', v: 1, id: w.id, place: 'Courtyard' }, Date.now())).toBe('changed');
    expect((await getInvite(w.id))?.place).toBe('Courtyard');
    expect(await handleInviteMessage(sam, { t: 'cancel', v: 1, id: w.id }, Date.now())).toBe('changed');
    expect(await pendingIncoming()).toEqual([]);
  });

  it("declining keeps no details, a repeat delivery can't bring it back, and expired ones disappear quietly", async () => {
    const sam = conn('Sam');
    await putConnection(sam);
    const w = parseWireInvite(wire())!;
    await handleInviteMessage(sam, { t: 'invite', v: 1, invite: w }, Date.now());
    await declineInvite((await getInvite(w.id))!);
    const tomb = (await getInvite(w.id))!;
    expect(tomb.status).toBe('declined');
    expect([tomb.place, tomb.note, tomb.meetingSpot]).toEqual([undefined, undefined, undefined]);
    expect(await handleInviteMessage(sam, { t: 'invite', v: 1, invite: w }, Date.now())).toBeNull(); // replayed
    expect(await handleInviteMessage(sam, { t: 'update', v: 1, id: w.id, place: 'Somewhere' }, Date.now())).toBeNull();
    expect((await getInvite(w.id))!.place).toBeUndefined(); // an update can't put details back
    expect(await pendingIncoming()).toEqual([]);
    await pendingIncoming(w.start + 1); // its time has come: the tombstone goes too
    expect(await getInvite(w.id)).toBeNull();
    const soon = parseWireInvite(wire({ start: Date.now() + 1000, end: Date.now() + H }))!;
    await handleInviteMessage(sam, { t: 'invite', v: 1, invite: soon }, Date.now());
    expect(await pendingIncoming(Date.now() + 2000)).toEqual([]);
  });
});

describe('retention', () => {
  it('deletes the meeting spot and note once the meetup has ended', async () => {
    const sam = conn('Sam');
    await putConnection(sam);
    const w = parseWireInvite(wire({ spot: { row: 'front', side: 'left' }, note: 'by the door' }))!;
    await handleInviteMessage(sam, { t: 'invite', v: 1, invite: w }, Date.now());
    await acceptInvite(null, { ...(await getInvite(w.id))!, simulated: true });
    expect((await getInvite(w.id))!.meetingSpot).toBeTruthy();
    await pendingIncoming(w.end + 1);
    const after = (await getInvite(w.id))!;
    expect(after.meetingSpot).toBeUndefined();
    expect(after.note).toBeUndefined();
    expect(after.status).toBe('accepted'); // still counts for your own recap
  });

  it('refuses invites dated far in the future', async () => {
    const sam = conn('Sam');
    await putConnection(sam);
    const far = Date.now() + 60 * 24 * H;
    const w = parseWireInvite(wire({ start: far, end: far + H }))!;
    expect(await handleInviteMessage(sam, { t: 'invite', v: 1, invite: w }, Date.now())).toBeNull();
  });
});

describe('sending and answering', () => {
  it('counts a yes only from someone who was invited', async () => {
    const sam = conn('Sam', true);
    const eve = conn('Eve');
    await putConnection(sam);
    const { invite } = await sendInvite(null, 'Ana', [sam], { kind: 'break-together', start: Date.now() + H, end: Date.now() + 2 * H }, () => {});
    expect(await handleInviteMessage(eve, { t: 'yes', v: 1, id: invite.id }, Date.now())).toBeNull();
    // Sam is a demo person, so their yes is simulated; a real yes from Sam would also count:
    expect(await handleInviteMessage(sam, { t: 'yes', v: 1, id: invite.id }, Date.now())).toBe('changed');
    expect((await getInvite(invite.id))?.acceptedIds).toEqual([sam.id]);
    expect((await listAllSchedule()).some((s) => s.inviteId === invite.id)).toBe(true);
    await cancelInvite(null, (await getInvite(invite.id))!);
    expect((await listAllSchedule()).some((s) => s.inviteId === invite.id)).toBe(false);
  });

  it('reports a failure for real people when there is no relay', async () => {
    const real = conn('Real');
    const { failed } = await sendInvite(null, 'Ana', [real], { kind: 'meal', start: Date.now() + H, end: Date.now() + 2 * H }, () => {});
    expect(failed.map((f) => f.profile.displayName)).toEqual(['Real']);
  });

  it('saying yes to a simulated invite puts it in the day with the place filled in', async () => {
    const mina = conn('Mina', true);
    await putConnection(mina);
    const w = parseWireInvite(wire())!;
    await handleInviteMessage(mina, { t: 'invite', v: 1, invite: w }, Date.now());
    await acceptInvite(null, (await getInvite(w.id))!);
    const item = (await listAllSchedule()).find((s) => s.inviteId === w.id);
    expect(item?.place).toBe('Lunch hall');
    expect(item?.title).toBe('Lunch with Mina');
  });
});

describe('find-me card and spots', () => {
  it('is the same for everyone in a meetup and varies between meetups', async () => {
    const id = randomId();
    expect(await findMeCard(id)).toEqual(await findMeCard(id));
    const words = new Set<string>();
    for (let i = 0; i < 30; i++) words.add((await findMeCard(randomId())).word);
    expect(words.size).toBeGreaterThan(10);
  });
  it('describes spots in plain words', () => {
    expect(describeSpot({ row: 'back', side: 'left', aisleSeat: true })).toBe('Back left, aisle seat');
    expect(describeSpot({ row: 'middle', side: 'centre' })).toBe('Middle centre');
    expect(describeSpot({ byDoor: true })).toBe('By the door');
    expect(describeSpot(undefined)).toBe('');
  });
});
