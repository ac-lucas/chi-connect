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

/** Shapes on a -1..1 box, as one or more strokes. Simple enough to say out loud: "mine's the house and the bolt". */
type Local = [number, number][];
const TAU = Math.PI * 2;
const curve = (n: number, f: (t: number) => [number, number]): Local => Array.from({ length: n + 1 }, (_, i) => f(i / n));
const poly = (...pts: [number, number][]): Local => pts;

const SHAPES: Record<string, (r: () => number) => Local[]> = {
  circle: () => [curve(36, (t) => [Math.cos(t * TAU), Math.sin(t * TAU)])],
  square: () => [poly([-0.85, -0.85], [0.85, -0.85], [0.85, 0.85], [-0.85, 0.85], [-0.85, -0.85])],
  triangle: () => [poly([0, -0.95], [0.95, 0.8], [-0.95, 0.8], [0, -0.95])],
  diamond: () => [poly([0, -1], [0.7, 0], [0, 1], [-0.7, 0], [0, -1])],
  star: () => [curve(10, (t) => {
    const a = t * TAU - Math.PI / 2;
    const rr = Math.round(t * 10) % 2 ? 0.42 : 1;
    return [Math.cos(a) * rr, Math.sin(a) * rr];
  })],
  spiral: () => [curve(44, (t) => [t * Math.cos(t * 2 * TAU), t * Math.sin(t * 2 * TAU)])],
  zigzag: () => [poly([-1, 0.35], [-0.6, -0.35], [-0.2, 0.35], [0.2, -0.35], [0.6, 0.35], [1, -0.35])],
  wave: () => [curve(32, (t) => [-1 + 2 * t, 0.4 * Math.sin(t * 2 * TAU)])],
  plus: () => [poly([0, -0.9], [0, 0.9]), poly([-0.9, 0], [0.9, 0])],
  heart: () => [curve(40, (t) => {
    const a = t * TAU;
    return [(16 * Math.sin(a) ** 3) / 17, -(13 * Math.cos(a) - 5 * Math.cos(2 * a) - 2 * Math.cos(3 * a) - Math.cos(4 * a)) / 17];
  })],
  cloud: () => [curve(48, (t) => {
    const a = t * TAU;
    const rr = 0.8 + 0.2 * Math.abs(Math.sin(a * 3.5));
    return [Math.cos(a) * rr, Math.sin(a) * rr * 0.62];
  })],
  bolt: () => [poly([0.25, -1], [-0.45, 0.1], [0.05, 0.1], [-0.25, 1], [0.5, -0.15], [0, -0.15], [0.25, -1])],
  arrow: () => [poly([-1, 0], [0.95, 0]), poly([0.45, -0.45], [0.95, 0], [0.45, 0.45])],
  flower: () => [curve(72, (t) => {
    const a = t * Math.PI;
    const rr = Math.cos(5 * a);
    return [rr * Math.cos(a), rr * Math.sin(a)];
  })],
  dots: () => [[[-0.6, 0]], [[0, 0]], [[0.6, 0]]],
  loop: (r) => {
    const f = 1 + Math.floor(r() * 2);
    const ph = r() * TAU;
    return [curve(48, (t) => [Math.sin(f * t * TAU * 0.9 + ph), Math.sin((f + 1) * t * TAU * 0.9)])];
  },
  house: () => [poly([-0.9, -0.05], [0, -0.95], [0.9, -0.05]), poly([-0.65, -0.05], [-0.65, 0.9], [0.65, 0.9], [0.65, -0.05])],
  sun: () => [
    curve(24, (t) => [0.45 * Math.cos(t * TAU), 0.45 * Math.sin(t * TAU)]),
    ...Array.from({ length: 8 }, (_, i): Local => {
      const a = (i / 8) * TAU;
      return [[0.65 * Math.cos(a), 0.65 * Math.sin(a)], [0.95 * Math.cos(a), 0.95 * Math.sin(a)]];
    }),
  ],
  smile: () => [curve(20, (t) => [Math.cos(Math.PI * (0.15 + 0.7 * t)) * 0.8, 0.15 + Math.sin(Math.PI * (0.15 + 0.7 * t)) * 0.55]), [[-0.35, -0.35]], [[0.35, -0.35]]],
  moon: () => [[
    ...curve(24, (t): [number, number] => [Math.cos(Math.PI * (0.3 + 1.4 * t)), Math.sin(Math.PI * (0.3 + 1.4 * t))]),
    ...curve(20, (t): [number, number] => {
      const a = 1.586 + t * (TAU - 3.172);
      return [0.6 + 0.809 * Math.cos(a), -0.809 * Math.sin(a)];
    }),
  ]],
  leaf: () => [
    [...curve(20, (t): [number, number] => [-1 + 2 * t, -0.45 * Math.sin(Math.PI * t)]), ...curve(20, (t): [number, number] => [1 - 2 * t, 0.45 * Math.sin(Math.PI * t)])],
    poly([-0.8, 0], [0.8, 0]),
  ],
  drop: () => [curve(40, (t) => {
    const a = t * TAU;
    return [0.85 * Math.sin(a) * Math.sin(a / 2), -Math.cos(a)];
  })],
  mountains: () => [poly([-1, 0.6], [-0.45, -0.45], [0, 0.15], [0.45, -0.75], [1, 0.6], [-1, 0.6])],
  target: () => [curve(32, (t) => [Math.cos(t * TAU), Math.sin(t * TAU)]), curve(20, (t) => [0.45 * Math.cos(t * TAU), 0.45 * Math.sin(t * TAU)]), [[0, 0]]],
  infinity: () => [curve(48, (t) => {
    const a = t * TAU;
    const d = 1 + Math.sin(a) ** 2;
    return [Math.cos(a) / d, (Math.sin(a) * Math.cos(a)) / d];
  })],
};
export const SHAPE_NAMES = Object.keys(SHAPES);

