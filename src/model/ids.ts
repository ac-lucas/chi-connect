// Random IDs. Uses crypto.getRandomValues, which also works on plain-http LAN dev servers
// (crypto.randomUUID needs a secure context).

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

export function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 128-bit random ID, base64url (22 characters). */
export function randomId(): string {
  return toBase64Url(randomBytes(16));
}
