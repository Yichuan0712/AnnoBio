/**
 * Uncaught renderer errors (renderer.js's window 'error' / 'unhandledrejection' handlers) on the
 * desktop app: a small store, the bottom panel's Errors tab, and a corner notice for when no
 * project is open and the panel doesn't exist. Errors the code handles itself keep their own
 * dialogs (showAlert) — this is only for bugs.
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

export function clearAppErrors() {
  errors = [];
  notify();
}

/** Calls `listener(errors)` now and on every change; returns an unsubscribe function. */
export function subscribeAppErrors(listener) {
  listeners.add(listener);
  listener(errors);
  return () => listeners.delete(listener);
}

/** True while a project is open, i.e. the bottom panel exists to hold the Errors tab. */
export function setErrorsPanelAvailable(available) {
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

/** Renders the Errors tab into `container`; newest first, stack collapsed under each entry. */
export function mountErrorsPanel(container) {
  const view = document.createElement('div');
  view.className = 'app-errors';
  container.appendChild(view);
  view.innerHTML = `
    <div class="app-errors__toolbar">
      <span class="app-errors__status"></span>
      <button type="button" class="btn btn-secondary app-errors__copy-all">Copy all</button>
      <button type="button" class="btn btn-secondary app-errors__clear">Clear</button>
    </div>
    <ul class="app-errors__list"></ul>
  `;
  const listEl = view.querySelector('.app-errors__list');
  const statusEl = view.querySelector('.app-errors__status');
  const copyAllBtn = view.querySelector('.app-errors__copy-all');
  const clearBtn = view.querySelector('.app-errors__clear');
  const expanded = new Set();

  copyAllBtn.addEventListener('click', () => copyText(errors.map(formatAppError).join('\n\n'), copyAllBtn));
  clearBtn.addEventListener('click', clearAppErrors);
  listEl.addEventListener('toggle', (event) => {
    const id = Number(event.target.closest('[data-error-id]')?.dataset.errorId);
    if (event.target.open) expanded.add(id); else expanded.delete(id);
  }, true);
  listEl.addEventListener('click', (event) => {
    const button = event.target.closest('.app-error-copy');
    if (!button) return;
    const entry = errors.find((item) => item.id === Number(button.closest('[data-error-id]').dataset.errorId));
    if (entry) copyText(formatAppError(entry), button);
  });

  return subscribeAppErrors((list) => {
    statusEl.textContent = list.length ? `${list.length} error${list.length === 1 ? '' : 's'}` : 'No errors';
    copyAllBtn.disabled = clearBtn.disabled = list.length === 0;
    listEl.replaceChildren(...list.map((entry) => {
      const item = document.createElement('li');
      item.className = 'app-error';
      item.dataset.errorId = String(entry.id);
      const details = document.createElement('details');
      details.open = expanded.has(entry.id);
      const summary = document.createElement('summary');
      const time = document.createElement('span');
      time.className = 'app-error__time';
      time.textContent = formatTime(entry.lastAt);
      const message = document.createElement('span');
      message.className = 'app-error__message';
      message.textContent = entry.headline;
      const context = document.createElement('span');
      context.className = 'app-error__context';
      context.textContent = entry.context;
      summary.append(time, message, context);
      if (entry.count > 1) {
        const count = document.createElement('span');
        count.className = 'app-error__count';
        count.textContent = `×${entry.count}`;
        summary.appendChild(count);
      }
      const stack = document.createElement('pre');
      stack.className = 'app-error__stack';
      stack.textContent = entry.details;
      details.append(summary, stack);
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'btn btn-secondary app-error-copy';
      copy.textContent = 'Copy';
      item.append(details, copy);
      return item;
    }));
  });
}
