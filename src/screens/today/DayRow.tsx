// One row of the day plan with its actions. Changes are written to storage; the screen reloads by itself.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Connection, ScheduleItem } from '../../model/types';
import { clockTime as clock, timeRange, timeRangeSpoken } from '../../programme/programme';
import type { PlannedBreak } from '../../schedule/breaks';
import { cancelInvite, declineInvite, inviteTitle } from '../../schedule/invites';
import { alsoGoing, namesList } from '../../schedule/overlap';
import type { Transport } from '../../relay/transport';
import { deleteScheduleItem, putScheduleItem, skipBreak } from '../../storage/db';
import { announce } from '../../ui/announce';
import { keepingFocus } from '../../ui/focus';
import { ShapeBadge } from '../ShapeCard';
import { isOnMeetup, meetupContext, PROTECT_LABELS, rowClass, rowEnd, rowGlyph, rowKindLabel, rowStart, rowTitle, type InviteRow, type Row } from './rows';

interface Props {
  r: Row;
  now: number;
  connections: Connection[];
  nameOf: (id: string) => string;
  relay: Transport | null;
  onInviteFromSession: (s: ScheduleItem, preselect?: string[]) => void;
  onInviteFromBreak: (b: PlannedBreak) => void;
  onShowShape: (inviteId: string, context: string) => void;
}

/** Offer Invite only while there's enough of it left to meet (an invite starts at least 2 minutes out). */
const MIN_INVITE_MS = 10 * 60_000;

const badge = (label: string) => (
  <span class="badge">
    <span class="visually-hidden">, </span>
    {label}
  </span>
);

async function removeItem(item: ScheduleItem) {
  await deleteScheduleItem(item.id);
  announce(`Removed ${item.title}.`);
}

async function toggleFocus(item: ScheduleItem) {
  await putScheduleItem({ ...item, focus: !item.focus });
  announce(item.focus ? `Focus off for ${item.title}.` : `Focus on for ${item.title}. Invites wait until it ends.`);
}

async function skip(b: PlannedBreak) {
  await skipBreak(b.key);
  announce(b.kind === 'meal' ? 'Lunch suggestion skipped.' : 'Breather skipped.');
}

async function leaveOrCancel(r: InviteRow, relay: Transport | null) {
  const inv = r.invite;
  if (inv?.outgoing) {
    const { told, missed } = await cancelInvite(relay, inv);
    announce(
      missed === 0
        ? told === 1
          ? 'Called off. They’ve been told.'
          : 'Called off. Everyone invited has been told.'
        : `Called off. ${missed === 1 ? 'One person' : `${missed} people`} couldn’t be reached; it’s gone from your day anyway.`,
    );
  } else {
    // Leaving one you said yes to: it just leaves your day. Nothing is sent.
    await deleteScheduleItem(r.item.id);
    if (inv) await declineInvite(inv);
    announce('Removed from your day.');
  }
}

