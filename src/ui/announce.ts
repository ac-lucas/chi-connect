// Screen reader announcements through one polite live region (rendered by <Announcer />).
type Listener = (message: string) => void;
const listeners = new Set<Listener>();

export function announce(message: string): void {
  for (const l of listeners) l(message);
}

export function onAnnounce(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
