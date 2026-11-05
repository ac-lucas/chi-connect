import { useEffect, useRef, useState } from 'preact/hooks';
import { onStoresChanged, type StoreName } from '../storage/changes';

/**
 * Read something from storage and keep it current: loads once, then again whenever one of `stores` changes
 * (in this tab or another). The usual "live query" pattern, so screens never need to be told to refresh.
 * Returns undefined until the first load finishes.
 */
export function useLive<T>(load: () => Promise<T>, stores: readonly StoreName[], deps: readonly unknown[] = []): T | undefined {
  const [value, setValue] = useState<T | undefined>(undefined);
  const latest = useRef(load);
  latest.current = load;
  useEffect(() => {
    let live = true;
    let run = 0;
    const reload = () => {
      const mine = ++run; // only the newest load may set the value
      latest.current().then(
        (v) => live && mine === run && setValue(() => v),
        () => {}, // storage trouble: keep showing what we had
      );
    };
    reload();
    const off = onStoresChanged((changed) => {
      if (stores.some((s) => changed.has(s))) reload();
    });
    return () => {
      live = false;
      off();
    };
  }, deps);
  return value;
}
