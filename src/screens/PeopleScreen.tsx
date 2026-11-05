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
  // Demo people sit in the same list as everyone else (no separate section or label).
  const real = connections.filter((c) => c.state === 'connected').sort((a, b) => Number(a.demo) - Number(b.demo) || newest(a, b));
  const requests = connections.filter((c) => c.state === 'pending-received').sort(newest);
  const waiting = connections.filter((c) => c.state === 'pending-sent').sort(newest);

  const row = (c: Connection) => {
    const shared = sharedTags(myTags, c.profile.tags ?? []);
    const line = [c.profile.role, c.profile.company, c.profile.city].filter(Boolean).join(' · ');
    return (
      <li key={c.id}>
        <button type="button" class="person-row" onClick={() => onOpen(c.id)}>
          <span class="person-name" dir="auto">
            {c.profile.displayName}
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
        {onShare && onEnterCode ? (
          <>
            <button type="button" class="button" onClick={onShare}>
              Share
            </button>
            <button type="button" class="button secondary" onClick={onEnterCode}>
              Enter a code
            </button>
          </>
        ) : (
          // Without a relay, sharing and codes can't work: both phones scan each other instead.
          <button type="button" class="button" onClick={onConnect}>
            Connect
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
          <p>Meet someone, swap codes, and they show up here with the topics you share.</p>
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

    </section>
  );
}
