// Meetup doodles (F27): draw to a prompt, hold up the other person's doodle, look for your own.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Connection, Invite } from '../model/types';
import {
  countPoints,
  decodeDoodle,
  doodleColor,
  doodlePath,
  DOODLE_LIMITS,
  drawingOf,
  encodeDoodle,
  generateDoodle,
  isPromptKey,
  PROMPTS,
  skipDoodle,
  thin,
  type Doodle,
  type Point,
} from '../schedule/doodle';
import { HoldUpDialog } from './ShapeCard';

const STROKE = 9;
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const decode = (s: string | undefined, fallbackSeed: string): Doodle => (s && decodeDoodle(s)) || generateDoodle(fallbackSeed);

export const promptText = (key: string | undefined) => (isPromptKey(key) ? PROMPTS[key] : 'anything at all');

/** A still doodle. */
export function DoodleGraphic({ doodle, size, label }: { doodle: Doodle; size?: string; label?: string }) {
  return (
    <svg
      class="doodle-graphic"
      viewBox="-12 -12 280 280"
      style={size ? { width: size, height: size } : undefined}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : 'true'}
    >
      <path d={doodlePath(doodle)} fill="none" stroke="currentColor" stroke-width={STROKE} stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

/** A small doodle on its meetup color, with words beside it: "Look for yours" in the day, on invites, on Today. */
export function DoodleBadge({ inviteId, doodle, text }: { inviteId: string; doodle: Doodle; text: string }) {
  const c = doodleColor(inviteId);
  return (
    <span class="shape-badge" style={{ background: c.bg, color: c.fg }}>
      <DoodleGraphic doodle={doodle} size="1.75em" />
      <span>{text}</span>
    </span>
  );
}

/** The doodle you look for at the meetup: your own. */
export function myDoodleOf(inv: Invite): Doodle {
  return inv.outgoing ? decode(inv.doodle, inv.id) : decode(inv.myDoodle, `${inv.id}:me`);
}

/**
 * Drawing pad: finger, pen or mouse. People who can't or don't want to draw use "Make one for me" or skip (a
 * generated doodle is sent for them). Reports the encoded doodle, or null while it's empty.
 */
export function DoodlePad({ prompt, onChange }: { prompt: string; onChange: (encoded: string | null) => void }) {
  const [strokes, setStrokes] = useState<Point[][]>([]);
  const [live, setLive] = useState<Point[] | null>(null);
  const pad = useRef<SVGSVGElement>(null);
  const current = useRef<Point[] | null>(null);
  const full = countPoints(strokes) >= DOODLE_LIMITS.points || strokes.length >= DOODLE_LIMITS.strokes;

  const commit = (next: Point[][]) => {
    setStrokes(next);
    onChange(next.length ? encodeDoodle(next) : null);
  };

  const at = (e: PointerEvent): Point => {
    const r = pad.current!.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * 255;
    const y = ((e.clientY - r.top) / r.height) * 255;
    return [Math.max(0, Math.min(255, Math.round(x))), Math.max(0, Math.min(255, Math.round(y)))];
  };

  const down = (e: PointerEvent) => {
    if (full || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    pad.current?.setPointerCapture?.(e.pointerId);
    current.current = [at(e)];
    setLive(current.current);
  };
  const move = (e: PointerEvent) => {
    if (!current.current) return;
    const room = DOODLE_LIMITS.points - countPoints(strokes) - current.current.length;
    if (room <= 0 || current.current.length >= DOODLE_LIMITS.strokePoints) return;
    const p = at(e);
    const last = current.current[current.current.length - 1]!;
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 2) return;
    current.current = [...current.current, p];
    setLive(current.current);
  };
  const up = () => {
    const s = current.current;
    current.current = null;
    setLive(null);
    if (!s) return;
    const kept = thin(s, 3).slice(0, DOODLE_LIMITS.strokePoints);
    const room = DOODLE_LIMITS.points - countPoints(strokes);
    if (kept.length && room > 0) commit([...strokes, kept.slice(0, room)]);
  };

  const shown = live ? [...strokes, live] : strokes;
  const empty = shown.length === 0;
  return (
    <div class="doodle-pad-wrap stack">
      <p class="doodle-prompt" id="doodle-prompt">
        Draw <strong>{prompt}</strong>. Rough is perfect.
      </p>
      <svg
        ref={pad}
        class="doodle-pad"
        viewBox="-12 -12 280 280"
        role="img"
        aria-label={
          empty
            ? 'Drawing space, empty. Draw with a finger, pen or mouse, or use Make one for me, below.'
            : `Your drawing, ${strokes.length} ${strokes.length === 1 ? 'line' : 'lines'}`
        }
        aria-describedby="doodle-prompt"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
      >
        {empty && (
          <text x="128" y="136" text-anchor="middle" class="doodle-pad-hint" aria-hidden="true">
            Draw here
          </text>
        )}
        <path d={doodlePath(shown)} fill="none" stroke="currentColor" stroke-width={STROKE} stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      {full && <p class="hint">That’s as much as fits. Undo a line to keep going.</p>}
      <div class="actions">
        <button type="button" class="button quiet" disabled={!strokes.length} onClick={() => commit(strokes.slice(0, -1))}>
          Undo
        </button>
        <button type="button" class="button quiet" disabled={!strokes.length} onClick={() => commit([])}>
          Clear
        </button>
        <button type="button" class="button quiet" onClick={() => commit(skipDoodle().map((s) => [...s]))}>
          Make one for me
        </button>
      </div>
    </div>
  );
}

/** Pencil, drawn with its tip at (0, 0), pointing down-left like it's mid-stroke. */
function Pencil({ at, fg, bg }: { at: Point; fg: string; bg: string }) {
  return (
    <g transform={`translate(${at[0]} ${at[1]}) rotate(-40)`} aria-hidden="true">
      <path d="M0 0 L-7 -18 L7 -18 Z" fill={fg} />
      <rect x="-7" y="-78" width="14" height="60" rx="2" fill={bg} stroke={fg} stroke-width="4" />
      <rect x="-7" y="-92" width="14" height="14" rx="3" fill={fg} />
    </g>
  );
}

const DRAW_MS = { min: 1200, max: 2600, perUnit: 2.2 };
const HOLD_MS = 3000;
const ERASE_MS = 450;
const STILL_MS = 6000;

/**
 * Draws each doodle the way it was drawn, stroke by stroke, with a pencil; holds it; erases; moves to the next.
 * One doodle is drawn once and stays. With reduced motion there is no drawing or pencil: doodles swap in place.
 * Anything that moves by itself has Pause (WCAG 2.2.2), and Next for more than one.
 */
export function DoodleReplay({ items, fg, bg }: { items: { doodle: Doodle; label: string }[]; fg: string; bg: string }) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [tip, setTip] = useState<Point | null>(null);
  const [fade, setFade] = useState(false);
  const paths = useRef<(SVGPathElement | null)[]>([]);
  const still = useMemo(reducedMotion, []);
  const many = items.length > 1;
  const item = items[index % items.length]!;

  useEffect(() => {
    let raf = 0;
    const timers: number[] = [];
    const els = paths.current.slice(0, item.doodle.length).filter((p): p is SVGPathElement => !!p);
    const show = (all: boolean) => {
      for (const p of els) {
        p.style.strokeDasharray = '';
        p.style.strokeDashoffset = '';
        p.style.visibility = all ? 'visible' : 'hidden';
      }
    };
    const next = () => setIndex((i) => (i + 1) % items.length);
    setFade(false);
    const canMeasure = els.every((p) => typeof p.getTotalLength === 'function');
    if (still || paused || !canMeasure) {
      show(true);
      setTip(null);
      if (many && !paused) timers.push(window.setTimeout(next, STILL_MS));
      return () => timers.forEach(clearTimeout);
    }
    const lengths = els.map((p) => Math.max(0.01, p.getTotalLength()));
    const total = lengths.reduce((a, b) => a + b, 0);
    const duration = Math.max(DRAW_MS.min, Math.min(DRAW_MS.max, total * DRAW_MS.perUnit));
    els.forEach((p, i) => {
      p.style.visibility = 'visible';
      p.style.strokeDasharray = `${lengths[i]} ${lengths[i]}`;
      p.style.strokeDashoffset = `${lengths[i]}`;
    });
    const t0 = performance.now();
    const frame = (t: number) => {
      let drawn = Math.min(1, (t - t0) / duration) * total;
      let pt: Point | null = null;
      els.forEach((p, i) => {
        const len = lengths[i]!;
        const part = Math.max(0, Math.min(len, drawn));
        p.style.strokeDashoffset = `${len - part}`;
        if (part > 0 && part < len) {
          const q = p.getPointAtLength(part);
          pt = [q.x, q.y];
        }
        drawn -= len;
      });
      setTip(pt);
      if (t - t0 < duration) raf = requestAnimationFrame(frame);
      else {
        setTip(null);
        if (many) {
          timers.push(window.setTimeout(() => setFade(true), HOLD_MS));
          timers.push(window.setTimeout(next, HOLD_MS + ERASE_MS));
        }
      }
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      timers.forEach(clearTimeout);
    };
  }, [index, paused, items.length]);

  return (
    <div class="doodle-replay">
      <svg class={`doodle-graphic${fade ? ' erasing' : ''}`} viewBox="-12 -12 280 280" role="img" aria-label={item.label}>
        {item.doodle.map((s, i) => (
          <path
            key={`${index}-${i}`}
            ref={(el) => {
              paths.current[i] = el;
            }}
            d={doodlePath([s])}
            fill="none"
            stroke="currentColor"
            stroke-width={STROKE}
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        ))}
        {tip && <Pencil at={tip} fg={fg} bg={bg} />}
      </svg>
      {many && (
        <p class="doodle-count" aria-hidden="true">
          {item.label} · {(index % items.length) + 1} of {items.length}
        </p>
      )}
      {(many || !still) && (
        <div class="actions doodle-controls">
          {many && (
            <button type="button" class="findme-small" style={{ color: fg, borderColor: fg }} onClick={() => setPaused((p) => !p)}>
              {paused ? 'Play' : 'Pause'}
            </button>
          )}
          {many && (
            <button type="button" class="findme-small" style={{ color: fg, borderColor: fg }} onClick={() => setIndex((i) => (i + 1) % items.length)}>
              Next
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Full screen at a meetup. Guests hold up the sender's doodle; the sender holds up each guest's doodle in turn.
 * Everyone looks for their own. The drawing takes the screen; one line under it says whose it is and shows yours
 * small. "Show mine instead" swaps to your own (the others saw it on the invite).
 */
export function MeetupDoodleView({ invite, people, onClose }: { invite: Invite; people: Connection[]; context?: string; onClose: () => void }) {
  const [mine, setMine] = useState(false);
  const c = doodleColor(invite.id);
  const own = myDoodleOf(invite);
  const nameOf = (id: string) => people.find((p) => p.id === id)?.profile.displayName ?? 'Someone';

  const theirs: { doodle: Doodle; label: string }[] = invite.outgoing
    ? invite.acceptedIds.map((id) => ({ doodle: decode(invite.guestDoodles?.[id], `${invite.id}:${id}`), label: drawingOf(nameOf(id)) }))
    : [{ doodle: decode(invite.doodle, invite.id), label: drawingOf(invite.senderName) }];
  // Sent, but nobody has said yes yet: show your own drawing (they saw it on the invite).
  const waiting = invite.outgoing && theirs.length === 0;
  const showMine = mine || waiting;
  const items = showMine ? [{ doodle: own, label: 'Your drawing' }] : theirs;
  const title = showMine ? 'Your drawing' : invite.outgoing ? (theirs.length === 1 ? theirs[0]!.label : 'Their drawings') : theirs[0]!.label;
  const holder = !invite.outgoing ? invite.senderName : theirs.length > 1 ? 'They’re all' : 'They’re';
  const lead = showMine ? (
    waiting ? 'No yeses yet. They saw this on the invite.' : 'They saw this on the invite.'
  ) : (
    <>
      {invite.outgoing ? holder : `${holder} is`} holding up yours
      <DoodleGraphic doodle={own} size="2.25rem" />
    </>
  );
  // Whoever can see does the finding: the person holding this up never has to look for anything.
  const srHint = !invite.outgoing && !showMine ? `You don’t need to look: ${invite.senderName} will find you.` : 'You don’t need to look: they’ll find you.';

  return (
    <HoldUpDialog
      bg={c.bg}
      fg={c.fg}
      lead={lead}
      srHint={srHint}
      onClose={onClose}
      art={<DoodleReplay key={showMine ? 'mine' : 'theirs'} items={items} fg={c.fg} bg={c.bg} />}
      actions={
        !waiting && (
          <button type="button" class="findme-small" style={{ color: c.fg, borderColor: c.fg }} onClick={() => setMine((m) => !m)}>
            {mine ? 'Show theirs' : 'Show mine instead'}
          </button>
        )
      }
    >
      <h2 id="findme-word" class="findme-word doodle-title">
        {title}
      </h2>
    </HoldUpDialog>
  );
}
