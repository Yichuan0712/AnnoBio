import { createStartupScreen } from './startupScreen.js';
import { waitForBackend } from './backendConfig.js';

const startup = createStartupScreen();
performance.mark('annobio:startup');

// Do not await at module scope: the first page paint and Electron's ready-to-show must
// happen before the backend starts. The editor loads independently of this small entry.
async function start() {
  let phase = 'editor';
  try {
    const backendReady = waitForBackend(45000);
    const { initializeApp } = await import('./renderer.js');
    performance.mark('annobio:editor-loaded');
    phase = 'workspace';
    await initializeApp({ onStartupStatus: (text) => startup.status(text) });
    performance.mark('annobio:workspace-mounted');
    startup.status('Preparing workspace…');
    phase = 'backend';
    if (!await backendReady) throw new Error('The local workspace did not become ready. Please try again.');
    performance.mark('annobio:ready');
    performance.measure('annobio:startup-duration', 'annobio:startup', 'annobio:ready');
    startup.finish();
  } catch (error) {
    console.error('AnnoBio startup:', error);
    window.electronAPI?.reportRendererError?.({ context: 'Startup', details: error?.stack || String(error) })?.catch(() => {});
    const message = phase === 'editor'
      ? 'Some application files could not be loaded. Please try again.'
      : phase === 'backend'
        ? 'The local workspace did not become ready. Please try again.'
        : 'The workspace could not be opened. Please try again.';
    startup.fail({ message });
  }
}
start();
