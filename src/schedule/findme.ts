// "Your shape" (F27): a colour, shape, pattern and word that everyone in the same meetup (or the two people
// connecting face to face) see identically, made from something only they share. Hold it up, look for the match.
// Nothing extra is stored or sent.

export const CARD_COLOURS = [
  { name: 'Blue', bg: '#1f4fbf', fg: '#ffffff' },
  { name: 'Green', bg: '#1d6b3a', fg: '#ffffff' },
  { name: 'Orange', bg: '#b84a00', fg: '#ffffff' },
  { name: 'Purple', bg: '#5b2a99', fg: '#ffffff' },
  { name: 'Red', bg: '#b0122d', fg: '#ffffff' },
  { name: 'Yellow', bg: '#f2c200', fg: '#111111' },
  { name: 'Teal', bg: '#006d6f', fg: '#ffffff' },
  { name: 'Pink', bg: '#c2185b', fg: '#ffffff' },
] as const;
export const CARD_SHAPES = ['Triangle', 'Circle', 'Square', 'Star', 'Diamond', 'Hexagon'] as const;
export const CARD_PATTERNS = ['Stripes', 'Dots', 'Waves', 'Checks'] as const;

/** SVG paths on a 200 x 200 box. */
export const SHAPE_PATHS: Record<(typeof CARD_SHAPES)[number], string> = {
  Triangle: 'M100 18 L186 172 L14 172 Z',
  Circle: 'M100 15 A85 85 0 1 1 99.9 15 Z',
  Square: 'M22 22 H178 V178 H22 Z',
  Star: 'M100 10 L124 74 L192 76 L138 118 L158 184 L100 146 L42 184 L62 118 L8 76 L76 74 Z',
  Diamond: 'M100 8 L192 100 L100 192 L8 100 Z',
  Hexagon: 'M100 10 L178 55 L178 145 L100 190 L22 145 L22 55 Z',
};

export interface ShapeCard {
  colour: (typeof CARD_COLOURS)[number];
  shape: (typeof CARD_SHAPES)[number];
  pattern: (typeof CARD_PATTERNS)[number];
  /** Spoken and printed name, e.g. "Blue Triangle". */
  word: string;
}
/** Older name, kept for callers. */
export type FindMeCard = ShapeCard;

/** A card from any seed string both sides share. */
export async function cardFromSeed(seed: string): Promise<ShapeCard> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed)));
  const colour = CARD_COLOURS[h[0]! % CARD_COLOURS.length]!;
  const shape = CARD_SHAPES[h[1]! % CARD_SHAPES.length]!;
  const pattern = CARD_PATTERNS[h[2]! % CARD_PATTERNS.length]!;
  return { colour, shape, pattern, word: `${colour.name} ${shape}` };
}

/** The card for a meetup: everyone invited shares the invite's random ID. */
export function findMeCard(inviteId: string): Promise<ShapeCard> {
  return cardFromSeed(`pebble-findme-v1:${inviteId}`);
}
