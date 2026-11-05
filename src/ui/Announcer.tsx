import { createPortal } from 'preact/compat';
import { useEffect, useState } from 'preact/hooks';
import { onAnnounce } from './announce';

/** Visually hidden live region. Clears first so the same message can be announced twice. */
export function Announcer() {
  const [message, setMessage] = useState('');
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Messages that arrive close together are joined and read as one: replacing the region's text would make
    // screen readers read only the last of them.
    let pending = '';
    const off = onAnnounce((m) => {
      pending = pending ? `${pending} ${m}` : m;
      setMessage('');
      clearTimeout(timer);
      timer = setTimeout(() => {
        setMessage(pending);
        pending = '';
      }, 100);
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, []);
  // Rendered into <body>, outside #app: the app goes inert behind the full-screen shape, and a live region inside
  // an inert subtree is never read.
  return createPortal(
    <div class="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
      {message}
    </div>,
    document.body,
  );
}
