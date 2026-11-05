// Relay sync: requests, replies, invites and shared session lists from the people you're connected with.
import { useEffect } from 'preact/hooks';
import { INTRO_KEEP_MS, syncOnce } from '../relay/protocol';
import type { Transport } from '../relay/transport';
import { handleInviteMessage } from '../schedule/invites';
import { handleSessionsMessage, shareSessionsIfChanged } from '../schedule/overlap';
import { getHome, getIntros, getSetting, listAllSchedule, listConnections, listInvites, pruneIntros, putConnection, setSetting, updateConnection } from '../storage/db';
import { announce } from '../ui/announce';

/** Sync while something is expected (a reply, a request to a live code, an upcoming meetup)... */
const SYNC_ACTIVE_MS = 60_000;
/** ...and when nothing is: a few requests an hour instead of sixty. */
const SYNC_IDLE_MS = 5 * 60_000;
/** When the relay says more mail is waiting. */
const SYNC_MORE_MS = 2_000;
/** Coming back to the app syncs straight away, unless it synced this recently. */
const SYNC_MIN_GAP_MS = 20_000;

/** True while protected time or a Focus session is running (new invites then wait quietly). */
async function isHoldingNow(now = Date.now()): Promise<boolean> {
  return (await listAllSchedule()).some((i) => i.start <= now && i.end > now && (i.type === 'protected' || (i.type === 'session' && !!i.focus)));
}

export function useRelaySync(relay: Transport | null, enabled: boolean): void {
  // Check the relay for requests and replies: on open, on coming back to the app, and then every minute while
  // something is expected or every 5 minutes while nothing is. Never while the app isn't on screen.
  useEffect(() => {
    if (!relay || !enabled) return;
    let running = false;
    let stopped = false;
    let lastRun = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (ms: number) => {
      clearTimeout(timer);
      if (!stopped) timer = setTimeout(() => void run(), ms);
    };
    const run = async () => {
      if (running || stopped || document.visibilityState !== 'visible') return;
      running = true;
      lastRun = Date.now();
      let next = SYNC_IDLE_MS;
      try {
        const newInvites: string[] = [];
        // Expired one-way codes (and their private keys) go once no late request can still arrive.
        await pruneIntros((i) => i.expiresAt + INTRO_KEEP_MS);
        let lastAcks: string[] = [];
        const r = await syncOnce(relay, await getHome(), {
          intros: getIntros,
          connections: listConnections,
          put: putConnection,
          patch: updateConnection,
          acks: async () => (lastAcks = (await getSetting('relayAcks')) ?? []),
          // Only written when there's something to change: every settings write makes open screens reload.
          setAcks: async (ids) => {
            if (ids.length || lastAcks.length) await setSetting('relayAcks', ids);
          },
          onPairMessage: async (c, msg, sentAt) => {
            if (msg.t === 'sessions') return handleSessionsMessage(c, msg.ids);
            const what = await handleInviteMessage(c, msg, sentAt);
            if (what === 'new') newInvites.push(c.profile.displayName);
          },
        });
        // Send my saved-session list to people I share it with, if it changed (F14).
        await shareSessionsIfChanged(relay);
        // New invites are announced, except while protected time or a Focus session is running (they wait).
        // One announcement per sync: the live region only reads the last message it's given.
        const lines: string[] = [];
        if (newInvites.length && !(await isHoldingNow())) {
          lines.push(newInvites.length === 1 ? `${newInvites[0]} sent you an invite.` : `${newInvites.length} new invites.`);
        }
        if (r.newRequests.length) {
          lines.push(r.newRequests.length === 1 ? `${r.newRequests[0]!.profile.displayName} would like to connect.` : `${r.newRequests.length} new requests to connect.`);
        }
        for (const c of r.accepted) lines.push(`${c.profile.displayName} said yes. You’re connected.`);
        if (lines.length) announce(lines.join(' '));
        // (Screens reload by themselves: every write above announced what it changed.)
        const conns = await listConnections();
        // Expecting something? Then check again in a minute; otherwise in five.
        const now = Date.now();
        const expecting =
          r.messages > 0 ||
          r.newRequests.length > 0 ||
          conns.some((c) => c.state === 'pending-sent') ||
          (await getIntros()).some((i) => i.expiresAt > now) ||
          (await listInvites()).some((i) => i.end > now && i.status !== 'declined' && i.status !== 'cancelled');
        // The relay held some mail back (reply size cap): fetch the rest straight away.
        next = r.more ? SYNC_MORE_MS : expecting ? SYNC_ACTIVE_MS : SYNC_IDLE_MS;
      } catch {
        // Offline or the relay is busy: try again at the slower pace.
      } finally {
        running = false;
        schedule(next);
      }
    };
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return clearTimeout(timer); // nothing runs in the background
      if (Date.now() - lastRun >= SYNC_MIN_GAP_MS) void run();
      else schedule(SYNC_MIN_GAP_MS);
    };
    void run();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [relay, enabled]);
}
