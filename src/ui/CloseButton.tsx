/**
 * The ✕ at the top of a screen opened from the tabs, so leaving never means scrolling to the bottom.
 * Phone and browser Back do the same (see App). Placed first in the screen, floated to the top right.
 */
export function CloseButton({ onClick, label = 'Close' }: { onClick: () => void; label?: string }) {
  return (
    <button type="button" class="close-x" aria-label={label} onClick={onClick}>
      <span aria-hidden="true">✕</span>
    </button>
  );
}
