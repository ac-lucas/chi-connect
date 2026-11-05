import { useState } from 'preact/hooks';
import type { ConnectPayload } from '../connect/payload';
import { redeemSixDigitCode } from '../relay/protocol';
import { RelayError, type Transport } from '../relay/transport';
import { announce } from '../ui/announce';
import { useScreenHeading } from '../ui/useScreenHeading';

interface Props {
  relay: Transport;
  onFound: (theirs: ConnectPayload) => void;
  onCancel: () => void;
}

export function EnterCodeScreen({ relay, onFound, onCancel }: Props) {
  const heading = useScreenHeading<HTMLHeadingElement>();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const digits = value.replace(/\D/g, '').slice(0, 6);

  async function submit(e: Event) {
    e.preventDefault();
    if (digits.length !== 6) {
      setProblem('Codes have six digits.');
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const theirs = await redeemSixDigitCode(relay, digits);
      if (theirs) {
        onFound(theirs);
        return;
      }
      const msg = 'That code didn’t work. Codes work once, for 2 minutes. Ask them for a new one.';
      setProblem(msg); // shown in a role=alert, which is read out: don't announce it twice
    } catch (err) {
      const msg =
        err instanceof RelayError && err.problem === 'offline'
          ? 'You seem to be offline. Try again when you have a connection.'
          : err instanceof RelayError && err.problem === 'slow-down'
            ? 'Too many tries. Wait a few minutes, then try again.'
            : 'Something went wrong. Try again in a moment.';
      setProblem(msg); // shown in a role=alert, which is read out: don't announce it twice
    } finally {
      setBusy(false);
    }
  }

  return (
    <form class="stack" onSubmit={submit} noValidate aria-labelledby="enter-heading">
      <div>
        <h2 id="enter-heading" ref={heading} tabIndex={-1}>
          Enter a code
        </h2>
        <p>Ask them to open “Share your code” and get a six-digit code.</p>
      </div>
      <div class="field">
        <label for="six">Six-digit code</label>
        <input
          id="six"
          class="six-input"
          type="text"
          inputMode="numeric"
          autocomplete="one-time-code"
          pattern="[0-9]*"
          maxLength={7}
          value={value}
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? 'six-error' : undefined}
          onInput={(e) => setValue(e.currentTarget.value)}
        />
        {problem && (
          <p id="six-error" class="error" role="alert">
            {problem}
          </p>
        )}
      </div>
      <div class="actions">
        <button type="submit" class="button" disabled={busy}>
          {busy ? 'Checking…' : 'Find them'}
        </button>
        <button type="button" class="button secondary" onClick={onCancel}>
          Not now
        </button>
      </div>
    </form>
  );
}
