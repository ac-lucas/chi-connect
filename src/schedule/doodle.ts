// The meetup doodle (F27): whoever sends an invite draws a quick doodle (or lets the app make one), and everyone who
// says yes holds the same doodle up to find each other. It travels inside the encrypted invite as a few hundred
// bytes of stroke points. Untrusted on arrival: decodeDoodle checks every byte.
import { fromBase64Url, toBase64Url } from '../connect/base64url';
import { CARD_COLORS } from './findme';

/** A point on a 256 x 256 grid. */
export type Point = readonly [number, number];
/** One or more strokes; each stroke is one or more points. */
export type Doodle = readonly (readonly Point[])[];

export const DOODLE_LIMITS = {
  strokes: 24,
  /** Points in one stroke (stored as one byte). */
  strokePoints: 255,
  /** Points in the whole doodle. */
  points: 600,
  /** Encoded length: 1 + 24 + 1200 bytes at most, as base64url. */
  encoded: 1700,
} as const;

const GRID = 255;
const clampByte = (n: number) => Math.max(0, Math.min(GRID, Math.round(n)));

/** Bytes: [stroke count] then, per stroke, [point count, x1, y1, x2, y2, …]. */
export function encodeDoodle(d: Doodle): string {
  const bytes: number[] = [d.length];
  for (const s of d) {
    bytes.push(s.length);
    for (const [x, y] of s) bytes.push(clampByte(x), clampByte(y));
  }
  return toBase64Url(new Uint8Array(bytes));
}

/** A doodle from another phone, or null if anything about it is off. */
export function decodeDoodle(v: unknown): Doodle | null {
  if (typeof v !== 'string' || v.length === 0 || v.length > DOODLE_LIMITS.encoded) return null;
  let b: Uint8Array;
  try {
    b = fromBase64Url(v);
  } catch {
    return null;
  }
  const strokes = b[0] ?? 0;
  if (strokes < 1 || strokes > DOODLE_LIMITS.strokes) return null;
  const out: Point[][] = [];
  let i = 1;
  let total = 0;
  for (let s = 0; s < strokes; s++) {
    const n = b[i++];
    if (n === undefined || n < 1) return null;
    total += n;
    if (total > DOODLE_LIMITS.points || i + n * 2 > b.length) return null;
    const pts: Point[] = [];
    for (let p = 0; p < n; p++, i += 2) pts.push([b[i]!, b[i + 1]!]);
    out.push(pts);
  }
  return i === b.length ? out : null; // no trailing bytes
}

/** Drop points closer than `min` to the last kept one, so a slow stroke doesn't use up the budget. */
export function thin(points: readonly Point[], min = 3): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) >= min) out.push(p);
  }
  const end = points[points.length - 1];
  if (end && out[out.length - 1] !== end && out.length > 1) out[out.length - 1] = end; // keep where the stroke stopped
  return out;
}

export const countPoints = (d: Doodle) => d.reduce((n, s) => n + s.length, 0);

