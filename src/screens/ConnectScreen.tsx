import { useEffect, useRef, useState } from 'preact/hooks';
import { hasWebCrypto, matchSeed, newPairKey, pairSecret, type PairKey } from '../connect/pairing';
import { cardFromSeed, type ShapeCard } from '../schedule/findme';
import { ShapeCardView, ShapeGraphic } from './ShapeCard';
import { decodeCode, DecodeError, FACE_TO_FACE_TTL_MS, fitLink, type ConnectPayload, type DecodeProblem } from '../connect/payload';
import { QrCode } from '../connect/QrCode';
import { QrScanner } from '../connect/QrScanner';
import { randomId } from '../model/ids';
import { newBox } from '../relay/protocol';
import type { Box, Transport } from '../relay/transport';
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
  /** The relay, if this build has one: our mailbox is claimed as soon as the code is shown. */
  relay?: Transport | null;
  /** Called with a one-way code (shared at a distance). Omitted when there is no relay. */
  onOneWayCode?: (theirs: ConnectPayload) => void;
  onConnected: (connectionId: string) => void;
  onCancel: () => void;
}

interface Mine {
  payload: ConnectPayload;
  /** Our mailbox for this connection; the token proves it's ours to the relay. */
  box: Box;
  /** This code's key pair. Kept in memory only; a new one comes with every new code. */
  key: PairKey;
  link: string;
  leftOut: string[];
}

const PROBLEMS: Record<DecodeProblem | 'own' | 'regular' | 'not-ready', string> = {
  'not-ready': 'Your own code isn’t ready, so face-to-face can’t finish here. Reload Pebble and try again.',
  'too-long': 'That isn’t a Pebble code.',
  'not-a-code': 'That isn’t a Pebble code.',
  unreadable: 'Couldn’t read that code. Ask them to open a fresh one.',
  'newer-version': 'Their app is a newer version. Reload this page and try again.',
  'older-version': 'Their app needs an update. Ask them to reload Pebble, then show a fresh code.',
  expired: 'That code has expired. Ask them to open a fresh one.',
  own: 'That’s your own code. Scan theirs instead.',
  regular: 'That code is for connecting at a distance, which isn’t switched on yet. Try face to face.',
};

function appBase(): string {
  return location.href.split('#')[0]!;
}

