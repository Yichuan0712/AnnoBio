/**
 * Workflow canvas (node-based editor surface).
 * Listens for workflow:add-prompt-node to add prompt nodes.
 * Edges use stable node ids and a type field for future extensibility.
 */

import { openDatasetDetailModal } from './datasetDetailModal.js';
import { openPromptDetailModal } from './promptDetailModal.js';

const MIN_CONTENT_PADDING = 200;
/** Minimum canvas content size (width, height) so there is plenty of room to work and zoom. */
const MIN_CANVAS_WIDTH = 4000;
const MIN_CANVAS_HEIGHT = 2600;

/** Edge type for prompt �?prompt (e.g. "new version" link). Add more types here as needed. */
const EDGE_TYPE_PROMPT_TO_PROMPT = 'prompt-to-prompt';

/** Invisible stroke width for edge hit area (px). */
const EDGE_HIT_STROKE_WIDTH = 16;

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

  function getNodeList() {
    return Array.from(nodesLayer.querySelectorAll('.workflow-node--prompt'));
  }

  function getNodeById(nodeId) {
    if (!nodeId) return null;
    return nodesLayer.querySelector(`[data-node-id="${nodeId}"]`) || null;
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
   * Find a unique prompt name by appending suffix. Used for duplicate / new version.
   * Strips existing " (Copy N)" / " vN" from base so we get "Name (Copy 2)" not "Name (Copy 1) (Copy 1)".
   * @param {string} baseName - base name (e.g. from source node)
   * @param {boolean} isNewVersion - true for "Name v1", false for "Name (Copy 1)"
   * @returns {string}
   */
  function findUniquePromptName(baseName, isNewVersion) {
    const base = stripCopyOrVersionSuffix(baseName || '');
    let n = 1;
    let candidate;
    do {
      candidate = isNewVersion ? `${base} v${n}` : `${base} (Copy ${n})`;
      n++;
    } while (isPromptNameAlreadyUsed(candidate));
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
      g.appendChild(line);
    }
  }

  function updateEdges() {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('pointer-events', 'none');
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
    lines.push('Name: ' + (data.name || '').trim());
    lines.push('Description: ' + (data.note || '').trim());
    lines.push('');
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
          <h2 id="edge-detail-title" class="modal-title">Compare versions: ${escapeHtml(fromName)} �?${escapeHtml(toName)}</h2>
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
    if (edgeType === EDGE_TYPE_PROMPT_TO_PROMPT && indexStr !== null) {
      const edgeIndex = parseInt(indexStr, 10);
      const edge = connections[edgeIndex];
      if (edge) {
        e.preventDefault();
        e.stopPropagation();
        openEdgeDetailModal(edge, edgeIndex);
      }
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
      const scrollContainer = nodesLayer.parentElement?.parentElement;
      const parentRect = scrollContainer ? scrollContainer.getBoundingClientRect() : nodesLayer.getBoundingClientRect();
      const scrollLeft = scrollContainer ? scrollContainer.scrollLeft : 0;
      const scrollTop = scrollContainer ? scrollContainer.scrollTop : 0;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      nodeStartLeft = rect.left - parentRect.left + scrollLeft;
      nodeStartTop = rect.top - parentRect.top + scrollTop;
      node.classList.add('workflow-node--dragging');
      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp, { once: true });
    }

    function onPointerMove(e) {
      lastInteractionWasDrag = true;
      const dx = e.clientX - dragStartX;
      const dy = e.clientY - dragStartY;
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
    node.style.borderColor = DATASET_BORDER_COLORS[colorIndex];
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
        <span class="workflow-node__icon workflow-node__icon--dataset" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><rect x="1" y="1" width="12" height="12" rx="0.5"/><line x1="1" y1="4" x2="13" y2="4"/><line x1="1" y1="7" x2="13" y2="7"/><line x1="1" y1="10" x2="13" y2="10"/><line x1="4.5" y1="1" x2="4.5" y2="13"/><line x1="8" y1="1" x2="8" y2="13"/></svg></span>
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
      const scrollContainer = nodesLayer.parentElement?.parentElement;
      const parentRect = scrollContainer ? scrollContainer.getBoundingClientRect() : nodesLayer.getBoundingClientRect();
      const scrollLeft = scrollContainer ? scrollContainer.scrollLeft : 0;
      const scrollTop = scrollContainer ? scrollContainer.scrollTop : 0;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      nodeStartLeft = rect.left - parentRect.left + scrollLeft;
      nodeStartTop = rect.top - parentRect.top + scrollTop;
      node.classList.add('workflow-node--dragging');
      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp, { once: true });
    }
    function onPointerMove(e) {
      lastInteractionWasDrag = true;
      const dx = e.clientX - dragStartX;
      const dy = e.clientY - dragStartY;
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

  function removeConnectionsInvolvingNodeId(id) {
    connections = connections.filter((c) => c.fromId !== id && c.toId !== id);
  }

  function showNodeContextMenu(clientX, clientY, node) {
    const existing = document.querySelector('.workflow-node-context-menu');
    if (existing) existing.remove();

    const isDataset = node.dataset.nodeType === 'dataset';
    const menu = document.createElement('div');
    menu.className = 'workflow-node-context-menu';
    menu.setAttribute('role', 'menu');
    if (isDataset) {
      menu.innerHTML = `
        <button type="button" class="workflow-node-context-item" data-action="sample-as-working-set" role="menuitem">Sample as working dataset</button>
      `;
    } else {
      menu.innerHTML = `
        <button type="button" class="workflow-node-context-item" data-action="duplicate" role="menuitem">Duplicate this prompt</button>
        <button type="button" class="workflow-node-context-item" data-action="new-version" role="menuitem">Add new version of this prompt</button>
      `;
    }

    function duplicateNode(isNewVersion = false) {
      const left = parseFloat(node.style.left) || 0;
      const top = parseFloat(node.style.top) || 0;
      const width = node.offsetWidth || 280;
      const offset = 40;
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
        left: left + width + offset,
        top,
      });
      updateContentSize();
      document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
      return newNode;
    }

    const actions = {
      duplicate: () => duplicateNode(false),
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
      'sample-as-working-set': () => {
        openDatasetDetailModal({
          node,
          getDatasetContent: () => datasetContentByNodeId.get(node.dataset.nodeId) || { headers: [], rows: [] },
          isDatasetNameAlreadyUsed,
        });
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