/** Small, fast, seeded random numbers (not for security: only to draw the same scribble on every phone). */
function seeded(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A scribble made from a seed: one looping line built from a few overlaid waves, so each seed gives a clearly
 * different, hand-ish curve. Used when someone doesn't draw, for "Draw one for me", and for invites from before
 * doodles existed (seeded by the invite ID, so everyone in the meetup still sees the same one).
 */
export function generateDoodle(seed: string): Doodle {
  const r = seeded(`pebble-doodle-v1:${seed}`);
  const fx = 1 + Math.floor(r() * 3);
  const fy = fx + 1 + Math.floor(r() * 2);
  const px = r() * Math.PI * 2;
  const py = r() * Math.PI * 2;
  const wobble = 0.12 + r() * 0.18;
  const wf = 5 + Math.floor(r() * 4);
  const turns = 0.75 + r() * 0.25; // not quite closed, so it reads as drawn
  const n = 90;
  const pts: Point[] = [];
  for (let k = 0; k < n; k++) {
    const t = (k / (n - 1)) * Math.PI * 2 * turns;
    const w = 1 + wobble * Math.sin(wf * t + px);
    const x = 128 + 100 * w * Math.sin(fx * t + px) * 0.95;
    const y = 128 + 100 * w * Math.sin(fy * t + py) * 0.95;
    pts.push([clampByte(x), clampByte(y)]);
  }
  return [thin(pts, 2)];
}

/**
 * An SVG path for the doodle, smoothed through the midpoints of each stroke. Built only from numbers, never from
 * text, so it can't carry anything but a drawing. A single tap becomes a dot (round line caps draw it).
 */
export function doodlePath(d: Doodle): string {
  const parts: string[] = [];
  for (const s of d) {
    const [x0, y0] = s[0]!;
    if (s.length === 1) {
      parts.push(`M${x0} ${y0}l0.01 0`);
      continue;
    }
    let path = `M${x0} ${y0}`;
    for (let i = 1; i < s.length - 1; i++) {
      const [x, y] = s[i]!;
      const [nx, ny] = s[i + 1]!;
      path += `Q${x} ${y} ${(x + nx) / 2} ${(y + ny) / 2}`;
    }
    const [lx, ly] = s[s.length - 1]!;
    path += `L${lx} ${ly}`;
    parts.push(path);
  }
  return parts.join('');
}

/** The doodle for a meetup: the one the sender drew, else one made from the invite ID. */
export function doodleFor(inv: { id: string; doodle?: string }): Doodle {
  return (inv.doodle && decodeDoodle(inv.doodle)) || generateDoodle(inv.id);
}

/** The card color for a meetup (the same on every phone), from the colors already checked for contrast. */
export function doodleColor(inviteId: string): (typeof CARD_COLORS)[number] {
  const r = seeded(`pebble-doodle-color-v1:${inviteId}`);
  return CARD_COLORS[Math.floor(r() * CARD_COLORS.length)]!;
}

/**
 * What everyone in a meetup draws. About the person, quick, no skill needed, and something to talk about once you
 * meet. Placeholder wording: to be checked with testers. Keys travel in invites, so never reuse a key for a
 * different prompt (retire it instead).
 */
export const PROMPTS = {
  bag: 'one thing in your bag',
  weather: 'your mood as weather',
  snack: 'your go-to snack',
  shoes: 'your shoes',
  home: 'something from home',
  dinner: 'your ideal dinner tonight',
  hobby: 'what you do on a day off',
  talent: 'your hidden talent',
  place: 'a place you love',
} as const;
/**
 * Keys that were used once and removed (Nov 23, 2026). Never give them to a new prompt: an invite sent with one
 * would show the wrong prompt. An invite carrying one now just has no prompt ("anything at all").
 */
export const RETIRED_PROMPT_KEYS = ['coffee', 'breakfast', 'view', 'journey', 'plant', 'pet', 'song', 'talk', 'hand'] as const;
export type PromptKey = keyof typeof PROMPTS;
export const PROMPT_KEYS = Object.keys(PROMPTS) as PromptKey[];
export const isPromptKey = (v: unknown): v is PromptKey => typeof v === 'string' && Object.prototype.hasOwnProperty.call(PROMPTS, v);

/** A prompt to start with, different from `not` when shuffling. */
export function pickPrompt(not?: PromptKey): PromptKey {
  const pool = PROMPT_KEYS.filter((k) => k !== not);
  const i = crypto.getRandomValues(new Uint32Array(1))[0]! % pool.length;
  return pool[i]!;
}

/** "Mina's coffee order"-style names are hard to make read well for every prompt, so: "Mina's drawing". */
export const drawingOf = (name: string) => `${name}’s drawing`;

/** A scribble for someone who skips drawing: made fresh, then sent like a real one. */
export const skipDoodle = (): Doodle => generateDoodle(crypto.getRandomValues(new Uint32Array(2)).join('-'));
