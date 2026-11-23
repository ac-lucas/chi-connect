// The program: sessions people can add to their day. Comes from the program feed once wired in;
// until then from the labeled sample program (src/program/sample.ts).

export type SessionFormat = 'keynote' | 'papers' | 'panel' | 'workshop' | 'posters' | 'demos' | 'other';

export interface ProgramSession {
  id: string;
  title: string;
  start: number;
  end: number;
  room?: string;
  format: SessionFormat;
  /** Topic keys from the tag vocabulary (src/data/tags.ts), for matching with interests. */
  topics: string[];
  summary?: string;
  /** Up to a few papers in the session with their DOI / ACM DL links (for Catch up later). */
  papers?: { title: string; url: string }[];
}

export interface Program {
  name: string;
  sessions: ProgramSession[];
  /** Set when the days were moved to start today for a preview (the original first day, local midnight). */
  shiftedFrom?: number;
  /** License credit to show wherever the program appears. */
  credit?: string;
}

export const FORMAT_LABELS: Record<SessionFormat, string> = {
  keynote: 'Keynote',
  papers: 'Paper session',
  panel: 'Panel',
  workshop: 'Workshop',
  posters: 'Posters',
  demos: 'Demos',
  other: 'Session',
};
