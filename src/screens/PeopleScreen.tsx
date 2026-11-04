import { sharedTags } from '../model/tags';
import type { Connection, Tag } from '../model/types';
import { useScreenHeading } from '../ui/useScreenHeading';

interface Props {
  connections: Connection[];
  myTags: Tag[];
  onConnect: () => void;
  onOpen: (id: string) => void;
}

export function PeopleScreen({ connections, myTags, onConnect, onOpen }: Props) {
  const heading = useScreenHeading<HTMLHeadingElement>();
  const real = connections.filter((c) => !c.demo).sort((a, b) => (b.connectedAt ?? 0) - (a.connectedAt ?? 0));
  const demo = connections.filter((c) => c.demo);

  const row = (c: Connection) => {
    const shared = sharedTags(myTags, c.profile.tags ?? []);
    const line = [c.profile.role, c.profile.company].filter(Boolean).join(' · ');
    return (
      <li key={c.id}>
        <button type="button" class="person-row" onClick={() => onOpen(c.id)}>
          <span class="person-name">
            {c.profile.displayName}
            {c.demo && <span class="badge">Demo</span>}
          </span>
          {line && <span class="muted">{line}</span>}
          <span class="person-shared">
            {shared.length === 0 ? 'No shared topics yet' : `${shared.length} shared ${shared.length === 1 ? 'topic' : 'topics'}`}
          </span>
        </button>
      </li>
    );
  };

  return (
    <section class="stack" aria-labelledby="people-heading">
      <h2 id="people-heading" ref={heading} tabIndex={-1}>
        People
      </h2>

      <div class="actions">
        <button type="button" class="button" onClick={onConnect}>
          Connect face to face
        </button>
      </div>

      {real.length === 0 ? (
        <div class="card stack">
          <p class="lede">Nobody here yet. That’s fine.</p>
          <p>When you meet someone, you scan each other’s code and they show up here, along with the topics you share.</p>
        </div>
      ) : (
        <section aria-labelledby="your-people" class="stack">
          <h3 id="your-people">Your people ({real.length})</h3>
          <ul class="people">{real.map(row)}</ul>
        </section>
      )}

      {demo.length > 0 && (
        <section aria-labelledby="demo-people" class="stack">
          <h3 id="demo-people">Demo people</h3>
          <p class="hint">Made up, so you can try everything on your own. Remove them any time.</p>
          <ul class="people">{demo.map(row)}</ul>
        </section>
      )}
    </section>
  );
}
