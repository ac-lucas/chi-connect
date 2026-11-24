// Today (F10, F11, F22): energy, the day plan with suggested breaks, invites and suggestions.
// Data comes from storage through a live query, so every change (here, from a sync, or another tab) shows up
// without anyone calling refresh. The day's rows, actions and forms live in ./today/.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Invite, ScheduleItem } from '../model/types';
import { clockTime as clock, dayLabel, nextDay, programDays, startOfDay, timeRangeSpoken } from '../program/program';
import type { Program } from '../program/types';
import { busyFrom, planDay, type PlannedBreak } from '../schedule/breaks';
import { energyToday } from '../schedule/energy';
import { holdsInvites, inviteTitle } from '../schedule/invites';
import type { Transport } from '../relay/transport';
import { dismiss, getSetting, putScheduleItem, setSetting } from '../storage/db';
import { announce } from '../ui/announce';
import { useClock } from '../ui/useClock';
import { useScreenHeading } from '../ui/useScreenHeading';
import type { InviteDraft } from './InviteScreen';
import { InvitesPanel, SimulateInvite, simulateFrom } from './InvitesPanel';
import { ProgramNote } from './ProgramNote';
import { DoodleBadge, MeetupDoodleView, myDoodleOf } from './DoodleCard';
import { SuggestionsPanel } from './SuggestionsPanel';
import { DayRow } from './today/DayRow';
import { EnergyPicker } from './today/EnergyPicker';
import { HeadsUpCard } from './today/HeadsUpCard';
import { ProtectForm } from './today/ProtectForm';
import { buildRows, isOnMeetup, meetupContext, meetupOf, PROTECT_LABELS, rowKey, type InviteRow } from './today/rows';
import { useTodayData } from './today/useTodayData';

interface Props {
  name: string;
  program: Program;
  relay: Transport | null;
  /** My interest topics (keys), for wildcard suggestions. */
  myTopics: string[];
  onAddSessions: (day: number) => void;
  onInvite: (draft: InviteDraft) => void;
  /** The day to show (kept by the app across screens); null = today. */
  day: number | null;
  onDayChange: (day: number) => void;
  /** An invite just sent: point it out once. */
  highlight: string | null;
  onHighlightShown: () => void;
  onRecap: () => void;
}

/** Re-read storage this often even when nothing is written, so expired invites tidy away. */
const TIDY_EVERY_MS = 3 * 60_000;

