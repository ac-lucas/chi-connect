import { sharedTags } from '../model/tags';
import type { Connection, Tag } from '../model/types';
import { useScreenHeading } from '../ui/useScreenHeading';

interface Props {
  connections: Connection[];
  myTags: Tag[];
  onConnect: () => void;
  onOpen: (id: string) => void;
  /** Present only when a relay is configured. */
  onShare?: () => void;
  onEnterCode?: () => void;
}

export function PeopleScreen({ connections, myTags, onConnect, onOpen, onShare, onEnterCode }: Props) {
  const heading = useScreenHeading<HTMLHeadingElement>();
  const newest = (a: Connection, b: Connection) => (b.connectedAt ?? b.requestedAt ?? 0) - (a.connectedAt ?? a.requestedAt ?? 0);
  const real = connections.filter((c) => !c.demo && c.state === 'connected').sort(newest);
  const requests = connections.filter((c) => c.state === 'pending-received').sort(newest);
  const waiting = connections.filter((c) => c.state === 'pending-sent').sort(newest);
  const demo = connections.filter((c) => c.demo);

  const row = (c: Connection) => {
    const shared = sharedTags(myTags, c.profile.tags ?? []);
    const line = [c.profile.role, c.profile.company].filter(Boolean).join(' · ');
    return (
      <li key={c.id}>
        <button type="button" class="person-row" onClick={() => onOpen(c.id)}>
          <span class="person-name" dir="auto">
            {c.profile.displayName}
            {c.demo && <span class="badge"><span class="visually-hidden">, </span>Demo</span>}
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
        {onShare && (
          <button type="button" class="button secondary" onClick={onShare}>
            Share your code
          </button>
        )}
        {onEnterCode && (
          <button type="button" class="button secondary" onClick={onEnterCode}>
            Enter a code
          </button>
        )}
      </div>

      {requests.length > 0 && (
        <section aria-labelledby="requests" class="stack">
          <h3 id="requests">Want to connect ({requests.length})</h3>
          <p class="hint">Say yes when you’re ready. If you don’t, they’re never told.</p>
          <ul class="people">{requests.map(row)}</ul>
        </section>
      )}

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

      {waiting.length > 0 && (
        <section aria-labelledby="waiting" class="stack">
          <h3 id="waiting">Requests you’ve sent ({waiting.length})</h3>
          <ul class="people">{waiting.map(row)}</ul>
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
