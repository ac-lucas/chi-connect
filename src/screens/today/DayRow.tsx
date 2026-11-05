// One row of the day plan with its actions. Changes are written to storage; the screen reloads by itself.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Connection, Invite, ScheduleItem } from '../../model/types';
import { clockTime as clock, timeRange, timeRangeSpoken } from '../../programme/programme';
import type { PlannedBreak } from '../../schedule/breaks';
import { cancelInvite, declineInvite, inviteTitle } from '../../schedule/invites';
import { alsoGoing, namesList } from '../../schedule/overlap';
import type { Transport } from '../../relay/transport';
import { deleteScheduleItem, skipBreak } from '../../storage/db';
import { announce } from '../../ui/announce';
import { keepingFocus } from '../../ui/focus';
import { ShapeBadge } from '../ShapeCard';
import { openerFor } from '../../data/icebreakers';
import { isOnMeetup, meetupContext, meetupOf, PROTECT_LABELS, rowClass, rowEnd, rowGlyph, rowKindLabel, rowStart, rowTitle, type InviteRow, type Row } from './rows';

interface Props {
  r: Row;
  now: number;
  connections: Connection[];
  nameOf: (id: string) => string;
  relay: Transport | null;
  onInviteFromSession: (s: ScheduleItem, preselect?: string[]) => void;
  onInviteFromBreak: (b: PlannedBreak) => void;
  /** Invite more people to the meetup merged into a session (your own), or start one (theirs). */
  onInviteMore: (session: ScheduleItem, invite: Invite) => void;
  onShowShape: (inviteId: string, context: string) => void;
  /** Just added (an invite you sent): marked for a moment. */
  highlighted?: boolean;
  /** For protected time: a saved session it overlaps. */
  clashWith?: string;
  /** Suggestions paused: no conversation starters. */
  quiet?: boolean;
}

/** Offer Invite only while there's enough of it left to meet (an invite starts at least 2 minutes out). */
const MIN_INVITE_MS = 10 * 60_000;

