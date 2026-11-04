import { toSharedProfile } from '../model/profile';
import type { Profile } from '../model/types';
import { useScreenHeading } from '../ui/useScreenHeading';
import { ProfileCard } from './ProfileCard';

export function MeScreen({ profile, onEdit }: { profile: Profile; onEdit: () => void }) {
  const heading = useScreenHeading<HTMLHeadingElement>();
  return (
    <section class="stack" aria-labelledby="me-heading">
      <h2 id="me-heading" ref={heading} tabIndex={-1}>
        You
      </h2>
      <section class="stack" aria-labelledby="me-preview">
        <h3 id="me-preview">What people see when you connect</h3>
        <ProfileCard profile={toSharedProfile(profile)} />
      </section>
      <div class="actions">
        <button type="button" class="button" onClick={onEdit}>
          Edit profile
        </button>
      </div>
      <p class="hint">Stored only on this device. No account, no sign-in.</p>
    </section>
  );
}
