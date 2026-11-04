// Encryption for everything that goes through the relay. All of it happens on the phone with Web Crypto;
// the relay only ever sees the output. Scheme (a proposal, reviewed before submission):
//  - AES-GCM-256, random 96-bit IV per message, the mailbox ID as additional data (binds a message to its mailbox).
//  - Keys from HKDF-SHA-256 over a secret only the two people hold, with the purpose and mailbox in `info`.
//  - Six-digit codes: PBKDF2 from the code. Only 20 bits, so this keeps the payload from casual view on the relay,
//    not from someone who runs the relay. A password-authenticated key exchange would fix that later.

import { fromBase64Url, toBase64Url } from '../connect/base64url';

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });
const HKDF_SALT = enc.encode('pebble-v1');
const CODE_SALT = enc.encode('pebble-code-v1');
const CODE_ITERATIONS = 150_000;
/** Plaintext size cap for anything we open. */
export const MAX_PLAINTEXT_BYTES = 8 * 1024;

export type KeyPurpose = 'hello' | 'msg';

async function hkdfKey(secret: Uint8Array, info: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', secret as BufferSource, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: enc.encode(info) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Key for messages into `mailboxId`, from a base64url secret (a pair secret or an intro nonce). */
export function mailboxKey(secretB64: string, purpose: KeyPurpose, mailboxId: string): Promise<CryptoKey> {
  return hkdfKey(fromBase64Url(secretB64), `${purpose}|${mailboxId}`);
}

export async function codeKey(code: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(code), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: CODE_SALT, iterations: CODE_ITERATIONS },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Encrypt a JSON value. Output is base64url(iv || ciphertext). */
export async function seal(key: CryptoKey, value: unknown, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = enc.encode(JSON.stringify(value));
  if (plain.byteLength > MAX_PLAINTEXT_BYTES) throw new Error('too-large');
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, plain));
  const out = new Uint8Array(iv.byteLength + ct.byteLength);
  out.set(iv);
  out.set(ct, iv.byteLength);
  return toBase64Url(out);
}

/** Decrypt and parse. Returns null for anything that doesn't open (wrong key, tampered, malformed, too big). */
export async function open(key: CryptoKey, sealed: string, aad: string): Promise<unknown> {
  try {
    if (sealed.length > MAX_PLAINTEXT_BYTES * 2) return null;
    const bytes = fromBase64Url(sealed);
    if (bytes.byteLength < 12 + 16) return null;
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: enc.encode(aad) },
      key,
      bytes.slice(12),
    );
    if (plain.byteLength > MAX_PLAINTEXT_BYTES) return null;
    return JSON.parse(dec.decode(plain));
  } catch {
    return null;
  }
}
