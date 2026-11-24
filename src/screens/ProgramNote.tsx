import type { Program } from '../program/types';

/**
 * Where the sessions come from: a preview with moved dates, or live. The license credit shows here unless
 * `credit` is false (Today leaves it to the You screen and Add sessions, which always show it).
 */
export function ProgramNote({ program, credit = true }: { program: Program; credit?: boolean }) {
  return (
    <div class="hint stack-tight">
      {program.shiftedFrom !== undefined && (
        <p>
          <span class="badge">Preview</span> {program.name} program, moved to this week.
        </p>
      )}
      {credit && program.credit && (
        <p class="credit">
          {program.credit}{' '}
          <a href="https://creativecommons.org/licenses/by-nc-sa/4.0/" target="_blank" rel="noopener noreferrer">
            License
          <span class="visually-hidden"> (opens in a new tab)</span></a>
        </p>
      )}
    </div>
  );
}