export function TodayScreen({ name, program, relay, myTopics, onAddSessions, onInvite, day: shownDay, onDayChange, highlight, onHighlightShown, onRecap }: Props) {
  const heading = useScreenHeading<HTMLHeadingElement>();
  const now = useClock(30_000);
  const { items, energy, skipped, invites, incoming, connections, hiddenPrompts } = useTodayData(Math.floor(now / TIDY_EVERY_MS));

  const days = useMemo(() => programDays(program), [program]);
  const today = startOfDay(now);
  const fallbackDay = days.includes(today) ? today : (days[0] ?? today);
  const day = shownDay !== null && days.includes(shownDay) ? shownDay : fallbackDay;
  const setDay = (d: number) => onDayChange(d);

  const [protecting, setProtecting] = useState(false);
  const protectBtn = useRef<HTMLButtonElement>(null);
  const closeProtect = () => {
    setProtecting(false);
    setTimeout(() => protectBtn.current?.focus(), 0); // back to the button that opened it
  };
  const [shapeFor, setShapeFor] = useState<{ id: string; context: string } | null>(null);
  /** Read live, so a yes that arrives while it's up joins the drawings. */
  const shapeInvite = shapeFor ? invites.find((i) => i.id === shapeFor.id) : undefined;

  const { level, setToday } = energyToday(energy, now);
  // Energy is about today. Other days are planned at the default pace, and get no wildcard.
  const dayLevel = day === today ? level : 'up-for-it';
  const dayItems = useMemo(() => items.filter((i) => i.start >= day && i.start < nextDay(day)), [items, day]);
  const plan = useMemo(() => {
    const mealInvites = new Set(invites.filter((i) => i.kind === 'meal').map((i) => i.id));
    return planDay(busyFrom(dayItems, mealInvites), day, dayLevel, undefined, new Set(skipped));
  }, [dayItems, day, dayLevel, skipped, invites]);
  const invitesById = useMemo(() => new Map(invites.map((i) => [i.id, i])), [invites]);
  const rows = useMemo(() => buildRows(dayItems, plan.breaks, invitesById), [dayItems, plan, invitesById]);
  const namesById = useMemo(() => new Map(connections.map((c) => [c.id, c.profile.displayName])), [connections]);
  const nameOf = (id: string) => namesById.get(id) ?? 'someone';

  // Invites wait during a Recharge block, and only then (shown as "waiting" to you alone).
  const holding = items.find((i) => holdsInvites(i, now));
  const nextBreak = day === today ? (plan.breaks.find((b) => b.start > now) ?? null) : null;

  // From 10 minutes before a confirmed meetup until it ends: put "Hold up their drawing" front and center.
  const meetupNow =
    day === today
      ? rows
          .map(meetupOf)
          .find(
            (r): r is InviteRow =>
              !!r && isOnMeetup(r) && r.item.start - 10 * 60_000 <= now && r.item.end > now && !hiddenPrompts.includes(`shapeprompt:${r.invite!.id}`),
          )
      : undefined;

  // First run: a lunch invite from Mina is already waiting, so the drawings are three taps away for someone trying
  // the app alone. Once per phone; skipped if the demo people were removed.
  const welcomeFrom = connections.find((c) => c.demo && c.state === 'connected' && c.id === 'demo-mina') ?? connections.find((c) => c.demo && c.state === 'connected');
  const lunchLater = day === today ? plan.breaks.find((b) => b.kind === 'meal' && b.start > now + 5 * 60_000) : undefined;
  useEffect(() => {
    if (!welcomeFrom || day !== today) return;
    let gone = false;
    void (async () => {
      if (await getSetting('welcomeInviteSent')) return;
      await setSetting('welcomeInviteSent', true); // first, so a second render can't send two
      if (gone) return;
      await simulateFrom(welcomeFrom, lunchLater ?? nextBreak, lunchLater ? true : undefined);
    })().catch(() => {});
    return () => {
      gone = true;
    };
  }, [welcomeFrom?.id, day === today]);

  function inviteFromBreak(b: PlannedBreak) {
    onInvite({ kinds: b.kind === 'meal' ? ['meal', 'break-together'] : ['break-together', 'meal'], start: b.start, end: b.end });
  }
  function inviteFromSession(s: ScheduleItem, preselect?: string[]) {
    onInvite({ kinds: ['sit-together', 'walk-over'], start: s.start, end: s.end, sessionId: s.programSessionId, sessionTitle: s.title, room: s.place, preselect });
  }
  // On a session with sitting together merged in: your own meetup gets more people (same invite, same doodles);
  // one you were invited to can't be changed by you, so that starts a new invite as usual.
  function inviteMore(s: ScheduleItem, inv: Invite) {
    if (!inv.outgoing) return inviteFromSession(s);
    onInvite({ kinds: ['sit-together'], start: inv.start, end: inv.end, sessionId: s.programSessionId, sessionTitle: s.title, room: s.place, addTo: inv.id, already: inv.recipientIds });
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
    announce('Hidden. The drawings are still on the meetup in your day.');
    // The card is gone: keep keyboard focus near, on that meetup's own button.
    setTimeout(() => document.querySelector<HTMLElement>(`[data-shape-for="${inviteId}"]`)?.focus(), 50);
  }

  const sessionsToday = dayItems.filter((i) => i.type === 'session').length;
  const lastDay = days.length > 0 && day === days[days.length - 1];

  // Just sent an invite: show its day, scroll to it and mark it for a moment.
  const highlightItem = highlight ? items.find((i) => i.type === 'invite' && i.inviteId === highlight) : undefined;
  useEffect(() => {
    if (!highlightItem) return;
    const d = startOfDay(highlightItem.start);
    if (d !== day) {
      setDay(d);
      return;
    }
    const t1 = setTimeout(() => document.querySelector('.day-row.just-added')?.scrollIntoView({ block: 'center' }), 50);
    const t2 = setTimeout(onHighlightShown, 4000);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [highlightItem?.id, day]);

  return (
    <section class="stack" aria-labelledby="today-heading">
      <div>
        <h2 id="today-heading" ref={heading} tabIndex={-1}>
          {day === today ? 'Today' : dayLabel(day, 'long')}
        </h2>
        <p class="muted">{day === today ? dayLabel(day, 'long') : 'Planning ahead'}</p>
      </div>

      {day === today && <EnergyPicker level={level} setToday={setToday} name={name} now={now} />}

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
            <DoodleBadge inviteId={meetupNow.invite.id} doodle={myDoodleOf(meetupNow.invite)} text="Look for your drawing" />
          </p>
          <button type="button" class="button big" onClick={() => setShapeFor({ id: meetupNow.invite!.id, context: meetupContext(meetupNow.item, meetupNow.invite!) })}>
            Hold up their drawing to find each other
          </button>
          <div class="actions">
            <button type="button" class="button quiet" onClick={() => void hideShapePrompt(meetupNow.invite!.id)}>
              Hide
            </button>
          </div>
        </section>
      )}

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
          sessions={dayItems.filter((i) => i.type === 'session')}
          onAdd={async (from, minutes) => {
            await addProtected('recharge', from, minutes);
            closeProtect();
          }}
          onCancel={closeProtect}
        />
      )}

      <InvitesPanel
        invites={incoming}
        connections={connections}
        items={items}
        relay={relay}
        heldUntil={holding ? holding.end : null}
        nextBreak={nextBreak}
        onAccepted={(start) => setDay(startOfDay(start))}
      />

      <SuggestionsPanel
        program={program}
        items={items}
        connections={connections}
        level={dayLevel}
        breaks={plan.breaks}
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
                onInviteMore={inviteMore}
                onShowShape={(inv, context) => setShapeFor({ id: inv.id, context })}
                highlighted={!!highlight && meetupOf(r)?.invite?.id === highlight}
                clashWith={
                  r.kind === 'protected' ? dayItems.find((i) => i.type === 'session' && i.start < r.item.end && i.end > r.item.start)?.title : undefined
                }
              />
            ))}
          </ol>
        )}
      </section>

      {lastDay && (
        <div class="card stack export-reminder">
          <p>
            <strong>Last day.</strong> Export your people and follow-ups before you go: this phone won’t keep them forever.
          </p>
          <div class="actions">
            <button type="button" class="button secondary" onClick={onRecap}>
              Your week and exports
            </button>
          </div>
        </div>
      )}

      {day === today && <SimulateInvite connections={connections} nextBreak={nextBreak} />}

      <ProgramNote program={program} credit={false} />

      {shapeFor && shapeInvite && <MeetupDoodleView invite={shapeInvite} people={connections} context={shapeFor.context} onClose={() => setShapeFor(null)} />}
    </section>
  );
}
