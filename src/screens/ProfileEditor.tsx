import { useRef, useState } from 'preact/hooks';
import { checkDraft, toSharedProfile, type DraftErrors, type DraftField, type ProfileDraft } from '../model/profile';
import { LIMITS } from '../model/text';
import type { ShareChoices } from '../model/types';
import { announce } from '../ui/announce';
import { useScreenHeading } from '../ui/useScreenHeading';
import { ProfileCard } from './ProfileCard';
import { TagPicker } from './TagPicker';

interface Props {
  initial: ProfileDraft;
  mode: 'create' | 'edit';
  onSave: (draft: ProfileDraft) => Promise<void>;
  onCancel?: () => void;
}

const SHARE_LABELS: Record<keyof ShareChoices, string> = {
  role: 'What you do',
  company: 'Where you’re from',
  links: 'Links',
  tags: 'Topics',
};

export function ProfileEditor({ initial, mode, onSave, onCancel }: Props) {
  const [draft, setDraft] = useState<ProfileDraft>(initial);
  const [errors, setErrors] = useState<DraftErrors>({});
  const [saving, setSaving] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const heading = useScreenHeading<HTMLHeadingElement>();

  const set = <K extends keyof ProfileDraft>(key: K, value: ProfileDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const errorProps = (field: DraftField) =>
    errors[field] ? { 'aria-invalid': true as const, 'aria-describedby': `${field}-error` } : {};
  const errorText = (field: DraftField) =>
    errors[field] ? (
      <p id={`${field}-error`} class="error">
        {errors[field]}
      </p>
    ) : null;

  async function submit(e: Event) {
    e.preventDefault();
    const { clean, errors: errs } = checkDraft(draft);
    setErrors(errs);
    const firstBad = Object.keys(errs)[0];
    if (firstBad) {
      announce('A couple of things need a look.');
      form.current?.querySelector<HTMLElement>(`#${firstBad}`)?.focus();
      return;
    }
    setSaving(true);
    try {
      await onSave(clean);
    } catch {
      announce('That didn’t save. Try again in a moment.');
    } finally {
      setSaving(false);
    }
  }

  const preview = toSharedProfile(checkDraft(draft).clean);

  return (
    <form ref={form} class="stack" onSubmit={submit} noValidate>
      <div>
        <h2 ref={heading} tabIndex={-1}>
          {mode === 'create' ? 'Hi. Let’s set you up.' : 'Edit your profile'}
        </h2>
        {mode === 'create' && (
          <p class="lede">
            Takes a minute. Only your name is required. Everything stays on this phone until you connect with someone.
          </p>
        )}
      </div>

      <div class="field">
        <label for="displayName">Your name</label>
        <input
          id="displayName"
          type="text"
          autocomplete="name"
          maxLength={LIMITS.displayName}
          value={draft.displayName}
          onInput={(e) => set('displayName', e.currentTarget.value)}
          required
          {...errorProps('displayName')}
        />
        {errorText('displayName')}
      </div>

      <div class="field">
        <label for="role">What you do</label>
        <span class="hint" id="role-hint">
          For example: PhD student, UX researcher, designer.
        </span>
        <input
          id="role"
          type="text"
          autocomplete="organization-title"
          maxLength={LIMITS.role}
          aria-describedby="role-hint"
          value={draft.role}
          onInput={(e) => set('role', e.currentTarget.value)}
        />
      </div>

      <div class="field">
        <label for="company">Where you’re from</label>
        <span class="hint" id="company-hint">
          A university, company or city. Whatever you’re happy to share.
        </span>
        <input
          id="company"
          type="text"
          autocomplete="organization"
          maxLength={LIMITS.company}
          aria-describedby="company-hint"
          value={draft.company}
          onInput={(e) => set('company', e.currentTarget.value)}
        />
      </div>

      <fieldset class="stack">
        <legend>Links (optional)</legend>
        <p class="hint">A website, portfolio or social profile. Up to {LIMITS.links}.</p>
        {draft.links.map((link, i) => (
          <div class="field" key={i}>
            <label for={`link${i}`}>Link {i + 1}</label>
            <input
              id={`link${i}`}
              type="url"
              inputMode="url"
              autocomplete="url"
              maxLength={LIMITS.link}
              value={link}
              onInput={(e) => {
                const links = [...draft.links];
                links[i] = e.currentTarget.value;
                set('links', links);
              }}
              {...errorProps(`link${i}`)}
            />
            {errorText(`link${i}`)}
          </div>
        ))}
      </fieldset>

      <TagPicker value={draft.tags} onChange={(tags) => set('tags', tags)} />

      <fieldset>
        <legend>Shared when you connect</legend>
        <p class="hint">Your name is always shared. Choose the rest.</p>
        {(Object.keys(SHARE_LABELS) as (keyof ShareChoices)[]).map((key) => (
          <label class="check" key={key}>
            <input
              type="checkbox"
              checked={draft.share[key]}
              onChange={(e) => set('share', { ...draft.share, [key]: e.currentTarget.checked })}
            />
            {SHARE_LABELS[key]}
          </label>
        ))}
      </fieldset>

      <section aria-labelledby="preview-heading" class="stack">
        <h3 id="preview-heading">What people see when you connect</h3>
        <ProfileCard profile={preview} />
      </section>

      <div class="actions">
        <button type="submit" class="button" disabled={saving}>
          {saving ? 'Saving…' : mode === 'create' ? 'Save and continue' : 'Save changes'}
        </button>
        {onCancel && (
          <button type="button" class="button secondary" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
