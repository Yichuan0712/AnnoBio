/** Prompt Version shows left-to-right ancestry; it does not query execution or evaluation results. */
import './promptOptimizationPanel.css';
import { buildPromptFamilies } from './promptOptimization.js';
import { renderPromptFamily } from './promptVersionTree.js';
import { showAlert } from './alertModal.js';

export function mountPromptOptimizationPanel(container, { getCanvasState, focusCanvasNodes, comparePrompts, highlightCanvasNodes = () => {} }) {
  const view = document.createElement('div');
  view.className = 'workspace-dock prompt-optimization';
  container.appendChild(view);
  let previousHtml = '';
  let hoveredAction = null;
  let highlightedGraph = null;

  const actionWithin = (element) => {
    const action = element?.closest?.('[data-action]');
    return action && view.contains(action) ? action : null;
  };

  function highlight(action) {
    if (highlightedGraph) {
      highlightedGraph.querySelectorAll('.is-active, .is-related').forEach((element) => element.classList.remove('is-active', 'is-related'));
    }
    highlightedGraph = action?.closest('.prompt-version__graph') || null;
    if (!highlightedGraph) {
      highlightCanvasNodes([]);
      return;
    }
    const nodeId = action.dataset.promptId;
    // Keep the same canvas highlight used by Current Pipeline.
    highlightCanvasNodes(nodeId ? [nodeId] : [action.dataset.fromId, action.dataset.toId]);
    const related = new Set();
    const matches = (element) => nodeId
      ? element.dataset.fromId === nodeId || element.dataset.toId === nodeId
      : element.dataset.fromId === action.dataset.fromId && element.dataset.toId === action.dataset.toId;
    highlightedGraph.querySelectorAll('.prompt-version__change').forEach((element) => {
      const active = matches(element);
      element.classList.toggle('is-active', active);
      if (active) {
        related.add(element.dataset.fromId);
        related.add(element.dataset.toId);
      }
    });
    highlightedGraph.querySelectorAll('.prompt-version__node').forEach((element) => {
      element.classList.toggle('is-active', element.dataset.promptId === nodeId);
      element.classList.toggle('is-related', related.has(element.dataset.promptId) && element.dataset.promptId !== nodeId);
    });
  }

  function refresh() {
    const focused = view.contains(document.activeElement) ? document.activeElement : null;
    const focusKey = focused ? { ...focused.dataset } : null;
    const families = buildPromptFamilies(getCanvasState());
    const html = families.length ? families.map(renderPromptFamily).join('')
      : '<p class="prompt-optimization__empty">Add a Prompt to see its version family.</p>';
    if (html === previousHtml) return;
    previousHtml = html;
    hoveredAction = null;
    highlightedGraph = null;
    view.innerHTML = html;
    if (focusKey) {
      const replacement = [...view.querySelectorAll('[data-action]')].find((element) =>
        element.dataset.action === focusKey.action && element.dataset.promptId === focusKey.promptId
        && element.dataset.fromId === focusKey.fromId && element.dataset.toId === focusKey.toId);
      replacement?.focus({ preventScroll: true });
    }
    highlight(actionWithin(document.activeElement));
  }

  view.addEventListener('pointerover', (event) => {
    const action = actionWithin(event.target);
    if (action === hoveredAction) return;
    hoveredAction = action;
    highlight(action || actionWithin(document.activeElement));
  });
  view.addEventListener('pointerout', (event) => {
    const action = actionWithin(event.relatedTarget);
    if (action === hoveredAction) return;
    hoveredAction = action;
    highlight(action || actionWithin(document.activeElement));
  });
  view.addEventListener('focusin', (event) => highlight(hoveredAction || actionWithin(event.target)));
  view.addEventListener('focusout', (event) => highlight(hoveredAction || actionWithin(event.relatedTarget)));

  async function activate(target) {
    const action = target.closest?.('[data-action]');
    if (!action || !view.contains(action)) return;
    try {
      if (action.dataset.action === 'locate') {
        action.focus({ preventScroll: true });
        focusCanvasNodes([action.dataset.promptId]);
      } else if (action.dataset.action === 'compare') {
        await comparePrompts(action.dataset.fromId, action.dataset.toId);
      }
    } catch (error) {
      showAlert(error instanceof Error ? error.message : 'Could not locate or compare this version.', { title: 'Prompt Version' });
    }
  }
  view.addEventListener('click', (event) => { void activate(event.target); });
  return { refresh, clearHighlight: () => { hoveredAction = null; highlight(null); } };
}
