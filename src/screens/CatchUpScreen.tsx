import { useEffect, useState } from 'preact/hooks';
import type { CatchUpItem } from '../model/types';
import { dayLabel } from '../programme/programme';
import { deleteCatchUp, listCatchUp } from '../storage/db';
import { announce } from '../ui/announce';
import { keepingFocus } from '../ui/focus';
import { useScreenHeading } from '../ui/useScreenHeading';

/** Catch up later (F23): sessions you couldn't be in, with their papers, for the train home. */
export function CatchUpScreen({ onBack }: { onBack: () => void }) {
  const heading = useScreenHeading<HTMLHeadingElement>();
  const [list, setList] = useState<CatchUpItem[]>([]);
  const load = () => listCatchUp().then(setList);
  useEffect(() => {
    void load();
  }, []);

  return (
    <section class="stack" aria-labelledby="catchup-heading">
      <div class="actions">
        <button type="button" class="button quiet" onClick={onBack}>
          <span aria-hidden="true">←</span> <span class="visually-hidden">Back to </span>You
        </button>
      </div>
      <div>
        <h2 id="catchup-heading" ref={heading} tabIndex={-1}>
          Catch up later
        </h2>
        <p>Nobody can be in two rooms at once. These are the ones you couldn’t fit in, with links to the papers.</p>
      </div>
      {list.length === 0 ? (
        <p class="muted">Nothing here yet. When two of your sessions clash, the one you skip lands here.</p>
      ) : (
        <ul class="sessions">
          {list.map((c) => (
            <li key={c.programmeSessionId} class="card stack">
              <div>
                <h3 class="session-title" dir="auto">{c.title}</h3>
                <p class="muted">{dayLabel(c.start, 'long')}</p>
              </div>
              {c.papers && c.papers.length > 0 ? (
                <ul class="papers">
                  {c.papers.map((p) => (
                    <li key={p.url}>
                      <a href={p.url} target="_blank" rel="noopener noreferrer">
                        {p.title}
                      <span class="visually-hidden"> (opens in a new tab)</span></a>
                    </li>
                  ))}
                </ul>
              ) : (
                <p class="muted">No paper links for this one.</p>
              )}
              <div class="actions">
                <button
                  type="button"
                  class="button quiet"
                  aria-label={`Remove ${c.title} from Catch up later`}
                  onClick={() => keepingFocus(async () => {
                    await deleteCatchUp(c.programmeSessionId);
                    await load();
                    announce('Removed.');
                  })}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
