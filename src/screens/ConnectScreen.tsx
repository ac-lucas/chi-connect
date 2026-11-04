import { useEffect, useRef, useState } from 'preact/hooks';
import { hasWebCrypto, matchWord, pairSecret, type MatchWord } from '../connect/pairing';
import { decodeCode, DecodeError, FACE_TO_FACE_TTL_MS, fitLink, type ConnectPayload, type DecodeProblem } from '../connect/payload';
import { QrCode } from '../connect/QrCode';
import { QrScanner } from '../connect/QrScanner';
import { randomId } from '../model/ids';
import { toSharedProfile } from '../model/profile';
import type { Connection, Profile } from '../model/types';
import { putConnection } from '../storage/db';
import { announce } from '../ui/announce';
import { useScreenHeading } from '../ui/useScreenHeading';
import { ProfileCard } from './ProfileCard';
import { SharedTopics } from './SharedTopics';

interface Props {
  profile: Profile;
  /** A code that arrived in the page link (someone scanned ours with their phone camera). */
  initialCode?: string;
  onConnected: (connectionId: string) => void;
  onCancel: () => void;
}

interface Mine {
  payload: ConnectPayload;
  link: string;
  leftOut: string[];
}

const PROBLEMS: Record<DecodeProblem | 'own' | 'regular', string> = {
  'too-long': 'That isn’t a Pebble code.',
  'not-a-code': 'That isn’t a Pebble code.',
  unreadable: 'Couldn’t read that code. Ask them to open a fresh one.',
  'newer-version': 'Their app is a newer version. Reload this page and try again.',
  expired: 'That code has expired. Ask them to open a fresh one.',
  own: 'That’s your own code. Scan theirs instead.',
  regular: 'That code is for connecting at a distance, which isn’t switched on yet. Try face to face.',
};

function appBase(): string {
  return location.href.split('#')[0]!;
}

