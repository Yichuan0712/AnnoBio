/**
 * Prompt panel cards: a family drawn with Pipeline's flow layout. Its steps are Prompt versions and
 * Evaluate & Optimize rounds (Generate, Evaluate and Optimize shown as one step); a Manual or Agent
 * edit connects two Prompts directly. Returns HTML only, so it stays testable without a DOM.
 */
import { layoutPipelineFlow } from './pipelineFlow.js';

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);
/** Hover text keeps its line breaks. */
const escapeTitle = (value) => escapeHtml(value).replaceAll('\n', '&#10;');

const svg = (viewBox, strokeWidth, body, size = 16) => `<svg width="${size}" height="${size}" viewBox="${viewBox}" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
// The canvas icons for Prompt and Evaluate (icons.js), and Lucide "git-compare-arrows".
const PROMPT_ICON = svg('0 0 14 14', 1.5, '<path d="M2 4h10M2 7h10M2 10h6"/>');
const ROUND_ICON = svg('0 0 14 14', 1.2, '<path d="M3 8v4M6 5v7M9 3v9M12 6v6"/>');
const COMPARE_ICON = svg('0 0 24 24', 2, '<circle cx="5" cy="6" r="3"/><circle cx="19" cy="18" r="3"/><path d="M12 6h5a2 2 0 0 1 2 2v7"/><path d="m15 9-3-3 3-3"/><path d="M12 18H7a2 2 0 0 1-2-2V9"/><path d="m9 15 3 3-3 3"/>', 14);

export const ROUND_LABEL = 'Evaluate & Optimize';
const ROUND_STATUS = { notOptimized: 'Not optimized yet', notApplied: 'Not applied yet' };

function promptKind(version) {
  if (version.via === 'review') return 'Prompt · Optimized';
  return version.via === 'version' ? `Prompt · ${version.changeLabel}` : 'Prompt';
}

/** The route layoutPipelineFlow draws: each version, then its rounds and direct edits as branches. */
export function buildPromptFamilyRoute(family) {
  const byId = new Map(family.versions.map((version) => [version.promptId, version]));
  const childVersions = new Map();
  for (const version of family.versions) {
    if (!version.parentId) continue;
    if (!childVersions.has(version.parentId)) childVersions.set(version.parentId, []);
    childVersions.get(version.parentId).push(version);
  }
  const rounds = family.rounds || [];
  const fork = (lanes) => (lanes.length > 1 ? [{ kind: 'branch', lanes }] : lanes[0] || []);
  function roundSequence(round) {
    return [{ kind: 'round', round }, ...fork(round.childIds.map((id) => versionSequence(byId.get(id))))];
  }
  function versionSequence(version) {
    const lanes = [];
    const placed = new Set();
    for (const child of childVersions.get(version.promptId) || []) {
      const round = child.via === 'review' && rounds.find((item) => item.promptId === version.promptId && item.childIds.includes(child.promptId));
      if (!round) lanes.push(versionSequence(child));
      else if (!placed.has(round)) {
        placed.add(round);
        lanes.push(roundSequence(round));
      }
    }
    for (const round of rounds) {
      if (round.promptId === version.promptId && round.status !== 'applied') lanes.push(roundSequence(round));
    }
    return [{ kind: 'prompt', version, parent: byId.get(version.parentId) || null }, ...fork(lanes)];
  }
  const root = byId.get(family.rootId);
  return root ? versionSequence(root) : [];
}

function roundTitle(round) {
  // The method first: it is what tells rounds apart, and the card may truncate it.
  return [
    round.reviewId ? `Method: ${round.method || 'not recorded'}` : 'Method: not optimized yet',
    `Generate: ${round.runName}`,
    `Evaluate: ${round.scoreName}`,
    `Optimize: ${round.reviewId ? round.reviewName : 'none yet'}`,
    round.inputName && `Input: ${round.inputName}`,
    round.groundTruthName && `Ground truth: ${round.groundTruthName}`,
    ROUND_STATUS[round.status] && `${ROUND_STATUS[round.status]}.`,
  ].filter(Boolean).join('\n');
}

function renderStep({ step, id, x, y }) {
  const position = `left:${x}px;top:${y}px`;
  if (step.kind === 'prompt') {
    const { version, parent } = step;
    const compareLabel = parent ? `Compare ${parent.name} with ${version.name}` : '';
    const compare = parent
      ? `<button type="button" class="prompt-flow__compare" data-action="compare" data-from-id="${escapeHtml(parent.promptId)}" data-to-id="${escapeHtml(version.promptId)}" data-focus-key="${escapeHtml(`compare:${version.promptId}`)}" title="${escapeHtml(compareLabel)}" aria-label="${escapeHtml(compareLabel)}">${COMPARE_ICON}</button>`
      : '';
    return `<div class="pipeline-flow-step prompt-flow__step" style="${position}" tabindex="0" role="${parent ? 'group' : 'button'}" aria-label="${escapeHtml(`Locate ${version.name} on canvas`)}" title="${escapeHtml(version.name)}" data-flow-node="${id}" data-focus-key="${escapeHtml(`prompt:${version.promptId}`)}" data-canvas-node-ids="${encodeURIComponent(JSON.stringify([version.promptId]))}">
      <span class="pipeline-flow-icon" aria-hidden="true">${PROMPT_ICON}</span>
      <div class="pipeline-flow-content"><span class="pipeline-flow-kind">${escapeHtml(promptKind(version))}</span><span class="pipeline-step-name">${escapeHtml(version.name)}</span></div>
      ${compare}
    </div>`;
  }
  const { round } = step;
  const pending = round.status !== 'applied';
  const name = round.reviewId ? round.method || round.reviewName : round.scoreName;
  const canvasIds = [round.runId, round.scoreId, round.reviewId].filter(Boolean);
  return `<div class="pipeline-flow-step prompt-flow__step${pending ? ' prompt-flow__step--pending' : ''}" style="${position}" tabindex="0" role="button" aria-label="${escapeHtml(`Locate ${ROUND_LABEL} ${name} on canvas${pending ? ` (${ROUND_STATUS[round.status]})` : ''}`)}" title="${escapeTitle(roundTitle(round))}" data-flow-node="${id}" data-focus-key="${escapeHtml(`round:${round.id}`)}" data-canvas-node-ids="${encodeURIComponent(JSON.stringify(canvasIds))}">
    <span class="pipeline-flow-icon" aria-hidden="true">${ROUND_ICON}</span>
    <div class="pipeline-flow-content"><span class="pipeline-flow-kind">${escapeHtml(ROUND_STATUS[round.status] || ROUND_LABEL)}</span><span class="pipeline-step-name">${escapeHtml(name)}</span></div>
  </div>`;
}

/** `index` keeps each family's arrow marker id unique in the panel without changing between renders. */
export function renderPromptFamily(family, index = 0) {
  const root = family.versions.find((version) => version.promptId === family.rootId);
  const graph = layoutPipelineFlow(buildPromptFamilyRoute(family));
  const markerId = `prompt-flow-arrow-${index}`;
  return `<section class="pipeline-overview-card prompt-optimization__family" data-family-id="${escapeHtml(family.rootId)}" aria-label="${escapeHtml(`Prompt family: ${root?.name || 'Prompt'}`)}">
    <div class="pipeline-overview-card-header"><h3 class="pipeline-overview-card-title">${escapeHtml(root?.name || 'Prompt')}</h3></div>
    <div class="pipeline-flow-viewport" tabindex="0" role="group" aria-label="Prompt versions; scroll horizontally to see more">
      <div class="pipeline-flow" style="width:${graph.width}px;height:${graph.height}px">
        <svg class="pipeline-flow-connections" width="${graph.width}" height="${graph.height}" viewBox="0 0 ${graph.width} ${graph.height}" aria-hidden="true">
          <defs><marker id="${markerId}" viewBox="0 0 6 6" refX="5.5" refY="3" markerWidth="5" markerHeight="5" orient="auto"><path d="m1 1 4 2-4 2" fill="none" stroke="context-stroke" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>
          ${graph.edges.map((edge) => `<path class="pipeline-flow-connector" data-flow-from="${edge.from}" data-flow-to="${edge.to}" d="${edge.path}"${edge.arrow ? ` marker-end="url(#${markerId})"` : ''}/>`).join('')}
        </svg>
        ${graph.nodes.map(renderStep).join('')}
      </div>
    </div>
  </section>`;
}
