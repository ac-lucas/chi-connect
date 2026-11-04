import { useEffect, useState } from 'preact/hooks';
import { PLACES, PLACE_TYPE_LABELS } from '../data/places';
import { LIMITS_INVITE } from '../relay/invites';
import { cleanText } from '../model/text';
import type { Connection, InviteKind, MeetingSpot } from '../model/types';
import { timeRange, timeRangeSpoken } from '../programme/programme';
import { KIND_INFO, sendInvite } from '../schedule/invites';
import type { Transport } from '../relay/transport';
import { listConnections } from '../storage/db';
import { announce } from '../ui/announce';
import { useScreenHeading } from '../ui/useScreenHeading';
import { SpotPicker } from './SpotPicker';

export interface InviteDraft {
  /** Kinds offered: break kinds for a gap, side-by-side kinds for a session. */
  kinds: InviteKind[];
  start: number;
  end: number;
  sessionId?: string;
  sessionTitle?: string;
  /** For sessions, the room. */
  room?: string;
  /** People to tick to start with (for example, connections who saved the same session). */
  preselect?: string[];
}

interface Props {
  me: string;
  draft: InviteDraft;
  relay: Transport | null;
  onSent: () => void;
  onCancel: () => void;
}

const ARRIVE_EARLY_MS = 5 * 60_000;

