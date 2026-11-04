// The invite as it travels between two phones (inside an encrypted pair message). Untrusted on arrival.
import type { InviteKind, MeetingSpot } from '../model/types';
import { cleanText } from '../model/text';
import { cleanSpot } from '../schedule/spot';

export const LIMITS_INVITE = { place: 80, note: 140, title: 300 } as const;
export const INVITE_KINDS: readonly InviteKind[] = ['meal', 'break-together', 'sit-together', 'walk-over', 'arrive-together', 'catch-up'];
const ID = /^[A-Za-z0-9_-]{22}$/;
const SESSION_ID = /^[A-Za-z0-9_-]{1,40}$/;
const MAX_LENGTH_MS = 6 * 60 * 60 * 1000;
const EARLIEST = Date.UTC(2024, 0, 1);

export interface WireInvite {
  id: string;
  kind: InviteKind;
  start: number;
  end: number;
  place?: string;
  spot?: MeetingSpot;
  note?: string;
  sessionId?: string;
  sessionTitle?: string;
}

const time = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v > EARLIEST ? v : null);

export function parseWireInvite(v: unknown): WireInvite | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string' || !ID.test(o.id)) return null;
  if (!INVITE_KINDS.includes(o.kind as InviteKind)) return null;
  const start = time(o.start);
  const end = time(o.end);
  if (start === null || end === null || end <= start || end - start > MAX_LENGTH_MS) return null;
  const out: WireInvite = { id: o.id, kind: o.kind as InviteKind, start, end };
  const place = cleanText(o.place, LIMITS_INVITE.place);
  if (place) out.place = place;
  const spot = cleanSpot(o.spot);
  if (spot) out.spot = spot;
  const note = cleanText(o.note, LIMITS_INVITE.note);
  if (note) out.note = note;
  if (typeof o.sessionId === 'string' && SESSION_ID.test(o.sessionId)) out.sessionId = o.sessionId;
  const sessionTitle = cleanText(o.sessionTitle, LIMITS_INVITE.title);
  if (sessionTitle) out.sessionTitle = sessionTitle;
  return out;
}