export function ConnectScreen({ profile, initialCode, onConnected, onCancel }: Props) {
  const heading = useScreenHeading<HTMLHeadingElement>();
  const [mine, setMine] = useState<Mine | null>(null);
  const [view, setView] = useState<'show' | 'scan'>('show');
  const [theirs, setTheirs] = useState<ConnectPayload | null>(null);
  const [match, setMatch] = useState<MatchWord | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [pasted, setPasted] = useState('');
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const lastBad = useRef<string | null>(null);
  const theirsRef = useRef<ConnectPayload | null>(null);
  theirsRef.current = theirs;
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const cryptoOk = hasWebCrypto();

  // Make a fresh code, and replace it shortly before it expires.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    async function make() {
      const payload: ConnectPayload = {
        mode: 'f',
        nonce: randomId(),
        mailboxId: randomId(),
        expiresAt: Date.now() + FACE_TO_FACE_TTL_MS,
        profile: toSharedProfile(profile),
      };
      setMine(await fitLink(payload, appBase()));
      timer = setTimeout(() => {
        // Only refresh if we haven't read theirs yet; otherwise the match word would change under them.
        if (!theirsRef.current) void make();
      }, FACE_TO_FACE_TTL_MS - 30_000);
    }
    void make();
    return () => clearTimeout(timer);
  }, [profile]);

  async function accept(text: string): Promise<boolean> {
    if (!mine) return false;
    if (text === lastBad.current) return false; // same bad code still in view: stay quiet
    try {
      const p = await decodeCode(text);
      if (p.nonce === mine.payload.nonce) throw new Error('own');
      if (p.mode !== 'f') throw new Error('regular');
      lastBad.current = null;
      setProblem(null);
      setTheirs(p);
      setMatch(await matchWord(mine.payload.nonce, p.nonce));
      announce(`Got ${p.profile.displayName}’s code.`);
      setTimeout(() => resultHeading.current?.focus(), 0);
      return true;
    } catch (e) {
      lastBad.current = text;
      const key = e instanceof DecodeError ? e.problem : (e as Error).message;
      const msg = PROBLEMS[key as keyof typeof PROBLEMS] ?? PROBLEMS.unreadable;
      setProblem(msg);
      announce(msg);
      return false;
    }
  }

  // A code that came in through the page link: read it as soon as our own code exists.
  const usedInitial = useRef(false);
  useEffect(() => {
    if (initialCode && mine && !usedInitial.current) {
      usedInitial.current = true;
      void accept(initialCode);
    }
  }, [initialCode, mine]);

  async function connect() {
    if (!mine || !theirs) return;
    setSaving(true);
    try {
      const c: Connection = {
        id: randomId(),
        profile: theirs.profile,
        state: 'connected',
        connectedAt: Date.now(),
        mailboxId: theirs.mailboxId,
        myMailboxId: mine.payload.mailboxId,
        via: 'face-to-face',
        sharedSecret: await pairSecret(mine.payload.nonce, theirs.nonce),
        scheduleSharing: false,
        sharedSessionIds: [],
        demo: false,
      };
      await putConnection(c);
      announce(`You’re connected with ${theirs.profile.displayName}.`);
      onConnected(c.id);
    } catch {
      announce('That didn’t save. Try again.');
      setSaving(false);
    }
  }

  function startOver() {
    setTheirs(null);
    setMatch(null);
    setView('scan');
    lastBad.current = null;
  }

  async function copyLink() {
    if (!mine) return;
    try {
      await navigator.clipboard.writeText(mine.link);
      setCopied(true);
      announce('Link copied.');
    } catch {
      announce('Couldn’t copy. Select the link and copy it instead.');
    }
  }

  const minutes = Math.round(FACE_TO_FACE_TTL_MS / 60_000);

  const myCode = mine && (
    <div class="stack">
      <div class="qr-wrap">
        <QrCode text={mine.link} label={`Your connect code. It works for ${minutes} minutes.`} />
      </div>
      <p class="hint">Works for {minutes} minutes. Holds only what you chose to share, plus a one-time pairing number.</p>
      {mine.leftOut.length > 0 && (
        <p class="hint">
          Left out to keep the code easy to scan: {mine.leftOut.join(', ')}. You can share those once you’re connected.
        </p>
      )}
      <details>
        <summary>Can’t scan? Share it as a link</summary>
        <div class="stack details-body">
          <label class="label" for="my-link">
            Your link
          </label>
          <input id="my-link" type="text" readOnly value={mine.link} onFocus={(e) => e.currentTarget.select()} />
          {'clipboard' in navigator && (
            <button type="button" class="button secondary" onClick={copyLink}>
              {copied ? 'Copied' : 'Copy link'}
            </button>
          )}
        </div>
      </details>
    </div>
  );

  return (
    <section class="stack" aria-labelledby="connect-heading">
      <div>
        <h2 id="connect-heading" ref={heading} tabIndex={-1}>
          Connect face to face
        </h2>
        {!theirs && (
          <p>
            You scan theirs, they scan yours. Order doesn’t matter. Then check both screens show the same word.
          </p>
        )}
      </div>

      {!cryptoOk && (
        <p class="error" role="alert">
          Connecting needs a secure connection. Open Pebble from its https address.
        </p>
      )}

      {theirs && match ? (
        <>
          <section class="card stack" aria-labelledby="result-heading">
            <h3 id="result-heading" ref={resultHeading} tabIndex={-1}>
              Got {theirs.profile.displayName}’s code
            </h3>
            <ProfileCard profile={theirs.profile} />
            <SharedTopics mine={profile.tags} theirs={theirs.profile.tags} name={theirs.profile.displayName} />
          </section>

          <section class="card stack match" aria-labelledby="match-heading">
            <h3 id="match-heading">Your match word</h3>
            <p class="match-word">
              <span class="match-glyph" aria-hidden="true">
                {match.glyph}
              </span>{' '}
              {match.text}
            </p>
            <p>
              Once they’ve scanned your code too, their screen shows the same word. Same word on both? You’re connected.
            </p>
            <div class="actions">
              <button type="button" class="button" onClick={connect} disabled={saving}>
                {saving ? 'Connecting…' : 'Same word. Connect'}
              </button>
              <button type="button" class="button secondary" onClick={startOver}>
                Different word
              </button>
            </div>
          </section>

          <section class="stack" aria-labelledby="still-show">
            <h3 id="still-show">Haven’t been scanned yet?</h3>
            <p class="hint">Hold this up for {theirs.profile.displayName}.</p>
            {myCode}
          </section>
        </>
      ) : (
        <>
          <div class="segmented" role="group" aria-label="Connect step">
            <button type="button" aria-pressed={view === 'show'} onClick={() => setView('show')}>
              Show my code
            </button>
            <button type="button" aria-pressed={view === 'scan'} onClick={() => setView('scan')}>
              Scan theirs
            </button>
          </div>

          {problem && (
            <p class="error" role="alert">
              {problem}
            </p>
          )}

          {view === 'show' ? (
            myCode ?? <p class="muted">Making your code…</p>
          ) : (
            <div class="stack">
              {cryptoOk && <QrScanner onResult={accept} />}
              <form
                class="stack"
                onSubmit={(e) => {
                  e.preventDefault();
                  lastBad.current = null;
                  void accept(pasted);
                }}
              >
                <div class="field">
                  <label for="paste-link">Or paste their link</label>
                  <input id="paste-link" type="text" inputMode="url" autocomplete="off" value={pasted} onInput={(e) => setPasted(e.currentTarget.value)} />
                </div>
                <button type="submit" class="button secondary" disabled={!pasted.trim()}>
                  Use this link
                </button>
              </form>
            </div>
          )}
        </>
      )}

      <div class="actions">
        <button type="button" class="button quiet" onClick={onCancel}>
          Not now
        </button>
      </div>
    </section>
  );
}
