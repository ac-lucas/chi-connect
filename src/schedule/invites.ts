// Meetup invites (F12): lunch, a break together, or side by side at a session. Only between connected pairs.
// Quiet by default: saying no sends nothing, and the sender only ever learns who said yes.
import { DEMO_NEVER_ANSWERS } from '../data/demo';
import { randomId } from '../model/ids';
import type { Connection, Invite, InviteKind, MeetingSpot, ScheduleItem } from '../model/types';
import type { WireInvite } from '../relay/invites';
import { sendPairMessage, type PairMessage } from '../relay/protocol';
import type { Transport } from '../relay/transport';
/** Invites wait (quietly, only you see it) during a Recharge block, and at no other time. */
export function holdsInvites(i: ScheduleItem, now = Date.now()): boolean {
  return i.type === 'protected' && i.protectedKind === 'recharge' && i.start <= now && i.end > now;
}

import { deleteInvite, deleteScheduleItem, getConnection, getInvite, listInvites, putInvite, putScheduleItem } from '../storage/db';

export const KIND_INFO: Record<InviteKind, { label: string; glyph: string; line: (i: { sessionTitle?: string; place?: string }) => string }> = {
  meal: { label: 'Lunch', glyph: '◒', line: (i) => (i.place ? `Lunch at ${i.place}.` : 'Lunch together.') },
  'break-together': { label: 'Break together', glyph: '○', line: () => 'It’s a break: just chill together or chat about life. No agenda.' },
  'sit-together': { label: 'Sit together', glyph: '▲', line: (i) => `Sit together at ${i.sessionTitle ?? 'the session'}. No talking required.` },
  'arrive-together': {
    label: 'Arrive together',
    glyph: '▲',
    line: (i) => `Meet a few minutes before ${i.sessionTitle ?? 'the session'} and walk in together.`,
  },
  'walk-over': { label: 'Walk over together', glyph: '▲', line: (i) => `Walk over to ${i.sessionTitle ?? 'the session'} together.` },
  'catch-up': { label: 'Talk about the talk', glyph: '◆', line: (i) => `Ten minutes to compare notes on ${i.sessionTitle ?? 'the session'}.` },
};

export function inviteTitle(i: Pick<Invite, 'kind' | 'outgoing' | 'senderName' | 'sessionTitle'>, names?: string[]): string {
  const label = KIND_INFO[i.kind].label;
  if (!i.outgoing) return `${label} with ${i.senderName}`;
  if (names && names.length) return `${label} with ${names.join(', ')}`;
  return label;
}

/** How long a message can usefully wait on the relay: until a little after the meetup starts. */
const ttlFor = (start: number, now: number) => Math.max(60, Math.round((start + 15 * 60_000 - now) / 1000));

export interface NewInvite {
  kind: InviteKind;
  start: number;
  end: number;
  place?: string;
  spot?: MeetingSpot;
  note?: string;
  sessionId?: string;
  sessionTitle?: string;
}

export interface SendResult {
  invite: Invite;
  failed: Connection[];
}

/**
 * Send an invite. Real connections get it through the relay; demo people (only on this phone) get a
 * simulated reply a moment later so the whole flow can be tried alone.
 */
export async function sendInvite(
  relay: Transport | null,
  me: string,
  recipients: Connection[],
  n: NewInvite,
  onSimulatedYes: (who: Connection) => void,
  now = Date.now(),
): Promise<SendResult> {
  const id = randomId();
  const invite: Invite = {
    id,
    senderName: me,
    outgoing: true,
    kind: n.kind,
    start: n.start,
    end: n.end,
    place: n.place,
    meetingSpot: n.spot,
    note: n.note,
    programmeSessionId: n.sessionId,
    sessionTitle: n.sessionTitle,
    createdAt: now,
    expiresAt: n.start,
    recipientIds: recipients.map((r) => r.id),
    acceptedIds: [],
    status: 'pending',
  };
  await putInvite(invite);
  await putScheduleItem(scheduleFor(invite));
  return { invite, failed: await deliverInvite(relay, invite, recipients, onSimulatedYes, now) };
}

/**
 * Invite more people to a meetup you already sent (same invite, same shape). Only new people are added and sent
 * it. Returns who it didn't reach, like deliverInvite.
 */
