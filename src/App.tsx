import { useEffect, useState } from 'preact/hooks';
import type { ConnectPayload } from './connect/payload';
import { syncOnce } from './relay/protocol';
import { relayFromEnv } from './relay/transport';
import { createProfile, draftFromProfile, emptyDraft, updateProfile, type ProfileDraft } from './model/profile';
import type { Connection, Profile } from './model/types';
import { ConnectScreen } from './screens/ConnectScreen';
import { EnterCodeScreen } from './screens/EnterCodeScreen';
import { RequestScreen } from './screens/RequestScreen';
import { ShareCodeScreen } from './screens/ShareCodeScreen';
import { MeScreen } from './screens/MeScreen';
import { PeopleScreen } from './screens/PeopleScreen';
import { PersonScreen } from './screens/PersonScreen';
import { ProfileEditor } from './screens/ProfileEditor';
import { TodayScreen } from './screens/TodayScreen';
import { AddSessionsScreen } from './screens/AddSessionsScreen';
import { checkFeed, POLL_MS } from './programme/feed';
import { resolveProgramme } from './programme/programme';
import type { Programme } from './programme/types';
import { getIntros, getProfile, getSampleAnchor, getSetting, removeSampleSessions, setSetting, listConnections, putConnection, requestPersistentStorage, saveProfile, seedDemoOnce } from './storage/db';
import { announce } from './ui/announce';
import { Announcer } from './ui/Announcer';

type Tab = 'today' | 'people' | 'me';
type Screen =
  | { kind: 'tabs' }
  | { kind: 'edit' }
  | { kind: 'connect'; code?: string }
  | { kind: 'share' }
  | { kind: 'sessions'; day: number }
  | { kind: 'enter-code' }
  | { kind: 'request'; theirs: ConnectPayload }
  | { kind: 'person'; id: string; justConnected?: boolean };

/** The relay for this build, or null (then one-way connecting is hidden). */
const relay = relayFromEnv();
const SYNC_EVERY_MS = 60_000;

const TABS: { id: Tab; label: string; glyph: string }[] = [
  { id: 'today', label: 'Today', glyph: '◷' },
  { id: 'people', label: 'People', glyph: '◎' },
  { id: 'me', label: 'You', glyph: '◉' },
];

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
  const [programme, setProgramme] = useState<Programme | null>(null);

  useEffect(() => {
    // Show what's on the device straight away (sample, or the last downloaded programme), then keep it current:
    // check the feed's version on open, when the app comes back to the front, and once a minute while visible.
    let stopped = false;
    let busy = false;
    const show = async () => {
      const anchor = await getSampleAnchor();
      const feed = await getSetting('programmeFeed');
      if (!stopped) setProgramme(resolveProgramme(anchor, feed));
    };
    const check = async () => {
      if (busy || stopped || document.visibilityState !== 'visible') return;
      busy = true;
      try {
        const held = await getSetting('programmeFeed');
        const r = await checkFeed(held ? { edition: held.edition, revision: held.revision } : null, (await getSetting('feedCheckedAt')) ?? 0);
        if (r.checked) await setSetting('feedCheckedAt', Date.now());
        if (r.programme && r.programme.sessions.length) {
          await setSetting('programmeFeed', r.programme);
          if (!held) await removeSampleSessions();
          await show();
        }
      } catch {
        // Keep what we have; try again next time.
      } finally {
        busy = false;
      }
    };
    void show().then(check);
    const timer = setInterval(check, POLL_MS);
    document.addEventListener('visibilitychange', check);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', check);
    };
  }, []);

  const refreshConnections = () => listConnections().then(setConnections);

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

  // Check the relay for requests and replies: on open, when the app comes back to the front, and every minute while visible.
  const hasProfile = !!profile;
  useEffect(() => {
    if (!relay || !hasProfile) return;
    let running = false;
    const run = async () => {
      if (running || document.visibilityState !== 'visible') return;
      running = true;
      try {
        const r = await syncOnce(relay, { intros: getIntros, connections: listConnections, put: putConnection });
        if (r.newRequests.length || r.accepted.length) await refreshConnections();
        for (const c of r.newRequests) announce(`${c.profile.displayName} would like to connect.`);
        for (const c of r.accepted) announce(`${c.profile.displayName} said yes. You’re connected.`);
      } catch {
        // Offline or the relay is busy: try again next time.
      } finally {
        running = false;
      }
    };
    void run();
    const timer = setInterval(run, SYNC_EVERY_MS);
    document.addEventListener('visibilitychange', run);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', run);
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
  } else if (screen.kind === 'sessions' && programme) {
    body = <AddSessionsScreen programme={programme} initialDay={screen.day} onDone={() => goTab('today')} />;
  } else if (tab === 'today') {
    body = programme ? (
      <TodayScreen name={profile.displayName} programme={programme} onAddSessions={(day) => setScreen({ kind: 'sessions', day })} />
    ) : (
      <p class="muted">Loading…</p>
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
    body = <MeScreen profile={profile} onEdit={() => setScreen({ kind: 'edit' })} />;
  }

  const showTabs = profile && (screen.kind === 'tabs' || screen.kind === 'person');
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
        {body}
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
