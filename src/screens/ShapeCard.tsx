import { useEffect, useRef, useState } from 'preact/hooks';
import { findMeCard, SHAPE_PATHS, type ShapeCard } from '../schedule/findme';

function Pattern({ kind, colour, id }: { kind: ShapeCard['pattern']; colour: string; id: string }) {
  return (
    <defs>
      <pattern id={id} width="20" height="20" patternUnits="userSpaceOnUse">
        {kind === 'Stripes' && <path d="M0 20 L20 0" stroke={colour} stroke-width="5" />}
        {kind === 'Dots' && <circle cx="10" cy="10" r="4" fill={colour} />}
        {kind === 'Waves' && <path d="M0 10 Q5 4 10 10 T20 10" fill="none" stroke={colour} stroke-width="3" />}
        {kind === 'Checks' && <path d="M0 0 H10 V10 H0 Z M10 10 H20 V20 H10 Z" fill={colour} />}
      </pattern>
    </defs>
  );
}

/** The shape itself: filled, patterned and outlined so it reads from across a room. */
export function ShapeGraphic({ card, size, label, idSuffix }: { card: ShapeCard; size?: string; label?: string; idSuffix: string }) {
  const { bg, fg } = card.colour;
  const pid = `pat-${idSuffix}`;
  return (
    <svg class="shape-graphic" viewBox="-6 -6 212 212" style={size ? { width: size, height: size } : undefined} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : 'true'}>
      <Pattern kind={card.pattern} colour={bg} id={pid} />
      <path d={SHAPE_PATHS[card.shape]} fill={fg} stroke={fg} stroke-width="10" stroke-linejoin="round" />
      <path d={SHAPE_PATHS[card.shape]} fill={`url(#${pid})`} />
    </svg>
  );
}

/** Small inline preview: "★ Orange Star" on its colour, so people know what to look for before they arrive. */
export function ShapeBadge({ seedKey, card: given }: { seedKey?: string; card?: ShapeCard }) {
  const [card, setCard] = useState<ShapeCard | null>(given ?? null);
  useEffect(() => {
    if (!given && seedKey) void findMeCard(seedKey).then(setCard);
  }, [seedKey, given]);
  if (!card) return null;
  return (
    <span class="shape-badge" style={{ background: card.colour.bg, color: card.colour.fg }}>
      <ShapeGraphic card={card} size="1.25em" idSuffix={`b-${seedKey ?? card.word}`} />
      <span>{card.word}</span>
    </span>
  );
}

/**
 * Full-screen "Your shape" to hold up. A word, a shape and a pattern, never colour alone. A dialog: focus moves in,
 * Escape or Done closes, focus goes back. Keeps the screen awake while it's up, where the browser allows it.
 */
export function ShapeCardView({ card, context, onClose }: { card: ShapeCard; context?: string; onClose: () => void }) {
  const done = useRef<HTMLButtonElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const [opener] = useState(() => document.activeElement as HTMLElement | null);

  useEffect(() => {
    done.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab') {
        // Keep focus inside: it moves between the corner close button and Done.
        e.preventDefault();
        (document.activeElement === done.current ? close.current : done.current)?.focus();
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
        if (wl && open && document.visibilityState === 'visible') lock = await wl.request('screen');
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
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  const { bg, fg } = card.colour;
  return (
    <div class="findme" role="dialog" aria-modal="true" aria-labelledby="findme-word" aria-describedby="findme-lead" style={{ background: bg, color: fg }}>
      <button type="button" ref={close} class="findme-close" aria-label="Close" style={{ color: fg, borderColor: fg }} onClick={onClose}>
        <span aria-hidden="true">✕</span>
      </button>
      <p id="findme-lead" class="findme-lead">
        Hold this up. Look for the same shape.
      </p>
      {context && <p class="findme-context">{context}</p>}
      <ShapeGraphic card={card} label={`${card.word} with ${card.pattern.toLowerCase()}`} idSuffix="full" />
      <h2 id="findme-word" class="findme-word">
        {card.word}
      </h2>
      <p class="findme-pattern">{card.pattern}</p>
      <button type="button" ref={done} class="findme-done" style={{ color: bg, background: fg }} onClick={onClose}>
        Done
      </button>
      <p class="findme-brand">Pebble</p>
    </div>
  );
}

/** Full-screen shape for a meetup, from its invite ID. */
export function MeetupShapeView({ inviteId, context, onClose }: { inviteId: string; context?: string; onClose: () => void }) {
  const [card, setCard] = useState<ShapeCard | null>(null);
  useEffect(() => {
    void findMeCard(inviteId).then(setCard);
  }, [inviteId]);
  return card ? <ShapeCardView card={card} context={context} onClose={onClose} /> : null;
}
