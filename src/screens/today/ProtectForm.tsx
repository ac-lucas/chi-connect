// Protect some time (F22): a Recharge block, the only time invites wait. Opening it moves focus in; the caller returns focus on close.
import { useEffect, useRef, useState } from 'preact/hooks';
import { atMinutes, clockTime as clock } from '../../programme/programme';
import { PROTECT_LABELS } from './rows';

export function ProtectForm({
  day,
  sessions,
  onAdd,
  onCancel,
}: {
  day: number;
  /** Saved sessions that day: times during one are marked, and the form starts at the first free slot. */
  sessions: { title: string; start: number; end: number }[];
  onAdd: (from: number, minutes: number) => Promise<void>;
  onCancel: () => void;
}) {
  const slots = Array.from({ length: (21 - 7) * 4 + 1 }, (_, i) => atMinutes(day, 7 * 60 + i * 15));
  const during = (from: number, mins: number) => sessions.find((s) => s.start < from + mins * 60_000 && s.end > from);
  const upcoming = slots.filter((s) => s > Date.now());
  const nowSlot = upcoming.find((s) => !during(s, 30)) ?? upcoming[0] ?? slots[0]!;
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
        void onAdd(from, minutes);
      }}
    >
      <h3 id="protect-heading" ref={heading} tabIndex={-1}>
        Protect some time
      </h3>
      <p class="hint">{PROTECT_LABELS.recharge.line} Only you see why.</p>
      <div class="field">
        <label for="protect-from">From</label>
        <select id="protect-from" value={from} onChange={(e) => setFrom(Number(e.currentTarget.value))}>
          {slots.map((s) => (
            <option key={s} value={s}>
              {clock(s)}
              {during(s, 15) ? ' (during a session)' : ''}
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
      {during(from, minutes) && <p class="hint">Heads-up: this is during {during(from, minutes)!.title}.</p>}
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
