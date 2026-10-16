/** Prompt panel: version families from canvas state; it does not query execution or evaluation results. */
import './promptOptimizationPanel.css';
import { buildPromptFamilies } from './promptOptimization.js';
import { renderPromptFamily } from './promptVersionTree.js';
import { showAlert } from './alertModal.js';

const canvasIdsOf = (step) => {
  try {
    const ids = JSON.parse(decodeURIComponent(step?.dataset.canvasNodeIds || ''));
    return Array.isArray(ids) ? ids : [];
  } catch (_) {
    return [];
  }
};

export function mountPromptOptimizationPanel(container, { getCanvasState, focusCanvasNodes, comparePrompts, highlightCanvasNodes = () => {} }) {
  const view = document.createElement('div');
  view.className = 'workspace-dock prompt-optimization';
  view.setAttribute('role', 'region');
  view.setAttribute('aria-label', 'Prompt');
  container.appendChild(view);
  let previousHtml = '';
  const stepWithin = (element) => {
    const step = element?.closest?.('.prompt-flow__step');
    return step && view.contains(step) ? step : null;
  };

  // Same canvas highlight and connector emphasis as Pipeline.
  function highlight(step) {
    view.querySelectorAll('.pipeline-flow-connector.is-active').forEach((edge) => edge.classList.remove('is-active'));
    if (!step) {
      highlightCanvasNodes([]);
      return;
    }
    step.closest('.pipeline-flow')?.querySelectorAll('.pipeline-flow-connector').forEach((edge) => {
      edge.classList.toggle('is-active', edge.dataset.flowFrom === step.dataset.flowNode || edge.dataset.flowTo === step.dataset.flowNode);
    });
    highlightCanvasNodes(canvasIdsOf(step));
  }

  function refresh() {
    const families = buildPromptFamilies(getCanvasState());
    const html = families.length ? families.map((family, index) => renderPromptFamily(family, index)).join('')
      : '<p class="prompt-optimization__empty">Add a Prompt to see its version family.</p>';
    if (html === previousHtml) return;
    previousHtml = html;
    const focusKey = view.contains(document.activeElement) ? document.activeElement.closest('[data-focus-key]')?.dataset.focusKey : null;
    const scrollLeft = new Map([...view.querySelectorAll('.prompt-optimization__family')]
      .map((card) => [card.dataset.familyId, card.querySelector('.pipeline-flow-viewport')?.scrollLeft || 0]));
    highlight(null);
    view.innerHTML = html;
    for (const card of view.querySelectorAll('.prompt-optimization__family')) {
      const viewport = card.querySelector('.pipeline-flow-viewport');
      if (viewport && scrollLeft.has(card.dataset.familyId)) viewport.scrollLeft = scrollLeft.get(card.dataset.familyId);
    }
    if (focusKey) {
      const replacement = [...view.querySelectorAll('[data-focus-key]')].find((element) => element.dataset.focusKey === focusKey);
      replacement?.focus({ preventScroll: true });
      highlight(stepWithin(replacement));
    }
  }

  view.addEventListener('pointerover', (event) => {
    const step = stepWithin(event.target);
    if (step && !step.contains(event.relatedTarget)) highlight(step);
  });
  view.addEventListener('pointerout', (event) => {
    const step = stepWithin(event.target);
    if (step && !step.contains(event.relatedTarget)) highlight(stepWithin(document.activeElement));
  });
  view.addEventListener('focusin', (event) => highlight(stepWithin(event.target)));
  view.addEventListener('focusout', (event) => {
    if (!stepWithin(event.relatedTarget)) highlight(null);
  });

  async function activate(target) {
    try {
      const compare = target.closest?.('[data-action="compare"]');
      if (compare && view.contains(compare)) {
        await comparePrompts(compare.dataset.fromId, compare.dataset.toId);
        return;
      }
      const step = stepWithin(target);
      if (step) focusCanvasNodes(canvasIdsOf(step));
    } catch (error) {
      showAlert(error instanceof Error ? error.message : 'Could not locate or compare this version.', { title: 'Prompt' });
    }
  }
  view.addEventListener('click', (event) => { void activate(event.target); });
  view.addEventListener('keydown', (event) => {
    if (!event.target.matches?.('.prompt-flow__step') || !['Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    void activate(event.target);
  });
  return { refresh, clearHighlight: () => highlight(null) };
}
