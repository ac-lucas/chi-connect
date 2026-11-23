// The ready-made schedule from src/data/demoSchedule.ts, as saved sessions, for the preview program.
import { DEMO_SCHEDULE } from '../data/demoSchedule';
import type { ScheduleItem } from '../model/types';
import type { Program } from '../program/types';

/** Stable ID per program session, the same one "Add sessions" uses, so the two never duplicate. */
export const savedId = (sessionId: string) => `saved-${sessionId}`;

/** The demo sessions that exist in this program, as saved items labeled Sample. */
export function demoScheduleItems(program: Program): ScheduleItem[] {
  const byId = new Map(program.sessions.map((s) => [s.id, s]));
  return DEMO_SCHEDULE.flatMap((id) => {
    const s = byId.get(id);
    return s ? [{ id: savedId(s.id), type: 'session' as const, source: 'auto' as const, starter: true, programSessionId: s.id, title: s.title, place: s.room, start: s.start, end: s.end }] : [];
  });
}
