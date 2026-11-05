import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Connection, EnergyLevel, EnergySetting, Invite, ProtectedKind, ScheduleItem } from '../model/types';
import { atMinutes, dayLabel, nextDay, programmeDays, startOfDay, timeRange, timeRangeSpoken } from '../programme/programme';
import type { Programme } from '../programme/types';
import { planDay, type Busy, type HeadsUp, type PlannedBreak } from '../schedule/breaks';
import { ENERGY, ENERGY_ORDER, energyToday } from '../schedule/energy';
import { deleteScheduleItem, dismiss, getSetting, listAllSchedule, listConnections, listInvites, putScheduleItem, setSetting, skipBreak } from '../storage/db';
import { cancelInvite, declineInvite, INVITES_CHANGED, inviteTitle, KIND_INFO, pendingIncoming } from '../schedule/invites';
import type { Transport } from '../relay/transport';
import { MeetupShapeView, ShapeBadge } from './ShapeCard';
import { describeSpot } from '../schedule/spot';
import { alsoGoing, namesList } from '../schedule/overlap';
import type { InviteDraft } from './InviteScreen';
import { InvitesPanel } from './InvitesPanel';
import { SuggestionsPanel } from './SuggestionsPanel';
import { announce } from '../ui/announce';
import { useScreenHeading } from '../ui/useScreenHeading';
import { keepingFocus } from '../ui/focus';
import { ProgrammeNote } from './ProgrammeNote';

interface Props {
  name: string;
  programme: Programme;
  relay: Transport | null;
  /** My interest topics (keys), for wildcard suggestions. */
  myTopics: string[];
  /** Changes when the relay sync brought news, so the screen reloads. */
  syncTick: number;
  onAddSessions: (day: number) => void;
  onInvite: (draft: InviteDraft) => void;
}

const PROTECT_LABELS: Record<Exclude<ProtectedKind, 'focus'>, { label: string; glyph: string; line: string }> = {
  recharge: { label: 'Recharge', glyph: '■', line: 'Downtime. Invites wait until it’s over.' },
  off: { label: 'Off', glyph: '⏸', line: 'Everything waits. Nobody sees why.' },
};

function greeting(hour: number): string {
  if (hour < 5) return 'Still up';
  if (hour < 12) return 'Morning';
  if (hour < 17) return 'Afternoon';
  return 'Evening';
}

const clock = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

type Row =
  | { kind: 'session'; item: ScheduleItem }
  | { kind: 'protected'; item: ScheduleItem }
  | { kind: 'break'; brk: PlannedBreak }
  | { kind: 'invite'; item: ScheduleItem; invite?: Invite };

