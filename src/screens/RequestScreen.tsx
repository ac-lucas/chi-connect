import { useState } from 'preact/hooks';
import type { ConnectPayload } from '../connect/payload';
import { toSharedProfile } from '../model/profile';
import type { Profile } from '../model/types';
import { sendRequest } from '../relay/protocol';
import { RelayError, type Transport } from '../relay/transport';
import { listConnections, putConnection } from '../storage/db';
import { announce } from '../ui/announce';
import { useScreenHeading } from '../ui/useScreenHeading';
import { ProfileCard } from './ProfileCard';
import { SharedTopics } from './SharedTopics';

interface Props {
  profile: Profile;
  theirs: ConnectPayload;
  relay: Transport;
  onSent: (connectionId: string) => void;
  onCancel: () => void;
}

/** Someone shared a one-way code (QR, link or six-digit code). Show who it is and offer to send a request. */
export function RequestScreen({ profile, theirs, relay, onSent, onCancel }: Props) {
  const heading = useScreenHeading<HTMLHeadingElement>();
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const name = theirs.profile.displayName;

  async function send() {
    setSending(true);
    setProblem(null);
    try {
      const existing = (await listConnections()).find((c) => c.theirNonce === theirs.nonce);
      if (existing) {
        onSent(existing.id);
        return;
      }
      const c = await sendRequest(relay, theirs, toSharedProfile(profile));
      await putConnection(c);
      announce(`Request sent to ${name}.`);
      onSent(c.id);
    } catch (e) {
      const offline = e instanceof RelayError && e.problem === 'offline';
      const msg = offline ? 'You seem to be offline. Try again when you have a connection.' : 'That didn’t go through. Try again in a moment.';
      setProblem(msg);
      announce(msg);
      setSending(false);
    }
  }

  return (
    <section class="stack" aria-labelledby="request-heading">
      <h2 id="request-heading" ref={heading} tabIndex={-1}>
        Connect with {name}?
      </h2>
      <ProfileCard profile={theirs.profile} />
      <SharedTopics mine={profile.tags} theirs={theirs.profile.tags} name={name} />
      <p>
        If you send a request, {name} sees your profile and can say yes. If they don’t, nothing happens and nobody is
        told.
      </p>
      {problem && (
        <p class="error" role="alert">
          {problem}
        </p>
      )}
      <div class="actions">
        <button type="button" class="button" onClick={send} disabled={sending}>
          {sending ? 'Sending…' : 'Send a request'}
        </button>
        <button type="button" class="button secondary" onClick={onCancel}>
          Not now
        </button>
      </div>
    </section>
  );
}
