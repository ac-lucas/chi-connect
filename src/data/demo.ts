// Demo connections so someone trying the app alone can see everything. Fictional people.
// Always shown with a "Demo" label. Topics overlap with common picks so shared-topic highlights appear.
import { resolveTag } from '../model/tags';
import type { Connection, Note, Tag } from '../model/types';

const tags = (...names: string[]): Tag[] => names.map((n) => resolveTag(n)!).filter(Boolean);

export const DEMO_CONNECTIONS: Connection[] = [
  {
    id: 'demo-mina',
    profile: {
      displayName: 'Mina Okafor',
      role: 'PhD student',
      company: 'Lagos',
      tags: tags('Accessibility', 'Haptics', 'VR', 'Design methods'),
    },
    state: 'connected',
    via: 'demo',
    scheduleSharing: true,
    sharedSessionIds: [],
    demo: true,
  },
  {
    id: 'demo-tomas',
    profile: {
      displayName: 'Tomás Reyes',
      role: 'Interaction designer',
      company: 'Studio in Valparaíso',
      tags: tags('Tangible interfaces', 'Fabrication', 'Creativity', 'Sustainability'),
    },
    state: 'connected',
    via: 'demo',
    scheduleSharing: true,
    sharedSessionIds: [],
    demo: true,
  },
  {
    id: 'demo-yuki',
    profile: {
      displayName: 'Yuki Tanaka (田中 由紀)',
      role: 'UX researcher',
      company: 'Osaka',
      tags: tags('UX research', 'AI and interaction', 'Eye tracking', 'Visualization', 'Slow tech'),
    },
    state: 'connected',
    via: 'demo',
    scheduleSharing: false,
    sharedSessionIds: [],
    demo: true,
  },
];

export const DEMO_NOTES: Omit<Note, 'createdAt'>[] = [
  { id: 'demo-note-mina', connectionId: 'demo-mina', text: 'Building a haptic map for blind travellers. Wants feedback on the study design.', chips: ['Follow up'] },
  { id: 'demo-note-tomas', connectionId: 'demo-tomas', text: 'Makes furniture that doubles as an interface. Ask about the clay prototypes.', chips: [] },
];