export function TodayScreen({ name, programme, relay, myTopics, syncTick, onAddSessions, onInvite }: Props) {
  const heading = useScreenHeading<HTMLHeadingElement>();
  const now = Date.now();
  const days = useMemo(() => programmeDays(programme), [programme]);
  const today = startOfDay(now);
  const [day, setDay] = useState(days.includes(today) ? today : (days[0] ?? today));
  useEffect(() => {
    if (!days.includes(day)) setDay(days.includes(today) ? today : (days[0] ?? today));
  }, [programme]);
  const [items, setItems] = useState<ScheduleItem[]>([]);
  const [energySetting, setEnergySetting] = useState<EnergySetting | undefined>(undefined);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [protecting, setProtecting] = useState(false);
  /** Calling off tells everyone and can't be undone: it asks first. Holds the schedule item ID being confirmed. */
  const [confirmCallOff, setConfirmCallOff] = useState<string | null>(null);
  const confirmCallOffBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirmCallOff) confirmCallOffBtn.current?.focus();
  }, [confirmCallOff]);
  const keepMeetup = (id: string) => {
    setConfirmCallOff(null);
    setTimeout(() => document.querySelector<HTMLElement>(`[data-calloff="${id}"]`)?.focus(), 0);
  };
  const protectBtn = useRef<HTMLButtonElement>(null);
  const closeProtect = () => {
    setProtecting(false);
    setTimeout(() => protectBtn.current?.focus(), 0); // back to the button that opened it
  };
  const [changingEnergy, setChangingEnergy] = useState(false);
  const changeEnergyBtn = useRef<HTMLButtonElement>(null);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [incoming, setIncoming] = useState<Invite[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [shapeFor, setShapeFor] = useState<{ id: string; context: string } | null>(null);
  const [hiddenPrompts, setHiddenPrompts] = useState<string[]>([]);
  // Time moves on: re-render every 30 s and when the app comes back to the front, so "now", "today", held
  // invites and the shape prompt follow the clock. Every few minutes, reload too (expired invites tidy away).
  const [, setTick] = useState(0);
  useEffect(() => {
    let n = 0;
    const tick = () => {
      setTick((x) => x + 1);
      if (++n % 6 === 0) void refresh();
    };
    const t = setInterval(tick, 30_000);
    const onShow = () => {
      if (document.visibilityState === 'visible') {
        setTick((x) => x + 1);
        void refresh();
      }
    };
    document.addEventListener('visibilitychange', onShow);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onShow);
    };
  }, []);

  const refresh = async () => {
    // Tidy invites first (it can delete some), then read everything at once and update together, so the screen
    // renders once instead of once per read.
    const incomingNow = await pendingIncoming();
    const [all, energy, skippedBreaks, invitesNow, conns, dismissedNow] = await Promise.all([
      listAllSchedule(),
      getSetting('energy'),
      getSetting('skippedBreaks'),
      listInvites(),
      listConnections(),
      getSetting('dismissed'),
    ]);
    setItems(all);
    setEnergySetting(energy);
    setSkipped(skippedBreaks ?? []);
    setIncoming(incomingNow);
    setInvites(invitesNow);
    setConnections(conns);
    setHiddenPrompts((dismissedNow ?? []).filter((k) => k.startsWith('shapeprompt:')));
  };
  // Reload when the programme changes (for example the real feed replacing the sample).
  useEffect(() => {
    void refresh();
  }, [programme, syncTick]);
  // Simulated replies from demo people arrive a few seconds after sending: reload when one lands (no polling).
  useEffect(() => {
    const onChange = () => void refresh();
    window.addEventListener(INVITES_CHANGED, onChange);
    return () => window.removeEventListener(INVITES_CHANGED, onChange);
  }, []);

  const { level, setToday } = energyToday(energySetting, now);
  const dayItems = items.filter((i) => i.start >= day && i.start < nextDay(day));
  const plan = useMemo(() => {
    const busy: Busy[] = dayItems
      .filter((i) => i.type === 'session' || i.type === 'protected' || i.type === 'invite')
      .map((i) => ({ id: i.id, start: i.start, end: i.end, kind: i.type === 'session' ? 'session' : i.type === 'protected' ? 'protected' : 'meetup' }));
    return planDay(busy, day, level, undefined, new Set(skipped));
  }, [items, day, level, skipped]);

  const rows: Row[] = [
    ...dayItems.filter((i) => i.type === 'session').map((item) => ({ kind: 'session' as const, item })),
    ...dayItems.filter((i) => i.type === 'protected').map((item) => ({ kind: 'protected' as const, item })),
    ...plan.breaks.map((brk) => ({ kind: 'break' as const, brk })),
    ...dayItems
      .filter((i) => i.type === 'invite')
      .map((item) => ({ kind: 'invite' as const, item, invite: invites.find((x) => x.id === item.inviteId) })),
  ].sort((a, b) => start(a) - start(b));

  // Invites wait while protected time or a Focus session is running (only shown as "waiting" to you).
  const holding = items.find((i) => i.start <= now && i.end > now && (i.type === 'protected' || (i.type === 'session' && i.focus)));
  const nameOf = (id: string) => connections.find((c) => c.id === id)?.profile.displayName ?? 'someone';
  const nextBreak = day === today ? (plan.breaks.find((b) => b.start > now) ?? null) : null;

  // From 10 minutes before a confirmed meetup until it ends: put "Display your shape" front and centre.
  const meetupNow =
    day === today
      ? rows.find(
          (r): r is Extract<Row, { kind: 'invite' }> =>
            r.kind === 'invite' &&
            !!r.invite &&
            (!r.invite.outgoing || r.invite.acceptedIds.length > 0) &&
            r.item.start - 10 * 60_000 <= now &&
            r.item.end > now &&
            !hiddenPrompts.includes(`shapeprompt:${r.invite.id}`),
        )
      : undefined;

  function inviteFromBreak(b: PlannedBreak) {
    onInvite({ kinds: b.kind === 'meal' ? ['meal', 'break-together'] : ['break-together', 'meal'], start: b.start, end: b.end });
  }
  function inviteFromSession(s: ScheduleItem, preselect?: string[]) {
    onInvite({ kinds: ['sit-together', 'arrive-together', 'walk-over'], start: s.start, end: s.end, sessionId: s.programmeSessionId, sessionTitle: s.title, room: s.place, preselect });
  }
  async function leaveOrCancel(r: Extract<Row, { kind: 'invite' }>) {
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
    await refresh();
  }

  // Arrow keys move through radios and select as they go (WCAG 3.2.2): save each pick but keep the choices
  // open; Done closes them. The screen reader reads each option as it's reached, so nothing is announced here.
  async function chooseEnergy(l: EnergyLevel) {
    setChangingEnergy(true);
    await setSetting('energy', { level: l, setAt: Date.now() });
    await refresh();
  }
  function doneEnergy() {
    setChangingEnergy(false);
    setTimeout(() => changeEnergyBtn.current?.focus(), 0); // keep focus where the choices were
    announce(`Energy: ${ENERGY[level].label}. Your day’s been updated.`);
  }
  function openEnergy() {
    setChangingEnergy(true);
    setTimeout(() => document.querySelector<HTMLInputElement>('input[name="energy"]:checked')?.focus(), 0);
  }

  async function addProtected(kind: Exclude<ProtectedKind, 'focus'>, from: number, minutes: number) {
    await putScheduleItem({
      id: `protect-${kind}-${from}`, // the same block twice (a double tap) overwrites instead of duplicating
      type: 'protected',
      protectedKind: kind,
      source: 'user',
      title: PROTECT_LABELS[kind].label,
      start: from,
      end: from + minutes * 60_000,
    });
    await refresh();
    announce(`${PROTECT_LABELS[kind].label} protected, ${timeRangeSpoken(from, from + minutes * 60_000)}.`);
  }

  async function removeItem(item: ScheduleItem) {
    await deleteScheduleItem(item.id);
    await refresh();
    announce(`Removed ${item.title}.`);
  }

  async function toggleFocus(item: ScheduleItem) {
    await putScheduleItem({ ...item, focus: !item.focus });
    await refresh();
    announce(item.focus ? `Focus off for ${item.title}.` : `Focus on for ${item.title}. Invites wait until it ends.`);
  }

  async function skip(b: PlannedBreak) {
    await skipBreak(b.key);
    await refresh();
    announce(b.kind === 'meal' ? 'Lunch suggestion skipped.' : 'Breather skipped.');
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

      {setToday && !changingEnergy ? (
        <div class="energy-summary">
          <p>
            <span aria-hidden="true">{ENERGY[level].glyph} </span>
            Today’s energy: <strong>{ENERGY[level].label}</strong>
          </p>
          <button type="button" class="button quiet" ref={changeEnergyBtn} aria-label="Change today’s energy" onClick={openEnergy}>
            Change
          </button>
        </div>
      ) : (
      <fieldset class="energy">
        <legend>{setToday ? 'Today’s energy' : `${greeting(new Date(now).getHours())}, ${name}. How’s your energy?`}</legend>
        {!setToday && <p class="hint">Up for it is the default. Change it whenever.</p>}
        <div class="energy-options">
          {ENERGY_ORDER.map((l) => (
            <label key={l} class={`energy-option${l === level ? ' chosen' : ''}`}>
              <input type="radio" name="energy" value={l} checked={l === level} onChange={() => void chooseEnergy(l)} />
              <span class="energy-glyph" aria-hidden="true">
                {ENERGY[l].glyph}
              </span>
              <span class="energy-label">{ENERGY[l].label}</span>
              <span class="energy-line">{ENERGY[l].line}</span>
            </label>
          ))}
        </div>
        {setToday && (
          <div class="actions">
            <button type="button" class="button secondary" onClick={doneEnergy}>
              Done
            </button>
          </div>
        )}
      </fieldset>
      )}

      {days.length > 1 && (
        <div class="segmented" role="group" aria-label="Day">
          {days.map((d) => (
            <button key={d} type="button" aria-pressed={d === day} onClick={() => setDay(d)}>
              {d === today ? 'Today' : dayLabel(d)}
            </button>
          ))}
        </div>
      )}

      {meetupNow && meetupNow.invite && (
        <section class="card stack shape-now" aria-labelledby="shape-now-heading">
          <h3 id="shape-now-heading">
            {meetupNow.item.start > now ? `Starting at ${clock(meetupNow.item.start)}` : 'On now'}: {meetupNow.invite ? inviteTitle(meetupNow.invite, meetupNow.invite.acceptedIds.map(nameOf)) : meetupNow.item.title}
          </h3>
          <p>{meetupContext(meetupNow.item, meetupNow.invite)}</p>
          <p class="shape-line">
            You’re all looking for <ShapeBadge seedKey={meetupNow.invite.id} />
          </p>
          <button type="button" class="button big" onClick={() => setShapeFor({ id: meetupNow.invite!.id, context: meetupContext(meetupNow.item, meetupNow.invite!) })}>
            Display your shape to find each other
          </button>
          <div class="actions">
            <button
              type="button"
              class="button quiet"
              onClick={async () => {
                const title = meetupNow.item.title;
                await dismiss(`shapeprompt:${meetupNow.invite!.id}`);
                await refresh();
                announce('Hidden. Your shape is still on the meetup in your day.');
                // The card is gone: keep keyboard focus near, on that meetup's own button.
                setTimeout(() => {
                  const btns = [...document.querySelectorAll<HTMLElement>('.day-row.is-social [aria-label^="Show your shape"]')];
                  (btns.find((el) => el.getAttribute('aria-label') === `Show your shape for ${title}`) ?? btns[0])?.focus();
                }, 0);
              }}
            >
              Hide
            </button>
          </div>
        </section>
      )}

      <InvitesPanel
        invites={incoming}
        connections={connections}
        items={items}
        relay={relay}
        heldUntil={holding ? holding.end : null}
        nextBreak={nextBreak}
        onChanged={() => void refresh()}
      />

      <SuggestionsPanel
        programme={programme}
        items={items}
        connections={connections}
        level={level}
        day={day}
        isToday={day === today}
        myTopics={myTopics}
        onInvite={onInvite}
        onChanged={() => void refresh()}
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
              <li key={r.kind === 'break' ? r.brk.key : r.item.id} class={`day-row ${rowClass(r)}`}>
                <span class="day-glyph" aria-hidden="true">
                  {glyph(r)}
                </span>
                <div class="day-body">
                  <p class="day-time">
                    <span aria-hidden="true">{timeRange(start(r), end(r))}</span>
                    <span class="visually-hidden">{timeRangeSpoken(start(r), end(r))}</span>
                    <span class="day-kind"> · {kindLabel(r)}</span>
                  </p>
                  <p class="day-title">
                    {r.kind === 'invite' && r.invite ? inviteTitle(r.invite, r.invite.acceptedIds.map(nameOf)) : title(r)}
                    {r.kind === 'invite' && r.invite?.simulated && <span class="badge"><span class="visually-hidden">, </span>Simulated</span>}
                    {r.kind === 'session' && r.item.starter && <span class="badge"><span class="visually-hidden">, </span>Sample</span>}
                  </p>
                  {r.kind === 'invite' && r.invite?.outgoing && (
                    <p class="muted">
                      {r.invite.acceptedIds.length === 0
                        ? `Invited ${r.invite.recipientIds.length}. Nobody yet, and that’s fine.`
                        : `${r.invite.acceptedIds.length} said yes.`}
                    </p>
                  )}
                  {r.kind === 'invite' && r.item.place && <p class="muted">{r.item.place}</p>}
                  {r.kind === 'invite' && r.invite && (!r.invite.outgoing || r.invite.acceptedIds.length > 0) && (
                    <p class="shape-line">
                      Find each other by <ShapeBadge seedKey={r.invite.id} />
                    </p>
                  )}
                  {r.kind === 'session' && r.item.place && <p class="muted">{r.item.place}</p>}
                  {r.kind === 'session' &&
                    (() => {
                      const going = alsoGoing(r.item.programmeSessionId, connections);
                      if (!going.length) return null;
                      return (
                        <p class="also-going">
                          <span aria-hidden="true">◆ </span>
                          Also going: {namesList(going)}.{' '}
                          <button type="button" class="button quiet inline" onClick={() => inviteFromSession(r.item, going.map((g) => g.id))}>
                            Sit together?
                          </button>
                        </p>
                      );
                    })()}
                  {r.kind === 'session' && r.item.focus && <p class="hint">Focus: invites and nudges wait until it ends.</p>}
                  {r.kind === 'protected' && r.item.protectedKind !== 'focus' && (
                    <p class="hint">{PROTECT_LABELS[r.item.protectedKind as 'recharge' | 'off']?.line}</p>
                  )}
                </div>
                <div class="day-actions">
                  {r.kind === 'session' && (
                    <>
                      <button type="button" class="button quiet" aria-pressed={!!r.item.focus} aria-label={`Focus on ${r.item.title}`} onClick={() => void toggleFocus(r.item)}>
                        Focus
                      </button>
                      {r.item.end > now + 2 * 60_000 && (
                        <button type="button" class="button quiet" aria-label={`Invite someone to ${r.item.title}`} onClick={() => inviteFromSession(r.item)}>
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
                      {r.brk.end > now + 2 * 60_000 && (
                        <button type="button" class="button quiet" aria-label={`Invite someone to your ${r.brk.kind === 'meal' ? 'lunch' : 'breather'} at ${clock(r.brk.start)}`} onClick={() => inviteFromBreak(r.brk)}>
                          Invite
                        </button>
                      )}
                      <button type="button" class="button quiet" aria-label={`Skip ${r.brk.kind === 'meal' ? 'lunch' : 'breather'} at ${clock(r.brk.start)}`} onClick={() => void keepingFocus(() => skip(r.brk))}>
                        Skip
                      </button>
                    </>
                  )}
                  {r.kind === 'invite' && (
                    <>
                      {r.invite && (!r.invite.outgoing || r.invite.acceptedIds.length > 0) && (
                        <button type="button" class="button quiet" aria-label={`Show your shape for ${r.item.title}`} onClick={() => setShapeFor({ id: r.invite!.id, context: meetupContext(r.item, r.invite!) })}>
                          Show your shape
                        </button>
                      )}
                      {r.invite?.outgoing && confirmCallOff === r.item.id ? (
                        <span role="group" aria-label={`Call off ${r.item.title}?`} class="inline-confirm">
                          <span>Call it off? Everyone invited is told.</span>{' '}
                          <button
                            type="button"
                            class="button danger"
                            ref={confirmCallOffBtn}
                            onClick={() => void keepingFocus(async () => {
                              setConfirmCallOff(null);
                              await leaveOrCancel(r);
                            })}
                          >
                            Call off
                          </button>
                          <button type="button" class="button quiet" onClick={() => keepMeetup(r.item.id)}>
                            Keep it
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          class="button quiet"
                          data-calloff={r.item.id}
                          aria-label={`${r.invite?.outgoing ? 'Call off' : 'Leave'} ${r.item.title}`}
                          onClick={() => (r.invite?.outgoing ? setConfirmCallOff(r.item.id) : void keepingFocus(() => leaveOrCancel(r)))}
                        >
                          {r.invite?.outgoing ? 'Call off' : 'Leave'}
                        </button>
                      )}
                    </>
                  )}
                </div>
              </li>
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

/** "Lunch hall · Back left, by the door" for a meetup. */
function meetupContext(item: ScheduleItem, inv: Invite): string {
  return [item.place ?? inv.place, describeSpot(inv.meetingSpot)].filter(Boolean).join(' · ') || KIND_INFO[inv.kind].label;
}

function start(r: Row) {
  return r.kind === 'break' ? r.brk.start : r.item.start;
}
function end(r: Row) {
  return r.kind === 'break' ? r.brk.end : r.item.end;
}
function glyph(r: Row) {
  if (r.kind === 'invite') return '◆';
  if (r.kind === 'session') return r.item.focus ? '◉' : '▲';
  if (r.kind === 'protected') return PROTECT_LABELS[r.item.protectedKind as 'recharge' | 'off']?.glyph ?? '■';
  return r.brk.kind === 'meal' ? '◒' : '○';
}
function kindLabel(r: Row) {
  if (r.kind === 'invite') return r.invite ? `Social · ${KIND_INFO[r.invite.kind].label}` : 'Social';
  if (r.kind === 'session') return r.item.focus ? 'Sprint, focus' : 'Sprint';
  if (r.kind === 'protected') return 'Protected';
  return r.brk.kind === 'meal' ? 'Lunch' : 'Breather';
}
function title(r: Row) {
  if (r.kind !== 'break') return r.item.title;
  return r.brk.kind === 'meal' ? 'Lunch. Eat something good.' : 'Water, air, or nothing.';
}
function rowClass(r: Row) {
  return r.kind === 'session' ? 'is-session' : r.kind === 'protected' ? 'is-protected' : r.kind === 'invite' ? 'is-social' : 'is-break';
}

function HeadsUpCard({ h, onRecharge, onEdit }: { h: HeadsUp; onRecharge: (from: number, mins: number) => void; onEdit: () => void }) {
  if (h.kind === 'no-lunch') {
    return (
      <div class="card stack heads-up">
        <p>
          <strong>Heads-up:</strong> no gap for lunch on this day. Want to drop a session, or grab something on the way?
        </p>
        <div class="actions">
          <button type="button" class="button secondary" onClick={onEdit}>
            Look at sessions
          </button>
        </div>
      </div>
    );
  }
  const mins = h.recharge ? Math.round((h.recharge.end - h.recharge.start) / 60_000) : 0;
  return (
    <div class="card stack heads-up">
      <p>
        <strong>Heads-up:</strong> back-to-back from {clock(h.from)} to {clock(h.until)}.
        {h.recharge ? ` Want a ${mins}-minute recharge at ${clock(h.recharge.start)}?` : ' Pace yourself.'}
      </p>
      {h.recharge && (
        <div class="actions">
          <button type="button" class="button secondary" onClick={() => onRecharge(h.recharge!.start, mins)}>
            Protect a recharge
          </button>
        </div>
      )}
    </div>
  );
}

function ProtectForm({
  day,
  onAdd,
  onCancel,
}: {
  day: number;
  onAdd: (kind: 'recharge' | 'off', from: number, minutes: number) => Promise<void>;
  onCancel: () => void;
}) {
  const slots = Array.from({ length: (21 - 7) * 4 + 1 }, (_, i) => atMinutes(day, 7 * 60 + i * 15));
  const nowSlot = slots.find((s) => s > Date.now()) ?? slots[0]!;
  const [kind, setKind] = useState<'recharge' | 'off'>('recharge');
  const [from, setFrom] = useState(nowSlot);
  const [minutes, setMinutes] = useState(30);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []); // opening it moves focus into it

  return (
    <form
      id="protect-form"
      class="card stack"
      aria-labelledby="protect-heading"
      onSubmit={(e) => {
        e.preventDefault();
        void onAdd(kind, from, minutes);
      }}
    >
      <h3 id="protect-heading" ref={heading} tabIndex={-1}>
        Protect some time
      </h3>
      <p class="hint">Only you see this. To anyone else you’re simply not free.</p>
      <fieldset>
        <legend>Kind</legend>
        {(['recharge', 'off'] as const).map((k) => (
          <label class="check" key={k}>
            <input type="radio" name="protect-kind" checked={kind === k} onChange={() => setKind(k)} />
            <span>
              <strong>{PROTECT_LABELS[k].label}</strong>: {PROTECT_LABELS[k].line}
            </span>
          </label>
        ))}
      </fieldset>
      <div class="field">
        <label for="protect-from">From</label>
        <select id="protect-from" value={from} onChange={(e) => setFrom(Number(e.currentTarget.value))}>
          {slots.map((s) => (
            <option key={s} value={s}>
              {clock(s)}
            </option>
          ))}
        </select>
      </div>
      <div class="field">
        <label for="protect-length">For</label>
        <select id="protect-length" value={minutes} onChange={(e) => setMinutes(Number(e.currentTarget.value))}>
          {[15, 30, 45, 60, 90, 120].map((m) => (
            <option key={m} value={m}>
              {m < 60 ? `${m} minutes` : m === 60 ? '1 hour' : `${m / 60} hours`}
            </option>
          ))}
        </select>
      </div>
      <div class="actions">
        <button type="submit" class="button">
          Protect it
        </button>
        <button type="button" class="button secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
