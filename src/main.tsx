import { render } from 'preact';
import { App } from './App';
import { ErrorBoundary } from './ui/ErrorBoundary';
import './styles.css';

// Right after an update, a page still running the old version can ask for a file the new version renamed.
// Vite reports that as 'vite:preloadError'; reload once to pick up the new version. The flag stops a reload loop.
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
