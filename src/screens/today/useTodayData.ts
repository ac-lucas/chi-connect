// Everything the Today screen shows from storage, kept current as it changes (see ui/useLive.ts).
import type { Connection, EnergySetting, Invite, ScheduleItem } from '../../model/types';
import { pendingIncoming } from '../../schedule/invites';
import { getSetting, listAllSchedule, listConnections, listInvites } from '../../storage/db';
import { useLive } from '../../ui/useLive';

export interface TodayData {
  items: ScheduleItem[];
  energy?: EnergySetting;
  skipped: string[];
  invites: Invite[];
  /** Incoming invites waiting for an answer. */
  incoming: Invite[];
  connections: Connection[];
  /** Meetups whose "display your shape" prompt was hidden. */
  hiddenPrompts: string[];
  /** Suggestions paused (no conversation starters either). */
  quiet: boolean;
}

const EMPTY: TodayData = { items: [], skipped: [], invites: [], incoming: [], connections: [], hiddenPrompts: [], quiet: false };

/**
 * `clockBucket` changes every few minutes so time-based tidying runs (unanswered invites go once their time
 * has come) even when nothing is written.
 */
export function useTodayData(clockBucket: number): TodayData {
  return (
    useLive(
      async () => {
        const incoming = await pendingIncoming(); // tidies invites first; it can delete some
        const [items, energy, skipped, invites, connections, dismissed, quiet] = await Promise.all([
          listAllSchedule(),
          getSetting('energy'),
          getSetting('skippedBreaks'),
          listInvites(),
          listConnections(),
          getSetting('dismissed'),
          getSetting('quietMode'),
        ]);
        return {
          items,
          energy,
          skipped: skipped ?? [],
          invites,
          incoming,
          connections,
          hiddenPrompts: (dismissed ?? []).filter((k) => k.startsWith('shapeprompt:')),
          quiet: !!quiet,
        };
      },
      ['schedule', 'settings', 'invites', 'connections'],
      [clockBucket],
    ) ?? EMPTY
  );
}