export function InviteScreen({ me, draft, relay, onSent, onCancel }: Props) {
  const heading = useScreenHeading<HTMLHeadingElement>();
  const [people, setPeople] = useState<Connection[]>([]);
  const [kind, setKind] = useState<InviteKind>(draft.kinds[0]!);
  const [chosen, setChosen] = useState<Set<string>>(new Set(draft.preselect ?? []));
  const [confirmAll, setConfirmAll] = useState(false);
  const [placeId, setPlaceId] = useState<string>(draft.room ? 'room' : (PLACES[0]?.id ?? 'own'));
  const [ownPlace, setOwnPlace] = useState('');
  const [spot, setSpot] = useState<MeetingSpot | undefined>(undefined);
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    void listConnections().then((all) => setPeople(all.filter((c) => c.state === 'connected').sort((a, b) => Number(a.demo) - Number(b.demo))));
  }, []);

  const isSession = !!draft.sessionId;
  // Arriving together means meeting just before the session starts.
  const start = kind === 'arrive-together' ? draft.start - ARRIVE_EARLY_MS : draft.start;
  const end = kind === 'arrive-together' ? draft.start : draft.end;
  const place =
    placeId === 'room' ? draft.room : placeId === 'own' ? cleanText(ownPlace, LIMITS_INVITE.place) || undefined : PLACES.find((p) => p.id === placeId)?.name;

  const toggle = (id: string) =>
    setChosen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  async function send(e: Event) {
    e.preventDefault();
    if (chosen.size === 0) {
      setProblem('Pick at least one person.');
      return;
    }
    if (chosen.size === people.length && people.length > 1 && !confirmAll) {
      setConfirmAll(true);
      return;
    }
    setSending(true);
    setProblem(null);
    const recipients = people.filter((p) => chosen.has(p.id));
    const { failed } = await sendInvite(
      relay,
      me,
      recipients,
      { kind, start, end, place, spot, note: cleanText(note, LIMITS_INVITE.note) || undefined, sessionId: draft.sessionId, sessionTitle: draft.sessionTitle },
      (who) => announce(`${who.profile.displayName} said yes (simulated).`),
    );
    setSending(false);
    if (failed.length) {
      const msg = `Sent, but it didn’t reach ${failed.map((f) => f.profile.displayName).join(', ')}. You might be offline.`;
      announce(msg);
      setProblem(msg);
      return;
    }
    announce(`Invite sent to ${recipients.length === 1 ? recipients[0]!.profile.displayName : `${recipients.length} people`}.`);
    onSent();
  }

  return (
    <form class="stack" onSubmit={send} aria-labelledby="invite-heading" noValidate>
      <div>
        <h2 id="invite-heading" ref={heading} tabIndex={-1}>
          Invite someone
        </h2>
        <p class="muted">
          <span aria-hidden="true">{timeRange(start, end)}</span>
          <span class="visually-hidden">{timeRangeSpoken(start, end)}</span>
          {draft.sessionTitle && ` · ${draft.sessionTitle}`}
        </p>
      </div>

      {draft.kinds.length > 1 && (
        <fieldset>
          <legend>What kind?</legend>
          {draft.kinds.map((k) => (
            <label key={k} class="check">
              <input type="radio" name="invite-kind" checked={kind === k} onChange={() => setKind(k)} />
              <span>
                <strong>{KIND_INFO[k].label}</strong>: {KIND_INFO[k].line({ sessionTitle: draft.sessionTitle, place })}
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {draft.kinds.length === 1 && <p>{KIND_INFO[kind].line({ sessionTitle: draft.sessionTitle, place })}</p>}

      <fieldset class="stack">
        <legend>Who?</legend>
        {people.length === 0 ? (
          <p class="muted">Nobody to invite yet. Connect with someone first.</p>
        ) : (
          <>
            <div class="actions">
              <button type="button" class="button quiet" onClick={() => setChosen(chosen.size === people.length ? new Set() : new Set(people.map((p) => p.id)))}>
                {chosen.size === people.length ? 'Clear' : `Everyone (${people.length})`}
              </button>
            </div>
            {people.map((p) => (
              <label key={p.id} class="check">
                <input type="checkbox" checked={chosen.has(p.id)} onChange={() => toggle(p.id)} />
                <span>
                  {p.profile.displayName}
                  {p.demo && <span class="badge">Demo</span>}
                </span>
              </label>
            ))}
          </>
        )}
      </fieldset>

      {!isSession || kind !== 'sit-together' ? (
        <fieldset class="stack">
          <legend>Where?</legend>
          {draft.room && (
            <label class="check">
              <input type="radio" name="place" checked={placeId === 'room'} onChange={() => setPlaceId('room')} />
              {draft.room}
            </label>
          )}
          {PLACES.map((p) => (
            <label key={p.id} class="check">
              <input type="radio" name="place" checked={placeId === p.id} onChange={() => setPlaceId(p.id)} />
              <span>
                {p.name} <span class="muted">· {PLACE_TYPE_LABELS[p.type]}{p.quiet ? ', quiet' : ''}{p.stepFree ? ', step-free' : ''}</span>
              </span>
            </label>
          ))}
          <label class="check">
            <input type="radio" name="place" checked={placeId === 'own'} onChange={() => setPlaceId('own')} />
            Somewhere else
          </label>
          {placeId === 'own' && (
            <div class="field">
              <label for="own-place">Where?</label>
              <input id="own-place" type="text" maxLength={LIMITS_INVITE.place} value={ownPlace} onInput={(e) => setOwnPlace(e.currentTarget.value)} />
            </div>
          )}
        </fieldset>
      ) : (
        <p class="muted">In {draft.room ?? 'the session room'}.</p>
      )}

      <SpotPicker value={spot} onChange={setSpot} />

      <div class="field">
        <label for="invite-note">A note (optional)</label>
        <input id="invite-note" type="text" maxLength={LIMITS_INVITE.note} value={note} onInput={(e) => setNote(e.currentTarget.value)} />
      </div>

      <p class="hint">
        Everyone who says yes gets the same shape to hold up, so you can spot each other in a crowd. They see this and can say yes.
        If they don’t, you won’t be told, and that’s fine.
      </p>

      {confirmAll && (
        <p class="card" role="alert">
          This goes to all {people.length} of your people. Tap Send again to confirm.
        </p>
      )}
      {problem && (
        <p class="error" role="alert">
          {problem}
        </p>
      )}

      <div class="actions">
        <button type="submit" class="button" disabled={sending || people.length === 0}>
          {sending ? 'Sending…' : 'Send'}
        </button>
        <button type="button" class="button secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
