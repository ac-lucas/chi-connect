// Connect codes: what one phone shows as a QR code (or link) and another reads.
// Format: a link with the data in the URL fragment, so no server ever receives it:
//   <app url>#c=<code>
// <code> is 'z' + base64url(deflate-raw(JSON)), or 'j' + base64url(JSON) for the uncompressed form.
// Compression uses the browser's CompressionStream where it supports deflate-raw, and fflate (loaded only when
// needed) where it doesn't, so every device can make and read both forms.
// Everything decoded here is untrusted: size-limited, strictly parsed, and cleaned field by field.

import { knownTagById, resolveTag } from '../model/tags';
import { cleanText, cleanUrl, LIMITS } from '../model/text';
import type { SharedProfile, Tag } from '../model/types';
import { fromBase64Url, toBase64Url } from './base64url';
import { importPublicKey, isPublicKeyText } from './pairing';

/** v2 added the ECDH public key (k). v1 codes, from before that, are refused with 'older-version'. */
export const PAYLOAD_VERSION = 2;
/** Keep the whole link at or under this many bytes so the QR stays easy to scan. */
export const QR_BUDGET_BYTES = 800;
/** Refuse inbound codes longer than this before doing any work on them. */
export const MAX_CODE_CHARS = 1600;
/** Refuse anything that inflates past this (guards against compression bombs). */
export const MAX_JSON_BYTES = 4096;
/** Face-to-face codes only work for a short time, so a photo of one is of little use later. */
export const FACE_TO_FACE_TTL_MS = 10 * 60 * 1000;
const MAX_FUTURE_MS = 24 * 60 * 60 * 1000;
const ID = /^[A-Za-z0-9_-]{22}$/;

export type ConnectMode = 'f' | 'r'; // face-to-face, regular one-way

export interface ConnectPayload {
  mode: ConnectMode;
  /** Random per showing of the code. */
  nonce: string;
  /** P-256 public key for this code (base64url). The matching private key stays on the phone that showed it. */
  publicKey: string;
  expiresAt: number;
  /** Where the other person can leave messages for this person (relay). */
  mailboxId?: string;
  profile: SharedProfile;
}

interface Wire {
  v: number;
  m: ConnectMode;
  n: string;
  k: string;
  x: number; // expiry, epoch seconds
  b?: string;
  p: { d: string; r?: string; c?: string; l?: string[]; t?: string[] };
}

export type DecodeProblem = 'too-long' | 'not-a-code' | 'unreadable' | 'newer-version' | 'older-version' | 'expired';

export class DecodeError extends Error {
  constructor(readonly problem: DecodeProblem) {
    super(problem);
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });

// Known topics travel as their short ID; custom ones as '~' + label.
const tagToWire = (t: Tag) => (t.key.startsWith('x:') ? `~${t.label}` : t.key);
function tagFromWire(s: string): Tag | null {
  if (s.startsWith('~')) return resolveTag(s.slice(1));
  return knownTagById(s) ?? resolveTag(s);
}

