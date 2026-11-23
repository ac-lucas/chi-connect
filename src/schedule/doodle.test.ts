import { describe, expect, it } from 'vitest';
import { toBase64Url } from '../model/ids';
import { parseWireInvite } from '../relay/invites';
import { randomId } from '../model/ids';
import { decodeDoodle, doodleColour, doodlePath, DOODLE_LIMITS, encodeDoodle, generateDoodle, isPromptKey, pickPrompt, PROMPTS, thin, type Doodle } from './doodle';

const sample: Doodle = [
  [
    [10, 20],
    [30, 40],
    [255, 0],
  ],
  [[128, 128]],
];
const raw = (bytes: number[]) => toBase64Url(new Uint8Array(bytes));

describe('doodle encoding', () => {
  it('round-trips and stays small', () => {
    const e = encodeDoodle(sample);
    expect(decodeDoodle(e)).toEqual(sample);
    const g = generateDoodle('x');
    expect(decodeDoodle(encodeDoodle(g))).toEqual(g);
    expect(encodeDoodle(g).length).toBeLessThan(400);
  });

  it('refuses anything malformed', () => {
    for (const bad of [undefined, null, 42, {}, [], '', '***', 'a'.repeat(DOODLE_LIMITS.encoded + 1)]) expect(decodeDoodle(bad)).toBeNull();
    expect(decodeDoodle(raw([0]))).toBeNull(); // no strokes
    expect(decodeDoodle(raw([DOODLE_LIMITS.strokes + 1, ...Array(DOODLE_LIMITS.strokes + 1).fill(0)]))).toBeNull(); // too many strokes
    expect(decodeDoodle(raw([1, 0]))).toBeNull(); // empty stroke
    expect(decodeDoodle(raw([1, 2, 1, 1]))).toBeNull(); // says 2 points, has 1
    expect(decodeDoodle(raw([1, 1, 5, 5, 9]))).toBeNull(); // trailing byte
    expect(decodeDoodle(raw([2, 1, 5, 5]))).toBeNull(); // missing second stroke
    // Over the total point budget, even though each stroke is within its own limit.
    const big: number[] = [3];
    for (let s = 0; s < 3; s++) big.push(250, ...Array(500).fill(7));
    expect(decodeDoodle(raw(big))).toBeNull();
  });

  it('draws as numbers only, never text', () => {
    expect(doodlePath(sample)).toMatch(/^[MQLl0-9. -]+$/);
  });

  it('makes the same scribble from the same seed and different ones otherwise', () => {
    expect(generateDoodle('a')).toEqual(generateDoodle('a'));
    expect(generateDoodle('a')).not.toEqual(generateDoodle('b'));
    for (const [x, y] of generateDoodle('c')[0]!) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(255);
    }
    expect(doodleColour('same')).toEqual(doodleColour('same'));
  });

  it('thins slow strokes but keeps where they end', () => {
    const slow: [number, number][] = Array.from({ length: 50 }, (_, i) => [i, 0]);
    const t = thin(slow, 5);
    expect(t.length).toBeLessThan(15);
    expect(t[0]).toEqual([0, 0]);
    expect(t[t.length - 1]).toEqual([49, 0]);
  });

  it('picks known prompts, and a different one when shuffling', () => {
    const k = pickPrompt();
    expect(isPromptKey(k)).toBe(true);
    for (let i = 0; i < 20; i++) expect(pickPrompt(k)).not.toBe(k);
    expect(isPromptKey('toString')).toBe(false);
    expect(isPromptKey('__proto__')).toBe(false);
    expect(Object.keys(PROMPTS).length).toBeGreaterThan(10);
  });
});

describe('doodles in invites from another phone', () => {
  const base = () => ({ id: randomId(), kind: 'meal', start: Date.now() + 3_600_000, end: Date.now() + 7_200_000 });
  it('keeps a valid doodle and prompt', () => {
    const w = parseWireInvite({ ...base(), doodle: encodeDoodle(sample), prompt: 'coffee' });
    expect(w?.doodle && decodeDoodle(w.doodle)).toEqual(sample);
    expect(w?.prompt).toBe('coffee');
  });
  it('drops a bad doodle or unknown prompt but keeps the invite', () => {
    const w = parseWireInvite({ ...base(), doodle: raw([1, 3, 1]), prompt: '<b>hi</b>' });
    expect(w).not.toBeNull();
    expect(w?.doodle).toBeUndefined();
    expect(w?.prompt).toBeUndefined();
  });
});
