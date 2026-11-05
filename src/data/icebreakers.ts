// Icebreaker bank (F17): short lines written ahead of time, grouped by situation. No AI at runtime.
// Tone: calm, a little curious, easy to say out loud. Each one leaves the other person an easy answer.

export type Situation = 'after-talk' | 'lunch' | 'hallway' | 'poster' | 'side-by-side' | 'closer';

export const ICEBREAKERS: Record<Situation, readonly string[]> = {
  'after-talk': [
    'What was the one idea from that you’d steal?',
    'Did anything in there surprise you?',
    'Which talk would you send a friend?',
    'Was that what you expected from the title?',
    'Anything in there you’d push back on?',
  ],
  lunch: [
    'What’s been the best session so far for you?',
    'Is this your first time here, or a regular?',
    'What are you working on at the moment?',
    'Anything on the program you’re saving for later?',
    'Found any good quiet spots yet?',
  ],
  hallway: [
    'Heading to the same one?',
    'Which session are you off to next?',
    'Have you been to anything good today?',
    'Is it me, or are the rooms really far apart?',
  ],
  poster: [
    'What’s the bit you’d most like feedback on?',
    'How did you end up working on this?',
    'What would you do next with more time?',
  ],
  'side-by-side': [
    'Mind if I sit here?',
    'Want to compare notes after?',
    'No need to chat, just nice to sit with someone.',
  ],
  closer: [
    'I’m going to grab a coffee before the next one. Good to meet you.',
    'I’ll let you get to your next session. Let’s connect?',
    'I need a quick breather. Catch you later?',
  ],
};

/** A topic-aware opener for talk about the talk (F24). Uses only the session's own title and topic names. */
export function talkOpeners(title: string, topic: string | null): string[] {
  const short = title.length > 60 ? `${title.slice(0, 57).trimEnd()}…` : title;
  const lines = [`What did you make of “${short}”?`, ICEBREAKERS['after-talk'][0]!];
  if (topic) lines.push(`Did any of it change how you think about ${topic.toLowerCase()}?`);
  else lines.push(ICEBREAKERS['after-talk'][1]!);
  return lines;
}

/** A conversation starter for a meetup kind (or just after a session), picked steadily for `key`. */
export function openerFor(kind: string, key: string): string {
  const situation: Situation =
    kind === 'meal' || kind === 'break-together'
      ? 'lunch'
      : kind === 'sit-together'
        ? 'side-by-side'
        : kind === 'arrive-together' || kind === 'walk-over'
          ? 'hallway'
          : 'after-talk'; // 'catch-up' and 'after-session'
  return pickLine(situation, key);
}

/** One line for a situation, picked steadily for a given key so it doesn't change on every render. */
export function pickLine(situation: Situation, key: string): string {
  const list = ICEBREAKERS[situation];
  const h = [...key].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 11);
  return list[h % list.length]!;
}

/**
 * Things to talk about with one person (shown on their page). Built only from what they chose to share and your
 * own plans: a topic you share, one of theirs, a session you're both going to, then a general line. At most three.
 */
export function personOpeners(o: { shared: string[]; theirs: string[]; bothSessions: string[]; key: string }): string[] {
  const out: string[] = [];
  const short = (t: string) => (t.length > 50 ? `${t.slice(0, 47).trimEnd()}…` : t);
  if (o.shared[0]) out.push(`You’re both into ${o.shared[0]}. What got you into it?`);
  const other = o.theirs.find((t) => !o.shared.includes(t));
  if (other) out.push(`What are you working on in ${other} at the moment?`);
  if (o.bothSessions[0]) out.push(`You’re both going to “${short(o.bothSessions[0])}”. Compare notes after?`);
  out.push(pickLine('lunch', o.key));
  return out.slice(0, 3);
}
