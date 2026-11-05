import { useEffect, useRef, useState } from 'preact/hooks';
import { randomId } from '../model/ids';
import { cleanText, LIMITS } from '../model/text';
import type { Connection, FollowUp, Note } from '../model/types';
import { deleteFollowUp, deleteNote, listFollowUps, listNotes, putFollowUp, putNote } from '../storage/db';
import { holdFocus, keepingFocus } from '../ui/focus';
import { announce } from '../ui/announce';

/** One-tap chips for quick capture (F07). Short, about the moment, never about the person's looks or background. */
export const CHIPS = ['Met at lunch', 'Same session', 'Same topic', 'Swap papers', 'Coffee later', 'Follow up'] as const;
const FOLLOW_UP_CHIP = 'Follow up';
const MAX_FOLLOW_UP = 200;

interface Props {
  connection: Connection;
  /** Right after connecting: show the quick-capture prompt first. */
  quickCapture?: boolean;
}

/** Notes and follow-ups about one person (F07, F09). Only on this phone; never shared. */
export function NotesSection({ connection: c, quickCapture }: Props) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [follow, setFollow] = useState<FollowUp[]>([]);
  const [chips, setChips] = useState<Set<string>>(new Set());
  const [text, setText] = useState('');
  const [captured, setCaptured] = useState(!quickCapture);
  const [fuText, setFuText] = useState('');
  const [fuDue, setFuDue] = useState('');
  const noteInput = useRef<HTMLTextAreaElement>(null);
  const name = c.profile.displayName;

  const load = async () => {
    setNotes((await listNotes(c.id)).sort((a, b) => b.createdAt - a.createdAt));
    setFollow(await listFollowUps(c.id));
  };
  useEffect(() => {
    void load();
  }, [c.id]);

  const toggleChip = (ch: string) =>
    setChips((s) => {
      const n = new Set(s);
      if (n.has(ch)) n.delete(ch);
      else n.add(ch);
      return n;
    });

  async function saveNote(e: Event) {
    e.preventDefault();
    const restore = holdFocus(); // quick capture closes after saving: keep focus in the notes area
    const clean = cleanText(text, LIMITS.note);
    if (!clean && chips.size === 0) return;
    await putNote({ id: randomId(), connectionId: c.id, text: clean, chips: [...chips], createdAt: Date.now() });
    if (chips.has(FOLLOW_UP_CHIP) && !follow.some((f) => !f.done)) {
      await putFollowUp({ id: randomId(), connectionId: c.id, text: `Follow up with ${name}`, done: false });
    }
    setText('');
    setChips(new Set());
    setCaptured(true);
    await load();
    announce(chips.has(FOLLOW_UP_CHIP) ? 'Note saved, and a follow-up added.' : 'Note saved.');
    restore();
  }

  async function addFollowUp(e: Event) {
    e.preventDefault();
    const clean = cleanText(fuText, MAX_FOLLOW_UP);
    if (!clean) return;
    const due = fuDue ? new Date(`${fuDue}T09:00`).getTime() : undefined;
    await putFollowUp({ id: randomId(), connectionId: c.id, text: clean, due: due && Number.isFinite(due) ? due : undefined, done: false });
    setFuText('');
    setFuDue('');
    await load();
    announce('Follow-up added.');
  }

  async function toggleDone(f: FollowUp) {
    await putFollowUp({ ...f, done: !f.done });
    await load();
    announce(f.done ? 'Marked not done.' : 'Done. Nice.');
  }

  const noteForm = (
    <form class="stack" onSubmit={saveNote}>
      <fieldset>
        <legend>{quickCapture && !captured ? `Quick note about meeting ${name}?` : 'Add a note'}</legend>
        <ul class="chips" aria-label="Quick tags">
          {CHIPS.map((ch) => (
            <li key={ch}>
              <button type="button" class="chip" aria-pressed={chips.has(ch)} onClick={() => toggleChip(ch)}>
                {chips.has(ch) && <span aria-hidden="true">✓</span>}
                <span>{ch}</span>
              </button>
            </li>
          ))}
        </ul>
      </fieldset>
      <div class="field">
        <label for="note-text">Note (optional)</label>
        <textarea id="note-text" ref={noteInput} rows={3} maxLength={LIMITS.note} value={text} onInput={(e) => setText(e.currentTarget.value)} />
      </div>
      <div class="actions">
        <button type="submit" class="button" disabled={!text.trim() && chips.size === 0}>
          Save note
        </button>
        {quickCapture && !captured && (
          <button type="button" class="button quiet" onClick={() => void keepingFocus(() => setCaptured(true))}>
            Skip
          </button>
        )}
      </div>
      <p class="hint">Only you can see your notes.</p>
    </form>
  );

  return (
    <>
      {quickCapture && !captured && <section class="card stack quick-capture">{noteForm}</section>}

      <section class="stack" aria-labelledby="followups-heading">
        <h3 id="followups-heading">Follow-ups</h3>
        {follow.length === 0 ? (
          <p class="muted">Nothing to follow up yet.</p>
        ) : (
          <ul class="followups">
            {follow.map((f) => (
              <li key={f.id} class={f.done ? 'done' : ''}>
                <label class="check">
                  <input type="checkbox" checked={f.done} onChange={() => void toggleDone(f)} />
                  <span>
                    {f.text}
                    {f.due && <span class="muted"> · by {new Date(f.due).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</span>}
                  </span>
                </label>
                <button
                  type="button"
                  class="button quiet"
                  aria-label={`Delete follow-up: ${f.text}`}
                  onClick={() => keepingFocus(async () => {
                    await deleteFollowUp(f.id);
                    await load();
                    announce('Deleted.');
                  })}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
        <form class="followup-form" onSubmit={addFollowUp}>
          <div class="field">
            <label for="fu-text">Add a follow-up</label>
            <input id="fu-text" type="text" maxLength={MAX_FOLLOW_UP} value={fuText} placeholder={`For example: send ${name} the paper`} onInput={(e) => setFuText(e.currentTarget.value)} />
          </div>
          <div class="field">
            <label for="fu-due">By (optional)</label>
            <input id="fu-due" type="date" value={fuDue} onInput={(e) => setFuDue(e.currentTarget.value)} />
          </div>
          <button type="submit" class="button secondary" disabled={!fuText.trim()}>
            Add
          </button>
        </form>
      </section>

      <section class="stack" aria-labelledby="notes-heading">
        <h3 id="notes-heading">Your notes</h3>
        {notes.length > 0 && (
          <ul class="notes">
            {notes.map((n) => (
              <li key={n.id} class="card stack">
                {n.chips.length > 0 && (
                  <ul class="chips" aria-label="Tags">
                    {n.chips.map((ch) => (
                      <li key={ch} class="chip static">
                        {ch}
                      </li>
                    ))}
                  </ul>
                )}
                {n.text && <p>{n.text}</p>}
                <div class="note-foot">
                  <span class="muted">{new Date(n.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</span>
                  <button
                    type="button"
                    class="button quiet"
                    aria-label="Delete this note"
                    onClick={() => keepingFocus(async () => {
                      await deleteNote(n.id);
                      await load();
                      announce('Note deleted.');
                    })}
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {(captured || !quickCapture) && noteForm}
      </section>
    </>
  );
}
