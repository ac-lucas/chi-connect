import { dayLabel } from '../programme/programme';
import type { Programme } from '../programme/types';

/**
 * Where the sessions come from: a preview with moved dates, or live. The licence credit shows here unless
 * `credit` is false (Today leaves it to the You screen and Add sessions, which always show it).
 */
export function ProgrammeNote({ programme, credit = true }: { programme: Programme; credit?: boolean }) {
  return (
    <div class="hint stack-tight">
      {programme.shiftedFrom !== undefined && (
        <p>
          <span class="badge">Preview</span> Last year’s {programme.name} programme, shown as if it starts{' '}
          {dayLabel(programme.sessions[0]?.start ?? Date.now(), 'long')}. Times are as published; parallel tracks share a slot.
        </p>
      )}
      {credit && programme.credit && (
        <p class="credit">
          {programme.credit}{' '}
          <a href="https://creativecommons.org/licenses/by-nc-sa/4.0/" target="_blank" rel="noopener noreferrer">
            Licence
          <span class="visually-hidden"> (opens in a new tab)</span></a>
        </p>
      )}
    </div>
  );
}
