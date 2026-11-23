// A tiny program for tests only (the app itself only ever uses the real feed).
import type { Program, ProgramSession } from '../program/types';

export function testProgram(anchor = new Date(2027, 3, 12).getTime()): Program {
  const at = (day: number, h: number, m = 0) => {
    const d = new Date(anchor);
    d.setDate(d.getDate() + day);
    d.setHours(h, m, 0, 0);
    return d.getTime();
  };
  const s = (id: string, day: number, h: number, topics: string[], title = id): ProgramSession => ({
    id,
    title,
    start: at(day, h),
    end: at(day, h + 1, 30),
    room: 'Room 1',
    format: 'papers',
    topics,
  });
  return {
    name: 'Test program',
    sessions: [
      s('t-1', 0, 10, ['haptics', 'accessibility'], 'Touch and access'),
      s('t-2', 0, 14, ['vr'], 'Virtual rooms'),
      s('t-3', 1, 10, ['vr', 'accessibility'], 'Accessible VR'),
      s('t-4', 1, 14, ['ai'], 'Machines that help'),
    ],
  };
}
