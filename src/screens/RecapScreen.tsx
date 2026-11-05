import { useEffect, useState } from 'preact/hooks';
import type { Programme } from '../programme/types';
import { nextDay, startOfDay } from '../programme/programme';
import { planDay, type Busy } from '../schedule/breaks';
import { energyToday } from '../schedule/energy';
import { buildRecap, recapText, type Recap } from '../schedule/recap';
import { getSetting, listAllNotes, listAllSchedule, listCatchUp, listConnections, listFollowUps, listInvites, putFollowUp } from '../storage/db';
import type { Connection, FollowUp } from '../model/types';
import { download, toCsv, toIcs, toVCard } from '../export/exports';
import { announce } from '../ui/announce';
import { useScreenHeading } from '../ui/useScreenHeading';

/** C Wrapped (F26): your own conference in a few cards. Built on this phone from your data; nothing is sent. */
export function RecapScreen({ programme, onBack }: { programme: Programme; onBack: () => void }) {
  const heading = useScreenHeading<HTMLHeadingElement>();
  const [recap, setRecap] = useState<Recap | null>(null);
  const [followUps, setFollowUps] = useState<FollowUp[]>([]);
  const [people, setPeople] = useState<Connection[]>([]);
  const loadFollowUps = async () => {
    setFollowUps(await listFollowUps());
    setPeople(await listConnections());
  };

  useEffect(() => {
    void (async () => {
      const items = await listAllSchedule();
      const skipped = new Set((await getSetting('skippedBreaks')) ?? []);
      const level = energyToday(await getSetting('energy')).level;
      // Breathers that have already happened, across the days you planned.
      const days = [...new Set(items.filter((i) => i.type === 'session').map((i) => startOfDay(i.start)))];
      let breathers = 0;
      for (const d of days) {
        const busy: Busy[] = items
          .filter((i) => i.start >= d && i.start < nextDay(d) && (i.type === 'session' || i.type === 'protected' || i.type === 'invite'))
          .map((i) => ({ id: i.id, start: i.start, end: i.end, kind: i.type === 'session' ? 'session' : i.type === 'protected' ? 'protected' : 'meetup' }));
        breathers += planDay(busy, d, level, undefined, skipped).breaks.filter((b) => b.end < Date.now()).length;
      }
      setRecap(buildRecap(programme, items, await listInvites(), await listConnections(), await listCatchUp(), breathers));
      await loadFollowUps();
    })();
  }, [programme]);

  async function copy() {
    if (!recap) return;
    try {
      await navigator.clipboard.writeText(recapText(recap));
      announce('Copied.');
    } catch {
      announce('Couldn’t copy here.');
    }
  }

  return (
    <section class="stack" aria-labelledby="recap-heading">
      <div class="actions">
        <button type="button" class="button quiet" onClick={onBack}>
          <span aria-hidden="true">←</span> You
        </button>
      </div>
      <div>
        <h2 id="recap-heading" ref={heading} tabIndex={-1}>
          Your week, in rhythm
        </h2>
        <p class="muted">Made on this phone from your own plans. Nobody else sees it.</p>
      </div>
      {!recap ? (
        <p class="muted">Putting it together…</p>
      ) : recap.sessions === 0 ? (
        <div class="card stack">
          <p class="lede">Nothing to wrap yet.</p>
          <p>Save some sessions and this fills up as the week goes on.</p>
        </div>
      ) : (
        <ol class="recap">
          <li class="card recap-card">
            <p class="recap-big">{recap.sessions}</p>
            <p>
              sessions across {recap.days} {recap.days === 1 ? 'day' : 'days'}
            </p>
          </li>
          {recap.topics.length > 0 && (
            <li class="card recap-card">
              <p class="recap-label">You spent your time on</p>
              <ul class="chips" aria-label="Your top topics">
                {recap.topics.map((t) => (
                  <li key={t.label} class="chip static">
                    {t.label} <span class="muted">· {t.count}</span>
                  </li>
                ))}
              </ul>
            </li>
          )}
          {recap.wildcards.length > 0 && (
            <li class="card recap-card">
              <p class="recap-big">{recap.wildcards.length}</p>
              <p>{recap.wildcards.length === 1 ? 'wildcard detour' : 'wildcard detours'}</p>
              <p class="muted">{recap.wildcards.join(' · ')}</p>
            </li>
          )}
          {recap.breathers > 0 && (
            <li class="card recap-card">
              <p class="recap-big">{recap.breathers}</p>
              <p>{recap.breathers === 1 ? 'breather' : 'breathers'} so far. Pacing counts.</p>
            </li>
          )}
          {(recap.meetups > 0 || recap.people > 0) && (
            <li class="card recap-card">
              {recap.meetups > 0 && (
                <p>
                  <span class="recap-big inline">{recap.meetups}</span> {recap.meetups === 1 ? 'meetup' : 'meetups'}
                </p>
              )}
              {recap.people > 0 && (
                <p>
                  <span class="recap-big inline">{recap.people}</span> new {recap.people === 1 ? 'connection' : 'connections'}
                </p>
              )}
            </li>
          )}
          {recap.catchUp > 0 && (
            <li class="card recap-card">
              <p class="recap-big">{recap.catchUp}</p>
              <p>
                to catch up on later{recap.papers ? `, with ${recap.papers} ${recap.papers === 1 ? 'paper' : 'papers'}` : ''}
              </p>
            </li>
          )}
        </ol>
      )}
      <section class="stack" aria-labelledby="fu-all">
        <h3 id="fu-all">Follow-ups</h3>
        {followUps.length === 0 ? (
          <p class="muted">None yet. Add them on someone’s page, or tick “Follow up” in a quick note.</p>
        ) : (
          <ul class="followups">
            {followUps.map((f) => {
              const who = people.find((c) => c.id === f.connectionId);
              return (
                <li key={f.id} class={f.done ? 'done' : ''}>
                  <label class="check">
                    <input
                      type="checkbox"
                      checked={f.done}
                      onChange={async () => {
                        await putFollowUp({ ...f, done: !f.done });
                        await loadFollowUps();
                        announce(f.done ? 'Marked not done.' : 'Done. Nice.');
                      }}
                    />
                    <span>
                      {f.text}
                      <span class="muted">
                        {who ? ` · ${who.profile.displayName}${who.demo ? ' (demo)' : ''}` : ''}
                        {f.due ? ` · by ${new Date(f.due).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}` : ''}
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section class="stack" aria-labelledby="take-heading">
        <h3 id="take-heading">Take it with you</h3>
        <p class="hint">Files made on this phone, from your own data. Only what each person chose to share is included.</p>
        <div class="actions">
          <button type="button" class="button secondary" onClick={async () => download('pebble-contacts.vcf', 'text/vcard', toVCard(await listConnections(), await listAllNotes()))}>
            Contacts (vCard)
          </button>
          <button
            type="button"
            class="button secondary"
            onClick={async () => download('pebble-people.csv', 'text/csv', toCsv(await listConnections(), await listAllNotes(), await listFollowUps()))}
          >
            Spreadsheet (CSV)
          </button>
          <button
            type="button"
            class="button secondary"
            disabled={!followUps.some((f) => f.due && !f.done)}
            onClick={async () => download('pebble-follow-ups.ics', 'text/calendar', toIcs(await listFollowUps(), await listConnections()))}
          >
            Follow-up reminders (calendar)
          </button>
        </div>
        {!followUps.some((f) => f.due && !f.done) && <p class="hint">Reminders need a follow-up with a date.</p>}
      </section>

      {recap && recap.sessions > 0 && 'clipboard' in navigator && (
        <div class="actions">
          <button type="button" class="button secondary" onClick={() => void copy()}>
            Copy as text
          </button>
        </div>
      )}
      {recap && recap.demoPeople > 0 && <p class="hint">Demo people and simulated meetups count here too, so you can see how it looks.</p>}
    </section>
  );
}
