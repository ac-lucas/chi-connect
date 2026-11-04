import { describe, expect, it } from 'vitest';
import { randomId } from '../model/ids';
import { codeKey, mailboxKey, open, seal } from './crypto';

describe('relay crypto', () => {
  it('round-trips with the same secret, purpose and mailbox', async () => {
    const secret = randomId();
    const box = randomId();
    const sealed = await seal(await mailboxKey(secret, 'msg', box), { t: 'hi', n: 1 }, box);
    expect(await open(await mailboxKey(secret, 'msg', box), sealed, box)).toEqual({ t: 'hi', n: 1 });
  });

  it('fails closed for a different secret, purpose, mailbox or tampering', async () => {
    const secret = randomId();
    const box = randomId();
    const key = await mailboxKey(secret, 'msg', box);
    const sealed = await seal(key, { t: 'hi' }, box);
    expect(await open(await mailboxKey(randomId(), 'msg', box), sealed, box)).toBeNull();
    expect(await open(await mailboxKey(secret, 'hello', box), sealed, box)).toBeNull();
    const other = randomId();
    expect(await open(await mailboxKey(secret, 'msg', other), sealed, other)).toBeNull();
    expect(await open(key, sealed, other)).toBeNull(); // moved to another mailbox
    const flipped = sealed.slice(0, -2) + (sealed.endsWith('A') ? 'BA' : 'AA');
    expect(await open(key, flipped, box)).toBeNull();
    expect(await open(key, 'not base64!', box)).toBeNull();
    expect(await open(key, '', box)).toBeNull();
  });

  it('six-digit code keys match for the same code only', async () => {
    const sealed = await seal(await codeKey('042917'), 'payload', 'code');
    expect(await open(await codeKey('042917'), sealed, 'code')).toBe('payload');
    expect(await open(await codeKey('042918'), sealed, 'code')).toBeNull();
  });

  it('uses a fresh IV each time', async () => {
    const box = randomId();
    const key = await mailboxKey(randomId(), 'msg', box);
    expect(await seal(key, 'x', box)).not.toBe(await seal(key, 'x', box));
  });
});
