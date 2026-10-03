/**
 * The bottom panel's Prompt Optimization tab: each Prompt version family (promptOptimization.js) as a
 * table of versions with the Precision / Recall / F1 of the Scores that evaluated them (the same
 * numbers as the Score window's banner), so each round of changes can be compared.
 * Click a row to find its Prompt, Run and Score on the canvas.
 */
import './promptOptimizationPanel.css';
import { buildPromptFamilies } from './promptOptimization.js';
import { buildFullScoreMetricsFromComparisonRows } from './agent/canvas/scoreComparisonPrf.js';

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const percent = (value) => (Number.isFinite(value) ? `${value.toFixed(1)}%` : '—');

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

  function familyHtml(family, metrics, pending) {
    const byPrompt = new Map(family.versions.map((version) => [version.promptId, version]));
    const rows = [];
    for (const version of family.versions) {
      const parentName = byPrompt.get(version.parentId)?.name || '';
      const from = version.via === 'review' ? `Review "${version.reviewName}" of ${parentName}`
        : version.via === 'version' ? `New version of ${parentName}` : '';
      const lines = version.runs.length
        ? version.runs.flatMap((run) => (run.scores.length ? run.scores.map((score) => ({ run, score })) : [{ run, score: null }]))
        : [{ run: null, score: null }];
      lines.forEach(({ run, score }, index) => {
        const ids = [version.promptId, run?.runId, score?.scoreId].filter(Boolean).join(',');
        const m = score ? metrics.get(score.scoreId) : null;
        const metric = (key) => (score && pending ? '…' : percent(m?.[key]));
        rows.push(`<tr class="prompt-optimization__row${index === 0 ? ' prompt-optimization__row--version' : ''}" tabindex="0" title="Locate on canvas" data-node-ids="${escapeHtml(ids)}">
          <td class="prompt-optimization__version" style="padding-left:${8 + version.depth * 16}px">${index === 0 ? escapeHtml(version.name) : ''}</td>
          <td class="prompt-optimization__muted">${index === 0 ? escapeHtml(from || '—') : ''}</td>
          <td>${run ? escapeHtml(run.name) : '<span class="prompt-optimization__muted">Not run</span>'}</td>
          <td>${score ? escapeHtml(score.name) : (run ? '<span class="prompt-optimization__muted">Not scored</span>' : '')}</td>
          <td class="prompt-optimization__muted">${score ? escapeHtml(score.groundTruthName || '—') : ''}</td>
          <td class="prompt-optimization__num">${score ? metric('precision') : ''}</td>
          <td class="prompt-optimization__num">${score ? metric('recall') : ''}</td>
          <td class="prompt-optimization__num prompt-optimization__f1">${score ? metric('f1') : ''}</td>
        </tr>`);
      });
    }
    return `<section class="prompt-optimization__family">
      <div class="prompt-optimization__header"><h3 class="prompt-optimization__title">${escapeHtml(family.versions[0]?.name || 'Prompt')}</h3></div>
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
    view.innerHTML = families.length
      ? families.map((family) => familyHtml(family, metrics, pending)).join('')
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
  view.addEventListener('click', (event) => {
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
