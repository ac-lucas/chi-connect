// Protect some time (F22): Recharge or Off. Opening it moves focus in; the caller returns focus on close.
import { useEffect, useRef, useState } from 'preact/hooks';
import { atMinutes, clockTime as clock } from '../../programme/programme';
import { PROTECT_LABELS } from './rows';

export function ProtectForm({
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
