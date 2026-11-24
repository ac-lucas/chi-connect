import type { ComponentChildren } from 'preact';
import { createPortal } from 'preact/compat';
import { useEffect, useRef, useState } from 'preact/hooks';

/**
 * The full-screen shell for anything you hold up to find someone (a shape, a doodle). Its children must include
 * an element with id "findme-word": the dialog's name.
 */
export function HoldUpDialog({
  bg,
  fg,
  lead,
  srHint,
  context,
  onClose,
  art,
  actions,
  children,
}: {
  bg: string;
  fg: string;
  /** Shown first, at the top, as big as the screen allows (the drawing). The words follow it. */
  art?: ComponentChildren;
  /** Small buttons shown in one row with Done. */
  actions?: ComponentChildren;
  lead: ComponentChildren;
  /** Read out to screen reader users only, after the lead (for example "You don't need to look: Mina will find you."). */
  srHint?: string;
  context?: string;
  onClose: () => void;
  children: ComponentChildren;
}) {
  const done = useRef<HTMLButtonElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const [opener] = useState(() => document.activeElement as HTMLElement | null);

  useEffect(() => {
    // A modal: the app behind it can't be reached while it's up. `inert` where supported, else hidden from
    // assistive technology (the Tab trap below keeps keyboard focus in either case).
    const app = document.getElementById('app');
    const canInert = !!app && typeof (app as { inert?: unknown }).inert === 'boolean';
    if (app) {
      if (canInert) app.inert = true;
      else app.setAttribute('aria-hidden', 'true');
    }
    done.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab') {
        // Keep focus inside the card: Tab and Shift+Tab go round its buttons.
        const box = done.current?.closest('.findme');
        const all = box ? Array.from(box.querySelectorAll<HTMLElement>('button:not([disabled])')) : [];
        if (!all.length) return;
        e.preventDefault();
        const at = all.indexOf(document.activeElement as HTMLElement);
        const next = e.shiftKey ? (at <= 0 ? all.length - 1 : at - 1) : at === -1 || at === all.length - 1 ? 0 : at + 1;
        all[next]!.focus();
      }
    };
    document.addEventListener('keydown', onKey);

    // Screen Wake Lock: support differs by browser (verify on devices). Released when the card closes, and
    // asked for again if the page comes back to the front while the card is still up.
    let lock: { release(): Promise<void> } | null = null;
    let open = true;
    const wake = async () => {
      try {
        const wl = (navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock;
        if (!wl || !open || document.visibilityState !== 'visible') return;
        const got = await wl.request('screen');
        if (!open) {
          void got.release().catch(() => {}); // the card closed while asking: let it go straight away
          return;
        }
        const previous = lock;
        lock = got;
        void previous?.release().catch(() => {}); // never hold two
      } catch {
        // Not allowed or not supported: the card still works, the screen may just dim.
      }
    };
    void wake();
    document.addEventListener('visibilitychange', wake);
    return () => {
      open = false;
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', wake);
      void lock?.release().catch(() => {});
      if (app) {
        if (canInert) app.inert = false;
        else app.removeAttribute('aria-hidden');
      }
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  // Rendered straight into <body>, outside #app, so making the app inert doesn't make the card inert too.
  return createPortal(
    <div class={`findme${art ? ' art-first' : ''}`} role="dialog" aria-modal="true" aria-labelledby="findme-word" aria-describedby="findme-lead" style={{ background: bg, color: fg, '--findme-fg': fg }}>
      <button type="button" ref={close} class="findme-close" aria-label="Close" style={{ color: fg, borderColor: fg }} onClick={onClose}>
        <span aria-hidden="true">✕</span>
      </button>
      {art}
      {art && children}
      <p id="findme-lead" class="findme-lead">
        {lead}
        {/* Screen reader users often keep the display off (VoiceOver calls it Screen Curtain; other readers: verify).
            A card held up to be seen is no use then, so say so. */}
        <span class="visually-hidden">
          {srHint ? ` ${srHint}` : ''} If your screen is turned off, turn it on so others can see this.
        </span>
      </p>
      {context && <p class="findme-context">{context}</p>}
      {!art && children}
      <div class="findme-actions">
        {actions}
        <button type="button" ref={done} class="findme-done" style={{ color: bg, background: fg }} onClick={onClose}>
          Done
        </button>
      </div>
      <p class="findme-brand">Pebble</p>
    </div>,
    document.body,
  );
}
