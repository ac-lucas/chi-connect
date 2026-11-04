import { describe, expect, it } from 'vitest';
import { randomId } from '../model/ids';
import { cardFromSeed } from '../schedule/findme';
import { helloSecret, importPublicKey, matchSeed, matchWord, newPairKey, pairSecret, PUBLIC_KEY_CHARS, type PairKey, type PairSide } from './pairing';

async function side(): Promise<{ key: PairKey; pub: PairSide }> {
  const key = await newPairKey();
  return { key, pub: { nonce: randomId(), publicKey: key.publicKey } };
}

describe('pairing', () => {
  it('gives both phones the same match word and secret, whichever order', async () => {
    const a = await side();
    const b = await side();
    expect(await matchWord(a.pub, b.pub)).toEqual(await matchWord(b.pub, a.pub));
    expect(await pairSecret(a.key.privateKey, a.pub, b.pub)).toBe(await pairSecret(b.key.privateKey, b.pub, a.pub));
  });

  it('needs a private key: someone who saw both codes ends up with a different secret', async () => {
    const a = await side();
    const b = await side();
    const watcher = await newPairKey(); // has both public codes, but neither private key
    const real = await pairSecret(a.key.privateKey, a.pub, b.pub);
    expect(await pairSecret(watcher.privateKey, a.pub, b.pub)).not.toBe(real);
    expect(await pairSecret(watcher.privateKey, b.pub, a.pub)).not.toBe(real);
  });

  it('binds the secret to both codes, not just the keys', async () => {
    const a = await side();
    const b = await side();
    const real = await pairSecret(a.key.privateKey, a.pub, b.pub);
    expect(await pairSecret(a.key.privateKey, a.pub, { ...b.pub, nonce: randomId() })).not.toBe(real);
  });

  it('changes the match word if someone swaps in their own key', async () => {
    // The word is 6 bits (8 colours x 8 shapes), so any single swap keeps it 1 time in 64 by chance.
    // Check that swapped keys spread across many words.
    const a = await side();
    const b = await side();
    const words = new Set<string>();
    for (let i = 0; i < 20; i++) words.add((await matchWord(a.pub, { ...b.pub, publicKey: (await newPairKey()).publicKey })).text);
    expect(words.size).toBeGreaterThan(5);
  });

  it('agrees on the hello secret between sender and the code owner only', async () => {
    const owner = await side();
    const sender = await newPairKey();
    const fromSender = await helloSecret(sender.privateKey, owner.pub, sender.publicKey, owner.pub.publicKey);
    expect(await helloSecret(owner.key.privateKey, owner.pub, sender.publicKey, sender.publicKey)).toBe(fromSender);
    const watcher = await newPairKey();
    expect(await helloSecret(watcher.privateKey, owner.pub, sender.publicKey, sender.publicKey)).not.toBe(fromSender);
  });

  it('accepts only valid P-256 public keys', async () => {
    const good = (await newPairKey()).publicKey;
    expect(good).toHaveLength(PUBLIC_KEY_CHARS);
    await expect(importPublicKey(good)).resolves.toBeTruthy();
    await expect(importPublicKey('A'.repeat(PUBLIC_KEY_CHARS))).rejects.toThrow(); // not a point on the curve
    await expect(importPublicKey(good.slice(1))).rejects.toThrow();
    await expect(importPublicKey(`${good.slice(0, -1)}!`)).rejects.toThrow();
  });

  it('gives both phones the same shape card, and a swapped key a different seed', async () => {
    const a = await side();
    const b = await side();
    expect(await cardFromSeed(matchSeed(a.pub, b.pub))).toEqual(await cardFromSeed(matchSeed(b.pub, a.pub)));
    expect(matchSeed(a.pub, { ...b.pub, publicKey: (await newPairKey()).publicKey })).not.toBe(matchSeed(a.pub, b.pub));
  });

  it('builds readable words', async () => {
    const w = await matchWord((await side()).pub, (await side()).pub);
    expect(w.text).toBe(`${w.colour} ${w.shape}`);
    expect(w.glyph.length).toBeGreaterThan(0);
  });
});
