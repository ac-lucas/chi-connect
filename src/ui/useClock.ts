import { useEffect, useState } from 'preact/hooks';

/**
 * The current time, updated every `everyMs` and as soon as the app comes back to the front, so screens follow the
 * clock. Paused while the app isn't on screen.
 */
export function useClock(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      clearInterval(timer);
      setNow(Date.now());
      timer = setInterval(() => setNow(Date.now()), everyMs);
    };
    const onVisibility = () => (document.visibilityState === 'visible' ? start() : clearInterval(timer));
    start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [everyMs]);
  return now;
}
