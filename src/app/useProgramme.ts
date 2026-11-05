// The programme: show what's on the device straight away, and fetch it if there's none yet. Polling for a newer
// edition (on open, on return to the front, and once a minute while visible) only runs once POLL_NEWEST is on.
import { useEffect, useState } from 'preact/hooks';
import { checkFeed, POLL_MS, POLL_NEWEST } from '../programme/feed';
import { isOver } from '../programme/preview';
import { resolveProgramme, startOfDay } from '../programme/programme';
import type { Programme } from '../programme/types';
import { getPreviewAnchor, getSetting, removeProgrammeSessions, setSetting, syncSavedSessions } from '../storage/db';
import { announce } from '../ui/announce';

/** The programme to show (null until one is on the device), and whether a first download failed. */
export function useProgramme(): { programme: Programme | null; failed: boolean } {
  const [programme, setProgramme] = useState<Programme | null>(null);
  const [failed, setProgrammeFailed] = useState(false);
  useEffect(() => {
    let stopped = false;
    let busy = false;
    /** Which programme is on the device: kept here so a check doesn't re-read the whole stored programme. */
    let held: { edition: string; revision: number } | null = null;
    const show = async () => {
      try {
        const feed = await getSetting('programmeFeed');
        if (!feed) return; // nothing downloaded yet: check() fetches it
        held = { edition: feed.edition, revision: feed.revision };
        let anchor = await getPreviewAnchor();
        let p = resolveProgramme(anchor, feed);
        // A preview whose days have all gone by (someone coming back a week later): start it from today.
        if (p.shiftedFrom !== undefined && isOver(p)) {
          anchor = startOfDay(Date.now());
          await setSetting('sampleAnchor', anchor);
          p = resolveProgramme(anchor, feed);
        }
        // Saved sessions follow the programme: moved times, new rooms and renames show up in your day.
        await syncSavedSessions(p.sessions);
        if (!stopped) setProgramme(p);
      } catch {
        if (!stopped) setProgrammeFailed(true);
      }
    };
    const check = async () => {
      if (busy || stopped || document.visibilityState !== 'visible') return;
      busy = true;
      try {
        // Polling is off and a programme is held: nothing to ask, so don't touch storage at all.
        if (held && !POLL_NEWEST) return;
        const r = await checkFeed(held, (await getSetting('feedCheckedAt')) ?? 0, {
          skip: await getSetting('feedUnusable'),
        });
        if (r.checked) await setSetting('feedCheckedAt', Date.now());
        if (r.unusable) await setSetting('feedUnusable', r.unusable);
        if (!r.programme && !held && r.checked) setProgrammeFailed(true); // first download didn't work: say so
        if (r.programme && r.programme.sessions.length) {
          setProgrammeFailed(false);
          await setSetting('programmeFeed', r.programme);
          if (held && held.edition !== r.programme.edition) {
            // A new edition (the real programme replacing the preview): sessions saved from the old one go.
            const n = await removeProgrammeSessions();
            if (n) announce(`The ${r.programme.name} programme is here. Your preview sessions were cleared; add the real ones.`);
          }
          await show();
        }
      } catch {
        // Keep what we have; try again next time.
      } finally {
        busy = false;
      }
    };
    void show().then(check);
    // The minute-by-minute poll only exists once polling the newest edition is switched on. Until then, opening
    // the app or coming back to it is enough: that's when a first download that failed is tried again.
    const timer = POLL_NEWEST ? setInterval(check, POLL_MS) : undefined;
    document.addEventListener('visibilitychange', check);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', check);
    };
  }, []);
  return { programme, failed };
}
