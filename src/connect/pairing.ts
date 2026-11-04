// Face-to-face pairing. Each phone shows a code with a fresh random nonce. Once a phone has read the
// other's code it holds both nonces, so it can work out:
//  - a match word, shown on both screens so two people can see they really paired with each other;
//  - the pair's shared secret, later used to derive encryption keys for messages between them.
// Order does not matter: both phones sort the nonces first, so both get the same result.
// Needs Web Crypto (secure context: HTTPS or localhost).

import { toBase64Url } from './base64url';

export const MATCH_COLOURS = ['Blue', 'Green', 'Orange', 'Purple', 'Red', 'Yellow', 'Teal', 'Pink'] as const;
export const MATCH_SHAPES = [
  { name: 'Triangle', glyph: '▲' },
  { name: 'Circle', glyph: '●' },
  { name: 'Square', glyph: '■' },
  { name: 'Star', glyph: '★' },
  { name: 'Diamond', glyph: '◆' },
  { name: 'Hexagon', glyph: '⬢' },
  { name: 'Heart', glyph: '♥' },
  { name: 'Moon', glyph: '☾' },
] as const;

export interface MatchWord {
  colour: (typeof MATCH_COLOURS)[number];
  shape: (typeof MATCH_SHAPES)[number]['name'];
  glyph: string;
  /** For display and screen readers, for example "Blue Triangle". */
  text: string;
}

export function hasWebCrypto(): boolean {
  return typeof crypto !== 'undefined' && !!crypto.subtle;
}

async function digest(label: string, a: string, b: string): Promise<Uint8Array> {
  const [x, y] = [a, b].sort();
  const data = new TextEncoder().encode(`${label}:${x}:${y}`);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

export async function matchWord(myNonce: string, theirNonce: string): Promise<MatchWord> {
  const h = await digest('pebble-match-v1', myNonce, theirNonce);
  const colour = MATCH_COLOURS[h[0]! % MATCH_COLOURS.length]!;
  const shape = MATCH_SHAPES[h[1]! % MATCH_SHAPES.length]!;
  return { colour, shape: shape.name, glyph: shape.glyph, text: `${colour} ${shape.name}` };
}

/** The pair's shared secret (base64url). Proposal: HKDF from this for per-purpose keys once the relay exists. */
export async function pairSecret(myNonce: string, theirNonce: string): Promise<string> {
  return toBase64Url(await digest('pebble-pair-v1', myNonce, theirNonce));
}