export function ConnectScreen({ profile, relay, initialCode, onOneWayCode, onConnected, onCancel }: Props) {
  const heading = useScreenHeading<HTMLHeadingElement>();
  const [mine, setMine] = useState<Mine | null>(null);
  const [view, setView] = useState<'show' | 'scan'>('show');
  const [theirs, setTheirs] = useState<ConnectPayload | null>(null);
  const [match, setMatch] = useState<ShapeCard | null>(null);
  const [showShape, setShowShape] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [pasted, setPasted] = useState('');
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [makeFailed, setMakeFailed] = useState(false);
  const lastBad = useRef<string | null>(null);
  const theirsRef = useRef<ConnectPayload | null>(null);
  theirsRef.current = theirs;
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const cryptoOk = hasWebCrypto();

  // Make a fresh code, and replace it shortly before it expires.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let live = true;
    async function make() {
      try {
        await makeOnce();
        setMakeFailed(false);
      } catch {
        // Missing or failing Web Crypto, or storage trouble: say so rather than "Making your code…" forever.
        if (live) setMakeFailed(true);
      }
    }
    async function makeOnce() {
      const box = await newBox();
      // Claim our mailbox now: the relay only takes mail for claimed mailboxes. Fine if offline; sync claims it later.
      relay?.claim(box).catch(() => {});
      const key = await newPairKey();
      const payload: ConnectPayload = {
        mode: 'f',
        nonce: randomId(),
        publicKey: key.publicKey,
        mailboxId: box.id,
        expiresAt: Date.now() + FACE_TO_FACE_TTL_MS,
        profile: toSharedProfile(profile),
      };
      const next = await fitLink(payload, appBase());
      if (!live) return;
      setMine({ ...next, box, key });
      timer = setTimeout(function due() {
        // Don't refresh while theirs is on screen, or the shape would change under them.
        // Check again shortly, so "Different word" never leaves an expired code on show.
        if (theirsRef.current) timer = setTimeout(due, 5_000);
        else void make();
      }, FACE_TO_FACE_TTL_MS - 30_000);
    }
    void make();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [profile]);

  async function accept(text: string): Promise<boolean> {
    if (text === lastBad.current) return false; // same bad code still in view: stay quiet
    try {
      const p = await decodeCode(text);
      if (mine && p.nonce === mine.payload.nonce) throw new Error('own');
      // One-way codes don't need our own code at all, so they work even if making ours failed.
      if (p.mode !== 'f') {
        if (!onOneWayCode) throw new Error('regular');
        onOneWayCode(p);
        return true;
      }
      if (!mine) throw new Error('not-ready');
      // A code that points at our own mailbox is someone replaying our code with a new nonce: refuse it.
      if (p.mailboxId && p.mailboxId === mine.box.id) throw new Error('own');
      lastBad.current = null;
      setProblem(null);
      setTheirs(p);
      setMatch(await cardFromSeed(matchSeed(mine.payload, p)));
      // Focusing the heading reads it ("Got X's code"); no separate announcement, or it would be read twice.
      setTimeout(() => resultHeading.current?.focus(), 0);
      return true;
    } catch (e) {
      lastBad.current = text;
      const key = e instanceof DecodeError ? e.problem : (e as Error).message;
      setProblem(PROBLEMS[key as keyof typeof PROBLEMS] ?? PROBLEMS.unreadable); // shown in a role=alert: read once
      return false;
    }
  }

  // A code that came in through the page link: read it as soon as our own code exists (or failed to).
  const usedInitial = useRef(false);
  useEffect(() => {
    if (initialCode && (mine || makeFailed) && !usedInitial.current) {
      usedInitial.current = true;
      void accept(initialCode);
    }
  }, [initialCode, mine, makeFailed]);

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
        myMailboxId: mine.box.id,
        myMailboxToken: mine.box.token,
        via: 'face-to-face',
        sharedSecret: await pairSecret(mine.key.privateKey, mine.payload, theirs),
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
      <p class="hint">Works for {minutes} minutes. Holds only what you chose to share, plus a one-time pairing number. Anyone who sees it can read those.</p>
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
            You scan theirs, they scan yours. Order doesn’t matter. Then you both hold up your shape: same shape, you’re connected.
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
            <h3 id="match-heading">Your shape</h3>
            <div class="match-card" style={{ background: match.colour.bg, color: match.colour.fg }}>
              <ShapeGraphic card={match} size="5rem" idSuffix="match" />
              <p class="match-word">{match.word}</p>
              <p class="match-pattern">{match.pattern}</p>
            </div>
            <p>
              Once they’ve scanned your code too, their screen shows the same shape. Hold them side by side: same shape? You’re connected.
            </p>
            <div class="actions">
              <button type="button" class="button secondary" onClick={() => setShowShape(true)}>
                Show it full screen
              </button>
            </div>
            <div class="actions">
              <button type="button" class="button" onClick={connect} disabled={saving}>
                {saving ? 'Connecting…' : 'Same shape. Connect'}
              </button>
              <button type="button" class="button secondary" onClick={startOver}>
                Different shape
              </button>
            </div>
          </section>
          {showShape && <ShapeCardView card={match} context={`Connecting with ${theirs.profile.displayName}`} onClose={() => setShowShape(false)} />}

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
            myCode ??
            (makeFailed ? (
              <p class="error" role="alert">
                Couldn’t make your code on this device. Reload Pebble and try again, or scan theirs instead.
              </p>
            ) : (
              <p class="muted">Making your code…</p>
            ))
          ) : (
            cryptoOk && (
            <div class="stack">
              <QrScanner onResult={accept} />
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
            )
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
