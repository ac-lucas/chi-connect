import { lazy, Suspense } from 'preact/compat';
import { useEffect, useState } from 'preact/hooks';
import type { ConnectPayload } from './connect/payload';
import { INTRO_KEEP_MS, syncOnce } from './relay/protocol';
import { relayFromEnv } from './relay/transport';
import { createProfile, draftFromProfile, emptyDraft, updateProfile, type ProfileDraft } from './model/profile';
import type { Connection, Profile } from './model/types';
import { EnterCodeScreen } from './screens/EnterCodeScreen';
import { RequestScreen } from './screens/RequestScreen';
import { MeScreen } from './screens/MeScreen';
import { PeopleScreen } from './screens/PeopleScreen';
import { PersonScreen } from './screens/PersonScreen';
import { ProfileEditor } from './screens/ProfileEditor';
import { TodayScreen } from './screens/TodayScreen';
import { AddSessionsScreen } from './screens/AddSessionsScreen';
import { InviteScreen, type InviteDraft } from './screens/InviteScreen';
import { CatchUpScreen } from './screens/CatchUpScreen';
import { RecapScreen } from './screens/RecapScreen';
import { handleInviteMessage } from './schedule/invites';
import { handleSessionsMessage, shareSessionsIfChanged } from './schedule/overlap';
import { checkFeed, POLL_MS, POLL_NEWEST } from './programme/feed';
import { resolveProgramme, startOfDay } from './programme/programme';
import { isOver } from './programme/preview';
import type { Programme } from './programme/types';
import { getIntros, pruneIntros, updateConnection, getProfile, listAllSchedule, getPreviewAnchor, getSetting, listInvites, removeProgrammeSessions, syncSavedSessions, setSetting, listConnections, putConnection, requestPersistentStorage, saveProfile, seedDemoOnce, seedDemoScheduleOnce } from './storage/db';
import { demoScheduleItems } from './schedule/starter';
import { announce } from './ui/announce';
import { Announcer } from './ui/Announcer';

type Tab = 'today' | 'people' | 'me';
type Screen =
  | { kind: 'tabs' }
  | { kind: 'edit' }
  | { kind: 'connect'; code?: string }
  | { kind: 'share' }
  | { kind: 'sessions'; day: number }
  | { kind: 'invite'; draft: InviteDraft }
  | { kind: 'catchup' }
  | { kind: 'recap' }
  | { kind: 'enter-code' }
  | { kind: 'request'; theirs: ConnectPayload }
  | { kind: 'person'; id: string; justConnected?: boolean };

// The two screens that draw and read QR codes load on demand: the QR libraries are about 40% of the app's
// JavaScript and most opens never need them. They're still precached, so they work offline.
const ConnectScreen = lazy(() => import('./screens/ConnectScreen').then((m) => ({ default: m.ConnectScreen })));
const ShareCodeScreen = lazy(() => import('./screens/ShareCodeScreen').then((m) => ({ default: m.ShareCodeScreen })));

/** Page titles per screen (WCAG 2.4.2), so tabs, history and screen readers say where you are. */
const SCREEN_TITLES: Record<Exclude<Screen['kind'], 'tabs'>, string> = {
  edit: 'Edit profile',
  connect: 'Connect face to face',
  share: 'Share your code',
  sessions: 'Add sessions',
  invite: 'Invite someone',
  catchup: 'Catch up later',
  recap: 'Your week',
  'enter-code': 'Enter a code',
  request: 'Connect',
  person: 'Person',
};
const TAB_TITLES: Record<Tab, string> = { today: 'Today', people: 'People', me: 'You' };

/** The relay for this build, or null (then one-way connecting is hidden). */
const relay = relayFromEnv();
/** Relay sync while something is expected (a reply, a request to a live code, an upcoming meetup)... */
const SYNC_ACTIVE_MS = 60_000;
/** ...and when nothing is: a few requests an hour instead of sixty. */
const SYNC_IDLE_MS = 5 * 60_000;
/** Coming back to the app syncs straight away, unless it synced this recently. */
const SYNC_MIN_GAP_MS = 20_000;

