import { useScreenHeading } from '../ui/useScreenHeading';

const RHYTHM = [
  { glyph: '▲', name: 'Sprint', text: 'a session you’ve saved' },
  { glyph: '○', name: 'Breather', text: 'a gap to eat, walk or do nothing' },
  { glyph: '◆', name: 'Social', text: 'a meetup you said yes to' },
  { glyph: '■', name: 'Recharge', text: 'protected time, held for you' },
];

function greeting(hour: number): string {
  if (hour < 5) return 'Still up';
  if (hour < 12) return 'Morning';
  if (hour < 17) return 'Afternoon';
  return 'Evening';
}

export function TodayScreen({ name }: { name: string }) {
  const heading = useScreenHeading<HTMLHeadingElement>();
  const today = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  return (
    <section class="stack" aria-labelledby="today-heading">
      <div>
        <h2 id="today-heading" ref={heading} tabIndex={-1}>
          Today
        </h2>
        <p class="muted">{today}</p>
      </div>
      <div class="card stack">
        <p class="lede">
          {greeting(new Date().getHours())}, {name}. Your day is wide open.
        </p>
        <p>Save a few sessions and your day fills in around them, breathers and lunch included.</p>
      </div>
      <section aria-labelledby="rhythm-heading" class="stack">
        <h3 id="rhythm-heading">How your day is laid out</h3>
        <ul class="rhythm">
          {RHYTHM.map((r) => (
            <li key={r.name}>
              <span class="glyph" aria-hidden="true">
                {r.glyph}
              </span>
              <span>
                <strong>{r.name}</strong>: {r.text}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </section>
  );
}