export async function addPeopleToInvite(
  relay: Transport | null,
  inviteId: string,
  people: Connection[],
  onSimulatedYes: (who: Connection) => void,
  now = Date.now(),
): Promise<{ invite: Invite; failed: Connection[] } | null> {
  const inv = await getInvite(inviteId);
  if (!inv || !inv.outgoing || inv.status === 'cancelled') return null;
  const fresh = people.filter((p) => !inv.recipientIds.includes(p.id));
  const invite: Invite = { ...inv, recipientIds: [...inv.recipientIds, ...fresh.map((p) => p.id)] };
  await putInvite(invite);
  return { invite, failed: await deliverInvite(relay, invite, fresh, onSimulatedYes, now) };
}

/**
 * Send an invite that already exists to some of its recipients: the first time, or again to the ones it didn't
 * reach. Same invite ID every time, so a retry never makes a second invite. Returns who it still didn't reach.
 */
export async function deliverInvite(
  relay: Transport | null,
  invite: Invite,
  recipients: Connection[],
  onSimulatedYes: (who: Connection) => void,
  now = Date.now(),
): Promise<Connection[]> {
  const wire: WireInvite = {
    id: invite.id,
    kind: invite.kind,
    start: invite.start,
    end: invite.end,
    place: invite.place,
    spot: invite.meetingSpot,
    note: invite.note,
    sessionId: invite.programmeSessionId,
    sessionTitle: invite.sessionTitle,
  };
  const failed: Connection[] = [];
  for (const r of recipients) {
    if (r.demo) {
      // Simulated: demo people "say yes" after a short pause, except one who never answers (what a decline looks
      // like to the sender). Labelled as simulated in the UI.
      if (r.id === DEMO_NEVER_ANSWERS) {
        const inv = await getInvite(invite.id);
        if (inv && !inv.simulated) await putInvite({ ...inv, simulated: true });
        continue;
      }
      setTimeout(() => void simulatedYes(invite.id, r).then(() => onSimulatedYes(r)), 2500 + Math.random() * 2000);
      continue;
    }
    try {
      if (!relay) throw new Error('no-relay');
      await sendPairMessage(relay, r, { t: 'invite', v: 1, invite: wire }, ttlFor(invite.start, now));
    } catch {
      failed.push(r);
    }
  }
  return failed;
}

async function simulatedYes(inviteId: string, who: Connection) {
  const inv = await getInvite(inviteId);
  if (!inv || inv.status === 'cancelled' || inv.acceptedIds.includes(who.id)) return;
  await putInvite({ ...inv, acceptedIds: [...inv.acceptedIds, who.id], simulated: true }); // open screens update by themselves
}

function scheduleFor(i: Invite, title?: string): ScheduleItem {
  return {
    id: `inv-${i.id}`,
    type: 'invite',
    source: 'invite',
    inviteId: i.id,
    title: title ?? inviteTitle(i),
    place: i.place,
    start: i.start,
    end: i.end,
    programmeSessionId: i.programmeSessionId,
  };
}

/** Invites further ahead than this are refused (a meetup is about the event days, not next year). */
const MAX_AHEAD_MS = 30 * 24 * 60 * 60 * 1000;

/** Apply an invite message from a connected pair (called by the relay sync). */
export async function handleInviteMessage(c: Connection, msg: Exclude<PairMessage, { t: 'accept' } | { t: 'sessions' }>, sentAt: number, now = Date.now()): Promise<'new' | 'changed' | null> {
  if (msg.t === 'invite') {
    const w = msg.invite;
    // Too late, too far ahead to be real, or already have it (including one declined here: a tombstone).
    if (w.start <= now || w.start > now + MAX_AHEAD_MS || (await getInvite(w.id))) return null;
    await putInvite({
      id: w.id,
      senderName: c.profile.displayName,
      outgoing: false,
      fromConnectionId: c.id,
      kind: w.kind,
      start: w.start,
      end: w.end,
      place: w.place,
      meetingSpot: w.spot,
      note: w.note,
      programmeSessionId: w.sessionId,
      sessionTitle: w.sessionTitle,
      createdAt: now,
      expiresAt: w.start,
      receivedAt: sentAt,
      recipientIds: [],
      acceptedIds: [],
      status: 'pending',
    });
    return 'new';
  }
  const inv = await getInvite(msg.id);
  if (!inv) return null;
  if (msg.t === 'yes') {
    // Only count a yes from someone who was actually invited.
    if (!inv.outgoing || !inv.recipientIds.includes(c.id) || inv.acceptedIds.includes(c.id)) return null;
    await putInvite({ ...inv, acceptedIds: [...inv.acceptedIds, c.id] });
    return 'changed';
  }
  // Cancel only counts from the person who sent the invite (and a declined tombstone stays as it is).
  if (inv.outgoing || inv.fromConnectionId !== c.id || inv.status === 'declined') return null;
  await putInvite({ ...inv, status: 'cancelled' });
  await deleteScheduleItem(`inv-${inv.id}`);
  return 'changed';
}

