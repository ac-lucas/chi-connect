import { useState } from 'preact/hooks';
import type { Connection, Invite, ScheduleItem } from '../model/types';
import { overlaps, timeRange, timeRangeSpoken } from '../programme/programme';
import { describeSpot } from '../schedule/spot';
import { acceptInvite, declineInvite, KIND_INFO, simulateIncoming } from '../schedule/invites';
import type { Transport } from '../relay/transport';
import type { PlannedBreak } from '../schedule/breaks';
import { announce } from '../ui/announce';
import { keepingFocus } from '../ui/focus';
import { ShapeBadge } from './ShapeCard';

interface Props {
  invites: Invite[];
  connections: Connection[];
  items: ScheduleItem[];
  relay: Transport | null;
  /** Set while protected time or a Focus session is running: new invites wait until it ends. */
  heldUntil: number | null;
  /** Where a simulated invite can go (the next suggested break today). */
  nextBreak: PlannedBreak | null;
  onChanged: () => void;
}

const clock = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/** Incoming invites with Yes and Not now. Answering no tells nobody. */
export function InvitesPanel({ invites, connections, items, relay, heldUntil, nextBreak, onChanged }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const demo = connections.filter((c) => c.demo && c.state === 'connected');

  if (heldUntil !== null && invites.length) {
    return (
      <p class="card hint" role="status">
        {invites.length === 1 ? 'Something is' : `${invites.length} things are`} waiting for you after {clock(heldUntil)}.
      </p>
    );
  }

  async function yes(i: Invite) {
    setBusy(i.id);
    setProblem(null);
    try {
      await acceptInvite(relay, i);
      announce(`Added: ${KIND_INFO[i.kind].label} with ${i.senderName}, ${timeRangeSpoken(i.start, i.end)}${i.place ? `, ${i.place}` : ''}.`);
      onChanged();
    } catch {
      const msg = 'That didn’t go through. You might be offline. Try again in a moment.';
      setProblem(msg); // shown in a role=alert, which is read out: don't announce it twice
    } finally {
      setBusy(null);
    }
  }

  async function no(i: Invite) {
    await declineInvite(i);
    announce('Removed. Nobody is told.');
    onChanged();
  }

  async function simulate() {
    const from = demo[Math.floor(Math.random() * demo.length)]!;
    const start = nextBreak ? nextBreak.start : Math.ceil((Date.now() + 30 * 60_000) / (15 * 60_000)) * 15 * 60_000;
    const end = nextBreak ? nextBreak.end : start + 30 * 60_000;
    const meal = nextBreak?.kind === 'meal';
    await simulateIncoming(from, {
      kind: meal ? 'meal' : 'break-together',
      start,
      end,
      place: meal ? 'Lunch hall' : 'Courtyard benches',
      spot: meal ? undefined : { side: 'left', byDoor: true },
    });
    announce(`Simulated invite from ${from.profile.displayName}.`);
    onChanged();
  }

  return (
    <section class="stack" aria-labelledby={invites.length > 0 ? 'invites-heading' : undefined} aria-label={invites.length > 0 ? undefined : 'Invites'}>
      {invites.length > 0 && <h3 id="invites-heading">Invites ({invites.length})</h3>}
      {invites.map((i) => {
        const clash = items.find((s) => s.type === 'session' && overlaps(s, i));
        const spot = describeSpot(i.meetingSpot);
        return (
          <article key={i.id} data-row class="card stack invite" aria-labelledby={`inv-${i.id}`}>
            <div>
              <h4 id={`inv-${i.id}`} class="invite-title">
                <span aria-hidden="true">{KIND_INFO[i.kind].glyph} </span>
                {KIND_INFO[i.kind].label} with {i.senderName}
                {i.simulated && <span class="badge"><span class="visually-hidden">, </span>Simulated</span>}
              </h4>
              <p class="day-time">
                <span aria-hidden="true">{timeRange(i.start, i.end)}</span>
                <span class="visually-hidden">{timeRangeSpoken(i.start, i.end)}</span>
              </p>
            </div>
            <p>{KIND_INFO[i.kind].line({ sessionTitle: i.sessionTitle, place: i.place })}</p>
            {i.place && i.kind !== 'meal' && <p>Where: {i.place}</p>}
            {spot && <p>Spot: {spot}</p>}
            {i.note && <p class="invite-note">“{i.note}”</p>}
            <p class="shape-line">
              Say yes and you’ll both get <ShapeBadge seedKey={i.id} /> to hold up and find each other.
            </p>
            {clash && <p class="hint">Heads-up: overlaps {clash.title}.</p>}
            <div class="actions">
              <button type="button" class="button" disabled={busy === i.id} aria-describedby={`inv-${i.id}`} onClick={() => void keepingFocus(() => yes(i))}>
                Yes
              </button>
              <button type="button" class="button secondary" aria-describedby={`inv-${i.id}`} onClick={() => void keepingFocus(() => no(i))}>
                Not now
              </button>
            </div>
          </article>
        );
      })}
      {problem && (
        <p class="error" role="alert">
          {problem}
        </p>
      )}
      {invites.length === 0 && demo.length > 0 && (
        <div data-row class="card stack try-it">
          <p>
            <strong>Trying this on your own?</strong> See what it’s like to get an invite.
          </p>
          <div class="actions">
            <button type="button" class="button secondary" onClick={() => void simulate()}>
              Simulate an invite from a demo person
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
