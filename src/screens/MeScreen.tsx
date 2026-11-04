import { useEffect, useState } from 'preact/hooks';
import { toSharedProfile } from '../model/profile';
import type { Profile } from '../model/types';
import { getSetting, listCatchUp, setSetting } from '../storage/db';
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

      <p class="hint">Stored only on this device. No account, no sign-in.</p>
    </section>
  );
}
