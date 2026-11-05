// "This data changed" notices from storage writes, so screens reload what they show (see ui/useLive.ts) instead
// of being told to by hand-wired refresh calls. Writes in the same moment are joined into one notice. Other open
// tabs hear about them too, where BroadcastChannel exists (feature-detected; without it, only this tab updates).

export type StoreName = 'profile' | 'settings' | 'connections' | 'notes' | 'followUps' | 'schedule' | 'invites' | 'catchUp';
export const ALL_STORES: readonly StoreName[] = ['profile', 'settings', 'connections', 'notes', 'followUps', 'schedule', 'invites', 'catchUp'];

type Listener = (stores: ReadonlySet<StoreName>) => void;
const listeners = new Set<Listener>();
let pending = new Set<StoreName>();
let queued = false;

const channel: BroadcastChannel | null = (() => {
  try {
    if (typeof BroadcastChannel === 'undefined') return null;
    const c = new BroadcastChannel('pebble-changes');
    (c as unknown as { unref?: () => void }).unref?.(); // don't keep test runners alive
    return c;
  } catch {
    return null;
  }
})();

function deliver(stores: ReadonlySet<StoreName>) {
  for (const l of listeners) l(stores);
}

if (channel) channel.onmessage = (e: MessageEvent<StoreName[]>) => Array.isArray(e.data) && deliver(new Set(e.data));

/** Call after a write: the named stores changed. */
export function changed(...stores: StoreName[]): void {
  for (const s of stores) pending.add(s);
  if (queued) return;
  queued = true;
  void Promise.resolve().then(() => {
    const batch = pending;
    pending = new Set();
    queued = false;
    deliver(batch);
    try {
      channel?.postMessage([...batch]);
    } catch {
      // closed channel: other tabs just won't hear this one
    }
  });
}

/** Listen for changes. Returns a function that stops listening. */
export function onStoresChanged(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