/** Where the shapes go: one big with a small one beside or above it, two side by side, or three. [x, y, scale]. */
const LAYOUTS: [number, number, number][][] = [
  [[-0.12, 0.05, 0.72], [0.68, -0.62, 0.26]],
  [[-0.5, 0, 0.44], [0.5, 0, 0.44]],
  [[0, -0.48, 0.42], [0, 0.5, 0.42]],
  [[-0.52, -0.42, 0.36], [0.52, -0.42, 0.36], [0, 0.48, 0.36]],
  [[0, 0.14, 0.6], [0, -0.78, 0.2]],
  [[0, -0.62, 0.3], [0, 0, 0.3], [0, 0.62, 0.3]],
  [[-0.55, -0.55, 0.33], [0, 0, 0.33], [0.55, 0.55, 0.33]],
];

/** Add points along each segment so the hand wobble looks drawn, not jagged. */
function densify(line: Local, step = 0.12): Local {
  const out: Local = [];
  for (let i = 0; i < line.length; i++) {
    const a = line[i]!;
    out.push(a);
    const b = line[i + 1];
    if (!b) break;
    const n = Math.floor(Math.hypot(b[0] - a[0], b[1] - a[1]) / step);
    for (let k = 1; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}

/** Which shapes and layout a seed makes (the same on every phone). Exposed for tests. */
export function doodleRecipe(seed: string): { layout: number; shapes: string[] } {
  const r = seeded(`pebble-doodle-v2:${seed}`);
  const layout = Math.floor(r() * LAYOUTS.length);
  const pool = [...SHAPE_NAMES];
  const shapes: string[] = [];
  for (let i = 0; i < LAYOUTS[layout]!.length; i++) shapes.push(pool.splice(Math.floor(r() * pool.length), 1)[0]!);
  return { layout, shapes };
}

/**
 * A drawing made from a seed: two or three simple shapes (out of 25) in one of seven layouts, each a little tilted
 * and wobbly so it reads as hand-drawn. Thousands of combinations that are easy to tell apart at a glance. Used
 * when someone doesn't draw, for "Make one for me", for demo people, and for invites from before doodles existed
 * (seeded by the invite ID, so everyone in the meetup sees the same one).
 */
export function generateDoodle(seed: string): Doodle {
  const { layout, shapes } = doodleRecipe(seed);
  const r = seeded(`pebble-doodle-v2-hand:${seed}`);
  const out: Point[][] = [];
  shapes.forEach((name, i) => {
    const [cx, cy, scale] = LAYOUTS[layout]![i]!;
    const s = scale * (0.92 + r() * 0.16);
    const tilt = (r() - 0.5) * 0.6;
    const cos = Math.cos(tilt);
    const sin = Math.sin(tilt);
    for (const line of SHAPES[name]!(r)) {
      const pts = (line.length > 1 ? densify(line) : line).map(([x, y]): Point => {
        const jx = line.length > 1 ? (r() - 0.5) * 0.06 : 0;
        const jy = line.length > 1 ? (r() - 0.5) * 0.06 : 0;
        const rx = (x + jx) * cos - (y + jy) * sin;
        const ry = (x + jx) * sin + (y + jy) * cos;
        return [clampByte(128 + (cx + rx * s) * 105), clampByte(128 + (cy + ry * s) * 105)];
      });
      const kept = pts.length > 1 ? thin(pts, 2) : pts;
      if (kept.length) out.push(kept.slice(0, DOODLE_LIMITS.strokePoints));
    }
  });
  return out.slice(0, DOODLE_LIMITS.strokes);
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
  superpower: 'a superpower you’d pick',
  kid: 'what you wanted to be as a kid',
  season: 'your favorite season',
  smell: 'a smell you love',
  gift: 'the best gift you’ve ever gotten',
  emoji: 'your favorite emoji',
  outfit: 'your favorite outfit',
  bottle: 'your water bottle',
  sleep: 'your sleeping position',
  fruit: 'your favorite fruit',
} as const;
/**
 * Keys that were used once and removed (Nov 23, 2026). Never give them to a new prompt: an invite sent with one
 * would show the wrong prompt. An invite carrying one now just has no prompt ("anything at all").
 */
export const RETIRED_PROMPT_KEYS = ['coffee', 'breakfast', 'view', 'journey', 'plant', 'pet', 'song', 'talk', 'hand'] as const;
export type PromptKey = keyof typeof PROMPTS;
export const PROMPT_KEYS = Object.keys(PROMPTS) as PromptKey[];
export const isPromptKey = (v: unknown): v is PromptKey => typeof v === 'string' && Object.prototype.hasOwnProperty.call(PROMPTS, v);

/**
 * A prompt to draw: one you haven't drawn yet if there is one (`used` is oldest first, kept on this phone only),
 * else the one you drew longest ago. Never `not` (the one on screen, when shuffling).
 */
export function pickPrompt(not?: PromptKey, used: readonly string[] = []): PromptKey {
  const fresh = PROMPT_KEYS.filter((k) => k !== not && !used.includes(k));
  if (fresh.length) return fresh[crypto.getRandomValues(new Uint32Array(1))[0]! % fresh.length]!;
  return used.find((k): k is PromptKey => isPromptKey(k) && k !== not) ?? PROMPT_KEYS.find((k) => k !== not)!;
}

/** Note that a prompt was drawn: moved to the end (newest), no repeats, only prompts that still exist. */
export function rememberPrompt(used: readonly string[], key: string | undefined): string[] {
  if (!isPromptKey(key)) return [...used];
  return [...used.filter((k) => k !== key && isPromptKey(k)), key].slice(-PROMPT_KEYS.length);
}

/** "Mina's coffee order"-style names are hard to make read well for every prompt, so: "Mina's drawing". */
export const drawingOf = (name: string) => `${name}’s drawing`;

/** A scribble for someone who skips drawing: made fresh, then sent like a real one. */
export const skipDoodle = (): Doodle => generateDoodle(crypto.getRandomValues(new Uint32Array(2)).join('-'));
