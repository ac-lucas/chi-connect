// Pairing keys and secrets. Every code a phone shows (face to face or one-way) carries a fresh random nonce
// and a fresh P-256 ECDH public key; the private key never leaves the phone. From the other side's code:
//  - the pair's shared secret comes from ECDH (HKDF-SHA-256 over the ECDH output, salted with both nonces and
//    both public keys). Seeing both codes is not enough to work it out: it needs one of the private keys.
//  - a match word, shown on both screens, comes from the public parts (nonces and keys), so both people can
//    check they read each other's codes and not someone else's.
// Order does not matter: both phones sort the two sides first. Needs Web Crypto (secure context).
// P-256 is used because it is the ECDH curve every current browser supports (X25519 support: verify).

import { fromBase64Url, toBase64Url } from './base64url';

const enc = new TextEncoder();
const P256 = { name: 'ECDH', namedCurve: 'P-256' } as const;
/** Length of a P-256 public key (uncompressed point, 65 bytes) in base64url. */
export const PUBLIC_KEY_CHARS = 87;
const PUBLIC_KEY = /^[A-Za-z0-9_-]{87}$/;

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

/** One side of a pairing, as it appears in that side's code. */
export interface PairSide {
  nonce: string;
  /** base64url P-256 public key. */
  publicKey: string;
}

/** A key pair for one shown code. The private key is non-extractable: it can be used, never read out. */
export interface PairKey {
  privateKey: CryptoKey;
  publicKey: string;
}

export async function newPairKey(): Promise<PairKey> {
  const kp = await crypto.subtle.generateKey(P256, false, ['deriveBits']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  return { privateKey: kp.privateKey, publicKey: toBase64Url(raw) };
}

export function isPublicKeyText(s: unknown): s is string {
  return typeof s === 'string' && PUBLIC_KEY.test(s);
}

/** Import an untrusted public key. Throws unless it is a valid uncompressed P-256 point (Web Crypto checks the curve). */
export async function importPublicKey(b64: string): Promise<CryptoKey> {
  if (!isPublicKeyText(b64)) throw new Error('bad-key');
  const raw = fromBase64Url(b64);
  if (raw.byteLength !== 65 || raw[0] !== 4) throw new Error('bad-key');
  return crypto.subtle.importKey('raw', raw as BufferSource, P256, false, []);
}

/** The two sides in a fixed order, so both phones build the same bytes. */
function sorted(a: PairSide, b: PairSide): string {
  return [`${a.nonce}.${a.publicKey}`, `${b.nonce}.${b.publicKey}`].sort().join(':');
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

/** ECDH with their public key, then HKDF-SHA-256 with a context-bound salt. Returns base64url (256 bits). */
async function deriveSecret(myPrivate: CryptoKey, theirPublic: string, label: string, context: string): Promise<string> {
  const z = await crypto.subtle.deriveBits({ name: 'ECDH', public: await importPublicKey(theirPublic) }, myPrivate, 256);
  const base = await crypto.subtle.importKey('raw', z, 'HKDF', false, ['deriveBits']);
  const salt = await sha256(`${label}:${context}`);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: enc.encode(label) }, base, 256);
  return toBase64Url(new Uint8Array(bits));
}

export async function matchWord(mine: PairSide, theirs: PairSide): Promise<MatchWord> {
  const h = await sha256(`pebble-match-v2:${sorted(mine, theirs)}`);
  const colour = MATCH_COLOURS[h[0]! % MATCH_COLOURS.length]!;
  const shape = MATCH_SHAPES[h[1]! % MATCH_SHAPES.length]!;
  return { colour, shape: shape.name, glyph: shape.glyph, text: `${colour} ${shape.name}` };
}

/** The pair's shared secret (base64url). Message keys are derived from it per purpose and mailbox (src/relay/crypto.ts). */
export function pairSecret(myPrivate: CryptoKey, mine: PairSide, theirs: PairSide): Promise<string> {
  return deriveSecret(myPrivate, theirs.publicKey, 'pebble-pair-v2', sorted(mine, theirs));
}

/**
 * Secret for a one-way request ("hello"), before the receiver knows the sender's nonce: ECDH between the sender's
 * key and the key in the receiver's code, bound to that code's nonce and both public keys. Only the person who
 * showed the code can open a hello, not people who saw the code, and not the relay.
 */
export function helloSecret(myPrivate: CryptoKey, intro: PairSide, senderPublicKey: string, theirPublic: string): Promise<string> {
  return deriveSecret(myPrivate, theirPublic, 'pebble-hello-v2', `${intro.nonce}.${intro.publicKey}:${senderPublicKey}`);
}
