// Meetup invites (F12): lunch, a break together, or side by side at a session. Only between connected pairs.
// Quiet by default: saying no sends nothing, and the sender only ever learns who said yes.
import { randomId } from '../model/ids';
import type { Connection, Invite, InviteKind, MeetingSpot, ScheduleItem } from '../model/types';
import type { WireInvite } from '../relay/invites';
import { sendPairMessage, type PairMessage } from '../relay/protocol';
import type { Transport } from '../relay/transport';
import { deleteInvite, deleteScheduleItem, getConnection, getInvite, listInvites, putInvite, putScheduleItem, scheduleItemForInvite } from '../storage/db';

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

  const wire: WireInvite = { id, kind: n.kind, start: n.start, end: n.end, place: n.place, spot: n.spot, note: n.note, sessionId: n.sessionId, sessionTitle: n.sessionTitle };
  const failed: Connection[] = [];
  for (const r of recipients) {
    if (r.demo) {
      // Simulated: demo people "say yes" after a short pause. Labelled as simulated in the UI.
      setTimeout(() => void simulatedYes(id, r).then(() => onSimulatedYes(r)), 2500 + Math.random() * 2000);
      continue;
    }
    try {
      if (!relay) throw new Error('no-relay');
      await sendPairMessage(relay, r, { t: 'invite', v: 1, invite: wire }, ttlFor(n.start, now));
    } catch {
      failed.push(r);
    }
  }
  return { invite, failed };
}

async function simulatedYes(inviteId: string, who: Connection) {
  const inv = await getInvite(inviteId);
  if (!inv || inv.status === 'cancelled' || inv.acceptedIds.includes(who.id)) return;
  await putInvite({ ...inv, acceptedIds: [...inv.acceptedIds, who.id], simulated: true });
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

/** Apply an invite message from a connected pair (called by the relay sync). */
export async function handleInviteMessage(c: Connection, msg: Exclude<PairMessage, { t: 'accept' }>, sentAt: number, now = Date.now()): Promise<'new' | 'changed' | null> {
  if (msg.t === 'invite') {
    const w = msg.invite;
    if (w.start <= now || (await getInvite(w.id))) return null; // too late, or already have it
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
  // Cancel and update only count from the person who sent the invite.
  if (inv.outgoing || inv.fromConnectionId !== c.id) return null;
  if (msg.t === 'cancel') {
    await putInvite({ ...inv, status: 'cancelled' });
    const item = await scheduleItemForInvite(inv.id);
    if (item) await deleteScheduleItem(item.id);
    return 'changed';
  }
  const next = { ...inv, place: msg.place ?? inv.place, meetingSpot: msg.spot ?? inv.meetingSpot };
  await putInvite(next);
  const item = await scheduleItemForInvite(inv.id);
  if (item) await putScheduleItem({ ...item, place: next.place });
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

/** Say no (or not now): removed on this phone. Nothing is sent. */
export async function declineInvite(inv: Invite): Promise<void> {
  await deleteInvite(inv.id);
}

/** The sender calls it off: everyone invited is told, and it leaves the day. */
export async function cancelInvite(relay: Transport | null, inv: Invite): Promise<void> {
  if (relay) {
    for (const id of inv.recipientIds) {
      const c = await getConnection(id);
      if (c && !c.demo) await sendPairMessage(relay, c, { t: 'cancel', v: 1, id: inv.id }).catch(() => {});
    }
  }
  await putInvite({ ...inv, status: 'cancelled' });
  const item = await scheduleItemForInvite(inv.id);
  if (item) await deleteScheduleItem(item.id);
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

/** Pending invites to show now: not expired, not cancelled. */
export async function pendingIncoming(now = Date.now()): Promise<Invite[]> {
  const all = await listInvites();
  for (const i of all) if (!i.outgoing && i.status === 'pending' && i.expiresAt <= now) await deleteInvite(i.id); // unanswered: gone quietly
  return all.filter((i) => !i.outgoing && i.status === 'pending' && i.expiresAt > now).sort((a, b) => a.start - b.start);
}
