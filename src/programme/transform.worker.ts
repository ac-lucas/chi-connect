// Runs off the main thread: turns the downloaded programme file (about 12 MB of JSON) into the app's small
// programme, so the screen stays responsive while it happens. See parseProgramme in feed.ts.
import { transformFeed } from './transform';

self.onmessage = (e: MessageEvent<{ bytes: Uint8Array; edition: string; revision: number }>) => {
  const { bytes, edition, revision } = e.data;
  try {
    const programme = transformFeed(JSON.parse(new TextDecoder().decode(bytes)), edition, revision);
    self.postMessage({ ok: true, programme });
  } catch {
    self.postMessage({ ok: false });
  }
};
