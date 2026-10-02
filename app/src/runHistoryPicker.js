function formatEntry(entry, index, currentId) {
  const when = entry.createdAt ? new Date(entry.createdAt).toLocaleString() : 'Unknown time';
  const summary = entry.summary || {};
  const title = entry.kind === 'run'
    ? [summary.promptName, ...(summary.datasetNames || [])].filter(Boolean).join(' · ')
    : [summary.codeLine, ...(summary.datasetNames || [])].filter(Boolean).join(' · ');
  const count = summary.rowCount != null ? `${summary.rowCount} rows` : (summary.branchCount != null ? `${summary.branchCount} branches` : '');
  return { number: `#${index + 1}`, when, title, detail: [count, entry.status || ''].filter(Boolean).join(' · '), current: entry.id === currentId };
}

/** Add History immediately before the pane toggle in a Run/Process window. */
export function attachRunHistoryPicker({ overlay, loadEntries, onSelect, onDelete, isDisabled = () => false }) {
  const panel = overlay.querySelector('.modal-panel');
  const actions = overlay.querySelector('.modal-header-actions');
  if (!panel || !actions || !loadEntries || !onSelect) return { close() {} };
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'modal-history-button';
  button.textContent = 'History';
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-expanded', 'false');
  actions.insertBefore(button, actions.querySelector('.modal-pane-toggle') || actions.firstChild);
  const popup = document.createElement('div');
  popup.className = 'modal-history-popup';
  popup.setAttribute('role', 'dialog');
  popup.setAttribute('aria-label', 'Run history');
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
    try {
      const { entries = [], currentId = '' } = await loadEntries();
      if (!entries.length) {
        const empty = document.createElement('p');
        empty.className = 'modal-history-popup__empty';
        empty.textContent = 'No previous runs.';
        popup.appendChild(empty);
      }
      entries.forEach((entry, index) => {
        const item = formatEntry(entry, index, currentId);
        const container = document.createElement('div');
        container.className = 'modal-history-popup__row';
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'modal-history-popup__item';
        row.disabled = item.current || isDisabled();
        row.setAttribute('aria-current', item.current ? 'true' : 'false');
        const title = document.createElement('strong');
        title.textContent = `${item.current ? '✓ ' : ''}${item.number} · ${item.when}`;
        const description = document.createElement('span');
        description.textContent = item.title || 'Saved inputs';
        const detail = document.createElement('small');
        detail.textContent = item.detail;
        row.append(title, description, detail);
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
          remove.className = 'modal-history-popup__delete';
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
