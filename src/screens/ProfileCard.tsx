import type { SharedProfile } from '../model/types';

/** Shows a profile as another person would see it. All text is rendered as text, never as HTML. */
export function ProfileCard({ profile, headingLevel = 3 }: { profile: SharedProfile; headingLevel?: 2 | 3 }) {
  const H = headingLevel === 2 ? 'h2' : 'h3';
  const line = [profile.role, profile.company].filter(Boolean).join(' · ');
  return (
    <div class="card stack">
      <div>
        <H dir="auto">{profile.displayName || 'Your name'}</H>
        {line && <p class="muted">{line}</p>}
      </div>
      {profile.tags && profile.tags.length > 0 && (
        <ul class="chips" aria-label="Topics">
          {profile.tags.map((t) => (
            <li key={t.key} class="chip static">
              {t.label}
            </li>
          ))}
        </ul>
      )}
      {profile.links && profile.links.length > 0 && (
        <ul aria-label="Links">
          {profile.links.map((href) => (
            <li key={href}>
              <a href={href} target="_blank" rel="noopener noreferrer">
                {href.replace(/^https:\/\//, '').replace(/\/$/, '')}
              <span class="visually-hidden"> (opens in a new tab)</span></a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
