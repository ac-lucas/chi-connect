// Show one person, read live by ID: a just-saved connection appears as soon as it's stored, and one removed
// elsewhere (another tab) says so instead of showing stale details.
import type { Tag } from '../model/types';
import type { Programme } from '../programme/types';
import type { Transport } from '../relay/transport';
import { getConnection } from '../storage/db';
import { useLive } from '../ui/useLive';
import { PersonScreen } from './PersonScreen';

interface Props {
  id: string;
  myTags: Tag[];
  justConnected?: boolean;
  relay: Transport | null;
  programme: Programme | null;
  onBack: () => void;
  onRemoved: () => void;
}

export function PersonById({ id, ...rest }: Props) {
  const c = useLive(() => getConnection(id), ['connections'], [id]);
  if (c === undefined) return <p class="muted">Loading…</p>;
  if (c === null) return <p class="muted">That person isn’t here any more.</p>;
  return <PersonScreen key={c.id} connection={c} {...rest} />;
}
