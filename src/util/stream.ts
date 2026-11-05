// Small network helpers shared by the feed, the relay client and connect codes.

/**
 * A signal that aborts after `ms`. AbortSignal.timeout is missing on older iOS Safari (verify), so fall back to
 * AbortController + setTimeout, or no timeout at all.
 */
export function timeoutSignal(ms: number): AbortSignal | undefined {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  if (typeof AbortController === 'undefined') return undefined;
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

/** Read a stream without ever holding more than `max` bytes. Throws `tooBig()` past that. */
export async function readCapped(stream: ReadableStream<Uint8Array>, max: number, tooBig: () => Error = () => new Error('too-large')): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw tooBig();
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

/** Read a response body as text, capped at `max` bytes (checks Content-Length first). */
export async function readTextCapped(res: Response, max: number): Promise<string> {
  if (Number(res.headers.get('Content-Length') ?? '0') > max) throw new Error('too-large');
  if (!res.body) return res.text();
  return new TextDecoder().decode(await readCapped(res.body, max));
}
