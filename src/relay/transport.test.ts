import { afterEach, describe, expect, it, vi } from 'vitest';
import { timeoutSignal } from './transport';

describe('timeoutSignal', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses AbortSignal.timeout where it exists', () => {
    expect(timeoutSignal(1000)).toBeInstanceOf(AbortSignal);
  });

  it('falls back to AbortController where AbortSignal.timeout is missing', async () => {
    vi.useFakeTimers();
    const Original = AbortSignal;
    vi.stubGlobal('AbortSignal', Object.assign(function () {}, { prototype: Original.prototype }));
    const s = timeoutSignal(50)!;
    expect(s.aborted).toBe(false);
    vi.advanceTimersByTime(60);
    expect(s.aborted).toBe(true);
    vi.useRealTimers();
  });

  it('gives no signal at all where neither exists', () => {
    vi.stubGlobal('AbortSignal', undefined);
    vi.stubGlobal('AbortController', undefined);
    expect(timeoutSignal(50)).toBeUndefined();
  });
});
