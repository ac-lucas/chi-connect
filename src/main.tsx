import { render } from 'preact';
import { App } from './App';
import { ErrorBoundary } from './ui/ErrorBoundary';
import './styles.css';

// Right after an update, a page still running the old version can ask for a file the new version renamed.
// Vite reports that as 'vite:preloadError'; reload once to pick up the new version. The flag stops a reload loop.
// Keyboard or pointer? After tapping Remove, focus moves to the next row's button (so keyboard and screen reader
// users keep their place), and some browsers then draw a focus ring on it. The ring is for keyboard use: hide it on
// buttons while the last input was a tap or click, and bring it back with the first key press.
document.addEventListener('pointerdown', () => (document.documentElement.dataset.input = 'pointer'), { capture: true, passive: true });
document.addEventListener('keydown', () => (document.documentElement.dataset.input = 'keyboard'), { capture: true });

window.addEventListener('vite:preloadError', (event) => {
  let reloaded = false;
  try {
    reloaded = sessionStorage.getItem('reloaded-for-update') === '1';
    sessionStorage.setItem('reloaded-for-update', '1');
  } catch {
    // Storage blocked: reloading once is still the best move, but only if we can't tell.
  }
  if (!reloaded) {
    event.preventDefault();
    location.reload();
  }
});
window.addEventListener('load', () => {
  // Clear the flag once a page has loaded cleanly, so a later update can reload again.
  setTimeout(() => {
    try {
      sessionStorage.removeItem('reloaded-for-update');
    } catch {
      // ignore
    }
  }, 10_000);
});

render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
  document.getElementById('app')!,
);
