import { useMemo, useState } from 'preact/hooks';
import { knownTag, resolveTag, searchKnownTags } from '../model/tags';
import { LIMITS } from '../model/text';
import type { Tag } from '../model/types';
import { announce } from '../ui/announce';

interface Props {
  value: Tag[];
  onChange: (tags: Tag[]) => void;
}

export function TagPicker({ value, onChange }: Props) {
  const [query, setQuery] = useState('');
  const selected = new Set(value.map((t) => t.key));
  const full = value.length >= LIMITS.tags;
  const matches = useMemo(() => searchKnownTags(query), [query]);
  const typed = resolveTag(query);
  const canAddTyped = typed && !selected.has(typed.key) && !matches.some((m) => m.id === typed.key);

  function add(tag: Tag) {
    if (selected.has(tag.key)) return;
    if (full) {
      announce(`That’s the limit of ${LIMITS.tags} topics. Remove one to add another.`);
      return;
    }
    onChange([...value, tag]);
    announce(`Added ${tag.label}.`);
  }
  function remove(tag: Tag) {
    onChange(value.filter((t) => t.key !== tag.key));
    announce(`Removed ${tag.label}.`);
  }
  function toggle(tag: Tag) {
    if (selected.has(tag.key)) remove(tag);
    else add(tag);
  }

  return (
    <fieldset class="stack">
      <legend>Topics you’re into</legend>
      <p class="hint" id="tags-hint">
        Pick up to {LIMITS.tags}. When you connect with someone, the ones you share light up.
      </p>

      <div>
        <h3 id="my-topics">Your topics ({value.length} of {LIMITS.tags})</h3>
        {value.length === 0 ? (
          <p class="muted">None yet.</p>
        ) : (
          <ul class="chips" aria-labelledby="my-topics">
            {value.map((t) => (
              <li key={t.key}>
                <button type="button" class="chip selected" onClick={() => remove(t)} aria-label={`Remove ${t.label}`}>
                  <span>{t.label}</span>
                  <span class="x" aria-hidden="true">×</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div class="field">
        <label for="tag-search">Find or add a topic</label>
        <input
          id="tag-search"
          type="search"
          value={query}
          autocomplete="off"
          aria-describedby="tags-hint"
          maxLength={LIMITS.tagLabel}
          onInput={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              const first = matches[0];
              if (canAddTyped && typed) add(typed);
              else if (first) add(knownTag(first));
              setQuery('');
            }
          }}
        />
      </div>

      {canAddTyped && typed && (
        <button
          type="button"
          class="button secondary"
          disabled={full}
          onClick={() => {
            add(typed);
            setQuery('');
          }}
        >
          Add “{typed.label}” as your own topic
        </button>
      )}

      <ul class="chips" aria-label={query ? 'Matching topics' : 'Suggested topics'}>
        {matches.map((t) => {
          const on = selected.has(t.id);
          return (
            <li key={t.id}>
              <button type="button" class="chip" aria-pressed={on} onClick={() => toggle(knownTag(t))} disabled={!on && full}>
                {on && <span aria-hidden="true">✓</span>}
                <span>{t.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {matches.length === 0 && !canAddTyped && <p class="muted">No matches.</p>}
    </fieldset>
  );
}
