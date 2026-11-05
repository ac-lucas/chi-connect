// Schedule overlap (F14): with someone's say-so, see which of your saved sessions they saved too.
// Opt-in per person, session-level only, revocable (turning it off sends an empty list). Connected pairs only.
import type { Connection } from '../model/types';
import type { Programme, ProgrammeSession } from '../programme/types';
import { MAX_SHARED_SESSIONS, sendPairMessage } from '../relay/protocol';
import type { Transport } from '../relay/transport';
import { listAllSchedule, listConnections, updateConnection } from '../storage/db';

/** Re-send unchanged lists now and then, in case one was missed (relay messages last a day). */
const RESEND_MS = 12 * 60 * 60 * 1000;

export async function mySavedSessionIds(): Promise<string[]> {
  const ids = (await listAllSchedule())
    .filter((s) => s.type === 'session' && s.programmeSessionId)
    .map((s) => s.programmeSessionId!);
  return [...new Set(ids)].sort().slice(0, MAX_SHARED_SESSIONS);
}

async function hashOf(ids: string[]): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ids.join(','))));
  return Array.from(h.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Send my saved-session list to everyone I share it with, if it changed since I last sent it (or it's been a while).
 * People I stopped sharing with get one empty list. Demo people are skipped: they only exist on this phone.
 */
export async function shareSessionsIfChanged(relay: Transport, now = Date.now()): Promise<number> {
  const mine = await mySavedSessionIds();
  const mineHash = await hashOf(mine);
  const emptyHash = await hashOf([]);
  let sent = 0;
  for (const c of await listConnections()) {
    if (c.demo || c.state !== 'connected') continue;
    const want = c.scheduleSharing ? mineHash : emptyHash;
    const fresh = c.lastSharedAt !== undefined && now - c.lastSharedAt < RESEND_MS;
    if (c.lastSharedHash === want && (fresh || !c.scheduleSharing)) continue;
    if (!c.scheduleSharing && c.lastSharedHash === undefined) continue; // never shared, nothing to take back
    try {
      await sendPairMessage(relay, c, { t: 'sessions', v: 1, ids: c.scheduleSharing ? mine : [] });
      // Only these two fields: the record may have changed (sharing switched off) while this was sending.
      await updateConnection(c.id, { lastSharedHash: want, lastSharedAt: now });
      sent++;
    } catch {
      // Offline: try again next sync.
    }
  }
  return sent;
}

/** Someone's list arrived: replace what we had for them. */
export async function handleSessionsMessage(c: Connection, ids: string[]): Promise<void> {
  await updateConnection(c.id, { sharedSessionIds: ids });
}

/**
 * Demo people's "saved sessions" (simulated): sessions whose topics overlap theirs, about two a day,
 * picked the same way every time so the demo is stable.
 */
export function demoSessionIds(c: Connection, p: Programme): string[] {
  const tags = new Set((c.profile.tags ?? []).map((t) => t.key));
  const byDay = new Map<number, ProgrammeSession[]>();
  for (const s of p.sessions) {
    if (!s.topics.some((t) => tags.has(t))) continue;
    const d = new Date(s.start).setHours(0, 0, 0, 0);
    byDay.set(d, [...(byDay.get(d) ?? []), s]);
  }
  const seed = [...c.id].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7);
  const out: string[] = [];
  for (const list of byDay.values()) {
    for (let k = 0; k < Math.min(3, list.length); k++) out.push(list[(seed + k * 7) % list.length]!.id);
  }
  return out;
}

/** Who (of the people who share with me) saved this session. */
export function alsoGoing(sessionId: string | undefined, people: Connection[], p: Programme): Connection[] {
  if (!sessionId) return [];
  return people.filter((c) => c.state === 'connected' && (c.demo ? demoSessionIds(c, p) : c.sharedSessionIds).includes(sessionId));
}

export function namesList(people: Connection[]): string {
  const names = people.map((c) => c.profile.displayName + (c.demo ? ' (demo)' : ''));
  if (names.length <= 2) return names.join(' and ');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

