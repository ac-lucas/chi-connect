import { describe, expect, it } from 'vitest';
import { randomId } from '../model/ids';
import { resolveTag } from '../model/tags';
import { LIMITS } from '../model/text';
import type { SharedProfile } from '../model/types';
import { toBase64Url } from './base64url';
import { newPairKey } from './pairing';
import {
  decodeCode,
  DecodeError,
  encodeCode,
  FACE_TO_FACE_TTL_MS,
  fitLink,
  linkFor,
  MAX_CODE_CHARS,
  QR_BUDGET_BYTES,
  type ConnectPayload,
} from './payload';

const BASE = 'https://example.github.io/some-app/';
const KEY = (await newPairKey()).publicKey;
const NOW = 1_800_000_000_000;

function payload(profile: SharedProfile): ConnectPayload {
  return { mode: 'f', nonce: randomId(), publicKey: KEY, mailboxId: randomId(), expiresAt: NOW + FACE_TO_FACE_TTL_MS, profile };
}

const typical: SharedProfile = {
  displayName: 'Ana Lucía Ortega',
  role: 'UX researcher',
  company: 'Somewhere University',
  links: ['https://example.com/ana'],
  tags: ['VR', 'Haptics', 'Slow tech', 'Accessibility'].map((t) => resolveTag(t)!),
};

// Every field at its limit, with text that compresses badly.
const rand = (n: number, alphabet: string) => Array.from({ length: n }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
const worst: SharedProfile = {
  displayName: rand(LIMITS.displayName, '山田太郎花子一二三四五六七八九十'),
  role: rand(LIMITS.role, 'abcdefghijklmnopqrstuvwxyz0123456789'),
  company: rand(LIMITS.company, 'abcdefghijklmnopqrstuvwxyz0123456789'),
  links: Array.from({ length: LIMITS.links }, () => `https://${rand(20, 'abcdefghij')}.com/${rand(170, 'abcdefghijklmnopqrstuvwxyz0123456789')}`),
  tags: Array.from({ length: LIMITS.tags }, () => resolveTag(rand(LIMITS.tagLabel, 'abcdefghijklmnopqrstuvwxyz'))!),
};

describe('connect codes', () => {
  for (const compress of [true, false]) {
    describe(compress ? 'compressed' : 'uncompressed fallback', () => {
      it('round-trips a typical profile', async () => {
        const p = payload(typical);
        const out = await decodeCode(linkFor(await encodeCode(p, compress), BASE), NOW);
        expect(out).toEqual(p);
      });

      it('keeps a typical profile within the QR budget with nothing left out', async () => {
        const { link, leftOut } = await fitLink(payload(typical), BASE, compress);
        expect(new TextEncoder().encode(link).byteLength).toBeLessThanOrEqual(QR_BUDGET_BYTES);
        expect(leftOut).toEqual([]);
      });

      it('fits a worst-case profile into the budget by leaving things out, and says what', async () => {
        const { link, leftOut, payload: fitted } = await fitLink(payload(worst), BASE, compress);
        expect(new TextEncoder().encode(link).byteLength).toBeLessThanOrEqual(QR_BUDGET_BYTES);
        expect(leftOut.length).toBeGreaterThan(0);
        const out = await decodeCode(link, NOW);
        expect(out.profile.displayName).toBe(worst.displayName);
        expect(out.profile.links ?? []).toEqual(fitted.profile.links ?? []);
        expect((out.profile.tags ?? []).map((t) => t.label)).toEqual((fitted.profile.tags ?? []).map((t) => t.label));
      });
    });
  }
});

describe('decoding untrusted input', () => {
  const expectProblem = async (input: string, problem: string, now = NOW) => {
    await expect(decodeCode(input, now)).rejects.toSatisfy((e: unknown) => e instanceof DecodeError && e.problem === problem);
  };
  const raw = (obj: unknown) => `j${toBase64Url(new TextEncoder().encode(JSON.stringify(obj)))}`;
  const good = { v: 2, m: 'f', n: randomId(), k: KEY, x: Math.floor((NOW + 60_000) / 1000), p: { d: 'Sam' } };

  it('rejects oversized input before decoding', () => expectProblem('j' + 'A'.repeat(MAX_CODE_CHARS), 'too-long'));
  it('rejects things that are not codes', async () => {
    await expectProblem('https://example.com/', 'not-a-code');
    await expectProblem('hello world', 'not-a-code');
    await expectProblem('j<script>', 'not-a-code');
  });
  it('rejects broken data', async () => {
    await expectProblem('jAAAA', 'unreadable');
    await expectProblem('z' + 'A'.repeat(40), 'unreadable');
    await expectProblem(raw([1, 2, 3]), 'unreadable');
    await expectProblem(raw({ ...good, n: 'short' }), 'unreadable');
    await expectProblem(raw({ ...good, m: 'x' }), 'unreadable');
    await expectProblem(raw({ ...good, p: { d: '   ' } }), 'unreadable');
    await expectProblem(raw({ ...good, x: 'soon' }), 'unreadable');
    await expectProblem(raw({ ...good, k: undefined }), 'unreadable');
    await expectProblem(raw({ ...good, k: 'A'.repeat(87) }), 'unreadable'); // not a point on the curve
    await expectProblem(raw({ ...good, k: KEY.slice(1) }), 'unreadable');
  });
  it('rejects expired codes and far-future expiry', async () => {
    await expectProblem(raw({ ...good, x: Math.floor((NOW - 1000) / 1000) }), 'expired');
    await expectProblem(raw({ ...good, x: Math.floor((NOW + 7 * 86_400_000) / 1000) }), 'unreadable');
  });
  it('rejects codes from a newer version', () => expectProblem(raw({ ...good, v: 3 }), 'newer-version'));
  it('asks for an update on codes from before keys', () => expectProblem(raw({ ...good, v: 1 }), 'older-version'));
  it('rejects compression bombs', async () => {
    const huge = new TextEncoder().encode(JSON.stringify({ ...good, p: { d: 'Sam', r: 'a'.repeat(100_000) } }));
    const z = new Uint8Array(await new Response(new Blob([huge]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
    await expectProblem(`z${toBase64Url(z)}`, 'too-long');
  });
  it('cleans fields: drops unsafe links, strips control characters, caps lists', async () => {
    const out = await decodeCode(
      raw({
        ...good,
        p: {
          d: 'Sam‮\u0000 Lee',
          l: ['javascript:alert(1)', 'example.com/sam', 'example.com/sam', 'http://plain.example', 'a.com'],
          t: ['vr', '~Slow tech', 'vr', 7, ...Array.from({ length: 20 }, (_, i) => `~t${i}`)],
        },
      }),
      NOW,
    );
    expect(out.profile.displayName).toBe('Sam Lee');
    expect(out.profile.links).toEqual(['https://example.com/sam']);
    expect(out.profile.tags?.[0]).toEqual({ key: 'vr', label: 'Virtual reality' });
    expect(out.profile.tags?.[1]?.label).toBe('Slow tech');
    expect(out.profile.tags!.length).toBeLessThanOrEqual(LIMITS.tags);
  });
});
