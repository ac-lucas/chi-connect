import { describe, expect, it } from 'vitest';
import { randomId } from '../model/ids';
import { matchWord, pairSecret } from './pairing';

describe('pairing', () => {
  it('gives both phones the same match word and secret, whichever order', async () => {
    const a = randomId();
    const b = randomId();
    expect(await matchWord(a, b)).toEqual(await matchWord(b, a));
    expect(await pairSecret(a, b)).toBe(await pairSecret(b, a));
  });
  it('gives different pairs different secrets', async () => {
    const a = randomId();
    expect(await pairSecret(a, randomId())).not.toBe(await pairSecret(a, randomId()));
  });
  it('builds readable words', async () => {
    const w = await matchWord(randomId(), randomId());
    expect(w.text).toBe(`${w.colour} ${w.shape}`);
    expect(w.glyph.length).toBeGreaterThan(0);
  });
});
