/**
 * The bottom panel's Log tab (desktop): backend output and frontend errors, streamed from the main
 * process (backendLog.js). Follows new output while scrolled to the bottom, like a terminal.
 */
import './backendLogPanel.css';
import { subscribeAppErrors } from './appErrors.js';

const MAX_LINES = 2000;
const FOLLOW_SLACK_PX = 24;
// Tracebacks, uvicorn's "ERROR:" lines and a final "ValueError: ..." line read as errors; stderr
// alone doesn't, since uvicorn logs its ordinary INFO lines there too.
const ERROR_LINE = /Traceback \(most recent call last\)|\b(ERROR|CRITICAL)\b|^\w*(Error|Exception)\b[:\s]/;

function formatTime(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

export function mountBackendLogPanel(container) {
  const api = window.electronAPI;
  const view = document.createElement('div');
  view.className = 'backend-log';
  container.appendChild(view);
  view.innerHTML = `
    <div class="backend-log__toolbar">
      <span class="backend-log__status"></span>
    </div>
    <div class="backend-log__output" role="log" tabindex="0">
      <p class="backend-log__empty">No log output yet.</p>
    </div>
  `;
  const statusEl = view.querySelector('.backend-log__status');
  const outputEl = view.querySelector('.backend-log__output');
  const emptyEl = view.querySelector('.backend-log__empty');

  // A renderer reloaded under an older main process (npm start keeps running) has no log bridge.
  if (!api?.getBackendLog || !api?.onBackendLog) {
    emptyEl.textContent = 'Restart AnnoBio to see logs here.';
    return;
  }

  let entries = [];
  let lastId = 0;
  let follow = true;
  let visible = false;
  let errorCount = 0;

  function updateState() {
    emptyEl.hidden = entries.length > 0;
    const count = entries.length ? `${entries.length} line${entries.length === 1 ? '' : 's'}` : '';
    statusEl.textContent = [count, errorCount ? `${errorCount} frontend error${errorCount === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ');
  }

  function lineElement(entry) {
    const row = document.createElement('div');
    row.className = 'backend-log__line';
    if (entry.stream === 'frontend') row.classList.add('backend-log__line--error');
    else if (entry.stream === 'app') row.classList.add('backend-log__line--app');
    else if (ERROR_LINE.test(entry.text)) row.classList.add('backend-log__line--error');
    else if (entry.highlight) row.classList.add('backend-log__line--heading');
    const time = document.createElement('span');
    time.className = 'backend-log__time';
    time.textContent = formatTime(entry.time);
    const text = document.createElement('span');
    text.className = 'backend-log__text';
    text.textContent = `${entry.stream === 'frontend' ? '[Frontend] ' : ''}${entry.text}`;
    row.append(time, text);
    return row;
  }

  function scrollToEnd() {
    if (follow) outputEl.scrollTop = outputEl.scrollHeight;
  }

  function isAtEnd() {
    return outputEl.scrollHeight - outputEl.scrollTop - outputEl.clientHeight < FOLLOW_SLACK_PX;
  }

  // Output that arrived while the tab was hidden: land on the newest line as soon as it's shown,
  // before anything measures the scroll position left over from before.
  function syncVisible() {
    const now = outputEl.clientHeight > 0;
    if (now && !visible) scrollToEnd();
    visible = now;
  }

  function append(batch) {
    const fresh = (batch || []).filter((entry) => entry.id > lastId);
    if (!fresh.length) return;
    lastId = fresh[fresh.length - 1].id;
    // Measured here, before the new lines land, as well as on scroll: the scroll event for moving
    // away from (or back to) the end can arrive after these lines, when the end has moved on.
    syncVisible();
    if (visible) follow = isAtEnd();
    entries = entries.concat(fresh).slice(-MAX_LINES);
    const fragment = document.createDocumentFragment();
    fresh.forEach((entry) => fragment.appendChild(lineElement(entry)));
    outputEl.appendChild(fragment);
    let excess = outputEl.childElementCount - 1 - MAX_LINES; // the first child is the empty-state note
    while (excess-- > 0) emptyEl.nextElementSibling.remove();
    updateState();
    scrollToEnd();
  }

  outputEl.addEventListener('scroll', () => { follow = isAtEnd(); });
  new ResizeObserver(() => {
    syncVisible();
    scrollToEnd();
  }).observe(outputEl);

  // Subscribe before reading the tail; batches that arrive meanwhile are merged in by id after it.
  let loaded = false;
  const early = [];
  api.onBackendLog((batch) => (loaded ? append(batch) : early.push(...batch)));
  api.getBackendLog()
    .then((tail) => {
      loaded = true;
      append(tail);
      append(early);
    })
    .catch((err) => {
      loaded = true;
      console.error('Load log:', err);
    });
  subscribeAppErrors((list) => {
    errorCount = list.length;
    updateState();
  });
  updateState();
}
