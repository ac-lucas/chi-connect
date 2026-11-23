// Runs off the main thread: turns the downloaded program file (about 12 MB of JSON) into the app's small
// program, so the screen stays responsive while it happens. See parseProgram in feed.ts.
import { transformFeed } from './transform';

self.onmessage = (e: MessageEvent<{ bytes: Uint8Array; edition: string; revision: number }>) => {
  const { bytes, edition, revision } = e.data;
  try {
    const program = transformFeed(JSON.parse(new TextDecoder().decode(bytes)), edition, revision);
    self.postMessage({ ok: true, program });
  } catch {
    self.postMessage({ ok: false });
  }
};
