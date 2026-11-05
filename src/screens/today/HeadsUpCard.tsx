// "Heads-up" cards from the day planner: no gap for lunch, or a long back-to-back stretch (with a recharge offer).
import { clockTime as clock } from '../../programme/programme';
import type { HeadsUp } from '../../schedule/breaks';

export function HeadsUpCard({ h, onRecharge, onEdit }: { h: HeadsUp; onRecharge: (from: number, mins: number) => void; onEdit: () => void }) {
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
