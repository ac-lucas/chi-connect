import { lazy, Suspense } from 'preact/compat';
import { CloseButton } from '../ui/CloseButton';
import { useRef, useState } from 'preact/hooks';
import { decodeCode, DecodeError, type ConnectPayload } from '../connect/payload';
import { redeemSixDigitCode } from '../relay/protocol';
import { RelayError, type Transport } from '../relay/transport';
import { announce } from '../ui/announce';
import { useScreenHeading } from '../ui/useScreenHeading';

// The camera scanner (and jsQR) loads only when someone chooses to scan.
const QrScanner = lazy(() => import('../connect/QrScanner').then((m) => ({ default: m.QrScanner })));

const SCAN_PROBLEMS: Record<string, string> = {
  expired: 'That code has expired. Ask them to open Share again.',
  'newer-version': 'Their app is a newer version. Reload this page and try again.',
  'older-version': 'Their app needs an update. Ask them to reload Pebble, then share again.',
  'face-to-face': 'That’s an older kind of code. Ask them to open Share.',
};

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
  const [scanning, setScanning] = useState(false);
  const [scanProblem, setScanProblem] = useState<string | null>(null);
  const lastBad = useRef<string | null>(null);
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

  async function scanned(text: string): Promise<boolean> {
    if (text === lastBad.current) return false; // same bad code still in view: stay quiet
    try {
      const p = await decodeCode(text);
      if (p.mode === 'f') throw new Error('face-to-face');
      onFound(p);
      return true;
    } catch (e) {
      lastBad.current = text;
      const key = e instanceof DecodeError ? e.problem : (e as Error).message;
      setScanProblem(SCAN_PROBLEMS[key] ?? 'That isn’t a Pebble code. Ask them to open Share.'); // role=alert: read once
      return false;
    }
  }

  return (
    <form class="stack" onSubmit={submit} noValidate aria-labelledby="enter-heading">
      <CloseButton onClick={onCancel} />
      <div>
        <h2 id="enter-heading" ref={heading} tabIndex={-1}>
          Enter a code
        </h2>
        <p>Ask them to tap Share. Then scan their QR code, or type the six digits they read out.</p>
      </div>
      <section class="stack" aria-label="Scan their code">
        {scanning ? (
          <>
            <Suspense fallback={<p class="muted">Starting the camera…</p>}>
              <QrScanner onResult={scanned} />
            </Suspense>
            {scanProblem && (
              <p class="error" role="alert">
                {scanProblem}
              </p>
            )}
            <div class="actions">
              <button type="button" class="button secondary" onClick={() => setScanning(false)}>
                Stop scanning
              </button>
            </div>
          </>
        ) : (
          <div class="actions">
            <button type="button" class="button" onClick={() => setScanning(true)}>
              Scan their QR code
            </button>
          </div>
        )}
      </section>
      <div class="field">
        <label for="six">Or type their six-digit code</label>
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
        <button type="submit" class="button secondary" disabled={busy}>
          {busy ? 'Checking…' : 'Find them'}
        </button>
        <button type="button" class="button quiet" onClick={onCancel}>
          Not now
        </button>
      </div>
    </form>
  );
}
