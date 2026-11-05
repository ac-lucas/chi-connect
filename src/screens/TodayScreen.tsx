// Today (F10, F11, F22): energy, the day plan with suggested breaks, invites and suggestions.
// Data comes from storage through a live query, so every change (here, from a sync, or another tab) shows up
// without anyone calling refresh. The day's rows, actions and forms live in ./today/.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ScheduleItem } from '../model/types';
import { clockTime as clock, dayLabel, nextDay, programmeDays, startOfDay, timeRangeSpoken } from '../programme/programme';
import type { Programme } from '../programme/types';
import { planDay, type Busy, type PlannedBreak } from '../schedule/breaks';
import { energyToday } from '../schedule/energy';
import { inviteTitle } from '../schedule/invites';
import type { Transport } from '../relay/transport';
import { dismiss, putScheduleItem } from '../storage/db';
import { announce } from '../ui/announce';
import { useClock } from '../ui/useClock';
import { useScreenHeading } from '../ui/useScreenHeading';
import type { InviteDraft } from './InviteScreen';
import { InvitesPanel } from './InvitesPanel';
import { ProgrammeNote } from './ProgrammeNote';
import { MeetupShapeView, ShapeBadge } from './ShapeCard';
import { SuggestionsPanel } from './SuggestionsPanel';
import { DayRow } from './today/DayRow';
import { EnergyPicker } from './today/EnergyPicker';
import { HeadsUpCard } from './today/HeadsUpCard';
import { ProtectForm } from './today/ProtectForm';
import { buildRows, isOnMeetup, meetupContext, PROTECT_LABELS, rowKey, type InviteRow } from './today/rows';
import { useTodayData } from './today/useTodayData';

interface Props {
  name: string;
  programme: Programme;
  relay: Transport | null;
  /** My interest topics (keys), for wildcard suggestions. */
  myTopics: string[];
  onAddSessions: (day: number) => void;
  onInvite: (draft: InviteDraft) => void;
}

/** Re-read storage this often even when nothing is written, so expired invites tidy away. */
const TIDY_EVERY_MS = 3 * 60_000;

