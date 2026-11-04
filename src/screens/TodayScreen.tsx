import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { randomId } from '../model/ids';
import type { EnergyLevel, EnergySetting, ProtectedKind, ScheduleItem } from '../model/types';
import { dayLabel, programmeDays, startOfDay, timeRange, timeRangeSpoken } from '../programme/programme';
import type { Programme } from '../programme/types';
import { planDay, type Busy, type HeadsUp, type PlannedBreak } from '../schedule/breaks';
import { ENERGY, ENERGY_ORDER, energyToday } from '../schedule/energy';
import { deleteScheduleItem, getSetting, listAllSchedule, putScheduleItem, setSetting, skipBreak } from '../storage/db';
import { announce } from '../ui/announce';
import { useScreenHeading } from '../ui/useScreenHeading';

interface Props {
  name: string;
  programme: Programme;
  onAddSessions: (day: number) => void;
}

const DAY_MS = 86_400_000;
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
  | { kind: 'break'; brk: PlannedBreak };

export function TodayScreen({ name, programme, onAddSessions }: Props) {
  const heading = useScreenHeading<HTMLHeadingElement>();
  const now = Date.now();
  const days = programmeDays(programme);
  const today = startOfDay(now);
  const [day, setDay] = useState(days.includes(today) ? today : (days[0] ?? today));
  const [items, setItems] = useState<ScheduleItem[]>([]);
  const [energySetting, setEnergySetting] = useState<EnergySetting | undefined>(undefined);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [protecting, setProtecting] = useState(false);
  const [changingEnergy, setChangingEnergy] = useState(false);
  const changeEnergyBtn = useRef<HTMLButtonElement>(null);

  const refresh = async () => {
    setItems(await listAllSchedule());
    setEnergySetting(await getSetting('energy'));
    setSkipped((await getSetting('skippedBreaks')) ?? []);
  };
  useEffect(() => {
    void refresh();
  }, []);

  const { level, setToday } = energyToday(energySetting, now);
  const dayItems = items.filter((i) => i.start >= day && i.start < day + DAY_MS);
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
  ].sort((a, b) => start(a) - start(b));

  async function chooseEnergy(l: EnergyLevel) {
    await setSetting('energy', { level: l, setAt: Date.now() });
    await refresh();
    setChangingEnergy(false);
    // The choices close up after a pick; keep keyboard focus nearby instead of losing it.
    setTimeout(() => changeEnergyBtn.current?.focus(), 0);
    announce(`Energy: ${ENERGY[l].label}. Your day’s been updated.`);
  }

  async function addProtected(kind: Exclude<ProtectedKind, 'focus'>, from: number, minutes: number) {
    await putScheduleItem({
      id: randomId(),
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
          <button type="button" class="button quiet" ref={changeEnergyBtn} aria-label="Change today’s energy" onClick={() => setChangingEnergy(true)}>
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
                  <p class="day-title">{title(r)}</p>
                  {r.kind === 'session' && r.item.place && <p class="muted">{r.item.place}</p>}
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
                      <button type="button" class="button quiet" aria-label={`Remove ${r.item.title}`} onClick={() => void removeItem(r.item)}>
                        Remove
                      </button>
                    </>
                  )}
                  {r.kind === 'protected' && (
                    <button type="button" class="button quiet" aria-label={`Remove ${r.item.title} at ${clock(r.item.start)}`} onClick={() => void removeItem(r.item)}>
                      Remove
                    </button>
                  )}
                  {r.kind === 'break' && (
                    <button type="button" class="button quiet" aria-label={`Skip ${r.brk.kind === 'meal' ? 'lunch' : 'breather'} at ${clock(r.brk.start)}`} onClick={() => void skip(r.brk)}>
                      Skip
                    </button>
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
        <button type="button" class="button secondary" aria-expanded={protecting} onClick={() => setProtecting((p) => !p)}>
          Protect some time
        </button>
      </div>

      {protecting && (
        <ProtectForm
          day={day}
          onAdd={async (kind, from, minutes) => {
            await addProtected(kind, from, minutes);
            setProtecting(false);
          }}
          onCancel={() => setProtecting(false)}
        />
      )}
    </section>
  );
}

function start(r: Row) {
  return r.kind === 'break' ? r.brk.start : r.item.start;
}
function end(r: Row) {
  return r.kind === 'break' ? r.brk.end : r.item.end;
}
function glyph(r: Row) {
  if (r.kind === 'session') return r.item.focus ? '◉' : '▲';
  if (r.kind === 'protected') return PROTECT_LABELS[r.item.protectedKind as 'recharge' | 'off']?.glyph ?? '■';
  return r.brk.kind === 'meal' ? '◒' : '○';
}
function kindLabel(r: Row) {
  if (r.kind === 'session') return r.item.focus ? 'Sprint, focus' : 'Sprint';
  if (r.kind === 'protected') return 'Protected';
  return r.brk.kind === 'meal' ? 'Lunch' : 'Breather';
}
function title(r: Row) {
  if (r.kind !== 'break') return r.item.title;
  return r.brk.kind === 'meal' ? 'Lunch. Eat something good.' : 'Water, air, or nothing.';
}
function rowClass(r: Row) {
  return r.kind === 'session' ? 'is-session' : r.kind === 'protected' ? 'is-protected' : 'is-break';
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
  const slots = Array.from({ length: (21 - 7) * 4 + 1 }, (_, i) => day + (7 * 60 + i * 15) * 60_000);
  const nowSlot = slots.find((s) => s > Date.now()) ?? slots[0]!;
  const [kind, setKind] = useState<'recharge' | 'off'>('recharge');
  const [from, setFrom] = useState(nowSlot);
  const [minutes, setMinutes] = useState(30);

  return (
    <form
      class="card stack"
      aria-labelledby="protect-heading"
      onSubmit={(e) => {
        e.preventDefault();
        void onAdd(kind, from, minutes);
      }}
    >
      <h3 id="protect-heading">Protect some time</h3>
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
