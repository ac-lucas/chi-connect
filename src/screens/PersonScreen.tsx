import { useEffect, useRef, useState } from 'preact/hooks';
import type { Connection, Note, Tag } from '../model/types';
import { listNotes, removeConnection } from '../storage/db';
import { announce } from '../ui/announce';
import { useScreenHeading } from '../ui/useScreenHeading';
import { ProfileCard } from './ProfileCard';
import { SharedTopics } from './SharedTopics';

interface Props {
  connection: Connection;
  myTags: Tag[];
  justConnected?: boolean;
  onBack: () => void;
  onRemoved: () => void;
}

export function PersonScreen({ connection: c, myTags, justConnected, onBack, onRemoved }: Props) {
  const heading = useScreenHeading<HTMLHeadingElement>();
  const [notes, setNotes] = useState<Note[]>([]);
  const [confirming, setConfirming] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const name = c.profile.displayName;

  useEffect(() => {
    void listNotes(c.id).then(setNotes);
  }, [c.id]);
  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);

  async function remove() {
    await removeConnection(c.id);
    announce(`Removed ${name}.`);
    onRemoved();
  }

  const since = c.connectedAt ? new Date(c.connectedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long' }) : null;

  return (
    <section class="stack" aria-labelledby="person-heading">
      <div class="actions">
        <button type="button" class="button quiet" onClick={onBack}>
          <span aria-hidden="true">←</span> People
        </button>
      </div>
      <div>
        <h2 id="person-heading" ref={heading} tabIndex={-1}>
          {name}
          {c.demo && <span class="badge">Demo</span>}
        </h2>
        {justConnected ? (
          <p class="lede">You’re connected. Nice one.</p>
        ) : (
          since && <p class="muted">{c.demo ? 'Demo connection' : `Connected ${since}${c.via === 'face-to-face' ? ', face to face' : ''}`}</p>
        )}
      </div>

      <SharedTopics mine={myTags} theirs={c.profile.tags} name={name} />
      <ProfileCard profile={c.profile} />

      {notes.length > 0 && (
        <section aria-labelledby="notes-heading" class="stack">
          <h3 id="notes-heading">Your notes</h3>
          <ul class="notes">
            {notes.map((n) => (
              <li key={n.id} class="card">
                {n.text}
              </li>
            ))}
          </ul>
          <p class="hint">Only you can see these.</p>
        </section>
      )}

      <section aria-labelledby="remove-heading" class="stack">
        <h3 id="remove-heading" class="visually-hidden">
          Remove
        </h3>
        {confirming ? (
          <div class="card stack" role="group" aria-labelledby="remove-q">
            <p id="remove-q">
              Remove {name}? Your notes about them go too. They won’t be told.
            </p>
            <div class="actions">
              <button type="button" class="button danger" ref={confirmRef} onClick={remove}>
                Remove
              </button>
              <button type="button" class="button secondary" onClick={() => setConfirming(false)}>
                Keep
              </button>
            </div>
          </div>
        ) : (
          <button type="button" class="button quiet" onClick={() => setConfirming(true)}>
            Remove {name}
          </button>
        )}
      </section>
    </section>
  );
}
