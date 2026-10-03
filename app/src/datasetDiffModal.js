/**
 * Dataset version comparison (click on a dataset-to-dataset edge): one unified table with added and
 * removed rows tinted, changed cells shown as an inline word diff, and unchanged runs collapsed.
 */

import { displayCell } from './datasetContent.js';
import { diffDatasets, diffCellText } from './datasetDiff.js';

/** Visible data rows rendered per step; "Show more" adds another step. */
const RENDER_STEP = 500;

const STATUS_LABEL = { added: 'Added row', removed: 'Removed row', changed: 'Edited row', same: 'Unchanged row' };

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function plural(n, word) {
  return `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
}

function summaryChipsHtml(summary) {
  const chips = [];
  if (summary.addedRows) chips.push(['added', `${plural(summary.addedRows, 'row')} added`]);
  if (summary.removedRows) chips.push(['removed', `${plural(summary.removedRows, 'row')} removed`]);
  if (summary.changedRows) {
    chips.push(['changed', `${plural(summary.changedRows, 'row')} edited · ${plural(summary.changedCells, 'cell')}`]);
  }
  if (summary.addedColumns.length) {
    chips.push(['added', `Added ${summary.addedColumns.length === 1 ? 'column' : 'columns'}: ${summary.addedColumns.join(', ')}`]);
  }
  if (summary.removedColumns.length) {
    chips.push(['removed', `Removed ${summary.removedColumns.length === 1 ? 'column' : 'columns'}: ${summary.removedColumns.join(', ')}`]);
  }
  if (!chips.length) chips.push(['same', 'No differences']);
  return chips.map(([kind, text]) => `<span class="dataset-diff-chip dataset-diff-chip--${kind}">${escapeHtml(text)}</span>`).join('');
}

function changedCellHtml(oldValue, newValue) {
  const parts = diffCellText(oldValue, newValue);
  if (!parts) {
    return `<del class="dataset-diff-old">${escapeHtml(displayCell(oldValue)) || '&nbsp;'}</del>`
      + `<ins class="dataset-diff-new">${escapeHtml(displayCell(newValue)) || '&nbsp;'}</ins>`;
  }
  return parts.map((p) => {
    const text = escapeHtml(p.text);
    if (p.type === 'remove') return `<del class="dataset-diff-word">${text}</del>`;
    if (p.type === 'add') return `<ins class="dataset-diff-word">${text}</ins>`;
    return text;
  }).join('');
}

/**
 * @param {{ before: object|null, after: object|null, fromName: string, toName: string }} options
 *   before/after are Dataset contents ({ headers, rows, rowIds }); null when a node has no content.
 */
export function openDatasetDiffModal({ before, after, fromName, toName }) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'dataset-diff-title');
  overlay.innerHTML = `
    <div class="modal-panel modal-panel--edge-detail modal-panel--dataset-diff">
      <div class="modal-header">
        <h2 id="dataset-diff-title" class="modal-title">${escapeHtml(fromName)} → ${escapeHtml(toName)}</h2>
        <button type="button" class="modal-close" aria-label="Close">×</button>
      </div>
      <div class="dataset-diff-toolbar"></div>
      <div class="modal-body modal-body--diff"></div>
    </div>
  `;
  const toolbarEl = overlay.querySelector('.dataset-diff-toolbar');
  const bodyEl = overlay.querySelector('.modal-body--diff');

  function close() {
    document.removeEventListener('keydown', onKeydown);
    overlay.remove();
    document.body.style.overflow = '';
  }
  function onKeydown(e) {
    if (e.key === 'Escape') close();
  }
  overlay.querySelector('.modal-close').addEventListener('click', close);
  document.addEventListener('keydown', onKeydown);
  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);

  if (!before || !after) {
    toolbarEl.remove();
    bodyEl.innerHTML = '<p class="prompt-detail-placeholder">One or both datasets have no content. Cannot compare.</p>';
    return;
  }

  const diff = diffDatasets(before, after);
  const { columns, rows, summary } = diff;
  const hasChanges = summary.addedRows + summary.removedRows + summary.changedRows > 0
    || summary.addedColumns.length > 0 || summary.removedColumns.length > 0;
  let onlyChanges = hasChanges;
  let renderLimit = RENDER_STEP;
  /** Start indexes (into `rows`) of unchanged runs the user expanded while "Only changes" is on. */
  const expandedRuns = new Set();

  toolbarEl.innerHTML = `
    <div class="dataset-diff-chips" aria-live="polite">${summaryChipsHtml(summary)}</div>
    <label class="dataset-diff-only-changes"><input type="checkbox" ${onlyChanges ? 'checked' : ''} /> Only changes</label>
    ${diff.method === 'content' && rows.length ? '<p class="dataset-diff-note">These versions don\'t share row IDs, so rows were matched by content. Edited rows may show as removed + added.</p>' : ''}
  `;
  toolbarEl.querySelector('.dataset-diff-only-changes input').addEventListener('change', (e) => {
    onlyChanges = e.target.checked;
    renderLimit = RENDER_STEP;
    renderTable();
  });

  function cellHtml(row, column, columnIndex) {
    const beforeRow = row.before >= 0 ? before.rows[row.before] : null;
    const afterRow = row.after >= 0 ? after.rows[row.after] : null;
    if (column.status === 'added') {
      return `<td class="dataset-diff-cell dataset-diff-cell--col-added">${afterRow ? escapeHtml(displayCell(afterRow[column.after])) : ''}</td>`;
    }
    if (column.status === 'removed') {
      return `<td class="dataset-diff-cell dataset-diff-cell--col-removed">${beforeRow ? escapeHtml(displayCell(beforeRow[column.before])) : ''}</td>`;
    }
    if (row.status === 'removed') return `<td class="dataset-diff-cell">${escapeHtml(displayCell(beforeRow[column.before]))}</td>`;
    if (row.changed.includes(columnIndex)) {
      return `<td class="dataset-diff-cell dataset-diff-cell--changed">${changedCellHtml(beforeRow[column.before], afterRow[column.after])}</td>`;
    }
    return `<td class="dataset-diff-cell">${escapeHtml(displayCell(afterRow[column.after]))}</td>`;
  }

  function rowHtml(row) {
    const rowNumber = row.after >= 0 ? row.after + 1 : row.before + 1;
    const numberTitle = row.status === 'removed' ? 'Row number in Before' : 'Row number in After';
    return `<tr class="dataset-diff-row dataset-diff-row--${row.status}">`
      + `<td class="dataset-diff-num" title="${STATUS_LABEL[row.status]} · ${numberTitle}">${rowNumber}</td>`
      + columns.map((column, k) => cellHtml(row, column, k)).join('')
      + '</tr>';
  }

  function renderTable() {
    const colSpan = columns.length + 1;
    const head = '<tr><th class="dataset-diff-num">#</th>'
      + columns.map((c) => {
        const title = c.status === 'added' ? 'Added column' : c.status === 'removed' ? 'Removed column' : '';
        return `<th class="dataset-diff-col dataset-diff-col--${c.status}"${title ? ` title="${title}"` : ''}>${escapeHtml(c.name)}</th>`;
      }).join('')
      + '</tr>';
    const body = [];
    let shown = 0;
    let truncated = false;
    for (let k = 0; k < rows.length && !truncated;) {
      if (onlyChanges && rows[k].status === 'same' && !expandedRuns.has(k)) {
        let end = k;
        while (end < rows.length && rows[end].status === 'same') end += 1;
        body.push(`<tr class="dataset-diff-gap"><td colspan="${colSpan}"><button type="button" class="dataset-diff-gap-btn" data-run-start="${k}">⋯ Show ${plural(end - k, 'unchanged row')} ⋯</button></td></tr>`);
        k = end;
        continue;
      }
      if (shown >= renderLimit) {
        truncated = true;
        break;
      }
      body.push(rowHtml(rows[k]));
      shown += 1;
      const startsExpandedRun = onlyChanges && expandedRuns.has(k);
      k += 1;
      if (startsExpandedRun) {
        while (k < rows.length && rows[k].status === 'same' && shown < renderLimit) {
          body.push(rowHtml(rows[k]));
          shown += 1;
          k += 1;
        }
        if (k < rows.length && rows[k].status === 'same') truncated = true;
      }
    }
    if (truncated) {
      body.push(`<tr class="dataset-diff-gap"><td colspan="${colSpan}"><button type="button" class="dataset-diff-more-btn">Show ${RENDER_STEP.toLocaleString()} more rows</button></td></tr>`);
    }
    if (!rows.length) body.push(`<tr class="dataset-diff-gap"><td colspan="${colSpan}">Both versions have no rows.</td></tr>`);
    bodyEl.innerHTML = `<table class="dataset-diff-table"><thead>${head}</thead><tbody>${body.join('')}</tbody></table>`;
    bodyEl.querySelectorAll('.dataset-diff-gap-btn').forEach((btn) => btn.addEventListener('click', () => {
      expandedRuns.add(Number(btn.dataset.runStart));
      renderTable();
    }));
    bodyEl.querySelector('.dataset-diff-more-btn')?.addEventListener('click', () => {
      renderLimit += RENDER_STEP;
      renderTable();
    });
  }

  renderTable();
}
