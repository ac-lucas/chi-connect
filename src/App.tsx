import { lazy, Suspense } from 'preact/compat';
import { useEffect, useState } from 'preact/hooks';
import type { ConnectPayload } from './connect/payload';
import { relayFromEnv } from './relay/transport';
import { createProfile, draftFromProfile, emptyDraft, updateProfile, type ProfileDraft } from './model/profile';
import type { Profile } from './model/types';
import { EnterCodeScreen } from './screens/EnterCodeScreen';
import { RequestScreen } from './screens/RequestScreen';
import { MeScreen } from './screens/MeScreen';
import { PeopleScreen } from './screens/PeopleScreen';
import { ProfileEditor } from './screens/ProfileEditor';
import { TodayScreen } from './screens/TodayScreen';
import { AddSessionsScreen } from './screens/AddSessionsScreen';
import { InviteScreen, type InviteDraft } from './screens/InviteScreen';
import { CatchUpScreen } from './screens/CatchUpScreen';
import { RecapScreen } from './screens/RecapScreen';
import { getProfile, listConnections, requestPersistentStorage, saveProfile, seedDemoOnce, seedDemoScheduleOnce } from './storage/db';
import { useProgramme } from './app/useProgramme';
import { useRelaySync } from './app/useRelaySync';
import { PersonById } from './screens/PersonById';
import { useLive } from './ui/useLive';
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
  connect: 'Connect',
  share: 'Share',
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
  const [tab, setTab] = useState<Tab>('today');
  const [screen, setScreenState] = useState<Screen>({ kind: 'tabs' });
  // The day shown on Today, kept here so coming back from another screen (an invite, adding sessions) lands on it.
  const [todayDay, setTodayDay] = useState<number | null>(null);
  // Something just added (an invite you sent): Today points it out once.
  const [highlight, setHighlight] = useState<string | null>(null);
  const [pendingCode, setPendingCode] = useState<string | undefined>(takeCodeFromLink);
  const [loadError, setLoadError] = useState(false);
  const { programme, failed: programmeFailed } = useProgramme();
  // Kept current by storage change notices: new connections, accepts and removals show up by themselves.
  const connections = useLive(listConnections, ['connections']) ?? [];
  useRelaySync(relay, !!profile);


  // Trying the app on the preview programme: start with the ready-made demo schedule (labelled Sample), once.
  useEffect(() => {
    if (!profile || programme?.shiftedFrom === undefined) return;
    void seedDemoScheduleOnce(demoScheduleItems(programme)).catch(() => {});
  }, [programme, !!profile]);

  useEffect(() => {
    getProfile()
      .then(async (p) => {
        if (p) await seedDemoOnce().catch(() => {});
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


  // A code from a link opens the connect screen once there is a profile to connect with.
  useEffect(() => {
    if (profile && pendingCode) {
      setScreen({ kind: 'connect', code: pendingCode });
      setPendingCode(undefined);
    }
  }, [profile, pendingCode]);

  // Browser and phone Back close the open screen instead of leaving the app. Each screen opened from the tabs adds
  // one history entry; moving from one screen to another replaces it, so Back always returns to the tabs. Only
  // in-app state is used (no URL changes, no server routing).
  function setScreen(s: Screen) {
    const depth: number = history.state?.pebbleDepth ?? 0;
    if (s.kind === 'tabs') {
      if (depth > 0) history.go(-depth); // the popstate that follows sets the tabs too
      setScreenState(s);
      return;
    }
    if (depth > 0) history.replaceState({ pebbleDepth: depth, pebble: s }, '');
    else history.pushState({ pebbleDepth: 1, pebble: s }, '');
    setScreenState(s);
  }
  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const s = (e.state?.pebble as Screen | undefined) ?? { kind: 'tabs' };
      setScreenState(s);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  async function handleCreate(d: ProfileDraft) {
    const p = createProfile(d);
    await saveProfile(p); // the only step that has to work
    void requestPersistentStorage();
    // Demo people are a nice-to-have: never let them stop someone getting in.
    try {
      await seedDemoOnce();
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
        onConnected={(id) => {
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
        onSent={(id) => {
          setTab('people');
          setScreen({ kind: 'person', id });
        }}
      />
    );
  } else if (screen.kind === 'person') {
    body = (
      <PersonById
        id={screen.id}
        myTags={profile.tags}
        justConnected={screen.justConnected}
        relay={relay}
        programme={programme}
        onBack={() => goTab('people')}
        onRemoved={() => goTab('people')}
      />
    );
  } else if (screen.kind === 'catchup') {
    body = <CatchUpScreen onBack={() => goTab('me')} />;
  } else if (screen.kind === 'recap' && programme) {
    body = <RecapScreen programme={programme} onBack={() => goTab('me')} />;
  } else if (screen.kind === 'invite') {
    body = (
      <InviteScreen
        me={profile.displayName}
        draft={screen.draft}
        relay={relay}
        onSent={(id) => {
          setHighlight(id);
          goTab('today');
        }}
        onCancel={() => goTab('today')}
      />
    );
  } else if (screen.kind === 'sessions' && programme) {
    body = <AddSessionsScreen programme={programme} initialDay={screen.day} onDone={() => goTab('today')} />;
  } else if (tab === 'today') {
    body = programme ? (
      <TodayScreen
        name={profile.displayName}
        programme={programme}
        relay={relay}
        myTopics={profile.tags.map((t) => t.key)}
        day={todayDay}
        onDayChange={setTodayDay}
        highlight={highlight}
        onHighlightShown={() => setHighlight(null)}
        onRecap={() => setScreen({ kind: 'recap' })}
        onAddSessions={(day) => setScreen({ kind: 'sessions', day })}
        onInvite={(draft) => setScreen({ kind: 'invite', draft })}
      />
    ) : (
      programmeFailed ? (
        <div class="card stack" role="status">
          <p class="lede">The program hasn’t loaded yet.</p>
          <p>Pebble needs a connection the first time, to download it. It’ll try again when you come back to the app.</p>
        </div>
      ) : (
        <p class="muted">Loading the program…</p>
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
        programme={programme}
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
