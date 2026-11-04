// A made-up programme so the app can be tried before (and without) the real feed. Three days starting on
// the day it was first opened, so "today" always has something in it. Labelled "Sample" in the UI.
// Includes very long titles and non-Latin text on purpose, to keep the layout honest.
import type { Programme, ProgrammeSession, SessionFormat } from './types';

interface Slot {
  start: string; // HH:MM local
  end: string;
  sessions: [title: string, format: SessionFormat, room: string, topics: string[]][];
}

const DAYS: Slot[][] = [
  [
    { start: '09:00', end: '10:00', sessions: [['Opening keynote: Designing for the people who leave early', 'keynote', 'Main hall', ['design-methods', 'ethics']]] },
    {
      start: '10:30',
      end: '12:00',
      sessions: [
        ['Touch, texture and haptic maps', 'papers', 'Room 101', ['haptics', 'accessibility']],
        ['Learning with machines in the classroom', 'papers', 'Room 102', ['education', 'ai']],
        ['Visualising uncertainty for everyone', 'papers', 'Room 201', ['visualization', 'cognition']],
        ['Panel: Who gets to play? Games beyond the usual players', 'panel', 'Room 202', ['games', 'accessibility']],
      ],
    },
    {
      start: '13:30',
      end: '15:00',
      sessions: [
        ['Bodies in virtual space', 'papers', 'Room 101', ['vr', 'wearables']],
        ['Privacy you can actually use', 'papers', 'Room 102', ['privacy', 'ux-research']],
        ['Workshop: Clay, code and other prototyping materials', 'workshop', 'Studio A', ['fabrication', 'tangible']],
        ['インタラクションと身体性: Embodied interaction across cultures', 'papers', 'Room 201', ['tangible', 'global']],
      ],
    },
    {
      start: '15:30',
      end: '17:00',
      sessions: [
        ['Conversational agents that know when to stop talking', 'papers', 'Room 101', ['voice', 'ai']],
        ['Sustainable computing at home', 'papers', 'Room 102', ['sustainability', 'ubicomp']],
        ['Eye tracking in the wild', 'papers', 'Room 201', ['eye-tracking', 'cognition']],
      ],
    },
    { start: '17:30', end: '19:00', sessions: [['Posters and demos reception', 'posters', 'Exhibition hall', ['creativity', 'design-methods']]] },
  ],
  [
    {
      start: '09:00',
      end: '10:30',
      sessions: [
        ['Augmented reality on the street', 'papers', 'Room 101', ['ar', 'ubicomp']],
        ['Older adults and the technologies they actually want', 'papers', 'Room 102', ['ageing', 'ux-research']],
        ['Children, families and screens', 'papers', 'Room 201', ['children', 'education']],
      ],
    },
    {
      start: '11:00',
      end: '12:30',
      sessions: [
        ['Accessible VR: beyond the headset', 'papers', 'Room 101', ['vr', 'accessibility']],
        ['Robots that share the room', 'papers', 'Room 102', ['robots', 'social']],
        [
          'A very long session title that keeps going because some sessions really do have titles this long: participatory design, community partnerships and what happens after the study ends',
          'papers',
          'Room 201',
          ['design-methods', 'global'],
        ],
        ['Demos: Things you can touch', 'demos', 'Exhibition hall', ['tangible', 'haptics', 'fabrication']],
      ],
    },
    {
      start: '14:00',
      end: '15:30',
      sessions: [
        ['Collaboration across time zones', 'papers', 'Room 101', ['cscw', 'social']],
        ['Health tracking without the guilt', 'papers', 'Room 102', ['health', 'wearables']],
        ['Panel: Responsible AI in practice', 'panel', 'Main hall', ['ethics', 'ai']],
      ],
    },
    {
      start: '16:00',
      end: '17:30',
      sessions: [
        ['Creative tools for musicians', 'papers', 'Room 101', ['creativity', 'input']],
        ['Driving, riding and being driven', 'papers', 'Room 102', ['automotive']],
        ['Posters: Work in progress', 'posters', 'Exhibition hall', ['ux-research', 'design-methods']],
      ],
    },
  ],
  [
    {
      start: '09:30',
      end: '11:00',
      sessions: [
        ['Input techniques for small screens', 'papers', 'Room 101', ['input', 'wearables']],
        ['التصميم من أجل الجميع: Design for everyone', 'papers', 'Room 102', ['accessibility', 'global']],
        ['Mixed reality for remote teams', 'papers', 'Room 201', ['ar', 'cscw']],
      ],
    },
    {
      start: '11:30',
      end: '13:00',
      sessions: [
        ['Attention, interruption and calm technology', 'papers', 'Room 101', ['cognition', 'health']],
        ['Workshop: Speculative futures for public services', 'workshop', 'Studio A', ['design-methods', 'ethics']],
      ],
    },
    { start: '14:30', end: '15:30', sessions: [['Closing keynote: What we carry home', 'keynote', 'Main hall', ['social', 'creativity']]] },
  ],
];

function at(day: Date, hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(day);
  d.setHours(h!, m!, 0, 0);
  return d.getTime();
}

/** The sample programme, with day 1 on the date of `anchor` (device local time). */
export function makeSampleProgramme(anchor: number): Programme {
  const sessions: ProgrammeSession[] = [];
  DAYS.forEach((slots, dayIndex) => {
    const day = new Date(anchor);
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() + dayIndex);
    slots.forEach((slot, slotIndex) => {
      slot.sessions.forEach(([title, format, room, topics], n) => {
        sessions.push({
          id: `sample-${dayIndex + 1}-${slotIndex + 1}-${n + 1}`,
          title,
          format,
          room,
          topics,
          start: at(day, slot.start),
          end: at(day, slot.end),
        });
      });
    });
  });
  return { name: 'Sample programme', sample: true, sessions };
}
