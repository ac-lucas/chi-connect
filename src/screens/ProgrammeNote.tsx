import { dayLabel } from '../programme/programme';
import type { Programme } from '../programme/types';

/** Where the sessions come from: sample, preview with moved dates, or live. Always with the licence credit for real data. */
export function ProgrammeNote({ programme }: { programme: Programme }) {
  if (programme.sample) {
    return (
      <p class="hint">
        <span class="badge">Sample</span> Made-up sessions so you can try things out. The real programme replaces these.
      </p>
    );
  }
  return (
    <div class="hint stack-tight">
      {programme.shiftedFrom !== undefined && (
        <p>
          <span class="badge">Preview</span> {programme.name} programme, with its days moved to start{' '}
          {dayLabel(programme.sessions[0]?.start ?? Date.now(), 'long')} so you can try it now. Times are as published.
        </p>
      )}
      {programme.credit && (
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
