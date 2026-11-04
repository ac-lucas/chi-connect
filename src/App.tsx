import { useEffect, useState } from 'preact/hooks';
import { createProfile, draftFromProfile, emptyDraft, updateProfile, type ProfileDraft } from './model/profile';
import type { Connection, Profile } from './model/types';
import { ConnectScreen } from './screens/ConnectScreen';
import { MeScreen } from './screens/MeScreen';
import { PeopleScreen } from './screens/PeopleScreen';
import { PersonScreen } from './screens/PersonScreen';
import { ProfileEditor } from './screens/ProfileEditor';
import { TodayScreen } from './screens/TodayScreen';
import { getProfile, listConnections, requestPersistentStorage, saveProfile, seedDemoOnce } from './storage/db';
import { announce } from './ui/announce';
import { Announcer } from './ui/Announcer';

type Tab = 'today' | 'people' | 'me';
type Screen =
  | { kind: 'tabs' }
  | { kind: 'edit' }
  | { kind: 'connect'; code?: string }
  | { kind: 'person'; id: string; justConnected?: boolean };

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

  const refreshConnections = () => listConnections().then(setConnections);

  useEffect(() => {
    getProfile()
      .then(async (p) => {
        if (p) {
          await seedDemoOnce();
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

  // A code from a link opens the connect screen once there is a profile to connect with.
  useEffect(() => {
    if (profile && pendingCode) {
      setScreen({ kind: 'connect', code: pendingCode });
      setPendingCode(undefined);
    }
  }, [profile, pendingCode]);

  async function handleCreate(d: ProfileDraft) {
    const p = createProfile(d);
    await saveProfile(p);
    void requestPersistentStorage();
    await seedDemoOnce();
    await refreshConnections();
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
        onCancel={() => goTab('people')}
        onConnected={async (id) => {
          await refreshConnections();
          setTab('people');
          setScreen({ kind: 'person', id, justConnected: true });
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
        onBack={() => goTab('people')}
        onRemoved={async () => {
          await refreshConnections();
          goTab('people');
        }}
      />
    ) : (
      <p class="muted">That person isn’t here any more.</p>
    );
  } else if (tab === 'today') {
    body = <TodayScreen name={profile.displayName} />;
  } else if (tab === 'people') {
    body = (
      <PeopleScreen
        connections={connections}
        myTags={profile.tags}
        onConnect={() => setScreen({ kind: 'connect' })}
        onOpen={(id) => setScreen({ kind: 'person', id })}
      />
    );
  } else {
    body = <MeScreen profile={profile} onEdit={() => setScreen({ kind: 'edit' })} />;
  }

  const showTabs = profile && screen.kind !== 'edit' && screen.kind !== 'connect';

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
