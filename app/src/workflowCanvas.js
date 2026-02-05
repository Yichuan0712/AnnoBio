/**
 * Workflow canvas (node-based editor surface).
 * Listens for workflow:add-prompt-node to add prompt nodes.
 * Edges use stable node ids and a type field for future extensibility.
 */

import { openDatasetDetailModal } from './datasetDetailModal.js';
import { openPromptDetailModal, extractInputFieldsFromSections } from './promptDetailModal.js';
import { openRunDetailModal } from './runDetailModal.js';
import { openSamplerDetailModal } from './samplerDetailModal.js';
import { openWorkingDatasetDetailModal } from './workingDatasetDetailModal.js';

const MIN_CONTENT_PADDING = 200;
/** Minimum canvas content size (width, height) so there is plenty of room to work and zoom. */
const MIN_CANVAS_WIDTH = 4000;
const MIN_CANVAS_HEIGHT = 2600;

/** Edge type for prompt �?prompt (e.g. "new version" link). Add more types here as needed. */
const EDGE_TYPE_PROMPT_TO_PROMPT = 'prompt-to-prompt';
/** Edge type for source dataset → sampler. */
const EDGE_TYPE_DATASET_TO_SAMPLER = 'dataset-to-sampler';
/** Edge type for sampler → subset. */
const EDGE_TYPE_SAMPLER_TO_SUBSET = 'sampler-to-subset';
/** Edge type for subset → subset (e.g. "version of" link). */
const EDGE_TYPE_SUBSET_TO_SUBSET = 'subset-to-subset';
/** Edge type for prompt → run (run/test this prompt). */
const EDGE_TYPE_PROMPT_TO_RUN = 'prompt-to-run';

/** Invisible stroke width for edge hit area (px). */
const EDGE_HIT_STROKE_WIDTH = 16;

/** Horizontal gap when placing a new node to the right of its parent (source → sampler, sampler → subset, duplicate prompt). */
const NEW_NODE_OFFSET = 40;

function generateNodeId() {
  return 'n_' + Date.now() + '_' + (Math.random() * 1e9 | 0);
}

