import { useEffect, useState } from 'preact/hooks';
import { onAnnounce } from './announce';

/** Visually hidden live region. Clears first so the same message can be announced twice. */
export function Announcer() {
  const [message, setMessage] = useState('');
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = onAnnounce((m) => {
      setMessage('');
      clearTimeout(timer);
      timer = setTimeout(() => setMessage(m), 50);
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, []);
  return (
    <div class="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
      {message}
    </div>
  );
}