export function DayRow({ r, now, connections, nameOf, relay, onInviteFromSession, onInviteFromBreak, onShowShape }: Props) {
  const going = r.kind === 'session' ? alsoGoing(r.item.programmeSessionId, connections) : [];
  return (
    <li class={`day-row ${rowClass(r)}`}>
      <span class="day-glyph" aria-hidden="true">
        {rowGlyph(r)}
      </span>
      <div class="day-body">
        <p class="day-time">
          <span aria-hidden="true">{timeRange(rowStart(r), rowEnd(r))}</span>
          <span class="visually-hidden">{timeRangeSpoken(rowStart(r), rowEnd(r))}</span>
          <span class="day-kind"> · {rowKindLabel(r)}</span>
        </p>
        <p class="day-title">
          {r.kind === 'invite' && r.invite ? inviteTitle(r.invite, r.invite.acceptedIds.map(nameOf)) : rowTitle(r)}
          {r.kind === 'invite' && r.invite?.simulated && badge('Simulated')}
          {r.kind === 'session' && r.item.starter && badge('Sample')}
        </p>
        {r.kind === 'invite' && r.invite?.outgoing && (
          <p class="muted">
            {r.invite.acceptedIds.length === 0 ? `Invited ${r.invite.recipientIds.length}. Nobody yet, and that’s fine.` : `${r.invite.acceptedIds.length} said yes.`}
          </p>
        )}
        {r.kind === 'invite' && r.item.place && <p class="muted">{r.item.place}</p>}
        {r.kind === 'invite' && isOnMeetup(r) && (
          <p class="shape-line">
            Find each other by <ShapeBadge seedKey={r.invite!.id} />
          </p>
        )}
        {r.kind === 'session' && r.item.place && <p class="muted">{r.item.place}</p>}
        {going.length > 0 && r.kind === 'session' && (
          <p class="also-going">
            <span aria-hidden="true">◆ </span>
            Also going: {namesList(going)}.{' '}
            <button type="button" class="button quiet inline" onClick={() => onInviteFromSession(r.item, going.map((g) => g.id))}>
              Sit together?
            </button>
          </p>
        )}
        {r.kind === 'session' && r.item.focus && <p class="hint">Focus: invites and nudges wait until it ends.</p>}
        {r.kind === 'protected' && r.item.protectedKind !== 'focus' && <p class="hint">{PROTECT_LABELS[r.item.protectedKind as 'recharge' | 'off']?.line}</p>}
      </div>
      <div class="day-actions">
        {r.kind === 'session' && (
          <>
            <button type="button" class="button quiet" aria-pressed={!!r.item.focus} aria-label={`Focus on ${r.item.title}`} onClick={() => void toggleFocus(r.item)}>
              Focus
            </button>
            {r.item.end > now + MIN_INVITE_MS && (
              <button type="button" class="button quiet" aria-label={`Invite someone to ${r.item.title}`} onClick={() => onInviteFromSession(r.item)}>
                Invite
              </button>
            )}
            <button type="button" class="button quiet" aria-label={`Remove ${r.item.title}`} onClick={() => void keepingFocus(() => removeItem(r.item))}>
              Remove
            </button>
          </>
        )}
        {r.kind === 'protected' && (
          <button type="button" class="button quiet" aria-label={`Remove ${r.item.title} at ${clock(r.item.start)}`} onClick={() => void keepingFocus(() => removeItem(r.item))}>
            Remove
          </button>
        )}
        {r.kind === 'break' && (
          <>
            {r.brk.end > now + MIN_INVITE_MS && (
              <button type="button" class="button quiet" aria-label={`Invite someone to your ${r.brk.kind === 'meal' ? 'lunch' : 'breather'} at ${clock(r.brk.start)}`} onClick={() => onInviteFromBreak(r.brk)}>
                Invite
              </button>
            )}
            <button type="button" class="button quiet" aria-label={`Skip ${r.brk.kind === 'meal' ? 'lunch' : 'breather'} at ${clock(r.brk.start)}`} onClick={() => void keepingFocus(() => skip(r.brk))}>
              Skip
            </button>
          </>
        )}
        {r.kind === 'invite' && <MeetupActions r={r} relay={relay} onShowShape={onShowShape} />}
      </div>
    </li>
  );
}

/** Show your shape, and Leave (or Call off, which asks first: it tells everyone and can't be undone). */
function MeetupActions({ r, relay, onShowShape }: { r: InviteRow; relay: Transport | null; onShowShape: Props['onShowShape'] }) {
  const [confirming, setConfirming] = useState(false);
  const confirmBtn = useRef<HTMLButtonElement>(null);
  const callOffBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirming) confirmBtn.current?.focus();
  }, [confirming]);
  const outgoing = !!r.invite?.outgoing;
  return (
    <>
      {isOnMeetup(r) && (
        <button
          type="button"
          class="button quiet"
          data-shape-for={r.invite!.id}
          aria-label={`Show your shape for ${r.item.title}`}
          onClick={() => onShowShape(r.invite!.id, meetupContext(r.item, r.invite!))}
        >
          Show your shape
        </button>
      )}
      {outgoing && confirming ? (
        <span role="group" aria-label={`Call off ${r.item.title}?`} class="inline-confirm">
          <span>Call it off? Everyone invited is told.</span>{' '}
          <button type="button" class="button danger" ref={confirmBtn} onClick={() => void keepingFocus(() => leaveOrCancel(r, relay))}>
            Call off
          </button>
          <button
            type="button"
            class="button quiet"
            onClick={() => {
              setConfirming(false);
              setTimeout(() => callOffBtn.current?.focus(), 0);
            }}
          >
            Keep it
          </button>
        </span>
      ) : (
        <button
          type="button"
          class="button quiet"
          ref={callOffBtn}
          aria-label={`${outgoing ? 'Call off' : 'Leave'} ${r.item.title}`}
          onClick={() => (outgoing ? setConfirming(true) : void keepingFocus(() => leaveOrCancel(r, relay)))}
        >
          {outgoing ? 'Call off' : 'Leave'}
        </button>
      )}
    </>
  );
}
