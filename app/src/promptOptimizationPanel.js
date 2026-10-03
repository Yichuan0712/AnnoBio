/**
 * The bottom panel's Prompt Optimization tab: each Prompt version family (promptOptimization.js) as a
 * table of versions with the Precision / Recall / F1 of the Scores that evaluated them (the same
 * numbers as the Score window's banner), so each round of changes can be compared.
 * Click a row to find its Prompt, Run and Score on the canvas.
 */
import * as XLSX from 'xlsx';
import './promptOptimizationPanel.css';
import { showAlert } from './alertModal.js';
import { buildPromptFamilies, familyRows, familySheetRows } from './promptOptimization.js';
import { buildFullScoreMetricsFromComparisonRows } from './agent/canvas/scoreComparisonPrf.js';

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const percent = (value) => (Number.isFinite(value) ? `${value.toFixed(1)}%` : '—');

function sanitizeFilename(name) {
  return String(name ?? '').replace(/[\r\n/:*?"<>|\\]/g, '_').trim() || 'prompt';
}

async function saveFamilyWorkbook(family, metrics) {
  const rows = familySheetRows(family, metrics);
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  for (let r = 1; r < rows.length; r += 1) {
    for (let c = 5; c <= 7; c += 1) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c })];
      if (cell?.t === 'n') cell.z = '0.0%';
    }
  }
  sheet['!cols'] = rows[0].map((_, c) => ({
    wch: Math.min(60, Math.max(10, ...rows.map((row) => String(row[c] ?? '').length + 2))),
  }));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Prompt optimization');
  const payload = XLSX.write(workbook, { bookType: 'xlsx', type: 'base64' });

  const fileName = `${sanitizeFilename(family.versions[0]?.name)} - prompt optimization.xlsx`;
  const api = window.electronAPI;
  if (api?.showSaveFileDialog && api?.writeFile) {
    const path = await api.showSaveFileDialog({
      title: 'Export Prompt Optimization',
      defaultPath: fileName,
      filters: [{ name: 'Excel', extensions: ['xlsx'] }],
    });
    if (path) await api.writeFile(path, payload, 'base64');
    return;
  }
  const blob = new Blob([Uint8Array.from(atob(payload), (c) => c.charCodeAt(0))], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(a.href);
}

/**
 * @param {HTMLElement} container the tab's container (workspacePanels.tabHost)
 * @param {{ getCanvasState: () => object, getScoreComparisonRows: (scoreId: string) => Promise<object[]>,
 *   focusNodes: (nodeIds: string[]) => void }} options
 * @returns {{ refresh: () => Promise<void> }}
 */
export function mountPromptOptimizationPanel(container, { getCanvasState, getScoreComparisonRows, focusNodes }) {
  const view = document.createElement('div');
  view.className = 'prompt-optimization';
  container.appendChild(view);
  let generation = 0;

  let lastRender = { families: [], metrics: new Map(), pending: true };

  function familyHtml(family, familyIndex, metrics, pending) {
    const rows = familyRows(family, metrics).map((row) => {
      const metric = (key) => (row.scoreId && pending ? '…' : percent(row[key]));
      return `<tr class="prompt-optimization__row${row.isVersionRow ? ' prompt-optimization__row--version' : ''}" tabindex="0" title="Locate on canvas" data-node-ids="${escapeHtml(row.nodeIds.join(','))}">
          <td class="prompt-optimization__version"><span class="prompt-optimization__tree">${escapeHtml(row.tree)}</span>${escapeHtml(row.name)}</td>
          <td class="prompt-optimization__muted">${escapeHtml(row.from)}</td>
          <td>${row.runId ? escapeHtml(row.run) : '<span class="prompt-optimization__muted">Not run</span>'}</td>
          <td>${row.scoreId ? escapeHtml(row.score) : (row.runId ? '<span class="prompt-optimization__muted">Not scored</span>' : '')}</td>
          <td class="prompt-optimization__muted">${row.scoreId ? escapeHtml(row.groundTruth || '—') : ''}</td>
          <td class="prompt-optimization__num">${row.scoreId ? metric('precision') : ''}</td>
          <td class="prompt-optimization__num">${row.scoreId ? metric('recall') : ''}</td>
          <td class="prompt-optimization__num prompt-optimization__f1">${row.scoreId ? metric('f1') : ''}</td>
        </tr>`;
    });
    return `<section class="prompt-optimization__family">
      <div class="prompt-optimization__header">
        <h3 class="prompt-optimization__title">${escapeHtml(family.versions[0]?.name || 'Prompt')}</h3>
        <button type="button" class="btn btn-secondary prompt-optimization__export" data-family-index="${familyIndex}"${pending ? ' disabled title="Waiting for Score results…"' : ''}>Export Excel</button>
      </div>
      <table class="prompt-optimization__table">
        <thead><tr>
          <th>Version</th><th>From</th><th>Run</th><th>Score</th><th>Ground truth</th>
          <th class="prompt-optimization__num">Precision</th><th class="prompt-optimization__num">Recall</th>
          <th class="prompt-optimization__num">F1</th>
        </tr></thead>
        <tbody>${rows.join('')}</tbody>
      </table>
    </section>`;
  }

  function render(families, metrics, pending) {
    lastRender = { families, metrics, pending };
    view.innerHTML = families.length
      ? families.map((family, index) => familyHtml(family, index, metrics, pending)).join('')
      : '<p class="prompt-optimization__empty">No prompt versions to compare yet. Run a prompt and score it, then add a new version or apply a Review.</p>';
  }

  async function refresh() {
    const current = ++generation;
    const families = buildPromptFamilies(getCanvasState());
    const metrics = new Map();
    render(families, metrics, true);
    const scoreIds = families.flatMap((family) => family.versions.flatMap((version) => version.runs.flatMap((run) => run.scores.map((score) => score.scoreId))));
    for (const scoreId of scoreIds) {
      try {
        metrics.set(scoreId, buildFullScoreMetricsFromComparisonRows(await getScoreComparisonRows(scoreId)));
      } catch (_) {
        metrics.set(scoreId, null);
      }
      if (current !== generation) return; // a newer refresh took over
    }
    render(families, metrics, false);
  }

  const locate = (row) => focusNodes(row.dataset.nodeIds.split(',').filter(Boolean));
  view.addEventListener('click', async (event) => {
    const exportButton = event.target.closest('.prompt-optimization__export');
    if (exportButton) {
      const family = lastRender.families[Number(exportButton.dataset.familyIndex)];
      if (!family || lastRender.pending) return;
      exportButton.disabled = true;
      try {
        await saveFamilyWorkbook(family, lastRender.metrics);
      } catch (error) {
        showAlert(error instanceof Error ? error.message : 'Could not export this table.', { title: 'Cannot export Excel' });
      } finally {
        if (exportButton.isConnected) exportButton.disabled = false;
      }
      return;
    }
    const row = event.target.closest('.prompt-optimization__row');
    if (row) locate(row);
  });
  view.addEventListener('keydown', (event) => {
    const row = event.target.closest('.prompt-optimization__row');
    if (row && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      locate(row);
    }
  });
  return { refresh };
}
