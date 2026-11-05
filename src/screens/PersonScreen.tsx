import { useEffect, useRef, useState } from 'preact/hooks';
import type { Connection, Tag } from '../model/types';
import { NotesSection } from './NotesSection';
import { approveRequest } from '../relay/protocol';
import { RelayError, type Transport } from '../relay/transport';
import { getSetting, listAllSchedule, removeConnection, updateConnection, getHome } from '../storage/db';
import { personOpeners } from '../data/icebreakers';
import { sharedTags } from '../model/tags';
import type { Programme } from '../programme/types';
import { dayLabel, timeRange } from '../programme/programme';
import { shareSessionsIfChanged } from '../schedule/overlap';
import { announce } from '../ui/announce';
import { useScreenHeading } from '../ui/useScreenHeading';
import { ProfileCard } from './ProfileCard';
import { keepingFocus } from '../ui/focus';
import { useLive } from '../ui/useLive';
import { SharedTopics } from './SharedTopics';

interface Props {
  connection: Connection;
  myTags: Tag[];
  justConnected?: boolean;
  relay: Transport | null;
  programme: Programme | null;
  onBack: () => void;
  onRemoved: () => void;
}

export function PersonScreen({ connection: c, myTags, justConnected, relay, programme, onBack, onRemoved }: Props) {
  const heading = useScreenHeading<HTMLHeadingElement>();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const mySessionIds =
    useLive(async () => (await listAllSchedule()).filter((s) => s.type === 'session' && s.programmeSessionId).map((s) => s.programmeSessionId!), ['schedule']) ?? [];
  const theirIds = c.sharedSessionIds;
  const quiet = useLive(async () => !!(await getSetting('quietMode')), ['settings']) ?? false;
  const both = programme ? programme.sessions.filter((s) => mySessionIds.includes(s.id) && theirIds.includes(s.id)) : [];

  async function toggleSharing(on: boolean) {
    await updateConnection(c.id, { scheduleSharing: on }); // never write the screen's (possibly stale) copy back
    announce(on ? `${name} can now see which sessions you’ve saved.` : `Stopped sharing your sessions with ${name}.`);
    if (relay && !c.demo) void shareSessionsIfChanged(relay).catch(() => {});
  }
  const confirmRef = useRef<HTMLButtonElement>(null);
  const name = c.profile.displayName;

  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);

  async function remove() {
    try {
      await removeConnection(c.id);
    } catch {
      announce('That didn’t work. Try again in a moment.');
      return;
    }
    announce(`Removed ${name}.`);
    onRemoved();
  }

  async function approve() {
    if (!relay) return;
    setBusy(true);
    setProblem(null);
    try {
      const done = await approveRequest(relay, await getHome(), c);
      await updateConnection(c.id, { state: done.state, connectedAt: done.connectedAt, myMailboxId: done.myMailboxId });
      announce(`You’re connected with ${name}.`);
    } catch (e) {
      const msg = e instanceof RelayError && e.problem === 'offline' ? 'You seem to be offline. Try again when you have a connection.' : 'That didn’t go through. Try again in a moment.';
      setProblem(msg); // shown in a role=alert, which is read out: don't announce it twice
    } finally {
      setBusy(false);
    }
  }

  /** Declining or cancelling just deletes it on this phone. Nothing is sent. */
  async function dismiss(message: string) {
    try {
      await removeConnection(c.id);
    } catch {
      announce('That didn’t work. Try again in a moment.');
      return;
    }
    announce(message);
    onRemoved();
  }

  const since = c.connectedAt ? new Date(c.connectedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long' }) : null;

  return (
    <section class="stack" aria-labelledby="person-heading">
      <div class="actions">
        <button type="button" class="button quiet" onClick={onBack}>
          <span aria-hidden="true">←</span> <span class="visually-hidden">Back to </span>People
        </button>
      </div>
      <div>
        <h2 id="person-heading" ref={heading} tabIndex={-1}>
          {name}
        </h2>
        {c.state === 'pending-received' ? (
          <p class="lede">{name} would like to connect.</p>
        ) : c.state === 'pending-sent' ? (
          <p class="lede">Request sent.</p>
        ) : justConnected ? (
          <p class="lede">You’re connected. Nice one.</p>
        ) : (
          since && !c.demo && <p class="muted">{`Connected ${since}${c.via === 'face-to-face' ? ', face to face' : ''}`}</p>
        )}
      </div>

      <SharedTopics mine={myTags} theirs={c.profile.tags} name={name} />
      <ProfileCard profile={c.profile} />

      {c.state === 'connected' && !quiet && (
        <section class="stack-tight" aria-labelledby="talk-heading">
          <h3 id="talk-heading">Things to talk about</h3>
          <ul class="openers">
            {personOpeners({
              shared: sharedTags(myTags, c.profile.tags ?? []).map((t) => t.label),
              theirs: (c.profile.tags ?? []).map((t) => t.label),
              bothSessions: both.map((s) => s.title),
              key: c.id,
            }).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
      )}

      {c.state === 'pending-received' && (
        <section class="card stack" aria-labelledby="decide-heading">
          <h3 id="decide-heading">Connect with {name}?</h3>
          <p>Saying yes lets you send each other meetup invites. If you’d rather not, they’re never told.</p>
          {problem && (
            <p class="error" role="alert">
              {problem}
            </p>
          )}
          <div class="actions">
            <button type="button" class="button" onClick={() => void keepingFocus(approve)} disabled={busy || !relay}>
              {busy ? 'Connecting…' : 'Yes, connect'}
            </button>
            <button type="button" class="button secondary" onClick={() => void keepingFocus(() => dismiss('Request removed.'))}>
              Not now
            </button>
          </div>
        </section>
      )}

      {c.state === 'pending-sent' && (
        <section class="card stack" aria-labelledby="waiting-heading">
          <h3 id="waiting-heading">Waiting to hear back</h3>
          <p>They’ll show up as connected once they say yes. If they don’t, you won’t hear anything, and that’s fine.</p>
          <div class="actions">
            <button type="button" class="button secondary" onClick={() => dismiss('Request canceled.')}>
              Cancel request
            </button>
          </div>
        </section>
      )}

      {c.state === 'connected' && (
        <section class="stack" aria-labelledby="share-heading">
          <h3 id="share-heading">Sessions</h3>
          <label class="check">
            <input type="checkbox" checked={c.scheduleSharing} onChange={(e) => void toggleSharing(e.currentTarget.checked)} />
            <span>Let {name} see which sessions I’ve saved</span>
          </label>
          {theirIds.length === 0 && !c.demo && <p class="muted">{name} hasn’t shared their sessions with you.</p>}
          {both.length > 0 && (
            <>
              <p>
                You’re both going to {both.length === 1 ? 'this' : `these ${both.length}`}:
              </p>
              <ul class="both">
                {both.slice(0, 8).map((s) => (
                  <li key={s.id}>
                    {s.title} <span class="muted">· {dayLabel(s.start)} {timeRange(s.start, s.end)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      {c.state === 'connected' && <NotesSection connection={c} quickCapture={justConnected} />}

      {c.state === 'connected' && (
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
              <button type="button" class="button secondary" onClick={() => void keepingFocus(() => setConfirming(false))}>
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
      )}
    </section>
  );
}
