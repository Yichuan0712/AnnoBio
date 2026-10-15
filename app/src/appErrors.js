/**
 * Uncaught renderer errors (renderer.js's window 'error' / 'unhandledrejection' handlers) on the
 * desktop app: forward details to the main-process Log, keep its error badge, and show a corner
 * notice when no project is open. Handled errors keep their existing dialogs.
 */
import './appErrors.css';

const MAX_ERRORS = 100;
let errors = [];
let nextId = 1;
const listeners = new Set();
let panelAvailable = false;
let noticeEl = null;
let noticeDismissed = false;

function describe(context, error) {
  if (error instanceof Error) {
    const headline = `${error.name || 'Error'}: ${error.message}`;
    return { headline, details: error.stack && error.stack.includes(error.message) ? error.stack : `${headline}\n${error.stack || ''}`.trim() };
  }
  let text = context;
  if (typeof error === 'string') text = error;
  else if (error != null) {
    try { text = error.message || JSON.stringify(error); } catch (_) { text = String(error); }
  }
  return { headline: text, details: text };
}

function formatTime(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

/** Plain text for pasting into an issue or a chat: when, what caught it, and the stack. */
export function formatAppError(entry) {
  const repeated = entry.count > 1 ? ` (×${entry.count}, last ${formatTime(entry.lastAt)})` : '';
  return `[${formatTime(entry.firstAt)}${repeated}] ${entry.context}\n${entry.details}`;
}

function notify() {
  for (const listener of listeners) listener(errors);
  renderNotice();
}

export function reportAppError(context, error) {
  const { headline, details } = describe(context, error);
  window.electronAPI?.reportRendererError?.({ context, details })?.catch((err) => {
    console.error('Write frontend error to log:', err);
  });
  const key = `${context}\n${details}`;
  const now = Date.now();
  const existing = errors.find((entry) => entry.key === key);
  if (existing) {
    existing.count += 1;
    existing.lastAt = now;
    errors = [existing, ...errors.filter((entry) => entry !== existing)];
  } else {
    errors = [{ id: nextId++, key, context, headline, details, count: 1, firstAt: now, lastAt: now }, ...errors].slice(0, MAX_ERRORS);
  }
  noticeDismissed = false;
  notify();
}

/** Calls `listener(errors)` now and on every change; returns an unsubscribe function. */
export function subscribeAppErrors(listener) {
  listeners.add(listener);
  listener(errors);
  return () => listeners.delete(listener);
}

/** True while a project is open and its Log tab is available. */
export function setLogPanelAvailable(available) {
  panelAvailable = available;
  renderNotice();
}

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    const label = button.textContent;
    button.textContent = 'Copied';
    setTimeout(() => { if (button.isConnected) button.textContent = label; }, 1200);
  } catch (err) {
    console.error('Copy error details:', err);
  }
}

function renderNotice() {
  if (panelAvailable || !errors.length || noticeDismissed) {
    noticeEl?.remove();
    return;
  }
  if (!noticeEl) {
    noticeEl = document.createElement('div');
    noticeEl.className = 'app-error-notice';
    noticeEl.setAttribute('role', 'alert');
    noticeEl.innerHTML = `
      <div class="app-error-notice__header">
        <span class="app-error-notice__title"></span>
        <button type="button" class="app-error-notice__close" aria-label="Dismiss">×</button>
      </div>
      <p class="app-error-notice__message"></p>
      <button type="button" class="btn btn-secondary app-error-copy">Copy details</button>
    `;
    noticeEl.querySelector('.app-error-notice__close').addEventListener('click', () => {
      noticeDismissed = true;
      renderNotice();
    });
    noticeEl.querySelector('.app-error-copy').addEventListener('click', (event) => {
      copyText(errors.map(formatAppError).join('\n\n'), event.currentTarget);
    });
  }
  noticeEl.querySelector('.app-error-notice__title').textContent = errors.length > 1 ? `Something went wrong (${errors.length} errors)` : 'Something went wrong';
  noticeEl.querySelector('.app-error-notice__message').textContent = errors[0].headline;
  if (!noticeEl.isConnected) document.body.appendChild(noticeEl);
}
