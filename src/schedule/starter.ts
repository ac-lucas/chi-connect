// The ready-made schedule from src/data/demoSchedule.ts, as saved sessions, for the preview programme.
import { DEMO_SCHEDULE } from '../data/demoSchedule';
import type { ScheduleItem } from '../model/types';
import type { Programme } from '../programme/types';

/** Stable ID per programme session, the same one "Add sessions" uses, so the two never duplicate. */
export const savedId = (sessionId: string) => `saved-${sessionId}`;

/** The demo sessions that exist in this programme, as saved items labelled Sample. */
export function demoScheduleItems(programme: Programme): ScheduleItem[] {
  const byId = new Map(programme.sessions.map((s) => [s.id, s]));
  return DEMO_SCHEDULE.flatMap((id) => {
    const s = byId.get(id);
    return s ? [{ id: savedId(s.id), type: 'session' as const, source: 'auto' as const, starter: true, programmeSessionId: s.id, title: s.title, place: s.room, start: s.start, end: s.end }] : [];
  });
}
