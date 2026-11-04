import { useEffect, useState } from 'preact/hooks';
import type { Programme } from '../programme/types';
import { startOfDay } from '../programme/programme';
import { planDay, type Busy } from '../schedule/breaks';
import { energyToday } from '../schedule/energy';
import { buildRecap, recapText, type Recap } from '../schedule/recap';
import { getSetting, listAllSchedule, listCatchUp, listConnections, listInvites } from '../storage/db';
import { announce } from '../ui/announce';
import { useScreenHeading } from '../ui/useScreenHeading';

/** C Wrapped (F26): your own conference in a few cards. Built on this phone from your data; nothing is sent. */
export function RecapScreen({ programme, onBack }: { programme: Programme; onBack: () => void }) {
  const heading = useScreenHeading<HTMLHeadingElement>();
  const [recap, setRecap] = useState<Recap | null>(null);

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
          .filter((i) => i.start >= d && i.start < d + 86_400_000 && (i.type === 'session' || i.type === 'protected' || i.type === 'invite'))
          .map((i) => ({ id: i.id, start: i.start, end: i.end, kind: i.type === 'session' ? 'session' : i.type === 'protected' ? 'protected' : 'meetup' }));
        breathers += planDay(busy, d, level, undefined, skipped).breaks.filter((b) => b.end < Date.now()).length;
      }
      setRecap(buildRecap(programme, items, await listInvites(), await listConnections(), await listCatchUp(), breathers));
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