export function buildWorkflowCanvas(root) {
  const canvas = document.createElement('div');
  canvas.className = 'workflow-canvas';

  const scrollWrapper = document.createElement('div');
  scrollWrapper.className = 'workflow-canvas__scroll';

  const zoomOuter = document.createElement('div');
  zoomOuter.className = 'workflow-canvas__zoom-outer';

  const scaleWrapper = document.createElement('div');
  scaleWrapper.className = 'workflow-canvas__scale';

  const contentInner = document.createElement('div');
  contentInner.className = 'workflow-canvas__inner';

  const edgesLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  edgesLayer.setAttribute('class', 'workflow-canvas__edges');
  edgesLayer.setAttribute('width', '100%');
  edgesLayer.setAttribute('height', '100%');
  edgesLayer.setAttribute('preserveAspectRatio', 'none');
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
  marker.setAttribute('id', 'workflow-arrow');
  marker.setAttribute('markerWidth', '10');
  marker.setAttribute('markerHeight', '8');
  marker.setAttribute('refX', '9');
  marker.setAttribute('refY', '4');
  marker.setAttribute('orient', 'auto');
  const arrowPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  arrowPath.setAttribute('d', 'M0,0 L10,4 L0,8 Z');
  arrowPath.setAttribute('fill', 'currentColor');
  marker.appendChild(arrowPath);
  defs.appendChild(marker);
  edgesLayer.appendChild(defs);

  const nodesLayer = document.createElement('div');
  nodesLayer.className = 'workflow-canvas__nodes';

  contentInner.appendChild(edgesLayer);
  contentInner.appendChild(nodesLayer);
  scaleWrapper.appendChild(contentInner);
  zoomOuter.appendChild(scaleWrapper);
  scrollWrapper.appendChild(zoomOuter);
  canvas.appendChild(scrollWrapper);

  let panStartScrollLeft = 0;
  let panStartScrollTop = 0;
  let panStartClientX = 0;
  let panStartClientY = 0;

  function onPanMove(e) {
    scrollWrapper.scrollLeft = panStartScrollLeft + (panStartClientX - e.clientX);
    scrollWrapper.scrollTop = panStartScrollTop + (panStartClientY - e.clientY);
  }
  function onPanEnd() {
    scrollWrapper.classList.remove('workflow-canvas__scroll--panning');
    document.removeEventListener('pointermove', onPanMove);
    document.removeEventListener('pointerup', onPanEnd);
    document.removeEventListener('pointercancel', onPanEnd);
  }
  scrollWrapper.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.workflow-node') || e.target.closest('.workflow-canvas__zoom-toolbar')) return;
    e.preventDefault();
    panStartScrollLeft = scrollWrapper.scrollLeft;
    panStartScrollTop = scrollWrapper.scrollTop;
    panStartClientX = e.clientX;
    panStartClientY = e.clientY;
    scrollWrapper.classList.add('workflow-canvas__scroll--panning');
    document.addEventListener('pointermove', onPanMove);
    document.addEventListener('pointerup', onPanEnd, { once: true });
    document.addEventListener('pointercancel', onPanEnd, { once: true });
  });

  let zoomLevel = 1;
  const MIN_ZOOM = 0.5;
  const MAX_ZOOM = 2;
  const ZOOM_STEP = 0.05;

  function applyZoom() {
    scaleWrapper.style.transformOrigin = '0 0';
    scaleWrapper.style.transform = `scale(${zoomLevel})`;
  }

  let nodeCount = 0;
  const STAGGER = 36;
  /** @type {{ fromId: string, toId: string, type: string }[]} */
  let connections = [];

  /** @type {Map<string, { headers: string[], rows: string[][] }>} nodeId -> dataset content for preview/detail */
  const datasetContentByNodeId = new Map();
  /** @type {Map<string, { headers: string[], rows: string[][] }>} nodeId -> working dataset (subset) content */
  const subsetContentByNodeId = new Map();

  function getNodeList() {
    return Array.from(nodesLayer.querySelectorAll('.workflow-node--prompt'));
  }

  function getNodeById(nodeId) {
    if (!nodeId) return null;
    return nodesLayer.querySelector(`[data-node-id="${nodeId}"]`) || null;
  }

  /**
   * Generate next working dataset name: SourceName SamplerName N (N increments per sampler; spaces between parts).
   * @param {string} samplerNodeId
   * @returns {string}
   */
  function findNextWorkingDatasetName(samplerNodeId) {
    const samplerNode = getNodeById(samplerNodeId);
    const sourceNode = samplerNode?.dataset?.sourceNodeId ? getNodeById(samplerNode.dataset.sourceNodeId) : null;
    const sourceName = (sourceNode?.dataset?.datasetName ?? '').trim() || 'Source';
    const samplerName = (samplerNode?.dataset?.samplerName ?? '').trim() || 'Sampler';
    const base = `${sourceName} ${samplerName}`;
    const subsetNodes = nodesLayer.querySelectorAll('.workflow-node--subset');
    let maxN = 0;
    const prefix = base + ' ';
    for (const n of subsetNodes) {
      if (n.dataset.samplerNodeId !== samplerNodeId) continue;
      const name = (n.dataset.subsetName || '').trim();
      if (!name.startsWith(prefix)) continue;
      const numStr = name.slice(prefix.length).trim();
      const num = parseInt(numStr, 10);
      if (Number.isFinite(num) && num >= 1 && String(num) === numStr) maxN = Math.max(maxN, num);
    }
    return `${base} ${maxN + 1}`;
  }

  function getNodeIndex(node) {
    return getNodeList().indexOf(node);
  }

  /**
   * Check if a prompt name is already used on the canvas (case-insensitive).
   * Empty string is considered "used" so multiple empty names are not allowed.
   * @param {string} nameToCheck - name to check (will be trimmed and lowercased)
   * @param {string|null} [excludeNodeId=null] - node id to exclude (e.g. when editing that node)
   * @returns {boolean}
   */
  function isPromptNameAlreadyUsed(nameToCheck, excludeNodeId = null) {
    const normalized = (nameToCheck || '').trim().toLowerCase();
    const nodes = getNodeList();
    for (const n of nodes) {
      if (excludeNodeId && n.dataset.nodeId === excludeNodeId) continue;
      const existing = (n.dataset.promptName || '').trim().toLowerCase();
      if (existing === normalized) return true;
    }
    return false;
  }

  /**
   * Check if a source dataset name is already used on the canvas (case-insensitive).
   * @param {string} nameToCheck
   * @param {string|null} [excludeNodeId=null] - node id to exclude (e.g. when editing that node)
   * @returns {boolean}
   */
  function isDatasetNameAlreadyUsed(nameToCheck, excludeNodeId = null) {
    const normalized = (nameToCheck || '').trim().toLowerCase();
    const datasetNodes = nodesLayer.querySelectorAll('.workflow-node--dataset');
    for (const n of datasetNodes) {
      if (excludeNodeId && n.dataset.nodeId === excludeNodeId) continue;
      const existing = (n.dataset.datasetName || '').trim().toLowerCase();
      if (existing === normalized) return true;
    }
    return false;
  }

  /**
   * Check if a working dataset (subset) name is already used on the canvas (case-insensitive).
   * @param {string} nameToCheck
   * @param {string|null} [excludeNodeId=null] - node id to exclude
   * @returns {boolean}
   */
  function isSubsetNameAlreadyUsed(nameToCheck, excludeNodeId = null) {
    const normalized = (nameToCheck || '').trim().toLowerCase();
    const subsetNodes = nodesLayer.querySelectorAll('.workflow-node--subset');
    for (const n of subsetNodes) {
      if (excludeNodeId && n.dataset.nodeId === excludeNodeId) continue;
      const existing = (n.dataset.subsetName || '').trim().toLowerCase();
      if (existing === normalized) return true;
    }
    return false;
  }

  /**
   * Check if a sampler name is already used for the same source dataset (case-insensitive).
   * @param {string} nameToCheck
   * @param {string} sourceNodeId - source dataset node id
   * @param {string|null} [excludeNodeId=null] - sampler node id to exclude (e.g. when editing)
   * @returns {boolean}
   */
  function isSamplerNameAlreadyUsedForSource(nameToCheck, sourceNodeId, excludeNodeId = null) {
    const normalized = (nameToCheck || '').trim().toLowerCase();
    if (!normalized) return true;
    const samplerNodes = nodesLayer.querySelectorAll('.workflow-node--sampler');
    for (const n of samplerNodes) {
      if (n.dataset.sourceNodeId !== sourceNodeId) continue;
      if (excludeNodeId && n.dataset.nodeId === excludeNodeId) continue;
      const existing = (n.dataset.samplerName || '').trim().toLowerCase();
      if (existing === normalized) return true;
    }
    return false;
  }

  /**
   * Parse row spec string (1-based) into sorted unique 0-based indices. Supports "1, 3, 5-10, 15".
   * @param {string} text
   * @param {number} totalRows - max row count (1-based), indices > totalRows are skipped
   * @returns {number[]}
   */
  function parseRowSpec(text, totalRows) {
    const seen = new Set();
    const parts = (text || '').split(/[\s,]+/).filter(Boolean);
    for (const part of parts) {
      const dash = part.indexOf('-');
      if (dash === -1) {
        const num = parseInt(part, 10);
        if (Number.isFinite(num) && num >= 1 && num <= totalRows) seen.add(num - 1);
      } else {
        const a = parseInt(part.slice(0, dash), 10);
        const b = parseInt(part.slice(dash + 1), 10);
        if (Number.isFinite(a) && Number.isFinite(b) && a >= 1 && b >= 1) {
          const low = Math.min(a, b);
          const high = Math.min(Math.max(a, b), totalRows);
          for (let r = Math.max(1, low); r <= high; r++) seen.add(r - 1);
        }
      }
    }
    return Array.from(seen).sort((x, y) => x - y);
  }

  /**
   * Sample rows from source data per sampler settings.
   * @param {string[][]} sourceRows
   * @param {number} sampleSize - row count or percentage (1-100)
   * @param {string} sampleSizeType - 'rows' | 'ratio'
   * @param {string} samplingType - 'with-replacement' | 'without-replacement'
   * @returns {string[][]}
   */
  function sampleRows(sourceRows, sampleSize, sampleSizeType, samplingType) {
    const n = sourceRows.length;
    if (n === 0) return [];
    let count = sampleSizeType === 'rows' ? Math.max(0, Math.floor(sampleSize)) : Math.max(0, Math.floor((n * sampleSize) / 100));
    count = Math.min(count, n);
    if (count === 0) return [];

    if (samplingType === 'without-replacement') {
      const indices = Array.from({ length: n }, (_, i) => i);
      for (let i = n - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [indices[i], indices[j]] = [indices[j], indices[i]];
      }
      return indices.slice(0, count).map((i) => sourceRows[i].slice());
    }

    const result = [];
    for (let k = 0; k < count; k++) {
      const i = Math.floor(Math.random() * n);
      result.push(sourceRows[i].slice());
    }
    return result;
  }

  /**
   * Strip trailing " (Copy N)" or " vN" from a name so we can reuse the root for next number.
   * @param {string} name
   * @returns {string}
   */
  function stripCopyOrVersionSuffix(name) {
    const s = (name || '').trim();
    const copyMatch = s.match(/^(.*)\s+\(Copy\s+\d+\)$/);
    if (copyMatch) return stripCopyOrVersionSuffix(copyMatch[1].trim());
    const versionMatch = s.match(/^(.*)\s+v(\d+)$/);
    if (versionMatch) return stripCopyOrVersionSuffix(versionMatch[1].trim());
    return s || 'Prompt';
  }

  /**
   * Strip only trailing " (Copy N)" from a name; keep version suffix like " v2".
   * Used when duplicating so "MySet v2" -> copy is "MySet v2 (Copy 1)".
   * @param {string} name
   * @returns {string}
   */
  function stripCopySuffixOnly(name) {
    const s = (name || '').trim();
    const copyMatch = s.match(/^(.*)\s+\(Copy\s+\d+\)$/);
    if (copyMatch) return stripCopySuffixOnly(copyMatch[1].trim());
    return s;
  }

  /**
   * Strip only trailing " vN" (space + v + digits) from a name.
   * Used for Add version: "MySet v2" -> "MySet", "MySet (Copy 1) v2" -> "MySet (Copy 1)".
   * @param {string} name
   * @returns {string}
   */
  function stripVersionSuffixOnly(name) {
    const s = (name || '').trim();
    const versionMatch = s.match(/^(.*)\s+v(\d+)$/);
    if (versionMatch) return versionMatch[1].trim();
    return s;
  }

  /**
   * Find a unique prompt name by appending suffix. Used for duplicate / new version.
   * Duplicate: strip only " (Copy N)" so "Name v2" -> "Name v2 (Copy 1)".
   * New version: strip only trailing " vN" so "Name v2" -> "Name v3", "Name (Copy 1)" -> "Name (Copy 1) v2".
   * Scans all prompt nodes (including current) so version number always increments.
   * @param {string} baseName - base name (e.g. from source node)
   * @param {boolean} isNewVersion - true for "Name v2", false for "Name (Copy 1)"
   * @returns {string}
   */
  function findUniquePromptName(baseName, isNewVersion) {
    if (isNewVersion) {
      const raw = (baseName || '').trim() || 'Prompt';
      const versionBase = stripVersionSuffixOnly(raw).trim() || 'Prompt';
      const nodes = getNodeList();
      let nextV = 2;
      const versionPrefix = versionBase + ' v';
      for (const n of nodes) {
        const name = (n.dataset.promptName || '').trim();
        const nBase = stripVersionSuffixOnly(name).trim();
        if (nBase !== versionBase) continue;
        if (name === versionBase) {
          nextV = Math.max(nextV, 2);
          continue;
        }
        if (!name.startsWith(versionPrefix)) continue;
        const numStr = name.slice(versionPrefix.length).trim();
        if (!/^\d+$/.test(numStr)) continue;
        const num = parseInt(numStr, 10);
        if (Number.isFinite(num) && num >= 1) nextV = Math.max(nextV, num + 1);
      }
      return `${versionBase} v${nextV}`;
    }
    const base = (stripCopySuffixOnly(baseName || '').trim() || 'Prompt');
    let n = 1;
    let candidate;
    do {
      candidate = `${base} (Copy ${n})`;
      n++;
    } while (isPromptNameAlreadyUsed(candidate));
    return candidate;
  }

  /**
   * Find a unique working dataset name (same pattern as prompt: duplicate = "Name (Copy 1)", version = "Name v2").
   * Duplicate keeps version suffix so "MySet v2" -> "MySet v2 (Copy 1)"; only " (Copy N)" is stripped for the base.
   * @param {string} baseName - current subset name
   * @param {boolean} isNewVersion - true for "Name v2", false for "Name (Copy 1)" (or "Name v2 (Copy 1)")
   * @returns {string}
   */
  function findUniqueWorkingDatasetName(baseName, isNewVersion) {
    const raw = (baseName || '').trim() || 'Working dataset';
    const base = isNewVersion ? (stripCopyOrVersionSuffix(raw).trim() || 'Working dataset') : (stripCopySuffixOnly(raw) || 'Working dataset');
    let n = isNewVersion ? 2 : 1;
    let candidate;
    do {
      candidate = isNewVersion ? `${base} v${n}` : `${base} (Copy ${n})`;
      n++;
    } while (isSubsetNameAlreadyUsed(candidate));
    return candidate;
  }

  /**
   * Draw a single edge into SVG group g. Override per edge type for different visuals/anchors.
   * @param {SVGGElement} g
   * @param {{ fromId: string, toId: string, type: string }} edge
   * @param {number} edgeIndex - index in connections (for data-edge-index / future click)
   */
  function renderEdge(g, edge, edgeIndex) {
    const fromNode = getNodeById(edge.fromId);
    const toNode = getNodeById(edge.toId);
    if (!fromNode || !toNode) return;

    const x1 = parseFloat(fromNode.style.left) || 0;
    const y1 = parseFloat(fromNode.style.top) || 0;
    const w1 = fromNode.offsetWidth || 0;
    const h1 = fromNode.offsetHeight || 0;
    const x2 = parseFloat(toNode.style.left) || 0;
    const y2 = parseFloat(toNode.style.top) || 0;
    const h2 = toNode.offsetHeight || 0;

    if (edge.type === EDGE_TYPE_PROMPT_TO_PROMPT) {
      const startX = x1 + w1;
      const startY = y1 + h1 / 2;
      const endX = x2;
      const endY = y2 + h2 / 2;
      // Hit area: invisible wide stroke (drawn first, behind visible line)
      const hitLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      hitLine.setAttribute('x1', String(startX));
      hitLine.setAttribute('y1', String(startY));
      hitLine.setAttribute('x2', String(endX));
      hitLine.setAttribute('y2', String(endY));
      hitLine.setAttribute('stroke', 'transparent');
      hitLine.setAttribute('stroke-width', String(EDGE_HIT_STROKE_WIDTH));
      hitLine.setAttribute('data-edge-type', edge.type);
      hitLine.setAttribute('data-edge-index', String(edgeIndex));
      hitLine.setAttribute('pointer-events', 'stroke');
      g.appendChild(hitLine);
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', String(startX));
      line.setAttribute('y1', String(startY));
      line.setAttribute('x2', String(endX));
      line.setAttribute('y2', String(endY));
      line.setAttribute('stroke', 'var(--text-muted)');
      line.setAttribute('stroke-width', '2');
      line.setAttribute('marker-end', 'url(#workflow-arrow)');
      line.setAttribute('data-edge-type', edge.type);
      line.setAttribute('data-edge-index', String(edgeIndex));
      line.setAttribute('pointer-events', 'none');
      g.appendChild(line);
    } else {
      // Unknown type: draw same as prompt-to-prompt for now; add branches for new types later.
      const startX = x1 + w1;
      const startY = y1 + h1 / 2;
      const endX = x2;
      const endY = y2 + h2 / 2;
      const hitLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      hitLine.setAttribute('x1', String(startX));
      hitLine.setAttribute('y1', String(startY));
      hitLine.setAttribute('x2', String(endX));
      hitLine.setAttribute('y2', String(endY));
      hitLine.setAttribute('stroke', 'transparent');
      hitLine.setAttribute('stroke-width', String(EDGE_HIT_STROKE_WIDTH));
      hitLine.setAttribute('data-edge-type', edge.type || '');
      hitLine.setAttribute('data-edge-index', String(edgeIndex));
      hitLine.setAttribute('pointer-events', 'stroke');
      g.appendChild(hitLine);
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', String(startX));
      line.setAttribute('y1', String(startY));
      line.setAttribute('x2', String(endX));
      line.setAttribute('y2', String(endY));
      line.setAttribute('stroke', 'var(--text-muted)');
      line.setAttribute('stroke-width', '2');
      line.setAttribute('marker-end', 'url(#workflow-arrow)');
      line.setAttribute('data-edge-type', edge.type || '');
      line.setAttribute('data-edge-index', String(edgeIndex));
      line.setAttribute('pointer-events', 'none');
      g.appendChild(line);
    }
  }

  function updateEdges() {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('pointer-events', 'auto');
    connections.forEach((edge, i) => renderEdge(g, edge, i));
    const existing = edgesLayer.querySelector('g');
    if (existing) existing.remove();
    edgesLayer.appendChild(g);
  }

  function getPromptDataFromNode(node) {
    if (!node) return null;
    let sections = [];
    let outputFormat = { returnShape: 'single', fields: [] };
    try {
      sections = JSON.parse(node.dataset.promptSections || node.dataset.promptFields || '[]');
    } catch (_) {}
    try {
      const raw = JSON.parse(node.dataset.promptOutputFormat || '[]');
      const fields = (Array.isArray(raw) ? raw : []).map((o) => ({ key: o.key || '', type: o.type || 'str', description: o.description ?? '', examples: o.examples || [], allowNone: o.allowNone === true }));
      outputFormat = { returnShape: node.dataset.promptOutputReturnShape || 'single', fields };
    } catch (_) {}
    return {
      name: node.dataset.promptName || '',
      note: node.dataset.promptNote || '',
      sections: Array.isArray(sections) ? sections : [],
      outputFormat,
    };
  }

  function serializePromptToDiffText(data) {
    const lines = [];
    const sections = data.sections || [];
    if (sections.length === 0) {
      lines.push('## Sections');
      lines.push('(none)');
      lines.push('');
    } else {
      sections.forEach((s) => {
        lines.push('## Section: ' + (s.name || '').trim());
        lines.push((s.content || '').trim());
        lines.push('');
      });
    }
    lines.push('## Output schema');
    const of = data.outputFormat || {};
    lines.push('Return shape: ' + (of.returnShape || 'single'));
    const fields = of.fields || [];
    if (fields.length === 0) {
      lines.push('(no fields)');
    } else {
      fields.forEach((f) => {
        const ex = Array.isArray(f.examples) ? f.examples : [];
        const type = f.type || 'str';
        const allowNone = f.allowNone === true ? 'yes' : 'no';
        const exStr = ex.map((e) => {
          if (Array.isArray(e)) {
            return type === 'list_str'
              ? '[' + e.map((el) => '"' + String(el ?? '').replace(/"/g, '\\"') + '"').join(', ') + ']'
              : '[' + e.join(', ') + ']';
          }
          return type === 'str' ? '"' + String(e ?? '').replace(/"/g, '\\"') + '"' : String(e);
        }).join('; ');
        lines.push('Field: ' + (f.key || '').trim() + ' | ' + type + ' | ' + (f.description || '').trim() + ' | Allow None: ' + allowNone + ' | ' + exStr);
      });
    }
    return lines.join('\n');
  }

  /** Line-based LCS diff. Returns { type: 'remove'|'add'|'unchanged', line, oldNum?, newNum? }[]. */
  function lineDiff(oldText, newText) {
    const a = (oldText || '').split('\n');
    const b = (newText || '').split('\n');
    const m = a.length;
    const n = b.length;
    const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
    const result = [];
    let i = m;
    let j = n;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
        result.unshift({ type: 'unchanged', line: a[i - 1], oldNum: i, newNum: j });
        i--;
        j--;
      } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
        result.unshift({ type: 'add', line: b[j - 1], newNum: j });
        j--;
      } else {
        result.unshift({ type: 'remove', line: a[i - 1], oldNum: i });
        i--;
      }
    }
    return result;
  }

  function openEdgeDetailModal(edge, edgeIndex) {
    const fromNode = getNodeById(edge.fromId);
    const toNode = getNodeById(edge.toId);
    const fromData = fromNode ? getPromptDataFromNode(fromNode) : null;
    const toData = toNode ? getPromptDataFromNode(toNode) : null;
    const fromName = (fromData && fromData.name.trim()) || 'Prompt';
    const toName = (toData && toData.name.trim()) || 'Prompt';

    let bodyHtml;
    if (!fromData || !toData) {
      bodyHtml = '<p class="prompt-detail-placeholder">One or both nodes are missing. Cannot compare.</p>';
    } else {
      const oldText = serializePromptToDiffText(fromData);
      const newText = serializePromptToDiffText(toData);
      const diffLines = lineDiff(oldText, newText);
      bodyHtml = '<div class="prompt-diff-view"><table class="prompt-diff-table"><colgroup><col class="diff-col-old-num"><col class="diff-col-old-content"><col class="diff-col-new-num"><col class="diff-col-new-content"></colgroup><thead><tr><th colspan="2" class="diff-th-old">Old</th><th colspan="2" class="diff-th-new">New</th></tr></thead><tbody>' +
        diffLines.map((item) => {
          const cls = 'diff-line diff-' + item.type;
          const oldNum = item.type === 'add' ? '' : (item.oldNum || '');
          const newNum = item.type === 'remove' ? '' : (item.newNum || '');
          const lineEsc = escapeHtml(item.line || ' ');
          const oldCell = item.type === 'add' ? '<td class="diff-line-num diff-old-num"></td><td class="diff-line-content diff-old-content"></td>' : '<td class="diff-line-num diff-old-num">' + oldNum + '</td><td class="diff-line-content diff-old-content">' + lineEsc + '</td>';
          const newCell = item.type === 'remove' ? '<td class="diff-line-num diff-new-num"></td><td class="diff-line-content diff-new-content"></td>' : '<td class="diff-line-num diff-new-num">' + newNum + '</td><td class="diff-line-content diff-new-content">' + lineEsc + '</td>';
          return '<tr class="' + cls + '">' + oldCell + newCell + '</tr>';
        }).join('') +
        '</tbody></table></div>';
    }

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'edge-detail-title');
    overlay.innerHTML = `
      <div class="modal-panel modal-panel--edge-detail">
        <div class="modal-header">
          <h2 id="edge-detail-title" class="modal-title">Compare versions: ${escapeHtml(fromName)} → ${escapeHtml(toName)}</h2>
          <button type="button" class="modal-close" aria-label="Close">×</button>
        </div>
        <div class="modal-body modal-body--diff">
          ${bodyHtml}
        </div>
      </div>
    `;
    overlay.querySelector('.modal-close').addEventListener('click', () => {
      overlay.remove();
      document.body.style.overflow = '';
    });
    document.body.style.overflow = 'hidden';
    document.body.appendChild(overlay);
  }

  function serializeSubsetToDiffText(content) {
    if (!content) return '(no data)';
    const headers = content.headers || [];
    const rows = content.rows || [];
    const lines = [];
    lines.push('Headers: ' + headers.join(', ') || '(none)');
    rows.forEach((row, i) => {
      const cells = Array.isArray(row) ? row : [];
      lines.push('Row ' + (i + 1) + ': ' + cells.join(', '));
    });
    if (rows.length === 0) lines.push('(no rows)');
    return lines.join('\n');
  }

  function openSubsetEdgeDetailModal(edge) {
    const fromNode = getNodeById(edge.fromId);
    const toNode = getNodeById(edge.toId);
    const fromContent = subsetContentByNodeId.get(edge.fromId) || null;
    const toContent = subsetContentByNodeId.get(edge.toId) || null;
    const fromName = (fromNode?.dataset?.subsetName ?? '').trim() || 'Working dataset';
    const toName = (toNode?.dataset?.subsetName ?? '').trim() || 'Working dataset';

    const oldText = serializeSubsetToDiffText(fromContent);
    const newText = serializeSubsetToDiffText(toContent);
    const diffLines = lineDiff(oldText, newText);
    const bodyHtml = '<div class="prompt-diff-view"><table class="prompt-diff-table"><colgroup><col class="diff-col-old-num"><col class="diff-col-old-content"><col class="diff-col-new-num"><col class="diff-col-new-content"></colgroup><thead><tr><th colspan="2" class="diff-th-old">Old</th><th colspan="2" class="diff-th-new">New</th></tr></thead><tbody>' +
      diffLines.map((item) => {
        const cls = 'diff-line diff-' + item.type;
        const oldNum = item.type === 'add' ? '' : (item.oldNum || '');
        const newNum = item.type === 'remove' ? '' : (item.newNum || '');
        const lineEsc = escapeHtml(item.line || ' ');
        const oldCell = item.type === 'add' ? '<td class="diff-line-num diff-old-num"></td><td class="diff-line-content diff-old-content"></td>' : '<td class="diff-line-num diff-old-num">' + oldNum + '</td><td class="diff-line-content diff-old-content">' + lineEsc + '</td>';
        const newCell = item.type === 'remove' ? '<td class="diff-line-num diff-new-num"></td><td class="diff-line-content diff-new-content"></td>' : '<td class="diff-line-num diff-new-num">' + newNum + '</td><td class="diff-line-content diff-new-content">' + lineEsc + '</td>';
        return '<tr class="' + cls + '">' + oldCell + newCell + '</tr>';
      }).join('') +
      '</tbody></table></div>';

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'edge-detail-title');
    overlay.innerHTML = `
      <div class="modal-panel modal-panel--edge-detail">
        <div class="modal-header">
          <h2 id="edge-detail-title" class="modal-title">Compare versions: ${escapeHtml(fromName)} → ${escapeHtml(toName)}</h2>
          <button type="button" class="modal-close" aria-label="Close">×</button>
        </div>
        <div class="modal-body modal-body--diff">
          ${bodyHtml}
        </div>
      </div>
    `;
    overlay.querySelector('.modal-close').addEventListener('click', () => {
      overlay.remove();
      document.body.style.overflow = '';
    });
    document.body.style.overflow = 'hidden';
    document.body.appendChild(overlay);
  }

  function onEdgesLayerClick(e) {
    const lineEl = e.target && (e.target.tagName === 'line' || e.target.localName === 'line') ? e.target : null;
    if (!lineEl) return;
    const edgeType = lineEl.getAttribute('data-edge-type');
    const indexStr = lineEl.getAttribute('data-edge-index');
    if (indexStr === null) return;
    const edgeIndex = parseInt(indexStr, 10);
    const edge = connections[edgeIndex];
    if (!edge) return;
    if (edgeType === EDGE_TYPE_PROMPT_TO_PROMPT) {
      e.preventDefault();
      e.stopPropagation();
      openEdgeDetailModal(edge, edgeIndex);
    } else if (edgeType === EDGE_TYPE_SUBSET_TO_SUBSET) {
      e.preventDefault();
      e.stopPropagation();
      openSubsetEdgeDetailModal(edge);
    } else if (edgeType === EDGE_TYPE_DATASET_TO_SAMPLER || edgeType === EDGE_TYPE_SAMPLER_TO_SUBSET) {
      e.preventDefault();
      e.stopPropagation();
      const samplerNodeId = edgeType === EDGE_TYPE_SAMPLER_TO_SUBSET ? edge.fromId : edge.toId;
      const samplerNode = getNodeById(samplerNodeId);
      if (samplerNode) openSamplerDetailModal({ node: samplerNode });
    }
  }

  edgesLayer.addEventListener('click', onEdgesLayerClick);

  function updateContentSize() {
    const nodes = nodesLayer.querySelectorAll('.workflow-node');
    const viewportW = scrollWrapper.clientWidth || 800;
    const viewportH = scrollWrapper.clientHeight || 600;
    const minW = Math.max(viewportW, MIN_CANVAS_WIDTH);
    const minH = Math.max(viewportH, MIN_CANVAS_HEIGHT);
    let maxRight = 0;
    let maxBottom = 0;
    nodes.forEach((n) => {
      const left = parseFloat(n.style.left) || 0;
      const top = parseFloat(n.style.top) || 0;
      maxRight = Math.max(maxRight, left + (n.offsetWidth || 0));
      maxBottom = Math.max(maxBottom, top + (n.offsetHeight || 0));
    });
    const width = Math.max(minW, maxRight + MIN_CONTENT_PADDING);
    const height = Math.max(minH, maxBottom + MIN_CONTENT_PADDING);
    contentInner.style.width = `${width}px`;
    contentInner.style.height = `${height}px`;
    nodesLayer.style.width = `${width}px`;
    nodesLayer.style.minHeight = `${height}px`;
    scaleWrapper.style.width = `${width}px`;
    scaleWrapper.style.height = `${height}px`;
    zoomOuter.style.width = `${width * zoomLevel}px`;
    zoomOuter.style.height = `${height * zoomLevel}px`;
  }

  const zoomToolbar = document.createElement('div');
  zoomToolbar.className = 'workflow-canvas__zoom-toolbar';
  zoomToolbar.setAttribute('role', 'toolbar');
  zoomToolbar.setAttribute('aria-label', 'Canvas zoom');
  zoomToolbar.innerHTML = `
    <button type="button" class="workflow-canvas__zoom-btn" data-zoom="out" aria-label="Zoom out">−</button>
    <span class="workflow-canvas__zoom-label" aria-live="polite">100%</span>
    <button type="button" class="workflow-canvas__zoom-btn" data-zoom="in" aria-label="Zoom in">+</button>
  `;
  const zoomLabelEl = zoomToolbar.querySelector('.workflow-canvas__zoom-label');
  function updateZoomLabel() {
    zoomLabelEl.textContent = Math.round(zoomLevel * 100) + '%';
  }
  zoomToolbar.querySelector('[data-zoom="out"]').addEventListener('click', () => {
    zoomLevel = Math.max(MIN_ZOOM, zoomLevel - ZOOM_STEP);
    applyZoom();
    updateContentSize();
    updateZoomLabel();
  });
  zoomToolbar.querySelector('[data-zoom="in"]').addEventListener('click', () => {
    zoomLevel = Math.min(MAX_ZOOM, zoomLevel + ZOOM_STEP);
    applyZoom();
    updateContentSize();
    updateZoomLabel();
  });
  canvas.appendChild(zoomToolbar);

  scrollWrapper.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
    zoomLevel = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoomLevel + delta));
    applyZoom();
    updateContentSize();
    updateZoomLabel();
  }, { passive: false });

  requestAnimationFrame(() => {
    applyZoom();
    updateContentSize();
    updateZoomLabel();
  });

  function createPromptNode({ name = '', note = '', sections = [], outputFormat, left, top, nodeId: givenNodeId }) {
    const nodeId = givenNodeId || generateNodeId();
    const title = (name && name.trim()) ? name.trim() : 'Prompt';
    const node = document.createElement('div');
    node.className = 'workflow-node workflow-node--prompt';
    node.setAttribute('role', 'article');
    node.setAttribute('aria-label', `Prompt node: ${title}`);
    node.dataset.nodeId = nodeId;
    node.dataset.promptSections = JSON.stringify(sections);
    node.dataset.promptName = name;
    node.dataset.promptNote = note;
    let ofList = outputFormat?.fields ?? (Array.isArray(outputFormat) ? outputFormat : []);
    if (!ofList.length && outputFormat?.columns?.length) {
      ofList = outputFormat.columns.map((key) => ({
        key: key || '',
        type: 'str',
        examples: (outputFormat.examples || []).map((r) => r[key]).filter((v) => v != null && v !== ''),
      }));
    }
    ofList = ofList.map((o) => ({ key: o.key || '', type: o.type || 'str', description: o.description ?? '', examples: o.examples || [], allowNone: o.allowNone === true }));
    node.dataset.promptOutputFormat = JSON.stringify(ofList);
    node.dataset.promptOutputReturnShape = outputFormat?.returnShape ?? 'single';
    const x = typeof left === 'number' ? left : 80 + (nodeCount % 5) * (280 + STAGGER);
    const y = typeof top === 'number' ? top : 80 + Math.floor(nodeCount / 5) * (120 + STAGGER);
    nodeCount += 1;
    node.style.left = `${x}px`;
    node.style.top = `${y}px`;
    const noteTrimmed = (note || '').trim();
    const hasNote = noteTrimmed.length > 0;
    if (!hasNote) node.classList.add('workflow-node--no-body');
    node.innerHTML = `
      <div class="workflow-node__header">
        <span class="workflow-node__icon workflow-node__icon--prompt" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="2" y1="4" x2="12" y2="4"/><line x1="2" y1="7" x2="12" y2="7"/><line x1="2" y1="10" x2="8" y2="10"/></svg></span>
        <span class="workflow-node__title">${escapeHtml(title)}</span>
        <button type="button" class="workflow-node__delete" aria-label="Delete node">×</button>
      </div>
      ${hasNote ? `<div class="workflow-node__body"><span class="workflow-node__note">${escapeHtml(noteTrimmed)}</span></div>` : ''}
    `;
    nodesLayer.appendChild(node);

    const deleteBtn = node.querySelector('.workflow-node__delete');
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      removeConnectionsInvolvingNodeId(nodeId);
      node.remove();
      updateContentSize();
      updateEdges();
      document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
    });

    let dragStartX = 0;
    let dragStartY = 0;
    let nodeStartLeft = 0;
    let nodeStartTop = 0;
    let lastInteractionWasDrag = false;

    function onPointerDown(e) {
      if (e.button !== 0) return;
      if (e.target.closest('.workflow-node__delete')) return;
      e.preventDefault();
      lastInteractionWasDrag = false;
      const rect = node.getBoundingClientRect();
      const swRect = scrollWrapper.getBoundingClientRect();
      const sl = scrollWrapper.scrollLeft;
      const st = scrollWrapper.scrollTop;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      nodeStartLeft = (rect.left - swRect.left + sl) / zoomLevel;
      nodeStartTop = (rect.top - swRect.top + st) / zoomLevel;
      node.classList.add('workflow-node--dragging');
      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp, { once: true });
    }

    function onPointerMove(e) {
      lastInteractionWasDrag = true;
      const dx = (e.clientX - dragStartX) / zoomLevel;
      const dy = (e.clientY - dragStartY) / zoomLevel;
      node.style.left = `${nodeStartLeft + dx}px`;
      node.style.top = `${nodeStartTop + dy}px`;
      updateEdges();
    }

    function onPointerUp() {
      node.classList.remove('workflow-node--dragging');
      document.removeEventListener('pointermove', onPointerMove);
      updateContentSize();
      updateEdges();
      document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
    }

    node.addEventListener('pointerdown', onPointerDown);

    node.addEventListener('click', (e) => {
      if (e.target.closest('.workflow-node__delete')) return;
      if (lastInteractionWasDrag) return;
      e.preventDefault();
      e.stopPropagation();
      let sectionsData = [];
      try {
        sectionsData = JSON.parse(node.dataset.promptSections || node.dataset.promptFields || '[]');
      } catch (_) {}
      openPromptDetailModal({
        name: node.dataset.promptName || '',
        note: node.dataset.promptNote || '',
        sections: sectionsData,
        node,
        isPromptNameAlreadyUsed,
      });
    });

    node.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.workflow-node__delete')) return;
      e.preventDefault();
      e.stopPropagation();
      showNodeContextMenu(e.clientX, e.clientY, node);
    });

    return node;
  }

  const DATASET_BORDER_COLORS = ['#2563eb', '#16a34a', '#ca8a04', '#c026d3', '#0891b2', '#dc2626', '#65a30d', '#7c3aed'];

  function createDatasetNode({ name = '', notes = '', left, top, nodeId: givenNodeId, colorIndex: givenColorIndex, headers, rows }) {
    const nodeId = givenNodeId || generateNodeId();
    const title = (name && name.trim()) ? name.trim() : 'Source dataset';
    const node = document.createElement('div');
    node.className = 'workflow-node workflow-node--dataset';
    node.setAttribute('role', 'article');
    node.setAttribute('aria-label', `Source dataset node: ${title}`);
    node.dataset.nodeId = nodeId;
    node.dataset.datasetName = name;
    node.dataset.datasetNote = notes;
    node.dataset.nodeType = 'dataset';
    let colorIndex = givenColorIndex;
    if (typeof colorIndex !== 'number' || colorIndex < 0) {
      const existingCount = nodesLayer.querySelectorAll('.workflow-node--dataset').length;
      colorIndex = existingCount % DATASET_BORDER_COLORS.length;
    }
    colorIndex = colorIndex % DATASET_BORDER_COLORS.length;
    node.dataset.datasetColorIndex = String(colorIndex);
    const x = typeof left === 'number' ? left : 80 + (nodeCount % 5) * (280 + STAGGER);
    const y = typeof top === 'number' ? top : 80 + Math.floor(nodeCount / 5) * (120 + STAGGER);
    nodeCount += 1;
    node.style.left = `${x}px`;
    node.style.top = `${y}px`;
    const notesTrimmed = (notes || '').trim();
    const hasNote = notesTrimmed.length > 0;
    if (!hasNote) node.classList.add('workflow-node--no-body');
    node.innerHTML = `
      <div class="workflow-node__header">
        <span class="workflow-node__icon workflow-node__icon--dataset" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><ellipse cx="7" cy="2.8" rx="4" ry="1.2"/><ellipse cx="7" cy="11.2" rx="4" ry="1.2"/><line x1="3" y1="2.8" x2="3" y2="11.2"/><line x1="11" y1="2.8" x2="11" y2="11.2"/></svg></span>
        <span class="workflow-node__title">${escapeHtml(title)}</span>
        <button type="button" class="workflow-node__delete" aria-label="Delete node">×</button>
      </div>
      ${hasNote ? `<div class="workflow-node__body"><span class="workflow-node__note">${escapeHtml(notesTrimmed)}</span></div>` : ''}
    `;
    nodesLayer.appendChild(node);

    if (Array.isArray(headers) && Array.isArray(rows)) {
      datasetContentByNodeId.set(nodeId, { headers, rows });
    }

    const deleteBtn = node.querySelector('.workflow-node__delete');
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      removeConnectionsInvolvingNodeId(nodeId);
      datasetContentByNodeId.delete(nodeId);
      node.remove();
      updateContentSize();
      updateEdges();
      document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
    });

    let dragStartX = 0, dragStartY = 0, nodeStartLeft = 0, nodeStartTop = 0;
    let lastInteractionWasDrag = false;
    function onPointerDown(e) {
      if (e.button !== 0) return;
      if (e.target.closest('.workflow-node__delete')) return;
      e.preventDefault();
      lastInteractionWasDrag = false;
      const rect = node.getBoundingClientRect();
      const swRect = scrollWrapper.getBoundingClientRect();
      const sl = scrollWrapper.scrollLeft;
      const st = scrollWrapper.scrollTop;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      nodeStartLeft = (rect.left - swRect.left + sl) / zoomLevel;
      nodeStartTop = (rect.top - swRect.top + st) / zoomLevel;
      node.classList.add('workflow-node--dragging');
      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp, { once: true });
    }
    function onPointerMove(e) {
      lastInteractionWasDrag = true;
      const dx = (e.clientX - dragStartX) / zoomLevel;
      const dy = (e.clientY - dragStartY) / zoomLevel;
      node.style.left = `${nodeStartLeft + dx}px`;
      node.style.top = `${nodeStartTop + dy}px`;
      updateEdges();
    }
    function onPointerUp() {
      node.classList.remove('workflow-node--dragging');
      document.removeEventListener('pointermove', onPointerMove);
      updateContentSize();
      updateEdges();
      document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
    }
    node.addEventListener('pointerdown', onPointerDown);

    node.addEventListener('click', (e) => {
      if (e.target.closest('.workflow-node__delete')) return;
      if (lastInteractionWasDrag) return;
      e.preventDefault();
      e.stopPropagation();
      openDatasetDetailModal({
        node,
        getDatasetContent: () => datasetContentByNodeId.get(node.dataset.nodeId) || { headers: [], rows: [] },
        isDatasetNameAlreadyUsed,
        isSamplerNameAlreadyUsedForSource,
      });
    });

    node.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.workflow-node__delete')) return;
      e.preventDefault();
      e.stopPropagation();
      showNodeContextMenu(e.clientX, e.clientY, node);
    });

    return node;
  }

  function createSamplerNode({ name = '', notes = '', left, top, nodeId: givenNodeId, sourceNodeId = '', colorIndex: givenColorIndex, samplingType = 'without-replacement', sampleSizeType = 'rows', sampleSize = 100, rowSpec = '' }) {
    const nodeId = givenNodeId || generateNodeId();
    const title = (name && name.trim()) ? name.trim() : 'Sampler';
    const node = document.createElement('div');
    node.className = 'workflow-node workflow-node--sampler workflow-node--no-body';
    node.setAttribute('role', 'article');
    node.setAttribute('aria-label', `Sampler node: ${title}`);
    node.dataset.nodeId = nodeId;
    node.dataset.samplerName = name;
    node.dataset.samplerNote = notes;
    node.dataset.nodeType = 'sampler';
    node.dataset.samplerSamplingType = samplingType;
    if (samplingType === 'specify-rows') {
      node.dataset.samplerRowSpec = (rowSpec || '').trim();
    } else {
      node.dataset.samplerSampleSizeType = sampleSizeType;
      node.dataset.samplerSampleSize = String(sampleSize);
    }
    if (sourceNodeId) node.dataset.sourceNodeId = sourceNodeId;
    let colorIndex = typeof givenColorIndex === 'number' && givenColorIndex >= 0 ? givenColorIndex : 0;
    colorIndex = colorIndex % DATASET_BORDER_COLORS.length;
    node.dataset.samplerColorIndex = String(colorIndex);
    const x = typeof left === 'number' ? left : 80 + (nodeCount % 5) * (280 + STAGGER);
    const y = typeof top === 'number' ? top : 80 + Math.floor(nodeCount / 5) * (120 + STAGGER);
    nodeCount += 1;
    node.style.left = `${x}px`;
    node.style.top = `${y}px`;
    node.innerHTML = `
      <div class="workflow-node__header">
        <span class="workflow-node__icon workflow-node__icon--sampler" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><path d="M2 2h10l-2 5H4L2 2z"/><line x1="4" y1="7" x2="10" y2="7"/><line x1="5" y1="11" x2="9" y2="11"/><line x1="6" y1="13" x2="8" y2="13"/></svg></span>
        <span class="workflow-node__title">${escapeHtml(title)}</span>
        <button type="button" class="workflow-node__delete" aria-label="Delete node">×</button>
      </div>
    `;
    nodesLayer.appendChild(node);

    const deleteBtn = node.querySelector('.workflow-node__delete');
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      removeConnectionsInvolvingNodeId(nodeId);
      node.remove();
      updateContentSize();
      updateEdges();
      document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
    });

    let dragStartX = 0, dragStartY = 0, nodeStartLeft = 0, nodeStartTop = 0;
    let lastInteractionWasDrag = false;
    function onPointerDown(e) {
      if (e.button !== 0) return;
      if (e.target.closest('.workflow-node__delete')) return;
      e.preventDefault();
      lastInteractionWasDrag = false;
      const rect = node.getBoundingClientRect();
      const swRect = scrollWrapper.getBoundingClientRect();
      const sl = scrollWrapper.scrollLeft;
      const st = scrollWrapper.scrollTop;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      nodeStartLeft = (rect.left - swRect.left + sl) / zoomLevel;
      nodeStartTop = (rect.top - swRect.top + st) / zoomLevel;
      node.classList.add('workflow-node--dragging');
      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp, { once: true });
    }
    function onPointerMove(e) {
      lastInteractionWasDrag = true;
      const dx = (e.clientX - dragStartX) / zoomLevel;
      const dy = (e.clientY - dragStartY) / zoomLevel;
      node.style.left = `${nodeStartLeft + dx}px`;
      node.style.top = `${nodeStartTop + dy}px`;
      updateEdges();
    }
    function onPointerUp() {
      node.classList.remove('workflow-node--dragging');
      document.removeEventListener('pointermove', onPointerMove);
      updateContentSize();
      updateEdges();
      document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
    }
    node.addEventListener('pointerdown', onPointerDown);

    node.addEventListener('click', (e) => {
      if (e.target.closest('.workflow-node__delete')) return;
      if (lastInteractionWasDrag) return;
      e.preventDefault();
      e.stopPropagation();
      openSamplerDetailModal({ node });
    });

    node.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.workflow-node__delete')) return;
      e.preventDefault();
      e.stopPropagation();
      showNodeContextMenu(e.clientX, e.clientY, node);
    });

    return node;
  }

  function createSubsetNode({ name = '', left, top, nodeId: givenNodeId, samplerNodeId = '', colorIndex: givenColorIndex, headers, rows }) {
    const nodeId = givenNodeId || generateNodeId();
    const title = (name && name.trim()) ? name.trim() : 'Working dataset';
    const node = document.createElement('div');
    node.className = 'workflow-node workflow-node--subset workflow-node--no-body';
    node.setAttribute('role', 'article');
    node.setAttribute('aria-label', `Working dataset node: ${title}`);
    node.dataset.nodeId = nodeId;
    node.dataset.subsetName = name;
    node.dataset.nodeType = 'subset';
    if (samplerNodeId) node.dataset.samplerNodeId = samplerNodeId;
    const subsetCount = nodesLayer.querySelectorAll('.workflow-node--subset').length;
    const colorIndex = (typeof givenColorIndex === 'number' && givenColorIndex >= 0)
      ? (givenColorIndex % DATASET_BORDER_COLORS.length)
      : (subsetCount % DATASET_BORDER_COLORS.length);
    node.dataset.subsetColorIndex = String(colorIndex);
    node.style.borderColor = DATASET_BORDER_COLORS[colorIndex];
    if (Array.isArray(headers) && Array.isArray(rows)) subsetContentByNodeId.set(nodeId, { headers: headers.slice(), rows: rows.map((r) => r.slice()) });
    const x = typeof left === 'number' ? left : 80 + (nodeCount % 5) * (280 + STAGGER);
    const y = typeof top === 'number' ? top : 80 + Math.floor(nodeCount / 5) * (120 + STAGGER);
    nodeCount += 1;
    node.style.left = `${x}px`;
    node.style.top = `${y}px`;
    node.innerHTML = `
      <div class="workflow-node__header">
        <span class="workflow-node__icon workflow-node__icon--subset" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><rect x="1" y="1" width="12" height="12" rx="0.5"/><line x1="1" y1="4" x2="13" y2="4"/><line x1="1" y1="7" x2="13" y2="7"/><line x1="1" y1="10" x2="13" y2="10"/><line x1="4.5" y1="1" x2="4.5" y2="13"/><line x1="8" y1="1" x2="8" y2="13"/></svg></span>
        <span class="workflow-node__title">${escapeHtml(title)}</span>
        <button type="button" class="workflow-node__delete" aria-label="Delete node">×</button>
      </div>
    `;
    nodesLayer.appendChild(node);

    const deleteBtn = node.querySelector('.workflow-node__delete');
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      removeConnectionsInvolvingNodeId(nodeId);
      subsetContentByNodeId.delete(nodeId);
      node.remove();
      updateContentSize();
      updateEdges();
      document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
    });

    let dragStartX = 0, dragStartY = 0, nodeStartLeft = 0, nodeStartTop = 0;
    let lastInteractionWasDrag = false;
    function onPointerDown(e) {
      if (e.button !== 0) return;
      if (e.target.closest('.workflow-node__delete')) return;
      e.preventDefault();
      lastInteractionWasDrag = false;
      const rect = node.getBoundingClientRect();
      const swRect = scrollWrapper.getBoundingClientRect();
      const sl = scrollWrapper.scrollLeft;
      const st = scrollWrapper.scrollTop;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      nodeStartLeft = (rect.left - swRect.left + sl) / zoomLevel;
      nodeStartTop = (rect.top - swRect.top + st) / zoomLevel;
      node.classList.add('workflow-node--dragging');
      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp, { once: true });
    }
    function onPointerMove(e) {
      lastInteractionWasDrag = true;
      const dx = (e.clientX - dragStartX) / zoomLevel;
      const dy = (e.clientY - dragStartY) / zoomLevel;
      node.style.left = `${nodeStartLeft + dx}px`;
      node.style.top = `${nodeStartTop + dy}px`;
      updateEdges();
    }
    function onPointerUp() {
      node.classList.remove('workflow-node--dragging');
      document.removeEventListener('pointermove', onPointerMove);
      updateContentSize();
      updateEdges();
      document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
    }
    node.addEventListener('pointerdown', onPointerDown);

    node.addEventListener('click', (e) => {
      if (e.target.closest('.workflow-node__delete')) return;
      if (lastInteractionWasDrag) return;
      e.preventDefault();
      e.stopPropagation();
      openWorkingDatasetDetailModal({
        node,
        getContent: () => subsetContentByNodeId.get(node.dataset.nodeId) || { headers: [], rows: [] },
        saveContent: (content) => {
          subsetContentByNodeId.set(node.dataset.nodeId, { headers: content.headers.slice(), rows: content.rows.map((r) => r.slice()) });
          document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
        },
      });
    });

    node.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.workflow-node__delete')) return;
      e.preventDefault();
      e.stopPropagation();
      showNodeContextMenu(e.clientX, e.clientY, node);
    });

    return node;
  }

  function createRunNode({ left, top, nodeId: givenNodeId }) {
    const nodeId = givenNodeId || generateNodeId();
    const node = document.createElement('div');
    node.className = 'workflow-node workflow-node--run workflow-node--no-body';
    node.setAttribute('role', 'article');
    node.setAttribute('aria-label', 'Run node');
    node.dataset.nodeId = nodeId;
    node.dataset.nodeType = 'run';
    const x = typeof left === 'number' ? left : 80 + (nodeCount % 5) * (280 + STAGGER);
    const y = typeof top === 'number' ? top : 80 + Math.floor(nodeCount / 5) * (120 + STAGGER);
    nodeCount += 1;
    node.style.left = `${x}px`;
    node.style.top = `${y}px`;
    node.innerHTML = `
      <div class="workflow-node__header">
        <span class="workflow-node__icon workflow-node__icon--run" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"><path d="M3 2v10l8-5-8-5z"/></svg></span>
        <span class="workflow-node__title">Run</span>
        <button type="button" class="workflow-node__delete" aria-label="Delete node">×</button>
      </div>
    `;
    nodesLayer.appendChild(node);

    const deleteBtn = node.querySelector('.workflow-node__delete');
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      removeConnectionsInvolvingNodeId(nodeId);
      node.remove();
      updateContentSize();
      updateEdges();
      document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
    });

    let dragStartX = 0, dragStartY = 0, nodeStartLeft = 0, nodeStartTop = 0;
    let lastInteractionWasDrag = false;
    function onPointerDown(e) {
      if (e.button !== 0) return;
      if (e.target.closest('.workflow-node__delete')) return;
      e.preventDefault();
      lastInteractionWasDrag = false;
      const rect = node.getBoundingClientRect();
      const swRect = scrollWrapper.getBoundingClientRect();
      const sl = scrollWrapper.scrollLeft;
      const st = scrollWrapper.scrollTop;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      nodeStartLeft = (rect.left - swRect.left + sl) / zoomLevel;
      nodeStartTop = (rect.top - swRect.top + st) / zoomLevel;
      node.classList.add('workflow-node--dragging');
      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp, { once: true });
    }
    function onPointerMove(e) {
      lastInteractionWasDrag = true;
      const dx = (e.clientX - dragStartX) / zoomLevel;
      const dy = (e.clientY - dragStartY) / zoomLevel;
      node.style.left = `${nodeStartLeft + dx}px`;
      node.style.top = `${nodeStartTop + dy}px`;
      updateEdges();
    }
    function onPointerUp() {
      node.classList.remove('workflow-node--dragging');
      document.removeEventListener('pointermove', onPointerMove);
      updateContentSize();
      updateEdges();
      document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
    }
    node.addEventListener('pointerdown', onPointerDown);

    node.addEventListener('click', (e) => {
      if (e.target.closest('.workflow-node__delete')) return;
      if (lastInteractionWasDrag) return;
      e.preventDefault();
      e.stopPropagation();
      const runNodeId = node.dataset.nodeId;
      const promptEdge = connections.find((c) => c.toId === runNodeId && c.type === EDGE_TYPE_PROMPT_TO_RUN);
      let sections = [];
      if (promptEdge) {
        const promptNode = getNodeById(promptEdge.fromId);
        if (promptNode) {
          try {
            sections = JSON.parse(promptNode.dataset.promptSections || promptNode.dataset.promptFields || '[]');
          } catch (_) {}
        }
      }
      const promptInputFields = extractInputFieldsFromSections(Array.isArray(sections) ? sections : []);
      const workingSets = Array.from(nodesLayer.querySelectorAll('.workflow-node--subset')).map((n) => {
        const id = n.dataset.nodeId || '';
        const content = subsetContentByNodeId.get(id);
        const colorIndex = n.dataset.subsetColorIndex != null ? parseInt(n.dataset.subsetColorIndex, 10) : 0;
        const color = DATASET_BORDER_COLORS[colorIndex % DATASET_BORDER_COLORS.length];
        return {
          nodeId: id,
          name: (n.dataset.subsetName || '').trim() || 'Working dataset',
          headers: content?.headers ? content.headers.slice() : [],
          color,
        };
      });
      openRunDetailModal({
        node,
        getWorkingSets: () => workingSets,
        getPromptInputFields: () => promptInputFields,
      });
    });

    return node;
  }

  function removeConnectionsInvolvingNodeId(id) {
    connections = connections.filter((c) => c.fromId !== id && c.toId !== id);
  }

  /**
   * Given current working dataset name, return a unique name for a new version.
   * Only strips trailing " vN" to get version base; never strips " (Copy N)".
   * So: "MySet v2" -> "MySet v3"; "MySet (Copy 1)" -> "MySet (Copy 1) v2".
   * Scans all subset nodes (including current) so version number always increments.
   * @param {string} baseName - current subset name
   * @param {string} [excludeNodeId] - unused; we count all nodes to get next version
   * @returns {string}
   */
  function findNextWorkingDatasetVersionName(baseName, excludeNodeId) {
    const raw = (baseName || 'Working dataset').trim() || 'Working dataset';
    const versionBase = stripVersionSuffixOnly(raw).trim() || 'Working dataset';
    const subsetNodes = nodesLayer.querySelectorAll('.workflow-node--subset');
    let nextV = 2;
    const versionPrefix = versionBase + ' v';
    for (const n of subsetNodes) {
      const name = (n.dataset.subsetName || '').trim();
      const nBase = stripVersionSuffixOnly(name).trim();
      if (nBase !== versionBase) continue;
      if (name === versionBase) {
        nextV = Math.max(nextV, 2);
        continue;
      }
      if (!name.startsWith(versionPrefix)) continue;
      const numStr = name.slice(versionPrefix.length).trim();
      if (!/^\d+$/.test(numStr)) continue;
      const num = parseInt(numStr, 10);
      if (Number.isFinite(num) && num >= 1) nextV = Math.max(nextV, num + 1);
    }
    return `${versionBase} v${nextV}`;
  }

  function showNodeContextMenu(clientX, clientY, node) {
    const existing = document.querySelector('.workflow-node-context-menu');
    if (existing) existing.remove();

    const isDataset = node.dataset.nodeType === 'dataset';
    const isSampler = node.dataset.nodeType === 'sampler';
    const isSubset = node.dataset.nodeType === 'subset';
    if (isDataset) return;

    const menu = document.createElement('div');
    menu.className = 'workflow-node-context-menu';
    menu.setAttribute('role', 'menu');
    if (isSampler) {
      menu.innerHTML = `
        <button type="button" class="workflow-node-context-item" data-action="create-working-dataset" role="menuitem">Create working dataset</button>
      `;
    } else if (isSubset) {
      menu.innerHTML = `
        <button type="button" class="workflow-node-context-item" data-action="duplicate-working-dataset" role="menuitem">Duplicate this working dataset</button>
        <button type="button" class="workflow-node-context-item" data-action="add-version-of-dataset" role="menuitem">Add version of dataset</button>
      `;
    } else {
      menu.innerHTML = `
        <button type="button" class="workflow-node-context-item" data-action="duplicate" role="menuitem">Duplicate this prompt</button>
        <button type="button" class="workflow-node-context-item" data-action="new-version" role="menuitem">Add new version of this prompt</button>
        <button type="button" class="workflow-node-context-item" data-action="run-this-prompt" role="menuitem">Run this prompt...</button>
      `;
    }

    function duplicateNode(isNewVersion = false) {
      const left = parseFloat(node.style.left) || 0;
      const top = parseFloat(node.style.top) || 0;
      const width = node.offsetWidth || 280;
      const height = node.offsetHeight || 80;
      let sections = [];
      let outputFormat = { returnShape: 'single', fields: [] };
      try {
        sections = JSON.parse(node.dataset.promptSections || node.dataset.promptFields || '[]');
      } catch (_) {}
      try {
        const raw = JSON.parse(node.dataset.promptOutputFormat || '[]');
        const fields = (Array.isArray(raw) ? raw : []).map((o) => ({ key: o.key || '', type: o.type || 'str', description: o.description ?? '', examples: o.examples || [], allowNone: o.allowNone === true }));
        outputFormat = { returnShape: node.dataset.promptOutputReturnShape || 'single', fields };
      } catch (_) {}
      const uniqueName = findUniquePromptName(node.dataset.promptName || '', isNewVersion);
      const newNode = createPromptNode({
        name: uniqueName,
        note: node.dataset.promptNote || '',
        sections: Array.isArray(sections) ? sections : [],
        outputFormat,
        left: isNewVersion ? left + width + NEW_NODE_OFFSET : left,
        top: isNewVersion ? top : top + height + NEW_NODE_OFFSET,
      });
      updateContentSize();
      document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
      return newNode;
    }

    const actions = {
      'run-this-prompt': () => {
        const left = parseFloat(node.style.left) || 0;
        const top = parseFloat(node.style.top) || 0;
        const width = node.offsetWidth || 280;
        const runNode = createRunNode({
          left: left + width + NEW_NODE_OFFSET,
          top,
        });
        if (runNode?.dataset?.nodeId) {
          connections.push({
            fromId: node.dataset.nodeId,
            toId: runNode.dataset.nodeId,
            type: EDGE_TYPE_PROMPT_TO_RUN,
          });
          updateEdges();
        }
        updateContentSize();
        document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
      },
      duplicate: () => {
        const newNode = duplicateNode(false);
        if (newNode) {
          connections.filter((c) => c.toId === node.dataset.nodeId).forEach((c) => {
            connections.push({ fromId: c.fromId, toId: newNode.dataset.nodeId, type: c.type });
          });
          updateEdges();
          document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
        }
      },
      'new-version': () => {
        const newNode = duplicateNode(true);
        if (newNode) {
          connections.push({
            fromId: node.dataset.nodeId,
            toId: newNode.dataset.nodeId,
            type: EDGE_TYPE_PROMPT_TO_PROMPT,
          });
          updateEdges();
          document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
        }
      },
      'create-working-dataset': () => {
        const samplerNodeId = node.dataset.nodeId || '';
        const colorIndex = node.dataset.samplerColorIndex != null ? parseInt(node.dataset.samplerColorIndex, 10) : undefined;
        document.dispatchEvent(new CustomEvent('workflow:add-subset-node', { detail: { samplerNodeId, colorIndex } }));
      },
      'duplicate-working-dataset': () => {
        const left = parseFloat(node.style.left) || 0;
        const top = parseFloat(node.style.top) || 0;
        const height = node.offsetHeight || 80;
        const currentName = (node.dataset.subsetName || '').trim() || 'Working dataset';
        const newName = findUniqueWorkingDatasetName(currentName, false);
        const content = subsetContentByNodeId.get(node.dataset.nodeId);
        const headers = content?.headers ? content.headers.slice() : [];
        const rows = content?.rows ? content.rows.map((r) => r.slice()) : [];
        const samplerNodeId = node.dataset.samplerNodeId || '';
        const newNode = createSubsetNode({
          name: newName,
          left,
          top: top + height + NEW_NODE_OFFSET,
          samplerNodeId,
          headers,
          rows,
        });
        if (newNode?.dataset?.nodeId) {
          connections.filter((c) => c.toId === node.dataset.nodeId).forEach((c) => {
            connections.push({ fromId: c.fromId, toId: newNode.dataset.nodeId, type: c.type });
          });
          updateEdges();
        }
        updateContentSize();
        document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
      },
      'add-version-of-dataset': () => {
        const left = parseFloat(node.style.left) || 0;
        const top = parseFloat(node.style.top) || 0;
        const width = node.offsetWidth || 280;
        const currentName = (node.dataset.subsetName || '').trim() || 'Working dataset';
        const versionName = findNextWorkingDatasetVersionName(currentName, node.dataset.nodeId);
        const content = subsetContentByNodeId.get(node.dataset.nodeId);
        const headers = content?.headers ? content.headers.slice() : [];
        const rows = content?.rows ? content.rows.map((r) => r.slice()) : [];
        const samplerNodeId = node.dataset.samplerNodeId || '';
        const newNode = createSubsetNode({
          name: versionName,
          left: left + width + NEW_NODE_OFFSET,
          top,
          samplerNodeId,
          headers,
          rows,
        });
        if (newNode?.dataset?.nodeId) {
          connections.push({
            fromId: node.dataset.nodeId,
            toId: newNode.dataset.nodeId,
            type: EDGE_TYPE_SUBSET_TO_SUBSET,
          });
          updateEdges();
        }
        updateContentSize();
        document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
      },
    };

    menu.querySelectorAll('.workflow-node-context-item').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = btn.getAttribute('data-action');
        if (actions[action]) actions[action]();
        menu.remove();
      });
    });

    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    const padding = 8;
    let left = clientX;
    let top = clientY;
    if (left + rect.width + padding > window.innerWidth) left = window.innerWidth - rect.width - padding;
    if (top + rect.height + padding > window.innerHeight) top = window.innerHeight - rect.height - padding;
    if (left < padding) left = padding;
    if (top < padding) top = padding;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    const close = () => {
      menu.remove();
      document.removeEventListener('click', close);
      document.removeEventListener('contextmenu', close);
    };
    requestAnimationFrame(() => document.addEventListener('click', close, { once: true }));
    document.addEventListener('contextmenu', close, { once: true });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  /**
   * Show an in-app alert dialog (replaces window.alert). Appends to document.body.
   * @param {string} message - Body text
   * @param {string} [title='Message'] - Dialog title
   */
  function showAppAlert(message, title = 'Message') {
    const overlay = document.createElement('div');
    overlay.className = 'app-alert-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'app-alert-title');
    overlay.innerHTML = `
      <div class="app-alert-dialog">
        <p id="app-alert-title" class="app-alert-dialog-title">${escapeHtml(title)}</p>
        <p class="app-alert-dialog-message">${escapeHtml(message)}</p>
        <div class="app-alert-dialog-btns">
          <button type="button" class="btn btn-secondary app-alert-ok">OK</button>
        </div>
      </div>
    `;
    const remove = () => overlay.remove();
    overlay.querySelector('.app-alert-ok').addEventListener('click', remove);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) remove(); });
    document.body.appendChild(overlay);
  }

  document.addEventListener('workflow:add-prompt-node', (e) => {
    const { name = '', note = '', sections = [], outputFormat } = e.detail || {};
    createPromptNode({ name, note, sections, outputFormat });
    updateContentSize();
    document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
  });

  document.addEventListener('workflow:add-dataset-node', (e) => {
    const { name = '', notes = '', headers, rows } = e.detail || {};
    createDatasetNode({ name, notes, headers, rows });
    updateContentSize();
    document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
  });

  document.addEventListener('workflow:add-sampler-node', (e) => {
    const { sourceNodeId = '', colorIndex, name = 'Sampler', samplingType = 'without-replacement', sampleSizeType = 'rows', sampleSize = 100, rowSpec = '' } = e.detail || {};
    let left, top;
    const sourceNode = sourceNodeId ? getNodeById(sourceNodeId) : null;
    if (sourceNode) {
      left = (parseFloat(sourceNode.style.left) || 0) + (sourceNode.offsetWidth || 280) + NEW_NODE_OFFSET;
      top = parseFloat(sourceNode.style.top) || 0;
    }
    const newNode = createSamplerNode({ name, notes: '', left, top, sourceNodeId, colorIndex, samplingType, sampleSizeType, sampleSize, rowSpec });
    if (sourceNodeId && newNode?.dataset?.nodeId) {
      connections.push({
        fromId: sourceNodeId,
        toId: newNode.dataset.nodeId,
        type: EDGE_TYPE_DATASET_TO_SAMPLER,
      });
      updateEdges();
    }
    updateContentSize();
    document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
  });

  document.addEventListener('workflow:add-subset-node', (e) => {
    const { samplerNodeId = '' } = e.detail || {};
    let left, top;
    let headers = [];
    let rows = [];
    const samplerNode = samplerNodeId ? getNodeById(samplerNodeId) : null;
    if (samplerNode) {
      left = (parseFloat(samplerNode.style.left) || 0) + (samplerNode.offsetWidth || 280) + NEW_NODE_OFFSET;
      top = parseFloat(samplerNode.style.top) || 0;
      const sourceNodeId = samplerNode.dataset.sourceNodeId;
      const sourceContent = sourceNodeId ? datasetContentByNodeId.get(sourceNodeId) : null;
      if (sourceContent?.headers?.length && Array.isArray(sourceContent.rows)) {
        headers = sourceContent.headers.slice();
        const samplingType = samplerNode.dataset.samplerSamplingType || 'without-replacement';
        if (samplingType === 'specify-rows') {
          const rowSpec = (samplerNode.dataset.samplerRowSpec || '').trim();
          const totalRows = sourceContent.rows.length;
          const indices = parseRowSpec(rowSpec, totalRows);
          rows = indices.map((i) => sourceContent.rows[i].slice());
        } else {
          const sampleSize = parseInt(samplerNode.dataset.samplerSampleSize, 10) || 100;
          const sampleSizeType = samplerNode.dataset.samplerSampleSizeType || 'rows';
          const totalRows = sourceContent.rows.length;
          const requestedCount = sampleSizeType === 'rows'
            ? Math.max(0, Math.floor(sampleSize))
            : Math.max(0, Math.floor((totalRows * sampleSize) / 100));
          if (samplingType === 'without-replacement' && requestedCount > 0) {
            let alreadyUsed = 0;
            nodesLayer.querySelectorAll('.workflow-node--subset').forEach((subNode) => {
              if ((subNode.dataset.samplerNodeId || '') === samplerNodeId) {
                const content = subsetContentByNodeId.get(subNode.dataset.nodeId);
                if (content?.rows?.length) alreadyUsed += content.rows.length;
              }
            });
            const remaining = totalRows - alreadyUsed;
            if (remaining < requestedCount) {
              showAppAlert(
                'Not enough remaining data to create a new working dataset when sampling without replacement.',
                'Cannot create subset'
              );
              return;
            }
          }
          rows = sampleRows(sourceContent.rows, sampleSize, sampleSizeType, samplingType);
        }
      }
    }
    const name = samplerNodeId ? findNextWorkingDatasetName(samplerNodeId) : 'Working dataset';
    const newNode = createSubsetNode({ name, left, top, samplerNodeId, headers, rows });
    if (samplerNodeId && newNode?.dataset?.nodeId) {
      connections.push({
        fromId: samplerNodeId,
        toId: newNode.dataset.nodeId,
        type: EDGE_TYPE_SAMPLER_TO_SUBSET,
      });
      updateEdges();
    }
    updateContentSize();
    document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
  });

  function getCanvasState() {
    const nodeEls = Array.from(nodesLayer.querySelectorAll('.workflow-node'));
    const nodes = nodeEls.map((node) => {
      const left = parseFloat(node.style.left) || 0;
      const top = parseFloat(node.style.top) || 0;
      const nodeId = node.dataset.nodeId || '';
      if (node.classList.contains('workflow-node--dataset')) {
        const datasetContent = datasetContentByNodeId.get(nodeId);
        return {
          type: 'dataset',
          nodeId,
          left,
          top,
          name: node.dataset.datasetName || '',
          note: node.dataset.datasetNote || '',
          colorIndex: node.dataset.datasetColorIndex != null ? parseInt(node.dataset.datasetColorIndex, 10) : undefined,
          datasetContent: datasetContent ? { headers: datasetContent.headers, rows: datasetContent.rows } : undefined,
        };
      }
      if (node.classList.contains('workflow-node--sampler')) {
        const samplingType = node.dataset.samplerSamplingType || 'without-replacement';
        const out = {
          type: 'sampler',
          nodeId,
          left,
          top,
          name: node.dataset.samplerName || '',
          note: node.dataset.samplerNote || '',
          sourceNodeId: node.dataset.sourceNodeId || '',
          colorIndex: node.dataset.samplerColorIndex != null ? parseInt(node.dataset.samplerColorIndex, 10) : undefined,
          samplingType,
        };
        if (samplingType === 'specify-rows') {
          out.rowSpec = (node.dataset.samplerRowSpec || '').trim();
        } else {
          out.sampleSizeType = node.dataset.samplerSampleSizeType || 'rows';
          out.sampleSize = node.dataset.samplerSampleSize != null ? parseInt(node.dataset.samplerSampleSize, 10) : 100;
        }
        return out;
      }
      if (node.classList.contains('workflow-node--subset')) {
        const subsetContent = subsetContentByNodeId.get(nodeId);
        return {
          type: 'subset',
          nodeId,
          left,
          top,
          name: node.dataset.subsetName || '',
          samplerNodeId: node.dataset.samplerNodeId || '',
          colorIndex: node.dataset.subsetColorIndex != null ? parseInt(node.dataset.subsetColorIndex, 10) : undefined,
          subsetContent: subsetContent ? { headers: subsetContent.headers, rows: subsetContent.rows } : undefined,
        };
      }
      if (node.classList.contains('workflow-node--run')) {
        return { type: 'run', nodeId, left, top };
      }
      let sections = [];
      let outputFormat = [];
      try {
        sections = JSON.parse(node.dataset.promptSections || node.dataset.promptFields || '[]');
      } catch (_) {}
      try {
        const raw = JSON.parse(node.dataset.promptOutputFormat || '[]');
        const fields = (Array.isArray(raw) ? raw : []).map((o) => ({ key: o.key || '', type: o.type || 'str', description: o.description ?? '', examples: o.examples || [] }));
        const returnShape = node.dataset.promptOutputReturnShape || 'single';
        outputFormat = { returnShape, fields };
      } catch (_) {
        outputFormat = { returnShape: 'single', fields: [] };
      }
      return {
        type: 'prompt',
        nodeId,
        left,
        top,
        name: node.dataset.promptName || '',
        note: node.dataset.promptNote || '',
        sections: Array.isArray(sections) ? sections : [],
        outputFormat,
      };
    });
    return { version: 2, nodes, connections: connections.slice() };
  }

  function loadCanvasState(state) {
    const list = state?.nodes;
    if (!Array.isArray(list)) return;
    nodesLayer.innerHTML = '';
    nodeCount = 0;
    const createdNodes = [];
    list.forEach((n) => {
      if (n.type === 'dataset') {
        const content = n.datasetContent;
        const node = createDatasetNode({
          name: n.name || '',
          notes: n.note || '',
          left: n.left,
          top: n.top,
          nodeId: n.nodeId || n.id,
          colorIndex: n.colorIndex,
          headers: content?.headers,
          rows: content?.rows,
        });
        createdNodes.push(node);
      } else if (n.type === 'sampler') {
        const samplingType = n.samplingType || 'without-replacement';
        const node = createSamplerNode({
          name: n.name || '',
          notes: n.note || '',
          left: n.left,
          top: n.top,
          nodeId: n.nodeId || n.id,
          sourceNodeId: n.sourceNodeId || '',
          colorIndex: n.colorIndex,
          samplingType,
          sampleSizeType: n.sampleSizeType || 'rows',
          sampleSize: n.sampleSize != null ? n.sampleSize : 100,
          rowSpec: (n.rowSpec || '').trim(),
        });
        createdNodes.push(node);
      } else if (n.type === 'subset') {
        const content = n.subsetContent;
        const node = createSubsetNode({
          name: n.name || '',
          left: n.left,
          top: n.top,
          nodeId: n.nodeId || n.id,
          samplerNodeId: n.samplerNodeId || '',
          colorIndex: n.colorIndex,
          headers: content?.headers,
          rows: content?.rows,
        });
        createdNodes.push(node);
      } else if (n.type === 'run') {
        const runNode = createRunNode({ left: n.left, top: n.top, nodeId: n.nodeId || n.id });
        createdNodes.push(runNode);
      } else {
        const node = createPromptNode({
          name: n.name || '',
          note: n.note || '',
          sections: n.sections || n.fields || [],
          outputFormat: n.outputFormat,
          left: n.left,
          top: n.top,
          nodeId: n.nodeId || n.id,
        });
        createdNodes.push(node);
      }
    });
    // Normalize connections: support old { from, to } indices and new { fromId, toId, type }
    const rawConnections = Array.isArray(state.connections) ? state.connections : [];
    connections = rawConnections.map((c) => {
      if (c.fromId != null && c.toId != null) {
        return { fromId: c.fromId, toId: c.toId, type: c.type || EDGE_TYPE_PROMPT_TO_PROMPT };
      }
      if (typeof c.from === 'number' && typeof c.to === 'number') {
        const fromNode = createdNodes[c.from];
        const toNode = createdNodes[c.to];
        if (fromNode?.dataset?.nodeId && toNode?.dataset?.nodeId) {
          return {
            fromId: fromNode.dataset.nodeId,
            toId: toNode.dataset.nodeId,
            type: EDGE_TYPE_PROMPT_TO_PROMPT,
          };
        }
      }
      return null;
    }).filter(Boolean);
    updateContentSize();
    updateEdges();
  }

  function setOnCanvasChange(fn) {
    document.addEventListener('workflow:canvas-changed', fn);
  }

  root.appendChild(canvas);
  return { getCanvasState, loadCanvasState, setOnCanvasChange, isPromptNameAlreadyUsed, isDatasetNameAlreadyUsed };
}
