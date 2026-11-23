import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { CloseButton } from '../ui/CloseButton';
import { knownTagById } from '../model/tags';
import type { ScheduleItem } from '../model/types';
import { dayLabel, MAX_RESULTS, overlaps, programDays, searchSessions, timeRange, timeRangeSpoken } from '../program/program';
import { FORMAT_LABELS, type Program, type ProgramSession } from '../program/types';
import { deleteScheduleItem, listAllSchedule, listConnections, putScheduleItem } from '../storage/db';
import { alsoGoing, namesList } from '../schedule/overlap';
import type { Connection } from '../model/types';
import { announce } from '../ui/announce';
import { useScreenHeading } from '../ui/useScreenHeading';
import { savedId } from '../schedule/starter';
import { useLive } from '../ui/useLive';
import { ProgramNote } from './ProgramNote';

interface Props {
  program: Program;
  initialDay: number;
  onDone: () => void;
}

/** Quick-add (F10): search and tap. No browsing screens. */
export function AddSessionsScreen({ program, initialDay, onDone }: Props) {
  const heading = useScreenHeading<HTMLHeadingElement>();
  const days = programDays(program);
  const [day, setDay] = useState(days.includes(initialDay) ? initialDay : days[0]!);
  const [query, setQuery] = useState('');
  const saved = useLive(async () => (await listAllSchedule()).filter((s) => s.type === 'session'), ['schedule']) ?? [];
  const people = useLive(listConnections, ['connections']) ?? [];

  const results = useMemo(() => searchSessions(program, query, day), [program, query, day]);
  // The spoken result count waits for a pause in typing, so it isn't read out on every keystroke.
  const countText =
    results.length === 0 ? 'No sessions match.' : results.length >= MAX_RESULTS ? `Showing the first ${MAX_RESULTS}. Search to narrow it down.` : `${results.length} sessions.`;
  const [spokenCount, setSpokenCount] = useState(countText);
  useEffect(() => {
    const t = setTimeout(() => setSpokenCount(countText), 600);
    return () => clearTimeout(t);
  }, [countText]);
  const savedBySession = new Map(saved.map((s) => [s.programSessionId, s]));

  // Taps on a session whose save is still in flight are ignored, so a double tap can't save it twice.
  const inFlight = useRef(new Set<string>());
  async function toggle(s: ProgramSession) {
    if (inFlight.current.has(s.id)) return;
    inFlight.current.add(s.id);
    try {
      await toggleNow(s);
    } finally {
      inFlight.current.delete(s.id);
    }
  }
  async function toggleNow(s: ProgramSession) {
    // Decide from what's stored right now, not the screen's copy, which can lag a quick second tap.
    const existing = (await listAllSchedule()).find((x) => x.type === 'session' && x.programSessionId === s.id);
    if (existing) {
      await deleteScheduleItem(existing.id);
      announce(`Removed ${s.title}.`);
    } else {
      await putScheduleItem({
        id: savedId(s.id), // one per program session: saving it again overwrites, never duplicates
        type: 'session',
        source: 'user',
        programSessionId: s.id,
        title: s.title,
        place: s.room,
        start: s.start,
        end: s.end,
      });
      const clash = saved.find((x) => overlaps(x, s));
      announce(clash ? `Added ${s.title}. It overlaps ${clash.title}.` : `Added ${s.title}.`);
    }
  }

  return (
    <section class="stack" aria-labelledby="add-heading">
      <CloseButton onClick={onDone} label="Done adding sessions" />
      <div>
        <h2 id="add-heading" ref={heading} tabIndex={-1}>
          Add sessions
        </h2>
        <ProgramNote program={program} />
      </div>

      <div class="segmented" role="group" aria-label="Day">
        {days.map((d) => (
          <button key={d} type="button" aria-pressed={d === day} onClick={() => setDay(d)}>
            {dayLabel(d)}
          </button>
        ))}
      </div>

      <div class="field">
        <label for="session-search">Search by title, topic or room</label>
        <input id="session-search" type="search" value={query} autocomplete="off" onInput={(e) => setQuery(e.currentTarget.value)} />
      </div>

      <p class="visually-hidden" role="status">
        {spokenCount}
      </p>
      {results.length >= MAX_RESULTS && <p class="hint">Showing the first {MAX_RESULTS}, earliest first. Search to narrow it down.</p>}
      {results.length === 0 ? (
        <p class="muted">Nothing matches that on {dayLabel(day, 'long')}.</p>
      ) : (
        <ul class="sessions">
          {results.map((s) => {
            const isSaved = savedBySession.has(s.id);
            const clash = !isSaved && saved.find((x) => overlaps(x, s));
            return (
              <li key={s.id} class={`session-row card${isSaved ? ' saved' : ''}`}>
                <div class="session-main">
                  <p class="session-time">
                    <span aria-hidden="true">{timeRange(s.start, s.end)}</span>
                    <span class="visually-hidden">{timeRangeSpoken(s.start, s.end)}</span>
                    {s.room && <span class="muted"> · {s.room}</span>}
                  </p>
                  <h3 class="session-title" dir="auto">{s.title}</h3>
                  <p class="muted session-meta">
                    {FORMAT_LABELS[s.format]}
                    {s.topics.length > 0 && ` · ${s.topics.map((t) => knownTagById(t)?.label ?? t).join(', ')}`}
                  </p>
                  {clash && <p class="hint">Overlaps {clash.title}.</p>}
                  {(() => {
                    const going = alsoGoing(s.id, people);
                    return going.length ? <p class="also-going">Going: {namesList(going)}</p> : null;
                  })()}
                </div>
                <button
                  type="button"
                  class={`button ${isSaved ? '' : 'secondary'}`}
                  aria-pressed={isSaved}
                  aria-label={`${isSaved ? "Added" : "Add"} ${s.title}`}
                  onClick={() => void toggle(s)}
                >
                  {isSaved ? (
                    <>
                      <span aria-hidden="true">✓</span> Added
                    </>
                  ) : (
                    'Add'
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div class="actions">
        <button type="button" class="button" onClick={onDone}>
          Done
        </button>
      </div>
    </section>
  );
}
