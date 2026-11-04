import { Component, type ComponentChildren } from 'preact';

interface State {
  failed: boolean;
}

/** If a screen breaks, show a calm message with a way out instead of a blank or frozen page. */
export class ErrorBoundary extends Component<{ children: ComponentChildren }, State> {
  override state: State = { failed: false };

  override componentDidCatch() {
    this.setState({ failed: true });
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main id="main" class="stack">
        <h1 class="app-name">Pebble</h1>
        <div class="card stack" role="alert">
          <p class="lede">Something went wrong on this screen.</p>
          <p>Your things are still saved on this phone. Reloading usually sorts it.</p>
          <div class="actions">
            <button type="button" class="button" onClick={() => location.reload()}>
              Reload
            </button>
          </div>
        </div>
      </main>
    );
  }
}
