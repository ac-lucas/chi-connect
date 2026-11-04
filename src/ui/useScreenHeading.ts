import { useLayoutEffect, useRef } from 'preact/hooks';

/**
 * Moves keyboard and screen reader focus to a screen's heading when the screen changes,
 * so people know where they are. Skipped on first load, where focus should start at the top.
 */
let firstScreen = true;

export function useScreenHeading<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    if (firstScreen) {
      firstScreen = false;
      return;
    }
    ref.current?.focus();
  }, []);
  return ref;
}
