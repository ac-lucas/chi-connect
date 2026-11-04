import { useScreenHeading } from '../ui/useScreenHeading';

export function PeopleScreen() {
  const heading = useScreenHeading<HTMLHeadingElement>();
  return (
    <section class="stack" aria-labelledby="people-heading">
      <h2 id="people-heading" ref={heading} tabIndex={-1}>
        People
      </h2>
      <div class="card stack">
        <p class="lede">Nobody here yet. That’s fine.</p>
        <p>
          When you meet someone, you scan each other’s code and they show up here, along with the topics you share.
          Nothing is shared until you’ve both said yes.
        </p>
      </div>
    </section>
  );
}