/** Say yes: it goes into the day with the place filled in, and the sender is told. */
export async function acceptInvite(relay: Transport | null, inv: Invite): Promise<void> {
  if (!inv.simulated) {
    const c = inv.fromConnectionId ? await getConnection(inv.fromConnectionId) : null;
    if (!c) throw new Error('no-connection');
    if (!c.demo) {
      if (!relay) throw new Error('no-relay');
      await sendPairMessage(relay, c, { t: 'yes', v: 1, id: inv.id }, ttlFor(inv.start, Date.now()));
    }
  }
  const accepted = { ...inv, status: 'accepted' as const };
  await putInvite(accepted);
  await putScheduleItem(scheduleFor(accepted));
}

/**
 * Say no (or not now), or leave one you said yes to: nothing is sent. The invite is kept only as a tombstone with
 * no details, so the same message delivered again can't bring it back; it goes for good once its time passes.
 */
export async function declineInvite(inv: Invite): Promise<void> {
  await putInvite({ ...inv, status: 'declined', place: undefined, meetingSpot: undefined, note: undefined });
}

/**
 * The sender calls it off and it leaves the day. Returns how many people were told and how many couldn't be
 * reached (demo people count as told), so the screen doesn't claim more than happened.
 */
export async function cancelInvite(relay: Transport | null, inv: Invite): Promise<{ told: number; missed: number }> {
  let told = 0;
  let missed = 0;
  for (const id of inv.recipientIds) {
    const c = await getConnection(id);
    if (!c) continue;
    if (c.demo) {
      told += 1;
      continue;
    }
    try {
      if (!relay) throw new Error('no-relay');
      await sendPairMessage(relay, c, { t: 'cancel', v: 1, id: inv.id });
      told += 1;
    } catch {
      missed += 1;
    }
  }
  await putInvite({ ...inv, status: 'cancelled' });
  await deleteScheduleItem(`inv-${inv.id}`); // its day entry always has this key
  return { told, missed };
}

/** Simulated incoming invite from a demo person, so someone testing alone can see the other side. */
export async function simulateIncoming(from: Connection, n: NewInvite, now = Date.now()): Promise<Invite> {
  const inv: Invite = {
    id: randomId(),
    senderName: from.profile.displayName,
    outgoing: false,
    fromConnectionId: from.id,
    kind: n.kind,
    start: n.start,
    end: n.end,
    place: n.place,
    meetingSpot: n.spot,
    note: n.note,
    programmeSessionId: n.sessionId,
    sessionTitle: n.sessionTitle,
    createdAt: now,
    expiresAt: n.start,
    receivedAt: now,
    recipientIds: [],
    acceptedIds: [],
    status: 'pending',
    simulated: true,
  };
  await putInvite(inv);
  return inv;
}

/**
 * Tidy invites, then return the pending ones to show now.
 *  - Unanswered, declined or cancelled incoming invites go for good once their time has come.
 *  - Once a meetup has ended, its meeting spot and note are deleted (the spot belongs to one meetup only).
 *    What's left (who, when, where) stays for your own day history and recap.
 */
export async function pendingIncoming(now = Date.now()): Promise<Invite[]> {
  const all = await listInvites();
  const kept: Invite[] = [];
  for (const i of all) {
    if (!i.outgoing && i.status !== 'accepted' && i.expiresAt <= now) {
      await deleteInvite(i.id);
      continue;
    }
    if (i.end <= now && (i.meetingSpot || i.note)) {
      const stripped = { ...i, meetingSpot: undefined, note: undefined };
      await putInvite(stripped);
      kept.push(stripped);
      continue;
    }
    kept.push(i);
  }
  return kept.filter((i) => !i.outgoing && i.status === 'pending' && i.expiresAt > now).sort((a, b) => a.start - b.start);
}
