import { useEffect, useState } from 'preact/hooks';
import { extractCode, fitLink } from '../connect/payload';
import { QrCode } from '../connect/QrCode';
import { toSharedProfile } from '../model/profile';
import type { Intro, Profile } from '../model/types';
import { createSixDigitCode, hasKeys, INTRO_KEEP_MS, introPayload, newIntro } from '../relay/protocol';
import { RelayError, type Transport } from '../relay/transport';
import { canStoreCryptoKeys, getHome, getIntros, saveIntros } from '../storage/db';
import { splitAddress } from '../relay/address';
import { announce } from '../ui/announce';
import { useScreenHeading } from '../ui/useScreenHeading';

const REUSE_IF_MORE_THAN_MS = 2 * 60 * 60 * 1000;

/** Reuse a recent one-way code if it has a good while left; otherwise make a new one. */
async function currentIntro(relay: Transport, now = Date.now()): Promise<Intro> {
  // Intros from before codes carried keys can't open requests any more, so they are dropped here.
  const kept = (await getIntros()).filter((i) => hasKeys(i) && i.expiresAt + INTRO_KEEP_MS > now);
  let intro = kept.find((i) => i.expiresAt - now > REUSE_IF_MORE_THAN_MS);
  if (!intro) {
    const home = await getHome();
    intro = await newIntro(home, now, { exportable: !(await canStoreCryptoKeys()) });
    kept.push(intro);
    // Register its mailbox now, so requests can arrive. Fine if offline: the next sync does it.
    relay.register(home, [splitAddress(intro.mailboxId).box]).catch(() => {});
  }
  await saveIntros(kept.slice(-10));
  return intro;
}

interface Props {
  profile: Profile;
  relay: Transport;
  onDone: () => void;
}

export function ShareCodeScreen({ profile, relay, onDone }: Props) {
  const heading = useScreenHeading<HTMLHeadingElement>();
  const [link, setLink] = useState<string | null>(null);
  const [leftOut, setLeftOut] = useState<string[]>([]);
  const [expiresAt, setExpiresAt] = useState(0);
  const [six, setSix] = useState<{ code: string; expiresAt: number } | null>(null);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [makeFailed, setMakeFailed] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const intro = await currentIntro(relay);
        const fitted = await fitLink(introPayload(toSharedProfile(profile), intro), location.href);
        if (!live) return;
        setLink(fitted.link);
        setLeftOut(fitted.leftOut);
        setExpiresAt(intro.expiresAt);
      } catch {
        // Say so rather than "Making your code…" forever.
        if (live) setMakeFailed(true);
      }
    })();
    return () => {
      live = false;
    };
  }, [profile, relay]);

  useEffect(() => {
    if (!six) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [six]);

  const sixLeft = six ? Math.max(0, Math.ceil((six.expiresAt - now) / 1000)) : 0;
  useEffect(() => {
    if (six && sixLeft === 0) announce('Your six-digit code has expired. Get a new one if you need it.');
  }, [six, sixLeft === 0]);
  // One warning before it runs out (the limit is a security limit: a short-lived code is hard to guess).
  useEffect(() => {
    if (six && sixLeft === 20) announce('20 seconds left on your code. “New code” makes another.');
  }, [six, sixLeft === 20]);
  const leftSpoken = sixLeft >= 60 ? `${Math.floor(sixLeft / 60)} minute${sixLeft >= 120 ? 's' : ''} ${sixLeft % 60} seconds left` : `${sixLeft} seconds left`;

  async function getSix() {
    if (!link) return;
    setBusy(true);
    setProblem(null);
    try {
      const made = await createSixDigitCode(relay, extractCode(link));
      setSix(made);
      setNow(Date.now());
      announce(`Your code is ${made.code.split('').join(' ')}. It works once, for 2 minutes.`);
    } catch (e) {
      const msg =
        e instanceof RelayError && e.problem === 'offline'
          ? 'You seem to be offline. The QR code still works.'
          : e instanceof RelayError && e.problem === 'slow-down'
            ? 'That’s a lot of codes. Wait a few minutes and try again.'
            : 'Couldn’t make a code just now. The QR code still works.';
      setProblem(msg); // shown in a role=alert, which is read out: don't announce it twice
    } finally {
      setBusy(false);
    }
  }

  async function shareLink() {
    if (!link) return;
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Connect with me on Pebble', url: link });
        return;
      } catch (e) {
        if ((e as DOMException)?.name === 'AbortError') return; // they closed the share sheet
        // Sharing refused or broken here: fall through to copying.
      }
    }
    try {
      await navigator.clipboard.writeText(link);
      announce('Link copied.');
    } catch {
      announce('Couldn’t copy here. Select the link below and copy it.');
    }
  }

  const until = expiresAt ? new Date(expiresAt).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '';
  const pretty = six ? `${six.code.slice(0, 3)} ${six.code.slice(3)}` : '';

  return (
    <section class="stack" aria-labelledby="share-heading">
      <div>
        <h2 id="share-heading" ref={heading} tabIndex={-1}>
          Share
        </h2>
        <p>
          Anyone who scans this can see what you chose to share and send you a request. You decide whether to say yes. If you don’t, they’re never told.
        </p>
      </div>

      {link ? (
        <div class="stack">
          <div class="qr-wrap">
            <QrCode text={link} label={`Your share code. It works until ${until}.`} />
          </div>
          <p class="hint">Works until {until}.</p>
          {leftOut.length > 0 && <p class="hint">Left out to keep the code easy to scan: {leftOut.join(', ')}.</p>}
          <div class="actions">
            <button type="button" class="button secondary" onClick={shareLink}>
              {'share' in navigator ? 'Share link' : 'Copy link'}
            </button>
          </div>
          <details>
            <summary>Show the link</summary>
            <div class="stack details-body">
              <label class="label" for="share-link">
                Your link
              </label>
              <input id="share-link" type="text" readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
            </div>
          </details>
        </div>
      ) : makeFailed ? (
        <p class="error" role="alert">
          Couldn’t make your code on this device. Reload Pebble and try again.
        </p>
      ) : (
        <p class="muted">Making your code…</p>
      )}

      <section class="card stack" aria-labelledby="six-heading">
        <h3 id="six-heading">Or read out a code</h3>
        {six && sixLeft > 0 ? (
          <>
            <p class="six-code" aria-label={`Your code: ${six.code.split('').join(' ')}`}>
              {pretty}
            </p>
            <p class="hint">
              They type this in Pebble under “Enter a code”. Works once, for{' '}
              <span aria-hidden="true">
                {Math.floor(sixLeft / 60)}:{String(sixLeft % 60).padStart(2, '0')} more
              </span>
              <span class="visually-hidden">2 minutes, {leftSpoken}</span>.
            </p>
          </>
        ) : (
          <p>A six-digit code they can type in instead of scanning. It works once, for 2 minutes.</p>
        )}
        {problem && (
          <p class="error" role="alert">
            {problem}
          </p>
        )}
        <div class="actions">
          <button type="button" class="button secondary" onClick={getSix} disabled={busy || !link}>
            {busy ? 'Getting a code…' : six ? 'New code' : 'Get a six-digit code'}
          </button>
        </div>
      </section>

      <div class="actions">
        <button type="button" class="button quiet" onClick={onDone}>
          Done
        </button>
      </div>
    </section>
  );
}
