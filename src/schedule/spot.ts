// Meeting spot (F25): a coarse area of a room picked by hand. Never device location.
import type { MeetingRow, MeetingSide, MeetingSpot } from '../model/types';

export const ROWS: MeetingRow[] = ['front', 'middle', 'back'];
export const SIDES: MeetingSide[] = ['left', 'centre', 'right'];

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "Back left, aisle seat", "By the door". Empty string when no spot was picked. */
export function describeSpot(s: MeetingSpot | undefined): string {
  if (!s) return '';
  const parts: string[] = [];
  // 'centre' is the stored and sent value (kept for compatibility); people read the US spelling.
  if (s.row && s.side) parts.push(s.side === 'centre' ? `${cap(s.row)} center` : `${cap(s.row)} ${s.side}`);
  else if (s.row) parts.push(`${cap(s.row)}`);
  else if (s.side) parts.push(s.side === 'centre' ? 'Center' : `${cap(s.side)} side`);
  if (s.byDoor) parts.push(parts.length ? 'by the door' : 'By the door');
  if (s.aisleSeat) parts.push(parts.length ? 'aisle seat' : 'Aisle seat');
  return parts.join(', ');
}

/** Validate a spot from another phone: only known values survive. */
export function cleanSpot(v: unknown): MeetingSpot | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const out: MeetingSpot = {};
  if (ROWS.includes(o.row as MeetingRow)) out.row = o.row as MeetingRow;
  if (SIDES.includes(o.side as MeetingSide)) out.side = o.side as MeetingSide;
  if (o.byDoor === true) out.byDoor = true;
  if (o.aisleSeat === true) out.aisleSeat = true;
  return Object.keys(out).length ? out : undefined;
}