async function removeItem(item: ScheduleItem) {
  await deleteScheduleItem(item.id);
  announce(`Removed ${item.title}.`);
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

export function DayRow({ r, now, connections, nameOf, relay, onInviteFromSession, onInviteFromBreak, onInviteMore, onShowShape, highlighted, clashWith, quiet }: Props) {
  const going = r.kind === 'session' ? alsoGoing(r.item.programmeSessionId, connections) : [];
  const past = rowEnd(r) <= now;
  const canInvite = rowEnd(r) > now + MIN_INVITE_MS;
  const m = meetupOf(r);
  const inv = m?.invite;
  const merged = r.kind === 'session' && !!m;
  const meetupMeta = m
      ? [
          merged && inv
            ? inv.outgoing
              ? inv.acceptedIds.length
                ? `Sitting with ${inv.acceptedIds.map(nameOf).join(', ')}`
                : 'Sitting together'
              : `Sitting with ${inv.senderName}`
            : m.item.place,
          // Merged: only say who hasn't answered yet; the names already say who's coming.
          merged && inv?.outgoing && inv.acceptedIds.length === inv.recipientIds.length
            ? undefined
            : inv?.outgoing
            ? inv.acceptedIds.length === 0
              ? `Invited ${inv.recipientIds.length}, no answers yet`
              : `${inv.acceptedIds.length} of ${inv.recipientIds.length} said yes`
            : undefined,
        ]
          .filter(Boolean)
          .join(' · ')
      : '';
  // Something to ask about a session that just finished (not on meetups).
  const opener = !quiet && r.kind === 'session' && past && now - r.item.end < 3 * 60 * 60_000 ? openerFor('after-session', r.item.id) : null;
  return (
    <li class={`day-row ${rowClass(r)}${merged ? ' is-social' : ''}${past ? ' is-past' : ''}${highlighted ? ' just-added' : ''}`}>
      <span class="day-glyph" aria-hidden="true">
        {rowGlyph(r)}
      </span>
      <div class="day-body">
        <p class="day-time">
          <span aria-hidden="true">{timeRange(rowStart(r), rowEnd(r))}</span>
          <span class="visually-hidden">{timeRangeSpoken(rowStart(r), rowEnd(r))}</span>
          {r.kind !== 'invite' && <span class="day-kind"> · {rowKindLabel(r)}</span>}
          {past && <span class="day-kind"> · Ended</span>}
          {highlighted && <span class="day-kind"> · Just added</span>}
        </p>
        <p class="day-title">
          {r.kind === 'invite' && r.invite ? inviteTitle(r.invite, r.invite.acceptedIds.map(nameOf)) : rowTitle(r)}
        </p>
        {r.kind === 'session' && r.item.place && <p class="muted">{r.item.place}</p>}
        {meetupMeta && (
          <p class={merged ? 'also-going' : 'muted'}>
            {merged && <span aria-hidden="true">◆ </span>}
            {meetupMeta}
          </p>
        )}
        {m && isOnMeetup(m) && (
          <p class="shape-line">
            Look for <ShapeBadge seedKey={inv!.id} />
          </p>
        )}
        {opener && (
          <p class="opener">
            <span aria-hidden="true">💬 </span>
            <span class="visually-hidden">Something to say: </span>
            {opener}
          </p>
        )}
        {going.length > 0 && r.kind === 'session' && !merged && (
          <p class="also-going">
            <span aria-hidden="true">◆ </span>
            Also going: {namesList(going)}.{' '}
            {r.item.end > now + MIN_INVITE_MS && (
              <button type="button" class="button quiet inline" onClick={() => onInviteFromSession(r.item, going.map((g) => g.id))}>
                Sit together?
              </button>
            )}
          </p>
        )}
        {r.kind === 'protected' && <p class="hint">{PROTECT_LABELS[r.item.protectedKind as 'recharge' | 'off']?.line}</p>}
        {r.kind === 'protected' && clashWith && <p class="hint">Heads-up: this is during {clashWith}.</p>}
      </div>
      <div class="day-actions">
        {r.kind === 'session' && merged && m && (
          <MergedActions session={r.item} meetup={m} relay={relay} onShowShape={onShowShape} canInvite={canInvite} onInviteMore={onInviteMore} />
        )}
        {r.kind === 'session' && !merged && (
          <>
            {/* Stays in place once it's too late, just switched off, so the row doesn't change shape. */}
            <button
              type="button"
              class="button quiet"
              disabled={!canInvite}
              aria-label={canInvite ? `Invite someone to ${r.item.title}` : `Invite someone to ${r.item.title} (too late now)`}
              onClick={() => onInviteFromSession(r.item)}
            >
              Invite
            </button>
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
            <button
              type="button"
              class="button quiet"
              disabled={!canInvite}
              aria-label={`Invite someone to your ${r.brk.kind === 'meal' ? 'lunch' : 'breather'} at ${clock(r.brk.start)}${canInvite ? '' : ' (too late now)'}`}
              onClick={() => onInviteFromBreak(r.brk)}
            >
              Invite
            </button>
            {!past && (
              <button type="button" class="button quiet" aria-label={`Skip ${r.brk.kind === 'meal' ? 'lunch' : 'breather'} at ${clock(r.brk.start)}`} onClick={() => void keepingFocus(() => skip(r.brk))}>
                Skip
              </button>
            )}
          </>
        )}
        {r.kind === 'invite' && m && <MeetupActions r={m} relay={relay} onShowShape={onShowShape} />}
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

/**
 * A session with sitting together merged in: one block, so one Remove. It takes the meetup with it (calling it off
 * tells the people you invited; leaving one you were invited to tells no one), after a check.
 */
function MergedActions({
  session,
  meetup,
  relay,
  onShowShape,
  canInvite,
  onInviteMore,
}: {
  session: ScheduleItem;
  meetup: InviteRow;
  relay: Transport | null;
  onShowShape: Props['onShowShape'];
  canInvite: boolean;
  onInviteMore: Props['onInviteMore'];
}) {
  const [confirming, setConfirming] = useState(false);
  const confirmBtn = useRef<HTMLButtonElement>(null);
  const removeBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirming) confirmBtn.current?.focus();
  }, [confirming]);
  const inv = meetup.invite;
  const outgoing = !!inv?.outgoing;
  return (
    <>
      {isOnMeetup(meetup) && (
        <button
          type="button"
          class="button quiet"
          data-shape-for={inv!.id}
          aria-label={`Show your shape for ${session.title}`}
          onClick={() => onShowShape(inv!.id, meetupContext(meetup.item, inv!))}
        >
          Show your shape
        </button>
      )}
      <button
        type="button"
        class="button quiet"
        disabled={!canInvite}
        aria-label={`Invite more people to ${session.title}${canInvite ? '' : ' (too late now)'}`}
        onClick={() => onInviteMore(session, inv!)}
      >
        Invite
      </button>
      {confirming ? (
        <span role="group" aria-label={`Remove ${session.title}?`} class="inline-confirm">
          <span>
            Remove this session? {outgoing ? 'Sitting together is called off, and everyone you invited is told.' : 'You’ll leave sitting together too. Nobody is told.'}
          </span>{' '}
          <button
            type="button"
            class="button danger"
            ref={confirmBtn}
            onClick={() =>
              void keepingFocus(async () => {
                await leaveOrCancel(meetup, relay);
                await removeItem(session);
              })
            }
          >
            Remove
          </button>
          <button
            type="button"
            class="button quiet"
            onClick={() => {
              setConfirming(false);
              setTimeout(() => removeBtn.current?.focus(), 0);
            }}
          >
            Keep it
          </button>
        </span>
      ) : (
        <button type="button" class="button quiet" ref={removeBtn} aria-label={`Remove ${session.title}`} onClick={() => setConfirming(true)}>
          Remove
        </button>
      )}
    </>
  );
}
