import { useEffect, useRef, useState } from 'preact/hooks';
import { toSharedProfile } from '../model/profile';
import type { Profile } from '../model/types';
import { getSetting, listCatchUp, setSetting, wipeEverything } from '../storage/db';
import { announce } from '../ui/announce';
import { useScreenHeading } from '../ui/useScreenHeading';
import { ProfileCard } from './ProfileCard';

interface Props {
  profile: Profile;
  onEdit: () => void;
  onCatchUp: () => void;
  onRecap: () => void;
}

export function MeScreen({ profile, onEdit, onCatchUp, onRecap }: Props) {
  const heading = useScreenHeading<HTMLHeadingElement>();
  const [quiet, setQuiet] = useState(false);
  const [snoozeUntil, setSnoozeUntil] = useState(0);
  const [catchUp, setCatchUp] = useState(0);
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [wiping, setWiping] = useState(false);
  const [wipeFailed, setWipeFailed] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const wipeOpener = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (confirmWipe) confirmRef.current?.focus();
  }, [confirmWipe]);

  async function wipe() {
    setWiping(true);
    setWipeFailed(false);
    try {
      await wipeEverything();
      announce('Everything is deleted. Starting fresh.');
      location.reload();
    } catch {
      setWiping(false);
      setWipeFailed(true);
      announce('Couldn’t delete everything. Close Pebble in other tabs or windows, then try again.');
    }
  }

  useEffect(() => {
    void (async () => {
      setQuiet(!!(await getSetting('quietMode')));
      setSnoozeUntil((await getSetting('snoozeUntil')) ?? 0);
      setCatchUp((await listCatchUp()).length);
    })();
  }, []);

  async function toggleQuiet(on: boolean) {
    await setSetting('quietMode', on);
    setQuiet(on);
    announce(on ? 'Quiet mode on. No nudges or suggestions.' : 'Quiet mode off.');
  }
  async function unsnooze() {
    await setSetting('snoozeUntil', 0);
    setSnoozeUntil(0);
    announce('Nudges are back on.');
  }

  const snoozed = snoozeUntil > Date.now();

  return (
    <section class="stack" aria-labelledby="me-heading">
      <h2 id="me-heading" ref={heading} tabIndex={-1}>
        You
      </h2>
      <section class="stack" aria-labelledby="me-preview">
        <h3 id="me-preview">What people see when you connect</h3>
        <ProfileCard profile={toSharedProfile(profile)} />
      </section>
      <div class="actions">
        <button type="button" class="button" onClick={onEdit}>
          Edit profile
        </button>
      </div>

      <section class="stack" aria-labelledby="me-week">
        <h3 id="me-week">Your week</h3>
        <div class="actions">
          <button type="button" class="button secondary" onClick={onRecap}>
            Your week and follow-ups
          </button>
          <button type="button" class="button secondary" onClick={onCatchUp}>
            Catch up later{catchUp ? ` (${catchUp})` : ''}
          </button>
        </div>
      </section>

      <section class="stack" aria-labelledby="me-nudges">
        <h3 id="me-nudges">Nudges</h3>
        <label class="check">
          <input type="checkbox" checked={quiet} onChange={(e) => void toggleQuiet(e.currentTarget.checked)} />
          <span>
            <strong>Quiet mode</strong>: no nudges, wildcards or icebreakers. Invites still arrive.
          </span>
        </label>
        {snoozed && (
          <p>
            Snoozed until {new Date(snoozeUntil).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}.{' '}
            <button type="button" class="button quiet inline" onClick={() => void unsnooze()}>
              Turn back on
            </button>
          </p>
        )}
        <p class="hint">How many you get follows today’s energy: fewer when Steady, more when Charged.</p>
      </section>

      <section class="stack" aria-labelledby="me-data">
        <h3 id="me-data">Your data</h3>
        <p class="hint">Stored only on this device. No account, no sign-in.</p>
        {confirmWipe ? (
          <div class="card stack" role="group" aria-labelledby="wipe-q">
            <p id="wipe-q">
              Delete your profile, people, notes, follow-ups, day plan and invites from this phone? This can’t be undone.
              Nobody is told. Anything waiting for you on the relay is encrypted and deletes itself within a day.
            </p>
            {wipeFailed && (
              <p class="error">Couldn’t delete everything. Close Pebble in other tabs or windows, then try again.</p>
            )}
            <div class="actions">
              <button type="button" class="button danger" ref={confirmRef} onClick={() => void wipe()} disabled={wiping}>
                {wiping ? 'Deleting…' : 'Delete everything'}
              </button>
              <button
                type="button"
                class="button secondary"
                onClick={() => {
                  setConfirmWipe(false);
                  setTimeout(() => wipeOpener.current?.focus(), 0);
                }}
              >
                Keep it
              </button>
            </div>
          </div>
        ) : (
          <div class="actions">
            <button type="button" class="button quiet" ref={wipeOpener} onClick={() => setConfirmWipe(true)}>
              Delete everything on this phone
            </button>
          </div>
        )}
      </section>
    </section>
  );
}
