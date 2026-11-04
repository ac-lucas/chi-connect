// The programme: sessions people can add to their day. Comes from the programme feed once wired in;
// until then from the labelled sample programme (src/programme/sample.ts).

export type SessionFormat = 'keynote' | 'papers' | 'panel' | 'workshop' | 'posters' | 'demos' | 'other';

export interface ProgrammeSession {
  id: string;
  title: string;
  start: number;
  end: number;
  room?: string;
  format: SessionFormat;
  /** Topic keys from the tag vocabulary (src/data/tags.ts), for matching with interests. */
  topics: string[];
  summary?: string;
  paperUrl?: string;
}

export interface Programme {
  name: string;
  /** True for the made-up sample programme. Shown as such wherever it appears. */
  sample: boolean;
  sessions: ProgrammeSession[];
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
