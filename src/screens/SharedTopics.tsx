import { sharedTags } from '../model/tags';
import type { Tag } from '../model/types';

/** Shared-interest highlight (F06). Uses your own topics on this device, even ones you chose not to share. */
export function SharedTopics({ mine, theirs, name }: { mine: Tag[]; theirs: Tag[] | undefined; name: string }) {
  const shared = sharedTags(mine, theirs ?? []);
  if (shared.length === 0) {
    return <p class="muted">No topics in common on paper. Plenty to ask about, then.</p>;
  }
  return (
    <div class="shared stack">
      <p class="shared-lead">
        <span aria-hidden="true">✦ </span>
        You and {name} are both into {shared.length === 1 ? 'this' : `these ${shared.length}`}:
      </p>
      <ul class="chips" aria-label={`Topics you share with ${name}`}>
        {shared.map((t) => (
          <li key={t.key} class="chip selected static">
            <span aria-hidden="true">✓</span> {t.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