function toWire(p: ConnectPayload): Wire {
  const w: Wire = { v: PAYLOAD_VERSION, m: p.mode, n: p.nonce, k: p.publicKey, x: Math.floor(p.expiresAt / 1000), p: { d: p.profile.displayName } };
  if (p.mailboxId) w.b = p.mailboxId;
  if (p.profile.role) w.p.r = p.profile.role;
  if (p.profile.company) w.p.c = p.profile.company;
  if (p.profile.links?.length) w.p.l = p.profile.links.map((l) => l.replace(/^https:\/\//, ''));
  if (p.profile.tags?.length) w.p.t = p.profile.tags.map(tagToWire);
  return w;
}

let compressOk: boolean | undefined;

/**
 * Whether deflate-raw compression works here. Checks the format too, not just that the API exists: a browser can
 * have CompressionStream without 'deflate-raw' (verify per browser). Without it, fflate does the work.
 */
export function canCompress(): boolean {
  if (compressOk === undefined) {
    try {
      new CompressionStream('deflate-raw');
      new DecompressionStream('deflate-raw');
      compressOk = true;
    } catch {
      compressOk = false;
    }
  }
  return compressOk;
}

async function readCapped(stream: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new DecodeError('too-long');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

const streamOf = (bytes: Uint8Array) => new Blob([bytes as BlobPart]).stream();

async function deflate(bytes: Uint8Array, native = canCompress()): Promise<Uint8Array> {
  if (!native) return (await import('fflate')).deflateSync(bytes, { level: 9 });
  return readCapped(streamOf(bytes).pipeThrough(new CompressionStream('deflate-raw')), MAX_JSON_BYTES);
}

async function inflate(bytes: Uint8Array, native = canCompress()): Promise<Uint8Array> {
  if (native) return readCapped(streamOf(bytes).pipeThrough(new DecompressionStream('deflate-raw')), MAX_JSON_BYTES);
  // Same cap as the native path: stop as soon as the output passes MAX_JSON_BYTES (compression bombs).
  const { Inflate } = await import('fflate');
  const chunks: Uint8Array[] = [];
  let total = 0;
  const inf = new Inflate((chunk) => {
    total += chunk.byteLength;
    if (total > MAX_JSON_BYTES) throw new DecodeError('too-long');
    chunks.push(chunk);
  });
  inf.push(bytes, true);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** Tests only: run the fflate path even where the browser has native compression. */
export const fallbackForTests = {
  deflate: (b: Uint8Array) => deflate(b, false),
  inflate: (b: Uint8Array) => inflate(b, false),
};

export async function encodeCode(p: ConnectPayload, compress = true): Promise<string> {
  const json = enc.encode(JSON.stringify(toWire(p)));
  if (compress) {
    try {
      const z = await deflate(json);
      if (z.byteLength < json.byteLength) return `z${toBase64Url(z)}`;
    } catch {
      // Compression failed on this device: the uncompressed form below always works.
    }
  }
  return `j${toBase64Url(json)}`;
}

export function linkFor(code: string, base: string): string {
  return `${base.split('#')[0]}#c=${code}`;
}

/**
 * Build the connect link, leaving out links and then topics (last first) until it fits the QR budget.
 * Returns what was left out so the screen can say so.
 */
export async function fitLink(
  p: ConnectPayload,
  base: string,
  compress = true,
): Promise<{ link: string; payload: ConnectPayload; leftOut: string[] }> {
  const profile: SharedProfile = { ...p.profile, links: [...(p.profile.links ?? [])], tags: [...(p.profile.tags ?? [])] };
  const leftOut: string[] = [];
  for (;;) {
    const payload = { ...p, profile };
    const link = linkFor(await encodeCode(payload, compress), base);
    if (enc.encode(link).byteLength <= QR_BUDGET_BYTES) return { link, payload, leftOut };
    if (profile.links?.length) leftOut.push(profile.links.pop()!.replace(/^https:\/\//, ''));
    else if (profile.tags?.length) leftOut.push(profile.tags.pop()!.label);
    else if (profile.company) {
      leftOut.push(profile.company);
      profile.company = undefined;
    } else if (profile.role) {
      leftOut.push(profile.role);
      profile.role = undefined;
    } else return { link, payload, leftOut }; // name alone always fits (60 characters)
  }
}

/** Pull the code out of whatever was scanned or pasted: a full link or a bare code. */
export function extractCode(input: string): string {
  const s = input.trim();
  const i = s.indexOf('#c=');
  return i >= 0 ? s.slice(i + 3) : s;
}

function str(v: unknown): v is string {
  return typeof v === 'string';
}

export async function decodeCode(input: string, now = Date.now()): Promise<ConnectPayload> {
  if (input.length > MAX_CODE_CHARS) throw new DecodeError('too-long');
  const code = extractCode(input);
  if (!/^[zj][A-Za-z0-9_-]+$/.test(code)) throw new DecodeError('not-a-code');

  let wire: Wire;
  try {
    let bytes = fromBase64Url(code.slice(1));
    if (code[0] === 'z') bytes = await inflate(bytes);
    if (bytes.byteLength > MAX_JSON_BYTES) throw new DecodeError('too-long');
    wire = JSON.parse(dec.decode(bytes)) as Wire;
  } catch (e) {
    if (e instanceof DecodeError) throw e;
    throw new DecodeError('unreadable');
  }

  if (!wire || typeof wire !== 'object' || typeof wire.v !== 'number') throw new DecodeError('unreadable');
  if (wire.v > PAYLOAD_VERSION) throw new DecodeError('newer-version');
  if (wire.v === 1) throw new DecodeError('older-version');
  if (wire.v !== PAYLOAD_VERSION) throw new DecodeError('unreadable');
  if (wire.m !== 'f' && wire.m !== 'r') throw new DecodeError('unreadable');
  if (!str(wire.n) || !ID.test(wire.n)) throw new DecodeError('unreadable');
  if (!isPublicKeyText(wire.k)) throw new DecodeError('unreadable');
  try {
    await importPublicKey(wire.k); // a valid point on the curve, or nothing
  } catch {
    throw new DecodeError('unreadable');
  }
  if (wire.b !== undefined && (!str(wire.b) || !ID.test(wire.b))) throw new DecodeError('unreadable');
  if (typeof wire.x !== 'number' || !Number.isFinite(wire.x)) throw new DecodeError('unreadable');
  const expiresAt = wire.x * 1000;
  if (expiresAt < now) throw new DecodeError('expired');
  if (expiresAt > now + MAX_FUTURE_MS) throw new DecodeError('unreadable');

  const p = wire.p;
  if (!p || typeof p !== 'object') throw new DecodeError('unreadable');
  const displayName = cleanText(p.d, LIMITS.displayName);
  if (!displayName) throw new DecodeError('unreadable');
  const profile: SharedProfile = { displayName };
  const role = cleanText(p.r, LIMITS.role);
  if (role) profile.role = role;
  const company = cleanText(p.c, LIMITS.company);
  if (company) profile.company = company;
  if (Array.isArray(p.l)) {
    const links = [
      ...new Set(
        p.l
          .slice(0, LIMITS.links)
          .map((l) => (str(l) ? cleanUrl(l) : null))
          .filter((l): l is string => !!l),
      ),
    ];
    if (links.length) profile.links = links;
  }
  if (Array.isArray(p.t)) {
    const tags: Tag[] = [];
    const seen = new Set<string>();
    for (const t of p.t.slice(0, LIMITS.tags)) {
      const tag = str(t) ? tagFromWire(t) : null;
      if (tag && !seen.has(tag.key)) {
        seen.add(tag.key);
        tags.push(tag);
      }
    }
    if (tags.length) profile.tags = tags;
  }

  const out: ConnectPayload = { mode: wire.m, nonce: wire.n, publicKey: wire.k, expiresAt, profile };
  if (wire.b) out.mailboxId = wire.b;
  return out;
}
