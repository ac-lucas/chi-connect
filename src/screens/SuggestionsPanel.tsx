import { useEffect, useState } from 'preact/hooks';
import { pickLine, talkOpeners } from '../data/icebreakers';
import { knownTagById } from '../model/tags';
import { randomId } from '../model/ids';
import type { Connection, EnergyLevel, ScheduleItem } from '../model/types';
import { atMinutes, dayKey, nextDay, timeRange, timeRangeSpoken } from '../programme/programme';
import type { Programme } from '../programme/types';
import type { Busy } from '../schedule/breaks';
import { alsoGoing, namesList } from '../schedule/overlap';
import { findClashes, freeGaps, inSomething, pickWildcard, recentlyEnded, topicLine } from '../schedule/suggest';
import { deleteScheduleItem, dismiss, getSetting, putCatchUp, putScheduleItem, setSetting } from '../storage/db';
import { announce } from '../ui/announce';
import { keepingFocus } from '../ui/focus';
import type { InviteDraft } from './InviteScreen';

interface Props {
  programme: Programme;
  items: ScheduleItem[];
  connections: Connection[];
  level: EnergyLevel;
  /** Midnight of the day being shown. */
  day: number;
  isToday: boolean;
  myTopics: string[];
  onInvite: (d: InviteDraft) => void;
  onChanged: () => void;
}

const NUDGE_CAP: Record<EnergyLevel, number> = { steady: 2, 'up-for-it': 3, charged: 5 };
const MIN = 60_000;
const clock = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/**
 * Suggestions for the day: a clash to settle (F23), talk about the talk (F24) or a nudge with an icebreaker (F16, F17),
 * and a wildcard session (F15) when energy is Charged. Quiet mode, snooze and the daily cap (F18) apply to everything
 * except clashes, which are about your own plan. Nothing shows during a session or protected time.
 */
