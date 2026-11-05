// Keep keyboard and screen reader focus in place when the focused control disappears (Remove, Skip, Yes, Not now...).
// Without this, focus falls back to the top of the page (WCAG 2.4.3 Focus Order).

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';
const ROW = 'li, [data-row]';

function headingOf(el: Element | null): HTMLElement | null {
  const section = el?.closest('section, fieldset, form');
  return section?.querySelector<HTMLElement>('h2, h3, legend') ?? null;
}

const mainHeading = () => document.querySelector<HTMLElement>('main h2');

/** Check again over about a second: the change may finish after the screen's own refresh, which isn't awaited. */
const CHECKS_MS = [0, 50, 150, 300, 600, 1000];

/**
 * Call before a change that may remove the focused control. Returns a function to call once the change is
 * done. Until the control actually disappears it waits; then it moves focus to the next row's first control (or
 * the previous row's, at the end of a list), else the section heading, else the screen heading. If the change
 * moved focus somewhere itself, it leaves that alone.
 */
export function holdFocus(from: Element | null = document.activeElement): () => void {
  const origin = from instanceof HTMLElement ? from : null;
  const row = origin?.closest(ROW) ?? null;
  const next = row?.nextElementSibling ?? null;
  const prev = row?.previousElementSibling ?? null;
  const heading = headingOf(origin);
  const settle = (): boolean => {
    const active = document.activeElement;
    if (active && active !== document.body && active !== origin) return true; // focus was moved on purpose
    if (origin?.isConnected && active === origin) return false; // still there: keep waiting
    if (origin?.isConnected) {
      origin.focus();
      return true;
    }
    for (const r of [next, prev]) {
      const target = r?.isConnected ? r.querySelector<HTMLElement>(FOCUSABLE) : null;
      if (target) {
        target.focus();
        return true;
      }
    }
    const h = heading?.isConnected ? heading : mainHeading();
    if (h) {
      if (!h.hasAttribute('tabindex')) h.setAttribute('tabindex', '-1');
      h.focus();
    }
    return true;
  };
  return () => {
    let i = 0;
    const step = () => {
      if (settle() || ++i >= CHECKS_MS.length) return;
      setTimeout(step, CHECKS_MS[i]! - CHECKS_MS[i - 1]!);
    };
    setTimeout(step, 0);
  };
}

/** Run a change that may remove the focused control, then put focus somewhere sensible (see holdFocus). */
export async function keepingFocus(change: () => unknown): Promise<void> {
  const restore = holdFocus();
  try {
    await change();
  } finally {
    restore();
  }
}
