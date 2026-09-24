/** Dataset reference for Process code. Copying a variable does not change the input. */
export function openProcessDatasetsDialog(bindings) {
  const dialog = document.createElement('dialog');
  dialog.className = 'modal-panel process-datasets-dialog';
  dialog.setAttribute('aria-label', 'Available datasets');
  dialog.innerHTML = `
    <div class="modal-header">
      <h2 class="modal-title">Available datasets</h2>
      <button type="button" class="modal-close" aria-label="Close">&times;</button>
    </div>
    <div class="process-datasets-dialog__body">
      <p class="process-datasets-dialog__intro">Copy a Python variable and paste it into your code to use that dataset. Your primary input is <code>df</code>.</p>
      <input type="search" class="process-datasets-dialog__search" placeholder="Find a dataset or variable…" aria-label="Find a dataset or variable" autofocus>
      <div class="process-datasets-dialog__scroll">
        <table class="process-datasets-dialog__table">
          <thead><tr><th scope="col">Dataset</th><th scope="col">Python variable</th><th scope="col"><span class="process-datasets-dialog__action-label">Copy</span></th></tr></thead>
          <tbody></tbody>
        </table>
        <p class="process-datasets-dialog__empty" hidden>No matching datasets.</p>
      </div>
      <p class="process-datasets-dialog__status" role="status" aria-live="polite"></p>
    </div>
  `;
  const body = dialog.querySelector('tbody');
  const status = dialog.querySelector('[role="status"]');
  const rows = bindings.map((binding) => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td><div class="process-datasets-dialog__dataset"><span class="run-detail-ws-option-color" aria-hidden="true"></span><div><span class="process-datasets-dialog__name"></span><span class="process-datasets-dialog__primary" hidden>Primary input</span></div></div></td>
      <td><code></code></td>
      <td><button type="button" class="btn btn-secondary process-datasets-dialog__copy">Copy variable</button></td>
    `;
    row.querySelector('.run-detail-ws-option-color').style.background = binding.color || 'transparent';
    row.querySelector('.process-datasets-dialog__name').textContent = binding.name || 'Dataset';
    row.querySelector('.process-datasets-dialog__primary').hidden = !binding.primary;
    row.querySelector('code').textContent = binding.alias;
    const copyButton = row.querySelector('button');
    copyButton.setAttribute('aria-label', `Copy variable ${binding.alias}`);
    copyButton.addEventListener('click', async () => {
      copyButton.disabled = true;
      const copied = await copyVariable(binding.alias, dialog);
      copyButton.disabled = false;
      status.textContent = copied
        ? `Copied ${binding.alias}. Paste it into your Python code.`
        : 'Could not copy. Select the Python variable and copy it manually.';
    });
    body.appendChild(row);
    return { row, searchText: `${binding.name} ${binding.alias}`.toLowerCase() };
  });
  const search = dialog.querySelector('input');
  function filter() {
    const query = search.value.trim().toLowerCase();
    let visible = 0;
    rows.forEach(({ row, searchText }) => {
      row.hidden = !searchText.includes(query);
      if (!row.hidden) visible += 1;
    });
    const empty = dialog.querySelector('.process-datasets-dialog__empty');
    empty.hidden = visible > 0;
    empty.textContent = bindings.length ? 'No matching datasets.' : 'No datasets are available on this canvas.';
  }
  search.addEventListener('input', filter);
  const close = () => dialog.close();
  dialog.querySelector('.modal-close').addEventListener('click', close);
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
  });
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.appendChild(dialog);
  filter();
  dialog.showModal();
  return close;
}

async function copyVariable(value, dialog) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch (_) { /* Fall back for desktop or browsers without clipboard permission. */ }
  const focused = document.activeElement;
  const input = document.createElement('textarea');
  input.value = value;
  input.readOnly = true;
  input.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
  // Keep the fallback inside the modal: elements outside a modal dialog are inert.
  dialog.appendChild(input);
  try {
    input.select();
    return document.execCommand('copy');
  } catch (_) {
    return false;
  } finally {
    input.remove();
    focused?.focus();
  }
}
