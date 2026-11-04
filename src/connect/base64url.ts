export { toBase64Url } from '../model/ids';

const B64URL = /^[A-Za-z0-9_-]*$/;

/** Decode base64url. Throws on anything that is not strict base64url. */
export function fromBase64Url(s: string): Uint8Array {
  if (!B64URL.test(s) || s.length % 4 === 1) throw new Error('bad base64url');
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