export function TodayScreen({ name, programme, relay, myTopics, onAddSessions, onInvite }: Props) {
  const heading = useScreenHeading<HTMLHeadingElement>();
  const now = useClock(30_000);
  const { items, energy, skipped, invites, incoming, connections, hiddenPrompts } = useTodayData(Math.floor(now / TIDY_EVERY_MS));

  const days = useMemo(() => programmeDays(programme), [programme]);
  const today = startOfDay(now);
  const [day, setDay] = useState(days.includes(today) ? today : (days[0] ?? today));
  useEffect(() => {
    if (!days.includes(day)) setDay(days.includes(today) ? today : (days[0] ?? today));
  }, [programme]);

  const [protecting, setProtecting] = useState(false);
  const protectBtn = useRef<HTMLButtonElement>(null);
  const closeProtect = () => {
    setProtecting(false);
    setTimeout(() => protectBtn.current?.focus(), 0); // back to the button that opened it
  };
  const [shapeFor, setShapeFor] = useState<{ id: string; context: string } | null>(null);

  const { level, setToday } = energyToday(energy, now);
  const dayItems = useMemo(() => items.filter((i) => i.start >= day && i.start < nextDay(day)), [items, day]);
  const plan = useMemo(() => {
    const busy: Busy[] = dayItems
      .filter((i) => i.type === 'session' || i.type === 'protected' || i.type === 'invite')
      .map((i) => ({ id: i.id, start: i.start, end: i.end, kind: i.type === 'session' ? 'session' : i.type === 'protected' ? 'protected' : 'meetup' }));
    return planDay(busy, day, level, undefined, new Set(skipped));
  }, [dayItems, day, level, skipped]);
  const invitesById = useMemo(() => new Map(invites.map((i) => [i.id, i])), [invites]);
  const rows = useMemo(() => buildRows(dayItems, plan.breaks, invitesById), [dayItems, plan, invitesById]);
  const namesById = useMemo(() => new Map(connections.map((c) => [c.id, c.profile.displayName])), [connections]);
  const nameOf = (id: string) => namesById.get(id) ?? 'someone';

  // Invites wait while protected time or a Focus session is running (only shown as "waiting" to you).
  const holding = items.find((i) => i.start <= now && i.end > now && (i.type === 'protected' || (i.type === 'session' && i.focus)));
  const nextBreak = day === today ? (plan.breaks.find((b) => b.start > now) ?? null) : null;

  // From 10 minutes before a confirmed meetup until it ends: put "Display your shape" front and centre.
  const meetupNow =
    day === today
      ? rows.find(
          (r): r is InviteRow =>
            r.kind === 'invite' && isOnMeetup(r) && r.item.start - 10 * 60_000 <= now && r.item.end > now && !hiddenPrompts.includes(`shapeprompt:${r.invite!.id}`),
        )
      : undefined;

  function inviteFromBreak(b: PlannedBreak) {
    onInvite({ kinds: b.kind === 'meal' ? ['meal', 'break-together'] : ['break-together', 'meal'], start: b.start, end: b.end });
  }
  function inviteFromSession(s: ScheduleItem, preselect?: string[]) {
    onInvite({ kinds: ['sit-together', 'arrive-together', 'walk-over'], start: s.start, end: s.end, sessionId: s.programmeSessionId, sessionTitle: s.title, room: s.place, preselect });
  }
  async function addProtected(kind: 'recharge' | 'off', from: number, minutes: number) {
    await putScheduleItem({
      id: `protect-${kind}-${from}`, // the same block twice (a double tap) overwrites instead of duplicating
      type: 'protected',
      protectedKind: kind,
      source: 'user',
      title: PROTECT_LABELS[kind].label,
      start: from,
      end: from + minutes * 60_000,
    });
    announce(`${PROTECT_LABELS[kind].label} protected, ${timeRangeSpoken(from, from + minutes * 60_000)}.`);
  }
  async function hideShapePrompt(inviteId: string) {
    await dismiss(`shapeprompt:${inviteId}`);
    announce('Hidden. Your shape is still on the meetup in your day.');
    // The card is gone: keep keyboard focus near, on that meetup's own button.
    setTimeout(() => document.querySelector<HTMLElement>(`[data-shape-for="${inviteId}"]`)?.focus(), 50);
  }

  const sessionsToday = dayItems.filter((i) => i.type === 'session').length;

  return (
    <section class="stack" aria-labelledby="today-heading">
      <div>
        <h2 id="today-heading" ref={heading} tabIndex={-1}>
          {day === today ? 'Today' : dayLabel(day, 'long')}
        </h2>
        <p class="muted">{day === today ? dayLabel(day, 'long') : 'Planning ahead'}</p>
      </div>

      <EnergyPicker level={level} setToday={setToday} name={name} now={now} />

      {days.length > 1 && (
        <div class="segmented" role="group" aria-label="Day">
          {days.map((d) => (
            <button key={d} type="button" aria-pressed={d === day} onClick={() => setDay(d)}>
              {d === today ? 'Today' : dayLabel(d)}
            </button>
          ))}
        </div>
      )}

      {meetupNow?.invite && (
        <section class="card stack shape-now" aria-labelledby="shape-now-heading">
          <h3 id="shape-now-heading">
            {meetupNow.item.start > now ? `Starting at ${clock(meetupNow.item.start)}` : 'On now'}: {inviteTitle(meetupNow.invite, meetupNow.invite.acceptedIds.map(nameOf))}
          </h3>
          <p>{meetupContext(meetupNow.item, meetupNow.invite)}</p>
          <p class="shape-line">
            You’re all looking for <ShapeBadge seedKey={meetupNow.invite.id} />
          </p>
          <button type="button" class="button big" onClick={() => setShapeFor({ id: meetupNow.invite!.id, context: meetupContext(meetupNow.item, meetupNow.invite!) })}>
            Display your shape to find each other
          </button>
          <div class="actions">
            <button type="button" class="button quiet" onClick={() => void hideShapePrompt(meetupNow.invite!.id)}>
              Hide
            </button>
          </div>
        </section>
      )}

      <InvitesPanel invites={incoming} connections={connections} items={items} relay={relay} heldUntil={holding ? holding.end : null} nextBreak={nextBreak} />

      <SuggestionsPanel
        programme={programme}
        items={items}
        connections={connections}
        level={level}
        day={day}
        isToday={day === today}
        now={now}
        myTopics={myTopics}
        onInvite={onInvite}
      />

      {plan.headsUps.map((h, i) => (
        <HeadsUpCard key={i} h={h} onRecharge={(from, mins) => void addProtected('recharge', from, mins)} onEdit={() => onAddSessions(day)} />
      ))}

      <section aria-labelledby="rhythm-heading" class="stack">
        <h3 id="rhythm-heading">Your rhythm</h3>
        {sessionsToday === 0 && (
          <div class="card stack">
            <p class="lede">Wide open. Nice.</p>
            <p>Add a few sessions and your breathers and lunch fill in around them.</p>
          </div>
        )}
        {rows.length > 0 && (
          <ol class="day">
            {rows.map((r) => (
              <DayRow
                key={rowKey(r)}
                r={r}
                now={now}
                connections={connections}
                nameOf={nameOf}
                relay={relay}
                onInviteFromSession={inviteFromSession}
                onInviteFromBreak={inviteFromBreak}
                onShowShape={(id, context) => setShapeFor({ id, context })}
              />
            ))}
          </ol>
        )}
      </section>

      <div class="actions">
        <button type="button" class="button" onClick={() => onAddSessions(day)}>
          Add sessions
        </button>
        <button type="button" class="button secondary" ref={protectBtn} aria-expanded={protecting} aria-controls="protect-form" onClick={() => setProtecting((p) => !p)}>
          Protect some time
        </button>
      </div>

      {/* Right after its button, so reading and Tab order follow it. */}
      {protecting && (
        <ProtectForm
          day={day}
          onAdd={async (kind, from, minutes) => {
            await addProtected(kind, from, minutes);
            closeProtect();
          }}
          onCancel={closeProtect}
        />
      )}

      <ProgrammeNote programme={programme} />

      {shapeFor && <MeetupShapeView inviteId={shapeFor.id} context={shapeFor.context} onClose={() => setShapeFor(null)} />}
    </section>
  );
}
