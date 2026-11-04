import { useEffect, useRef, useState } from 'preact/hooks';
import { findMeCard, type FindMeCard } from '../schedule/findme';

const SHAPES: Record<FindMeCard['shape'], string> = {
  Triangle: 'M100 18 L186 172 L14 172 Z',
  Circle: 'M100 15 A85 85 0 1 1 99.9 15 Z',
  Square: 'M22 22 H178 V178 H22 Z',
  Star: 'M100 10 L124 74 L192 76 L138 118 L158 184 L100 146 L42 184 L62 118 L8 76 L76 74 Z',
  Diamond: 'M100 8 L192 100 L100 192 L8 100 Z',
  Hexagon: 'M100 10 L178 55 L178 145 L100 190 L22 145 L22 55 Z',
};

function Pattern({ kind, fg }: { kind: FindMeCard['pattern']; fg: string }) {
  const id = `p-${kind}`;
  return (
    <defs>
      <pattern id={id} width="20" height="20" patternUnits="userSpaceOnUse">
        {kind === 'Stripes' && <path d="M0 20 L20 0" stroke={fg} stroke-width="5" />}
        {kind === 'Dots' && <circle cx="10" cy="10" r="4" fill={fg} />}
        {kind === 'Waves' && <path d="M0 10 Q5 4 10 10 T20 10" fill="none" stroke={fg} stroke-width="3" />}
        {kind === 'Checks' && <path d="M0 0 H10 V10 H0 Z M10 10 H20 V20 H10 Z" fill={fg} />}
      </pattern>
    </defs>
  );
}

/**
 * Full-screen card to hold up so people in the same meetup can spot each other. A word, a shape and a pattern,
 * never colour alone. A dialog: focus moves in, Escape or Done closes, focus goes back.
 */
export function FindMeCardView({ inviteId, onClose }: { inviteId: string; onClose: () => void }) {
  const [card, setCard] = useState<FindMeCard | null>(null);
  const done = useRef<HTMLButtonElement>(null);
  // Remember what opened the card (captured on first render, before focus moves), to return focus there.
  const [opener] = useState(() => document.activeElement as HTMLElement | null);

  useEffect(() => {
    void findMeCard(inviteId).then(setCard);
  }, [inviteId]);
  useEffect(() => {
    if (card) done.current?.focus();
  }, [card]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab') {
        e.preventDefault(); // only one control in here
        done.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  if (!card) return null;
  const { bg, fg } = card.colour;
  return (
    <div class="findme" role="dialog" aria-modal="true" aria-labelledby="findme-word" style={{ background: bg, color: fg }}>
      <p class="findme-lead">Hold this up. Look for the same card.</p>
      <svg class="findme-shape" viewBox="0 0 200 200" role="img" aria-label={`${card.word} with ${card.pattern.toLowerCase()}`}>
        <Pattern kind={card.pattern} fg={bg} />
        <path d={SHAPES[card.shape]} fill={fg} />
        <path d={SHAPES[card.shape]} fill={`url(#p-${card.pattern})`} />
      </svg>
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
