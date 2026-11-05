// Auto-breaks (F11): fill the gaps between what's in someone's day with a lunch break and breathers,
// shaped by today's energy (F22), and give a friendly heads-up on a packed day. Pure: no storage, no clock.
import type { EnergyLevel } from '../model/types';
import { atMinutes } from '../programme/programme';
import { ENERGY } from './energy';

export interface Busy {
  id: string;
  start: number;
  end: number;
  kind: 'session' | 'protected' | 'meetup';
}

export interface BreakPrefs {
  /** Lunch window, minutes after midnight. */
  mealFrom: number;
  mealTo: number;
  mealLength: number;
  /** Shortest lunch worth suggesting. */
  mealMin: number;
  /** Time to get from one room to the next, taken off each gap (split before and after the break). */
  buffer: number;
  /** Shortest breather worth suggesting. */
  breatherMin: number;
}

export const DEFAULT_PREFS: BreakPrefs = {
  mealFrom: 11 * 60 + 30,
  mealTo: 14 * 60 + 30,
  mealLength: 45,
  mealMin: 25,
  buffer: 10,
  breatherMin: 10,
};

export interface PlannedBreak {
  /** Stable key for this suggestion, so skipping it sticks. */
  key: string;
  kind: 'meal' | 'breather';
  start: number;
  end: number;
}

export type HeadsUp =
  | { kind: 'no-lunch' }
  | { kind: 'long-stretch'; from: number; until: number; sessions: number; recharge?: { start: number; end: number } };

export interface DayPlan {
  breaks: PlannedBreak[];
  headsUps: HeadsUp[];
}

const MIN = 60_000;

export function planDay(
  busy: Busy[],
  dayStart: number,
  energy: EnergyLevel,
  prefs: BreakPrefs = DEFAULT_PREFS,
  skipped: ReadonlySet<string> = new Set(),
): DayPlan {
  const items = busy.filter((b) => b.end > b.start).sort((a, b) => a.start - b.start || a.end - b.end);
  const plan: DayPlan = { breaks: [], headsUps: [] };
  if (!items.length) return plan;

  // Merge overlapping or touching items into blocks of busy time.
  // `restEnd` marks a block that finishes with protected time (already rest), so no breather straight after.
  const blocks: { start: number; end: number; sessions: number; restEnd: boolean }[] = [];
  for (const b of items) {
    const last = blocks.at(-1);
    const isSession = b.kind === 'session' ? 1 : 0;
    if (last && b.start <= last.end) {
      if (b.end >= last.end) last.restEnd = b.kind === 'protected';
      last.end = Math.max(last.end, b.end);
      last.sessions += isSession;
    } else blocks.push({ start: b.start, end: b.end, sessions: isSession, restEnd: b.kind === 'protected' });
  }

  const e = ENERGY[energy];
  const mealFrom = atMinutes(dayStart, prefs.mealFrom);
  const mealTo = atMinutes(dayStart, prefs.mealTo);
  const half = (prefs.buffer / 2) * MIN;
  let mealPlaced = false;

  for (let i = 0; i + 1 < blocks.length; i++) {
    const s = blocks[i]!.end + half;
    const en = blocks[i + 1]!.start - half;
    if (en - s < prefs.breatherMin * MIN) continue;

    if (!mealPlaced) {
      const ms = Math.max(s, mealFrom);
      const me = Math.min(en, mealTo, ms + prefs.mealLength * MIN);
      if (me - ms >= prefs.mealMin * MIN) {
        mealPlaced = true;
        plan.breaks.push({ key: `meal:${ms}`, kind: 'meal', start: ms, end: me });
        // Any room before lunch in the same gap is just part of the walk over; no extra breather.
        continue;
      }
    }
    if (blocks[i]!.restEnd) continue; // just had protected downtime
    const be = Math.min(en, s + e.breather * MIN);
    plan.breaks.push({ key: `breather:${s}`, kind: 'breather', start: s, end: be });
  }

  // Lunch: only a heads-up if the day actually runs across the lunch window.
  const dayFrom = blocks[0]!.start;
  const dayTo = blocks.at(-1)!.end;
  if (!mealPlaced && dayFrom < mealTo && dayTo > mealFrom) plan.headsUps.push({ kind: 'no-lunch' });

  // Long stretches: sessions in a row with no breather between them.
  let run: { from: number; until: number; sessions: number } | null = null;
  const flush = (nextStart: number | null) => {
    if (run && run.sessions >= e.stretch) {
      const r = { start: run.until + half, end: run.until + half + e.recharge * MIN };
      // Only offer a recharge when there's more day after it, and it fits before the next thing.
      const fits = nextStart !== null && r.end <= nextStart - half;
      plan.headsUps.push({ kind: 'long-stretch', ...run, ...(fits ? { recharge: r } : {}) });
    }
  };
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    const gapBefore = i > 0 ? b.start - blocks[i - 1]!.end : Infinity;
    const restBefore = gapBefore >= (prefs.buffer + prefs.breatherMin) * MIN;
    if (!run || restBefore) {
      flush(b.start);
      run = { from: b.start, until: b.end, sessions: b.sessions };
    } else {
      run.until = b.end;
      run.sessions += b.sessions;
    }
  }
  flush(null);

  plan.breaks = plan.breaks.filter((b) => !skipped.has(b.key));
  return plan;
}
