import { iconHistory } from './icons.js';
import { historyStatusLabel } from './runHistoryPresentation.js';

function formatEntry(entry, currentId) {
  const date = entry.createdAt ? new Date(entry.createdAt) : null;
  const when = date && !Number.isNaN(date.getTime())
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
    : 'Date unavailable';
  return {
    when,
    status: historyStatusLabel(entry.status),
    display: entry.display || {},
    current: entry.id === currentId,
  };
}

/** Add History immediately before the pane toggle in a Run/Process window. */
export function attachRunHistoryPicker({ overlay, loadEntries, onSelect, onDelete, isDisabled = () => false }) {
  const panel = overlay.querySelector('.modal-panel');
  const actions = overlay.querySelector('.modal-header-actions');
  if (!panel || !actions || !loadEntries || !onSelect) return { close() {} };
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'modal-history-button';
  button.append(iconHistory(16));
  button.setAttribute('aria-label', 'History');
  button.title = 'History';
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-expanded', 'false');
  actions.insertBefore(button, actions.querySelector('.modal-pane-toggle') || actions.firstChild);
  const popup = document.createElement('div');
  popup.className = 'modal-history-popup';
  popup.setAttribute('role', 'dialog');
  popup.setAttribute('aria-label', 'History');
  popup.hidden = true;
  panel.appendChild(popup);

  function close() {
    popup.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  }
  async function open() {
    if (isDisabled()) return;
    popup.replaceChildren();
    const heading = document.createElement('div');
    heading.className = 'modal-history-popup__heading';
    heading.textContent = 'History';
    popup.appendChild(heading);
    const hint = document.createElement('p');
    hint.className = 'modal-history-popup__hint';
    hint.textContent = 'Choose a result to restore its saved inputs and output.';
    popup.appendChild(hint);
    try {
      const { entries = [], currentId = '' } = await loadEntries();
      if (!entries.length) {
        const empty = document.createElement('p');
        empty.className = 'modal-history-popup__empty';
        empty.textContent = 'No history yet.';
        popup.appendChild(empty);
      }
      entries.forEach((entry) => {
        const item = formatEntry(entry, currentId);
        const container = document.createElement('div');
        container.className = 'modal-history-popup__row';
        container.classList.toggle('is-current', item.current);
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'modal-history-popup__item';
        row.disabled = item.current || isDisabled();
        row.setAttribute('aria-current', item.current ? 'true' : 'false');
        const top = document.createElement('span');
        top.className = 'modal-history-popup__top';
        const title = document.createElement('strong');
        title.textContent = item.when;
        const status = document.createElement('span');
        status.className = 'modal-history-popup__status';
        if (entry.status === 'completed') status.classList.add('modal-history-popup__status--completed');
        status.textContent = item.status;
        top.append(title, status);
        if (item.current) {
          const current = document.createElement('span');
          current.className = 'modal-history-popup__current';
          current.textContent = 'Current result';
          top.appendChild(current);
        }
        const description = document.createElement('span');
        description.className = 'modal-history-popup__fact';
        description.textContent = item.display.title || '';
        const input = document.createElement('span');
        input.className = 'modal-history-popup__fact';
        input.textContent = item.display.input || 'Input details unavailable';
        const output = document.createElement('span');
        output.className = 'modal-history-popup__fact';
        output.textContent = item.display.output || 'Result details unavailable';
        row.append(top);
        if (description.textContent) row.appendChild(description);
        row.append(input, output);
        if (item.display.meta) {
          const detail = document.createElement('small');
          detail.textContent = item.display.meta;
          row.appendChild(detail);
        }
        row.addEventListener('click', async () => {
          if (isDisabled()) return;
          row.disabled = true;
          try { await onSelect(entry.id); close(); } catch (error) {
            row.disabled = false;
            const message = document.createElement('p');
            message.className = 'modal-history-popup__error';
            message.textContent = String(error?.message || error);
            popup.appendChild(message);
          }
        });
        container.appendChild(row);
        if (onDelete) {
          const remove = document.createElement('button');
          remove.type = 'button';
          remove.className = 'btn btn-danger modal-history-popup__delete';
          remove.textContent = 'Delete';
          remove.title = item.current ? 'Select another result before deleting this record' : 'Delete this record and dependent history';
          remove.disabled = item.current || isDisabled();
          remove.addEventListener('click', async () => {
            remove.disabled = true;
            try {
              const deleted = await onDelete(entry.id);
              if (deleted) await open(); else remove.disabled = item.current || isDisabled();
            } catch (error) {
              remove.disabled = false;
              const message = document.createElement('p');
              message.className = 'modal-history-popup__error';
              message.textContent = String(error?.message || error);
              popup.appendChild(message);
            }
          });
          container.appendChild(remove);
        }
        popup.appendChild(container);
      });
    } catch (error) {
      const message = document.createElement('p');
      message.className = 'modal-history-popup__error';
      message.textContent = String(error?.message || error);
      popup.appendChild(message);
    }
    popup.hidden = false;
    button.setAttribute('aria-expanded', 'true');
  }

  button.addEventListener('click', (event) => {
    event.stopPropagation();
    if (popup.hidden) void open(); else close();
  });
  overlay.addEventListener('click', (event) => { if (!popup.contains(event.target) && event.target !== button) close(); });
  return { close, button };
}
