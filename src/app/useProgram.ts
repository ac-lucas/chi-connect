// The program: show what's on the device straight away, and fetch it if there's none yet. Polling for a newer
// edition (on open, on return to the front, and once a minute while visible) only runs once POLL_NEWEST is on.
import { useEffect, useState } from 'preact/hooks';
import { checkFeed, POLL_MS, POLL_NEWEST } from '../program/feed';
import { PROGRAM_CREDIT } from '../program/transform';
import { isOver } from '../program/preview';
import { resolveProgram, startOfDay } from '../program/program';
import type { Program } from '../program/types';
import { getPreviewAnchor, getSetting, removeProgramSessions, setSetting, syncSavedSessions } from '../storage/db';
import { announce } from '../ui/announce';

/** The program to show (null until one is on the device), and whether a first download failed. */
export function useProgram(): { program: Program | null; failed: boolean } {
  const [program, setProgram] = useState<Program | null>(null);
  const [failed, setProgramFailed] = useState(false);
  useEffect(() => {
    let stopped = false;
    let busy = false;
    /** Which program is on the device: kept here so a check doesn't re-read the whole stored program. */
    let held: { edition: string; revision: number } | null = null;
    const show = async () => {
      try {
        const stored = await getSetting('programFeed');
        if (!stored) return; // nothing downloaded yet: check() fetches it
        // Always the current credit wording, not whatever was saved with an older download.
        const feed = { ...stored, credit: PROGRAM_CREDIT };
        held = { edition: feed.edition, revision: feed.revision };
        let anchor = await getPreviewAnchor();
        let p = resolveProgram(anchor, feed);
        // A preview whose days have all gone by (someone coming back a week later): start it from today.
        if (p.shiftedFrom !== undefined && isOver(p)) {
          anchor = startOfDay(Date.now());
          await setSetting('sampleAnchor', anchor);
          p = resolveProgram(anchor, feed);
        }
        // Saved sessions follow the program: moved times, new rooms and renames show up in your day.
        await syncSavedSessions(p.sessions);
        if (!stopped) setProgram(p);
      } catch {
        if (!stopped) setProgramFailed(true);
      }
    };
    const check = async () => {
      if (busy || stopped || document.visibilityState !== 'visible') return;
      busy = true;
      try {
        // Polling is off and a program is held: nothing to ask, so don't touch storage at all.
        if (held && !POLL_NEWEST) return;
        const r = await checkFeed(held, (await getSetting('feedCheckedAt')) ?? 0, {
          skip: await getSetting('feedUnusable'),
        });
        if (r.checked) await setSetting('feedCheckedAt', Date.now());
        if (r.unusable) await setSetting('feedUnusable', r.unusable);
        if (!r.program && !held && r.checked) setProgramFailed(true); // first download didn't work: say so
        if (r.program && r.program.sessions.length) {
          setProgramFailed(false);
          await setSetting('programFeed', r.program);
          if (held && held.edition !== r.program.edition) {
            // A new edition (the real program replacing the preview): sessions saved from the old one go.
            const n = await removeProgramSessions();
            if (n) announce(`The ${r.program.name} program is here. Your preview sessions were cleared; add the real ones.`);
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
  return { program, failed };
}
