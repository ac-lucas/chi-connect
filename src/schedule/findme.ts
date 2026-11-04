// Find-me card (F27): everyone in one meetup sees the same card (colour, shape, pattern and a word),
// made from the invite's random ID, which only the people in it know. Nothing extra is stored or sent.

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

export interface FindMeCard {
  colour: (typeof CARD_COLOURS)[number];
  shape: (typeof CARD_SHAPES)[number];
  pattern: (typeof CARD_PATTERNS)[number];
  /** Spoken and printed name, e.g. "Blue Triangle". */
  word: string;
}

export async function findMeCard(inviteId: string): Promise<FindMeCard> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`pebble-findme-v1:${inviteId}`)));
  const colour = CARD_COLOURS[h[0]! % CARD_COLOURS.length]!;
  const shape = CARD_SHAPES[h[1]! % CARD_SHAPES.length]!;
  const pattern = CARD_PATTERNS[h[2]! % CARD_PATTERNS.length]!;
  return { colour, shape, pattern, word: `${colour.name} ${shape}` };
}