export function SuggestionsPanel({ programme, items, connections, level, day, isToday, myTopics, onInvite, onChanged }: Props) {
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [quiet, setQuiet] = useState(false);
  const [snoozeUntil, setSnoozeUntil] = useState(0);
  const [, tick] = useState(0);

  const load = async () => {
    setDismissed((await getSetting('dismissed')) ?? []);
    setQuiet(!!(await getSetting('quietMode')));
    setSnoozeUntil((await getSetting('snoozeUntil')) ?? 0);
  };
  useEffect(() => {
    void load();
    const t = setInterval(() => tick((n) => n + 1), 60_000); // time moves on: re-check what fits
    return () => clearInterval(t);
  }, []);

  const now = Date.now();
  const saved = items.filter((i) => i.type === 'session');
  const daySaved = saved.filter((i) => i.start >= day && i.start < nextDay(day));
  const quietNow = quiet || snoozeUntil > now || (isToday && inSomething(items, now));
  const seenToday = dismissed.filter((k) => k.startsWith(`seen:${dayKey(now)}:`)).length;

  async function hide(key: string, message?: string) {
    await dismiss(key);
    await load();
    if (message) announce(message);
  }

  // F23: a clash between two saved sessions. Keep one; the other goes to Catch up later with its papers.
  const clash = findClashes(daySaved).find(([a, b]) => !dismissed.includes(`clash:${a.id}:${b.id}`));
  async function keep(keepIt: ScheduleItem, other: ScheduleItem) {
    const s = programme.sessions.find((x) => x.id === other.programmeSessionId);
    await putCatchUp({ programmeSessionId: other.programmeSessionId ?? other.id, title: other.title, start: other.start, papers: s?.papers, reason: 'clash', addedAt: Date.now() });
    await deleteScheduleItem(other.id);
    announce(`Kept ${keepIt.title}. ${other.title} is in Catch up later${s?.papers?.length ? ', with its papers' : ''}.`);
    onChanged();
  }

  // F24 / F16: a session just ended.
  const ended = isToday ? recentlyEnded(saved, now) : null;
  const endedSession = ended && programme.sessions.find((s) => s.id === ended.programmeSessionId);
  const going = ended ? alsoGoing(ended.programmeSessionId, connections) : [];
  const topic = endedSession?.topics[0] ? (knownTagById(endedSession.topics[0])?.label ?? null) : null;
  const talkKey = ended ? `talk:${ended.id}` : '';
  const nudgeKey = ended ? `nudge:${ended.id}` : '';
  const seenKey = ended ? `seen:${dayKey(now)}:${ended.id}` : '';
  // Under the daily cap, or this one already counted (it was shown): counting it must not hide it again.
  const underCap = seenToday < NUDGE_CAP[level] || (!!seenKey && dismissed.includes(seenKey));
  const showTalk = !!ended && going.length > 0 && !dismissed.includes(talkKey) && !quietNow && underCap;
  const showNudge = !!ended && going.length === 0 && !dismissed.includes(nudgeKey) && !quietNow && underCap;
  useEffect(() => {
    if ((showTalk || showNudge) && seenKey && !dismissed.includes(seenKey)) void dismiss(seenKey).then(load); // counts towards the daily cap
  }, [showTalk, showNudge, seenKey]);

  // F15: wildcard, one a day, when Charged and there's a free gap.
  const wildKey = `wildcard:${dayKey(day)}`;
  let wildcard: ReturnType<typeof pickWildcard> = null;
  // Snooze and "not during a session" apply here too (NUD-2), not just quiet mode.
  if (level === 'charged' && !quietNow && !dismissed.includes(wildKey) && !daySaved.some((s) => s.fromWildcard)) {
    const busy: Busy[] = items
      .filter((i) => i.start >= day && i.start < nextDay(day) && i.type !== 'catch-up')
      .map((i) => ({ id: i.id, start: i.start, end: i.end, kind: i.type === 'session' ? 'session' : i.type === 'protected' ? 'protected' : 'meetup' }));
    const from = isToday ? Math.max(now, atMinutes(day, 8 * 60)) : atMinutes(day, 8 * 60);
    const lastEnd = Math.max(atMinutes(day, 18 * 60), ...busy.map((b) => b.end));
    const gaps = freeGaps([...busy, { id: 'end', start: lastEnd, end: lastEnd + MIN, kind: 'session' }], from, 30);
    wildcard = pickWildcard(programme, gaps, myTopics, new Set(saved.map((s) => s.programmeSessionId ?? '')));
  }
  const wildGoing = wildcard ? alsoGoing(wildcard.session.id, connections) : [];

  async function addWildcard() {
    if (!wildcard) return;
    const s = wildcard.session;
    await putScheduleItem({ id: randomId(), type: 'session', source: 'user', programmeSessionId: s.id, title: s.title, place: s.room, start: s.start, end: s.end, fromWildcard: true });
    announce(`Added ${s.title}. Enjoy the detour.`);
    onChanged();
  }

  async function snooze() {
    await setSetting('snoozeUntil', Date.now() + 60 * MIN);
    await load();
    announce('Snoozed for an hour.');
  }

  const controls = (key: string) => (
    <div class="actions">
      <button type="button" class="button quiet" onClick={() => void keepingFocus(() => hide(key, 'Got it.'))}>
        Not now
      </button>
      <button type="button" class="button quiet" onClick={() => void snooze()}>
        Snooze 1 hour
      </button>
    </div>
  );

  if (!clash && !showTalk && !showNudge && !wildcard) return null;

  return (
    <section class="stack" aria-label="Suggestions">
      {clash && (
        <div data-row class="card stack heads-up">
          <p>
            <strong>Two at once:</strong> {clash[0].title} and {clash[1].title} overlap. Keep one, and the other goes to
            Catch up later{programme.sessions.find((s) => s.id === clash[1].programmeSessionId)?.papers?.length ? ' with its papers' : ''}.
          </p>
          <div class="actions">
            <button type="button" class="button secondary" aria-label={`Keep ${clash[0].title}`} onClick={() => void keepingFocus(() => keep(clash[0], clash[1]))}>
              Keep {short(clash[0].title)}
            </button>
            <button type="button" class="button secondary" aria-label={`Keep ${clash[1].title}`} onClick={() => void keepingFocus(() => keep(clash[1], clash[0]))}>
              Keep {short(clash[1].title)}
            </button>
            <button type="button" class="button quiet" onClick={() => void hide(`clash:${clash[0].id}:${clash[1].id}`, 'Keeping both.')}>
              Keep both
            </button>
          </div>
        </div>
      )}

      {showTalk && ended && (
        <div data-row class="card stack suggestion">
          <p>
            <strong>{ended.title}</strong> just ended. You and {namesList(going)} were both there. Ten minutes to compare notes?
          </p>
          <ul class="openers" aria-label="Things to ask">
            {talkOpeners(ended.title, topic).map((o) => (
              <li key={o}>{o}</li>
            ))}
          </ul>
          <div class="actions">
            <button
              type="button"
              class="button"
              onClick={() => {
                const start = Math.ceil((Date.now() + 5 * MIN) / (5 * MIN)) * 5 * MIN;
                onInvite({ kinds: ['catch-up'], start, end: start + 10 * MIN, sessionId: ended.programmeSessionId, sessionTitle: ended.title, room: ended.place, preselect: going.map((g) => g.id) });
              }}
            >
              Invite {going.length === 1 ? going[0]!.profile.displayName : 'them'}
            </button>
          </div>
          {controls(talkKey)}
        </div>
      )}

      {showNudge && ended && (
        <div data-row class="card stack suggestion">
          <p>
            <strong>{ended.title}</strong> just ended.
            {endedSession && topicLine(programme, endedSession) ? ` ${topicLine(programme, endedSession)}` : ''}
          </p>
          <p>
            If you get chatting on the way out: <em>{pickLine('after-talk', ended.id)}</em>
          </p>
          {controls(nudgeKey)}
        </div>
      )}

      {wildcard && (
        <div data-row class="card stack suggestion wildcard">
          <p>
            <strong>Wildcard.</strong> You’re Charged and have a free stretch {wildcard.gap.start <= now + MIN ? 'right now' : `from ${clock(wildcard.gap.start)}`}.
            {' '}<strong>{wildcard.session.title}</strong>
            {wildcard.near ? `, next door to your interest in ${wildcard.near}` : ''}. Fancy a detour?
          </p>
          <p class="muted">
            <span aria-hidden="true">{timeRange(wildcard.session.start, wildcard.session.end)}</span>
            <span class="visually-hidden">{timeRangeSpoken(wildcard.session.start, wildcard.session.end)}</span>
            {wildcard.session.room && ` · ${wildcard.session.room}`}
          </p>
          {wildGoing.length > 0 && <p class="also-going">{namesList(wildGoing)} {wildGoing.length === 1 ? 'is' : 'are'} going.</p>}
          <div class="actions">
            <button type="button" class="button" onClick={() => void addWildcard()}>
              Add it
            </button>
            <button
              type="button"
              class="button secondary"
              onClick={() =>
                onInvite({
                  kinds: ['sit-together', 'arrive-together', 'walk-over'],
                  start: wildcard!.session.start,
                  end: wildcard!.session.end,
                  sessionId: wildcard!.session.id,
                  sessionTitle: wildcard!.session.title,
                  room: wildcard!.session.room,
                  preselect: wildGoing.map((g) => g.id),
                })
              }
            >
              Invite someone along
            </button>
            <button type="button" class="button quiet" onClick={() => void keepingFocus(() => hide(wildKey, 'No wildcard today.'))}>
              Not today
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function short(t: string) {
  return t.length > 28 ? `${t.slice(0, 26).trimEnd()}…` : t;
}