const TABS: { id: Tab; label: string; glyph: string }[] = [
  { id: 'today', label: 'Today', glyph: '◷' },
  { id: 'people', label: 'People', glyph: '◎' },
  { id: 'me', label: 'You', glyph: '◉' },
];

/** True while protected time or a Focus session is running. */
async function isHoldingNow(now = Date.now()): Promise<boolean> {
  return (await listAllSchedule()).some((i) => i.start <= now && i.end > now && (i.type === 'protected' || (i.type === 'session' && !!i.focus)));
}

/** Read a connect code from the page link (#c=...) and remove it from the address bar. */
function takeCodeFromLink(): string | undefined {
  if (!location.hash.startsWith('#c=')) return undefined;
  const code = location.hash.slice(3);
  history.replaceState(null, '', location.pathname + location.search);
  return code || undefined;
}

export function App() {
  // undefined = still loading, null = first run
  const [profile, setProfile] = useState<Profile | null | undefined>(undefined);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [tab, setTab] = useState<Tab>('today');
  const [screen, setScreen] = useState<Screen>({ kind: 'tabs' });
  const [pendingCode, setPendingCode] = useState<string | undefined>(takeCodeFromLink);
  const [loadError, setLoadError] = useState(false);
  const [syncTick, setSyncTick] = useState(0);
  const [programme, setProgramme] = useState<Programme | null>(null);
  const [programmeFailed, setProgrammeFailed] = useState(false);

  useEffect(() => {
    // Show the programme on the device straight away; fetch it if there's none yet. Polling for a newer edition
    // (on open, on return to the front, and once a minute while visible) only runs once POLL_NEWEST is on.
    let stopped = false;
    let busy = false;
    /** Which programme is on the device: kept here so a check doesn't re-read the whole stored programme. */
    let held: { edition: string; revision: number } | null = null;
    const show = async () => {
      try {
        const feed = await getSetting('programmeFeed');
        if (!feed) return; // nothing downloaded yet: check() fetches it
        held = { edition: feed.edition, revision: feed.revision };
        let anchor = await getPreviewAnchor();
        let p = resolveProgramme(anchor, feed);
        // A preview whose days have all gone by (someone coming back a week later): start it from today.
        if (p.shiftedFrom !== undefined && isOver(p)) {
          anchor = startOfDay(Date.now());
          await setSetting('sampleAnchor', anchor);
          p = resolveProgramme(anchor, feed);
        }
        // Saved sessions follow the programme: moved times, new rooms and renames show up in your day.
        await syncSavedSessions(p.sessions);
        if (!stopped) setProgramme(p);
      } catch {
        if (!stopped) setProgrammeFailed(true);
      }
    };
    const check = async () => {
      if (busy || stopped || document.visibilityState !== 'visible') return;
      busy = true;
      try {
        // Polling is off and a programme is held: nothing to ask, so don't touch storage at all.
        if (held && !POLL_NEWEST) return;
        const r = await checkFeed(held, (await getSetting('feedCheckedAt')) ?? 0, {
          skip: await getSetting('feedUnusable'),
        });
        if (r.checked) await setSetting('feedCheckedAt', Date.now());
        if (r.unusable) await setSetting('feedUnusable', r.unusable);
        if (!r.programme && !held && r.checked) setProgrammeFailed(true); // first download didn't work: say so
        if (r.programme && r.programme.sessions.length) {
          setProgrammeFailed(false);
          await setSetting('programmeFeed', r.programme);
          if (held && held.edition !== r.programme.edition) {
            // A new edition (the real programme replacing the preview): sessions saved from the old one go.
            const n = await removeProgrammeSessions();
            if (n) announce(`The ${r.programme.name} programme is here. Your preview sessions were cleared; add the real ones.`);
          }
          await show();
        }
      } catch {
        // Keep what we have; try again next time.
      } finally {
        busy = false;
      }
    };
    void show().then(check);
    // The minute-by-minute poll only exists once polling the newest edition is switched on. Until then, opening
    // the app or coming back to it is enough: that's when a first download that failed is tried again.
    const timer = POLL_NEWEST ? setInterval(check, POLL_MS) : undefined;
    document.addEventListener('visibilitychange', check);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', check);
    };
  }, []);

  const refreshConnections = () => listConnections().then(setConnections);

  // Trying the app on the preview programme: start with the ready-made demo schedule (labelled Sample), once.
  useEffect(() => {
    if (!profile || programme?.shiftedFrom === undefined) return;
    void seedDemoScheduleOnce(demoScheduleItems(programme))
      .then((added) => added && setSyncTick((n) => n + 1))
      .catch(() => {});
  }, [programme, !!profile]);

  useEffect(() => {
    getProfile()
      .then(async (p) => {
        if (p) {
          await seedDemoOnce().catch(() => {});
          await refreshConnections();
        }
        setProfile(p);
      })
      .catch(() => setLoadError(true));
    const onHash = () => {
      const code = takeCodeFromLink();
      if (code) setPendingCode(code);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Check the relay for requests and replies: on open, on coming back to the app, and then every minute while
  // something is expected or every 5 minutes while nothing is. Never while the app isn't on screen.
  const hasProfile = !!profile;
  useEffect(() => {
    if (!relay || !hasProfile) return;
    let running = false;
    let stopped = false;
    let lastRun = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (ms: number) => {
      clearTimeout(timer);
      if (!stopped) timer = setTimeout(() => void run(), ms);
    };
    const run = async () => {
      if (running || stopped || document.visibilityState !== 'visible') return;
      running = true;
      lastRun = Date.now();
      let next = SYNC_IDLE_MS;
      try {
        const newInvites: string[] = [];
        // Expired one-way codes (and their private keys) go once no late request can still arrive.
        await pruneIntros((i) => i.expiresAt + INTRO_KEEP_MS);
        const r = await syncOnce(relay, {
          intros: getIntros,
          connections: listConnections,
          put: putConnection,
          patch: updateConnection,
          onPairMessage: async (c, msg, sentAt) => {
            if (msg.t === 'sessions') return handleSessionsMessage(c, msg.ids);
            const what = await handleInviteMessage(c, msg, sentAt);
            if (what === 'new') newInvites.push(c.profile.displayName);
          },
        });
        // Send my saved-session list to people I share it with, if it changed (F14).
        await shareSessionsIfChanged(relay);
        if (r.messages) setSyncTick((n) => n + 1);
        // New invites are announced, except while protected time or a Focus session is running (they wait).
        // One announcement per sync: the live region only reads the last message it's given.
        const lines: string[] = [];
        if (newInvites.length && !(await isHoldingNow())) {
          lines.push(newInvites.length === 1 ? `${newInvites[0]} sent you an invite.` : `${newInvites.length} new invites.`);
        }
        if (r.newRequests.length) {
          lines.push(r.newRequests.length === 1 ? `${r.newRequests[0]!.profile.displayName} would like to connect.` : `${r.newRequests.length} new requests to connect.`);
        }
        for (const c of r.accepted) lines.push(`${c.profile.displayName} said yes. You’re connected.`);
        if (lines.length) announce(lines.join(' '));
        // Always refresh: a sync can change connections (accepts, shared session lists, sharing hashes).
        const conns = await listConnections();
        setConnections(conns);
        // Expecting something? Then check again in a minute; otherwise in five.
        const now = Date.now();
        const expecting =
          r.messages > 0 ||
          r.newRequests.length > 0 ||
          conns.some((c) => c.state === 'pending-sent') ||
          (await getIntros()).some((i) => i.expiresAt > now) ||
          (await listInvites()).some((i) => i.end > now && i.status !== 'declined' && i.status !== 'cancelled');
        next = expecting ? SYNC_ACTIVE_MS : SYNC_IDLE_MS;
      } catch {
        // Offline or the relay is busy: try again at the slower pace.
      } finally {
        running = false;
        schedule(next);
      }
    };
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return clearTimeout(timer); // nothing runs in the background
      if (Date.now() - lastRun >= SYNC_MIN_GAP_MS) void run();
      else schedule(SYNC_MIN_GAP_MS);
    };
    void run();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [hasProfile]);

  // A code from a link opens the connect screen once there is a profile to connect with.
  useEffect(() => {
    if (profile && pendingCode) {
      setScreen({ kind: 'connect', code: pendingCode });
      setPendingCode(undefined);
    }
  }, [profile, pendingCode]);

  async function handleCreate(d: ProfileDraft) {
    const p = createProfile(d);
    await saveProfile(p); // the only step that has to work
    void requestPersistentStorage();
    // Demo people are a nice-to-have: never let them stop someone getting in.
    try {
      await seedDemoOnce();
      await refreshConnections();
    } catch {
      // Try again on the next open.
    }
    setProfile(p);
    setTab('today');
    announce(`You’re set up, ${p.displayName}.`);
  }

  async function handleUpdate(d: ProfileDraft) {
    if (!profile) return;
    const p = updateProfile(profile, d);
    await saveProfile(p);
    setProfile(p);
    setScreen({ kind: 'tabs' });
    announce('Profile saved.');
  }

  const goTab = (t: Tab) => {
    setTab(t);
    setScreen({ kind: 'tabs' });
    window.scrollTo(0, 0);
  };

  let body;
  if (loadError) {
    body = (
      <div class="card stack" role="alert">
        <p class="lede">This browser won’t let Pebble store anything.</p>
        <p>Private browsing can block storage. Try a regular window.</p>
      </div>
    );
  } else if (profile === undefined) {
    body = <p class="muted">Loading…</p>;
  } else if (profile === null) {
    body = <ProfileEditor mode="create" initial={emptyDraft()} onSave={handleCreate} />;
  } else if (screen.kind === 'edit') {
    body = (
      <ProfileEditor mode="edit" initial={draftFromProfile(profile)} onSave={handleUpdate} onCancel={() => setScreen({ kind: 'tabs' })} />
    );
  } else if (screen.kind === 'connect') {
    body = (
      <ConnectScreen
        profile={profile}
        relay={relay}
        initialCode={screen.code}
        onOneWayCode={relay ? (theirs) => setScreen({ kind: 'request', theirs }) : undefined}
        onCancel={() => goTab('people')}
        onConnected={async (id) => {
          await refreshConnections();
          setTab('people');
          setScreen({ kind: 'person', id, justConnected: true });
        }}
      />
    );
  } else if (screen.kind === 'share' && relay) {
    body = <ShareCodeScreen profile={profile} relay={relay} onDone={() => goTab('people')} />;
  } else if (screen.kind === 'enter-code' && relay) {
    body = <EnterCodeScreen relay={relay} onFound={(theirs) => setScreen({ kind: 'request', theirs })} onCancel={() => goTab('people')} />;
  } else if (screen.kind === 'request' && relay) {
    body = (
      <RequestScreen
        profile={profile}
        theirs={screen.theirs}
        relay={relay}
        onCancel={() => goTab('people')}
        onSent={async (id) => {
          await refreshConnections();
          setTab('people');
          setScreen({ kind: 'person', id });
        }}
      />
    );
  } else if (screen.kind === 'person') {
    const c = connections.find((x) => x.id === screen.id);
    body = c ? (
      <PersonScreen
        key={c.id}
        connection={c}
        myTags={profile.tags}
        justConnected={screen.justConnected}
        relay={relay}
        programme={programme}
        onChanged={() => void refreshConnections()}
        onBack={() => goTab('people')}
        onRemoved={async () => {
          await refreshConnections();
          goTab('people');
        }}
      />
    ) : (
      <p class="muted">That person isn’t here any more.</p>
    );
  } else if (screen.kind === 'catchup') {
    body = <CatchUpScreen onBack={() => goTab('me')} />;
  } else if (screen.kind === 'recap' && programme) {
    body = <RecapScreen programme={programme} onBack={() => goTab('me')} />;
  } else if (screen.kind === 'invite') {
    body = <InviteScreen me={profile.displayName} draft={screen.draft} relay={relay} onSent={() => goTab('today')} onCancel={() => goTab('today')} />;
  } else if (screen.kind === 'sessions' && programme) {
    body = <AddSessionsScreen programme={programme} initialDay={screen.day} onDone={() => goTab('today')} />;
  } else if (tab === 'today') {
    body = programme ? (
      <TodayScreen
        name={profile.displayName}
        programme={programme}
        relay={relay}
        myTopics={profile.tags.map((t) => t.key)}
        syncTick={syncTick}
        onAddSessions={(day) => setScreen({ kind: 'sessions', day })}
        onInvite={(draft) => setScreen({ kind: 'invite', draft })}
      />
    ) : (
      programmeFailed ? (
        <div class="card stack" role="status">
          <p class="lede">The programme hasn’t loaded yet.</p>
          <p>Pebble needs a connection the first time, to download it. It’ll try again when you come back to the app.</p>
        </div>
      ) : (
        <p class="muted">Loading the programme…</p>
      )
    );
  } else if (tab === 'people') {
    body = (
      <PeopleScreen
        connections={connections}
        myTags={profile.tags}
        onConnect={() => setScreen({ kind: 'connect' })}
        onOpen={(id) => setScreen({ kind: 'person', id })}
        onShare={relay ? () => setScreen({ kind: 'share' }) : undefined}
        onEnterCode={relay ? () => setScreen({ kind: 'enter-code' }) : undefined}
      />
    );
  } else {
    body = (
      <MeScreen
        profile={profile}
        onEdit={() => setScreen({ kind: 'edit' })}
        onCatchUp={() => setScreen({ kind: 'catchup' })}
        onRecap={() => setScreen({ kind: 'recap' })}
      />
    );
  }

  const pageTitle = profile === null ? 'Set up' : profile === undefined ? '' : screen.kind === 'tabs' ? TAB_TITLES[tab] : SCREEN_TITLES[screen.kind];
  useEffect(() => {
    document.title = pageTitle ? `${pageTitle} · Pebble` : 'Pebble';
  }, [pageTitle]);

  const showTabs = profile && (screen.kind === 'tabs' || screen.kind === 'person' || screen.kind === 'catchup' || screen.kind === 'recap');
  const requestCount = connections.filter((c) => c.state === 'pending-received').length;

  return (
    <>
      <a class="skip-link" href="#main">
        Skip to content
      </a>
      <header class="app-header">
        <h1 class="app-name">Pebble</h1>
      </header>
      <main id="main" tabIndex={-1}>
        <Suspense fallback={<p class="muted">Loading…</p>}>{body}</Suspense>
      </main>
      {showTabs && (
        <nav class="tabbar" aria-label="Main">
          <ul>
            {TABS.map((t) => (
              <li key={t.id}>
                <button type="button" aria-current={tab === t.id ? 'page' : undefined} onClick={() => goTab(t.id)}>
                  <span class="glyph" aria-hidden="true">
                    {t.glyph}
                  </span>
                  {t.label}
                  {t.id === 'people' && requestCount > 0 && (
                    <span class="tab-count">
                      {requestCount}
                      <span class="visually-hidden"> {requestCount === 1 ? 'request' : 'requests'}</span>
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </nav>
      )}
      <Announcer />
    </>
  );
}
