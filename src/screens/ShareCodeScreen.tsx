import { useEffect, useState } from 'preact/hooks';
import { extractCode, fitLink } from '../connect/payload';
import { QrCode } from '../connect/QrCode';
import { toSharedProfile } from '../model/profile';
import type { Intro, Profile } from '../model/types';
import { createSixDigitCode, INTRO_KEEP_MS, introPayload, newIntro } from '../relay/protocol';
import { RelayError, type Transport } from '../relay/transport';
import { getIntros, saveIntros } from '../storage/db';
import { announce } from '../ui/announce';
import { useScreenHeading } from '../ui/useScreenHeading';

const REUSE_IF_MORE_THAN_MS = 2 * 60 * 60 * 1000;

/** Reuse a recent one-way code if it has a good while left; otherwise make a new one. */
async function currentIntro(relay: Transport, now = Date.now()): Promise<Intro> {
  const kept = (await getIntros()).filter((i) => i.expiresAt + INTRO_KEEP_MS > now);
  let intro = kept.find((i) => i.expiresAt - now > REUSE_IF_MORE_THAN_MS);
  if (!intro) {
    intro = newIntro(now);
    kept.push(intro);
    // Claim the mailbox now so nobody else can, before any request arrives. Fine if offline: the first sync claims it.
    relay.claim({ id: intro.mailboxId, token: intro.mailboxToken }).catch(() => {});
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

  useEffect(() => {
    let live = true;
    void (async () => {
      const intro = await currentIntro(relay);
      const fitted = await fitLink(introPayload(toSharedProfile(profile), intro), location.href);
      if (!live) return;
      setLink(fitted.link);
      setLeftOut(fitted.leftOut);
      setExpiresAt(intro.expiresAt);
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
      setProblem(msg);
      announce(msg);
    } finally {
      setBusy(false);
    }
  }

  async function shareLink() {
    if (!link) return;
    try {
      if (navigator.share) await navigator.share({ title: 'Connect with me on Pebble', url: link });
      else {
        await navigator.clipboard.writeText(link);
        announce('Link copied.');
      }
    } catch {
      // Share sheet closed, or copying blocked. Nothing to do.
    }
  }

  const until = expiresAt ? new Date(expiresAt).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '';
  const pretty = six ? `${six.code.slice(0, 3)} ${six.code.slice(3)}` : '';

  return (
    <section class="stack" aria-labelledby="share-heading">
      <div>
        <h2 id="share-heading" ref={heading} tabIndex={-1}>
          Share your code
        </h2>
        <p>
          Anyone who scans this can send you a request. You decide whether to say yes. If you don’t, they’re never told.
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
        </div>
      ) : (
        <p class="muted">Making your code…</p>
      )}

      <section class="card stack" aria-labelledby="six-heading">
        <h3 id="six-heading">No camera handy?</h3>
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
              <span class="visually-hidden">2 minutes</span>.
            </p>
          </>
        ) : (
          <p>Get a six-digit code they can type in instead. It works once, for 2 minutes.</p>
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
