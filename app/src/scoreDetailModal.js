/**
 * Score detail modal: left = Dataset as ground truth picker + field mapping table; right = results.
 * @param {{ node: HTMLElement, getWorkingSets?: () => Array<...>, getRunResultColumns?: () => Array<...>, getGroundTruthHeaders?: (wsNodeId: string) => string[], getReviewPayload?: () => { prompt_sections, run_results, output_fields, comparison_rows } | null }} options
 */

const API_BASE = 'http://localhost:8000';
const MATCH_TYPE_STRICT = { value: 'exact', label: 'Strict match' };
const ROWS_PER_PAGE_OPTIONS = [10, 25, 50, 100];

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  const s = String(str ?? '');
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/**
 * Create Review node and run review API stream (no modal).
 * @param {{ scoreNodeId: string, getReviewPayload: () => { prompt_sections, prompt_full_text?, run_results, output_fields, comparison_rows } | null, credentialId: string }} options
 * @returns {Promise<{ reviewNodeId: string } | null>} reviewNodeId after node is created; null if payload/credential invalid
 */
export function runReviewFromScore({ scoreNodeId, getReviewPayload, credentialId }) {
  const payload = getReviewPayload && getReviewPayload();
  if (!credentialId || !payload || !payload.prompt_sections || !payload.prompt_sections.length) return Promise.resolve(null);
  const addEvent = new CustomEvent('workflow:add-prompt-review-node', { detail: { scoreNodeId } });
  document.dispatchEvent(addEvent);
  const reviewNodeId = addEvent.detail?.reviewNodeId || '';
  if (!reviewNodeId) return Promise.resolve(null);
  return runReviewStream({ reviewNodeId, payload, credentialId }).then(() => ({ reviewNodeId }));
}

/**
 * Run review API stream and persist to node via workflow:save-review-result / review-stream-ended.
 * @param {{ reviewNodeId: string, payload: object, credentialId: string }} options
 */
export async function runReviewStream({ reviewNodeId, payload, credentialId }) {
  const body = {
    credential_id: credentialId,
    prompt_sections: payload.prompt_sections,
    run_results: payload.run_results || [],
    output_fields: payload.output_fields || [],
    comparison_rows: (payload.comparison_rows || []).map((r) => ({
      row_index: r.row_index,
      matched: r.matched,
      run_output: r.run_output || {},
      expected: r.expected || '',
      comment: r.comment ?? null,
    })),
  };
  const promptFullText = payload.prompt_full_text || (payload.prompt_sections || []).map((s) => `## ${(s.name || '').trim() || '(unnamed)'}\n\n${(s.content || '').trim()}`).join('\n\n');
  const sectionsCopy = (Array.isArray(payload.prompt_sections) && payload.prompt_sections.length > 0)
    ? payload.prompt_sections.map((s) => ({ name: String(s?.name ?? ''), content: String(s?.content ?? '').slice() }))
    : [];
  const workingSectionsInitial = sectionsCopy.map((s) => ({ name: s.name || '', content: (s.content || '').slice() }));
  document.dispatchEvent(new CustomEvent('workflow:review-progress', { detail: { reviewNodeId, percent: 0 } }));
  document.dispatchEvent(new CustomEvent('workflow:save-review-result', {
    detail: {
      reviewNodeId,
      data: {
        summary: '',
        suggestions: [],
        design_suggestions: [],
        promptSections: sectionsCopy,
        promptFullText: promptFullText || '',
        workingSections: workingSectionsInitial,
        reviewProgress: 0,
      },
    },
  }));
  document.dispatchEvent(new CustomEvent('workflow:review-stream-started', { detail: { reviewNodeId } }));
  try {
    const res = await fetch(`${API_BASE}/api/review/analyze/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      document.dispatchEvent(new CustomEvent('workflow:review-stream-ended', { detail: { reviewNodeId } }));
      alert(res.statusText || 'Review request failed.');
      return;
    }
    const workingSections = sectionsCopy.map((s) => ({ name: s.name || '', content: (s.content || '').slice() }));
    let streamSaved = {
      summary: '',
      suggestions: [],
      design_suggestions: [],
      promptSections: sectionsCopy,
      promptFullText: promptFullText || '',
      workingSections,
      reviewProgress: 0,
    };
    let focusCount = 0;
    let focusDone = 0;
    const setProgress = (percent) => {
      const pct = Math.min(100, Math.max(0, Math.round(percent)));
      streamSaved.reviewProgress = pct;
      document.dispatchEvent(new CustomEvent('workflow:review-progress', { detail: { reviewNodeId, percent: pct } }));
    };
    const persistToNode = (data) => {
      document.dispatchEvent(new CustomEvent('workflow:save-review-result', { detail: { reviewNodeId, data: { ...data, reviewProgress: streamSaved.reviewProgress } } }));
    };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let data;
        try {
          data = JSON.parse(trimmed);
        } catch (_) {
          continue;
        }
        if (data.type === 'error') {
          document.dispatchEvent(new CustomEvent('workflow:review-stream-ended', { detail: { reviewNodeId } }));
          alert(data.detail || 'Review failed.');
          return;
        }
        if (data.type === 'design' && Array.isArray(data.design_suggestions)) {
          streamSaved.design_suggestions = data.design_suggestions;
          setProgress(10);
          persistToNode({ ...streamSaved, design_suggestions: streamSaved.design_suggestions });
        } else if (data.type === 'plan') {
          focusCount = data.focus_count != null ? Math.max(0, parseInt(data.focus_count, 10)) : 0;
          focusDone = 0;
          streamSaved = {
            summary: data.summary || '',
            suggestions: [],
            design_suggestions: streamSaved.design_suggestions || [],
            promptSections: sectionsCopy,
            promptFullText: promptFullText || '',
            workingSections,
            streamComplete: false,
            reviewProgress: 20,
          };
          setProgress(20);
          persistToNode(streamSaved);
        } else if (data.type === 'suggestions' && Array.isArray(data.suggestions) && data.suggestions.length) {
          streamSaved.suggestions = (streamSaved.suggestions || []).concat(data.suggestions);
          focusDone += 1;
          const pct = focusCount > 0 ? 20 + (80 * focusDone / focusCount) : 90;
          setProgress(pct);
          persistToNode({ ...streamSaved, suggestions: streamSaved.suggestions });
        } else if (data.type === 'done') {
          setProgress(100);
          persistToNode({ ...streamSaved, suggestions: streamSaved.suggestions || [], design_suggestions: streamSaved.design_suggestions || [], streamComplete: true, reviewProgress: 100 });
        }
      }
    }
    if (buf.trim()) {
      try {
        const data = JSON.parse(buf.trim());
        if (data.type === 'design' && Array.isArray(data.design_suggestions)) {
          streamSaved.design_suggestions = data.design_suggestions;
          setProgress(10);
          persistToNode({ ...streamSaved, design_suggestions: streamSaved.design_suggestions });
        }
        if (data.type === 'plan') {
          focusCount = data.focus_count != null ? Math.max(0, parseInt(data.focus_count, 10)) : 0;
          focusDone = 0;
          streamSaved.reviewProgress = 20;
          setProgress(20);
        }
        if (data.type === 'suggestions' && Array.isArray(data.suggestions) && data.suggestions.length) {
          streamSaved.suggestions = (streamSaved.suggestions || []).concat(data.suggestions);
          focusDone += 1;
          setProgress(focusCount > 0 ? 20 + (80 * focusDone / focusCount) : 90);
          persistToNode({ ...streamSaved, suggestions: streamSaved.suggestions });
        }
        if (data.type === 'done') {
          setProgress(100);
          persistToNode({ ...streamSaved, suggestions: streamSaved.suggestions || [], design_suggestions: streamSaved.design_suggestions || [], streamComplete: true, reviewProgress: 100 });
        }
      } catch (_) {}
    }
    document.dispatchEvent(new CustomEvent('workflow:review-stream-ended', { detail: { reviewNodeId } }));
  } catch (e) {
    document.dispatchEvent(new CustomEvent('workflow:review-stream-ended', { detail: { reviewNodeId } }));
    alert(e?.message || 'Review request failed.');
  }
}

export function openScoreDetailModal({ node, getWorkingSets, getRunResultColumns, getGroundTruthHeaders, getRunResults, getRunWorkingSetContent, getGroundTruthContent, getReviewPayload, autoTriggerReview }) {
  getWorkingSets = getWorkingSets || (() => []);
  getRunResultColumns = getRunResultColumns || (() => []);
  getGroundTruthHeaders = getGroundTruthHeaders || (() => []);
  getRunResults = getRunResults || (() => ({ results: [], outputFields: [] }));
  getRunWorkingSetContent = getRunWorkingSetContent || (() => ({ headers: [], rows: [] }));
  getGroundTruthContent = getGroundTruthContent || (() => ({ headers: [], rows: [] }));
  getReviewPayload = getReviewPayload || (() => null);
  autoTriggerReview = !!autoTriggerReview;

  const workingSets = getWorkingSets();

  const name = (node?.querySelector?.('.workflow-node__title')?.textContent?.trim()) || 'Score';
  const title = `Score: ${name}`;

  let selectedNodeId = (node?.dataset?.scoreGroundTruthId || '').trim();

  /** Tree node: { type: 'group', ops: string[], children: Node[] } | { type: 'rule', ... }. ops[i] = operator between children[i] and children[i+1]. */
  function normalizeToRules(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return [];
    const first = arr[0];
    if (first && typeof first === 'object' && Array.isArray(first.gtColumns)) {
      return arr.map((r) => ({
        outputKey: r.outputKey || '',
        gtColumns: Array.isArray(r.gtColumns) ? r.gtColumns.filter(Boolean) : [],
        matchType: r.matchType || 'exact',
      })).filter((r) => r.outputKey || r.gtColumns.length > 0);
    }
    const pairs = [];
    if (first && first.outputKey !== undefined && !first.rules) {
      arr.forEach((r) => {
        pairs.push({ outputKey: r.outputKey || '', gtColumn: r.gtColumn || '', matchType: r.matchType || 'exact' });
      });
    } else if (first && first.rules) {
      arr.forEach((g) => {
        (g.rules || []).forEach((r) => {
          pairs.push({ outputKey: r.outputKey || '', gtColumn: r.gtColumn || '', matchType: r.matchType || 'exact' });
        });
      });
    } else {
      return [];
    }
    const byKey = {};
    pairs.forEach((p) => {
      if (!byKey[p.outputKey]) byKey[p.outputKey] = { outputKey: p.outputKey, gtColumns: [], matchType: p.matchType || 'exact' };
      if (p.gtColumn && !byKey[p.outputKey].gtColumns.includes(p.gtColumn)) byKey[p.outputKey].gtColumns.push(p.gtColumn);
    });
    return Object.values(byKey).filter((r) => r.outputKey || r.gtColumns.length > 0);
  }

  /** Parse stored value: array (legacy) -> tree root; keep tree (groups allowed). */
  function parseScoreRoot(raw) {
    let data;
    try {
      data = typeof raw === 'string' ? JSON.parse(raw || '[]') : raw;
    } catch (_) {
      return { type: 'group', ops: [], children: [] };
    }
    if (data && data.type === 'group' && Array.isArray(data.children)) {
      const children = (data.children || []).map((c) => (c && c.type === 'group')
        ? normalizeGroupChild(c)
        : normalizeChild(c));
      const ops = ensureGroupOps(data, children);
      return { type: 'group', ops, children };
    }
    const rules = normalizeToRules(Array.isArray(data) ? data : []);
    const children = rules.map((r) => ({ type: 'rule', outputKey: r.outputKey || '', gtColumns: (r.gtColumns || []).slice(), matchType: r.matchType || 'exact' }));
    return { type: 'group', ops: Array(Math.max(0, children.length - 1)).fill('AND'), children };
  }

  function ensureGroupOps(data, children) {
    const n = (children || []).length;
    const len = Math.max(0, n - 1);
    if (Array.isArray(data.ops) && data.ops.length >= len) {
      return data.ops.slice(0, len).map((o) => o === 'OR' ? 'OR' : 'AND');
    }
    const defaultOp = data.op === 'OR' ? 'OR' : 'AND';
    return Array(len).fill(defaultOp);
  }

  function normalizeGroupChild(c) {
    const children = (c.children || []).map((ch) => (ch && ch.type === 'group') ? normalizeGroupChild(ch) : normalizeChild(ch));
    const ops = ensureGroupOps(c, children);
    return { type: 'group', ops, children };
  }

  function normalizeChild(c) {
    if (!c || c.type === 'rule') {
      return {
        type: 'rule',
        outputKey: (c && c.outputKey) || '',
        gtColumns: Array.isArray(c && c.gtColumns) ? c.gtColumns.filter(Boolean) : [],
        matchType: (c && c.matchType) || 'exact',
      };
    }
    return normalizeGroupChild(c);
  }

  function getRoot() {
    return parseScoreRoot(node?.dataset?.scoreMapping || '[]');
  }

  function setRoot(root) {
    if (!node) return;
    node.dataset.scoreMapping = JSON.stringify(root);
    document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
  }

  /** Flatten tree to array of rules (depth-first) for results table and rule cards by path. */
  function collectRulesFlat(root, path = []) {
    if (!root) return [];
    if (root.type === 'rule') return [{ rule: root, path: path.slice() }];
    if (root.type === 'group' && Array.isArray(root.children)) {
      const out = [];
      root.children.forEach((ch, i) => {
        out.push(...collectRulesFlat(ch, path.concat(i)));
      });
      return out;
    }
    return [];
  }

  /** Get flat list of rules for backward-compat APIs (e.g. results table columns). */
  function getRulesFlat() {
    return collectRulesFlat(getRoot()).map((x) => x.rule);
  }

  /** Stringify value for strict comparison. */
  function toCompareStr(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v.trim();
    if (Array.isArray(v)) return v.map((x) => toCompareStr(x)).join(', ').trim();
    return String(v).trim();
  }

  /** Get run value for row i and outputKey. runResult = results.find(r => r.row_index === i). */
  function getRunValue(runResult, outputKey, rowIndex, runWs, outputFields) {
    if (outputKey === '#' || outputKey === '[#]') return toCompareStr(rowIndex);
    const keyStr = String(outputKey || '').trim();
    if (!keyStr) return '';
    const isBracket = keyStr.startsWith('[') && keyStr.endsWith(']');
    if (isBracket) {
      const header = keyStr.slice(1, -1).trim();
      const rows = runWs.rows || [];
      const headers = runWs.headers || [];
      const colIdx = headers.findIndex((h) => String(h).trim() === header);
      if (colIdx >= 0 && rows[rowIndex]) return toCompareStr(rows[rowIndex][colIdx]);
      return '';
    }
    if (runResult && runResult.output && typeof runResult.output === 'object' && keyStr in runResult.output) {
      return toCompareStr(runResult.output[keyStr]);
    }
    return '';
  }

  /** Get GT cell value for row i and column name. */
  function getGtValue(gtContent, rowIndex, columnName) {
    const headers = gtContent.headers || [];
    const rows = gtContent.rows || [];
    const colIdx = headers.findIndex((h) => String(h).trim() === String(columnName).trim());
    if (colIdx >= 0 && rows[rowIndex]) return toCompareStr(rows[rowIndex][colIdx]);
    return '';
  }

  /**
   * Evaluate a single rule: run value must equal any GT column value.
   */
  function ruleMatchesRow(rule, runRowIndex, gtRowIndex, resultsByIndex, runWs, outputFields, gtContent) {
    const runResult = resultsByIndex.get(runRowIndex) || null;
    const runVal = getRunValue(runResult, rule.outputKey, runRowIndex, runWs, outputFields);
    const gtVals = (rule.gtColumns || []).map((col) => getGtValue(gtContent, gtRowIndex, col));
    return gtVals.some((g) => g === runVal);
  }

  /**
   * Evaluate tree node for run row i vs GT row j.
   */
  function evaluateNode(node, runRowIndex, gtRowIndex, resultsByIndex, runWs, outputFields, gtContent) {
    if (!node) return false;
    if (node.type === 'rule') {
      return ruleMatchesRow(node, runRowIndex, gtRowIndex, resultsByIndex, runWs, outputFields, gtContent);
    }
    if (node.type === 'group' && Array.isArray(node.children)) {
      if (node.children.length === 0) return false;
      const ops = node.ops || Array(Math.max(0, node.children.length - 1)).fill('AND');
      let r = evaluateNode(node.children[0], runRowIndex, gtRowIndex, resultsByIndex, runWs, outputFields, gtContent);
      for (let i = 1; i < node.children.length; i++) {
        const next = evaluateNode(node.children[i], runRowIndex, gtRowIndex, resultsByIndex, runWs, outputFields, gtContent);
        r = (ops[i - 1] === 'OR') ? (r || next) : (r && next);
      }
      return r;
    }
    return false;
  }

  /**
   * Count how many leaf rules match for (run row i, GT row j). Used for pairing only.
   */
  function countMatchingRules(root, runRowIndex, gtRowIndex, resultsByIndex, runWs, outputFields, gtContent) {
    const rules = collectRulesFlat(root).map((x) => x.rule);
    return rules.filter((rule) => ruleMatchesRow(rule, runRowIndex, gtRowIndex, resultsByIndex, runWs, outputFields, gtContent)).length;
  }

  /**
   * Match run rows to GT rows: one-to-one pairing by "most rules matching" (greedy).
   * Match column still uses full tree evaluateNode(root, i, j) when rendering.
   */
  function computeMatchPerRow(root, results, outputFields, runWs, gtContent) {
    const gtRows = gtContent.rows || [];
    const resultsByIndex = new Map();
    (results || []).forEach((r) => { resultsByIndex.set(r.row_index, r); });
    const runCount = runWs?.rows?.length ?? 0;
    const gtCount = gtRows.length;
    const runToGt = new Array(Math.max(runCount, gtCount)).fill(-1);
    const gtUsed = new Array(gtCount).fill(false);

    const pairs = [];
    for (let i = 0; i < runCount; i++) {
      for (let j = 0; j < gtCount; j++) {
        const score = countMatchingRules(root, i, j, resultsByIndex, runWs, outputFields, gtContent);
        if (score > 0) pairs.push({ i, j, score });
      }
    }
    pairs.sort((a, b) => b.score - a.score);
    for (const { i, j } of pairs) {
      if (runToGt[i] >= 0 || gtUsed[j]) continue;
      runToGt[i] = j;
      gtUsed[j] = true;
    }

    const matched = [];
    const maxRow = Math.max(runCount, gtCount);
    for (let i = 0; i < maxRow; i++) {
      matched.push(i < runCount && runToGt[i] >= 0);
    }
    const matchedCount = runToGt.slice(0, runCount).filter((j) => j >= 0).length;
    return {
      matched,
      runToGt,
      total: runCount,
      matchedCount,
    };
  }

  /** Get node at path (array of child indices from root). Root = []. */
  function getNodeAtPath(root, path) {
    let cur = root;
    for (const i of path) {
      if (!cur || cur.type !== 'group' || !Array.isArray(cur.children)) return null;
      cur = cur.children[i];
    }
    return cur;
  }

  /** Clone tree and set node at path; returns new root. */
  function setNodeAtPath(root, path, newNode) {
    if (path.length === 0) return newNode;
    const [i, ...rest] = path;
    const group = root.type === 'group' && root.children ? { ...root, children: root.children.slice() } : root;
    group.children[i] = setNodeAtPath(group.children[i], rest, newNode);
    return group;
  }

  /** Clone tree and remove node at path (remove child at path's last index). Returns new root. */
  function removeNodeAtPath(root, path) {
    if (path.length === 0) return root;
    if (path.length === 1) {
      const k = path[0];
      const group = root.type === 'group' && root.children ? { ...root, children: root.children.filter((_, idx) => idx !== k) } : root;
      const ops = (root.ops || []).slice();
      if (ops.length > 0) ops.splice(k === 0 ? 0 : k - 1, 1);
      return { ...group, ops };
    }
    const [i, ...rest] = path;
    const group = root.type === 'group' && root.children ? { ...root, children: root.children.slice() } : root;
    group.children[i] = removeNodeAtPath(group.children[i], rest);
    return group;
  }

  /** Insert child at path (path points to parent group). Returns new root. */
  function insertChildAtPath(root, path, newChild, index) {
    if (path.length === 0) {
      const group = root.type === 'group' ? { ...root, children: (root.children || []).slice(), ops: (root.ops || []).slice() } : { type: 'group', ops: [], children: [] };
      group.children.splice(index, 0, newChild);
      group.ops.splice(index, 0, 'AND');
      return group;
    }
    const [i, ...rest] = path;
    const group = root.type === 'group' && root.children ? { ...root, children: root.children.slice() } : root;
    group.children[i] = insertChildAtPath(group.children[i], rest, newChild, index);
    return group;
  }

  function getResultComments() {
    try {
      const raw = node?.dataset?.scoreResultComments || '{}';
      const obj = JSON.parse(raw);
      return obj && typeof obj === 'object' ? obj : {};
    } catch (_) { return {}; }
  }

  function setResultComments(comments) {
    if (!node) return;
    node.dataset.scoreResultComments = JSON.stringify(comments);
    document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
  }

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'score-detail-title');
  overlay.innerHTML = `
    <div class="modal-panel modal-panel--score-detail" id="score-detail-panel">
      <div class="modal-header">
        <h2 id="score-detail-title" class="modal-title">${escapeHtml(title)}</h2>
        <button type="button" class="modal-close" aria-label="Close">×</button>
      </div>
      <div class="modal-body score-detail-body modal-body--score">
        <div class="score-detail-main">
          <p class="run-detail-main-label score-detail-main-label">Score settings</p>
          <div class="dataset-meta-wrap score-detail-meta-wrap">
            <div class="dataset-meta-field">
              <label class="dataset-meta-label" for="score-detail-gt-picker">Ground truth</label>
              <div class="run-detail-ws-picker" id="score-detail-gt-picker" role="combobox" aria-expanded="false" aria-haspopup="listbox" aria-label="Select dataset as ground truth">
                <div class="run-detail-ws-trigger" tabindex="0">
                  <span class="run-detail-ws-trigger-color" id="score-detail-gt-trigger-color"></span>
                  <span class="run-detail-ws-trigger-text" id="score-detail-gt-trigger-text">— Select dataset —</span>
                  <span class="run-detail-ws-trigger-arrow" aria-hidden="true">⌵</span>
                </div>
                <div class="run-detail-ws-dropdown" id="score-detail-gt-dropdown" role="listbox" hidden></div>
              </div>
            </div>
            <div class="dataset-meta-field score-detail-rules-section">
              <span class="dataset-meta-label run-detail-section-label score-detail-rules-label">Rules</span>
              <p class="score-detail-rules-hint">Use groups to combine rules with AND or OR. Within each rule, run column matches if it equals any selected ground truth column.</p>
              <div class="score-detail-rules-scroll">
                <div id="score-detail-rules-list" class="score-detail-rules-list"></div>
              </div>
            </div>
          </div>
        </div>
        <div class="score-detail-preview-wrap">
          <h3 class="run-detail-preview-title score-detail-preview-title">Results</h3>
          <div class="score-detail-preview-content">
            <div class="score-detail-results-card run-detail-results-card" id="score-detail-results-card">
              <div id="score-detail-results-body" class="score-detail-results-body-inner"></div>
              <div id="score-detail-results-toolbar" class="dataset-detail-preview-toolbar score-detail-results-toolbar" style="display: none;"></div>
              <div class="score-detail-results-footer-row">
                <button type="button" class="btn btn-secondary score-detail-save-to-workspace" id="score-detail-save-to-workspace" title="Save comparison table as a new dataset in workspace">Save to workspace</button>
                <div class="score-detail-results-footer-right">
                  <div class="score-detail-llm-row">
                    <label class="run-detail-label" for="score-detail-llm-select">Reviewer model</label>
                    <select id="score-detail-llm-select" class="credentials-select score-detail-llm-select" aria-label="Select Reviewer model"></select>
                  </div>
                  <button type="button" class="btn btn-primary score-detail-add-prompt-review" id="score-detail-add-prompt-review" title="Add a Review node and run analysis with selected Reviewer model">Review</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  const scoreDetailPanel = overlay.querySelector('#score-detail-panel');
  const pickerEl = overlay.querySelector('#score-detail-gt-picker');
  const triggerEl = overlay.querySelector('.run-detail-ws-trigger');
  const triggerColorEl = overlay.querySelector('#score-detail-gt-trigger-color');
  const triggerTextEl = overlay.querySelector('#score-detail-gt-trigger-text');
  const dropdownEl = overlay.querySelector('#score-detail-gt-dropdown');
  const rulesListEl = overlay.querySelector('#score-detail-rules-list');
  const llmSelect = overlay.querySelector('#score-detail-llm-select');
  const saveToWorkspaceBtn = overlay.querySelector('#score-detail-save-to-workspace');
  const addPromptReviewBtn = overlay.querySelector('#score-detail-add-prompt-review');
  const resultsBody = overlay.querySelector('#score-detail-results-body');
  const resultsToolbar = overlay.querySelector('#score-detail-results-toolbar');

  /** 有对比结果时展开右半栏（与 Run 页初始状态一致：无结果时只显示左半栏） */
  function updatePanelExpanded(hasResults) {
    if (!scoreDetailPanel) return;
    if (hasResults) scoreDetailPanel.classList.add('score-detail-panel--expanded');
    else scoreDetailPanel.classList.remove('score-detail-panel--expanded');
  }

  const scoreDetailPagination = { rowsPerPage: 25, currentPage: 1, searchQuery: '' };

  function getSelectedWorkingSet() {
    return workingSets.find((ws) => ws.nodeId === selectedNodeId) || null;
  }

  function updateScoreNodeBorder() {
    const ws = getSelectedWorkingSet();
    if (node && node.style) {
      node.style.borderColor = ws && ws.color ? ws.color : '';
    }
  }

  function updateTriggerDisplay() {
    const ws = getSelectedWorkingSet();
    if (ws) {
      triggerColorEl.style.background = ws.color || 'transparent';
      triggerColorEl.style.display = ws.color ? '' : 'none';
      triggerTextEl.textContent = ws.name || 'Dataset';
    } else {
      triggerColorEl.style.background = '';
      triggerColorEl.style.display = 'none';
      triggerTextEl.textContent = '— Select —';
    }
  }

  function closeDropdown() {
    dropdownEl.hidden = true;
    pickerEl.setAttribute('aria-expanded', 'false');
  }

  function openDropdown() {
    dropdownEl.hidden = false;
    pickerEl.setAttribute('aria-expanded', 'true');
  }

  /** Match method options (dropdown); currently only Strict match. */
  const MATCH_METHODS = [MATCH_TYPE_STRICT];

  /** Open Add rule / Edit rule modal. editPath = path to rule (edit), or null for add. When add: parentPath + indexInParent. */
  function openRuleEditor(editPath, parentPath, indexInParent, onDone) {
    const isEdit = Array.isArray(editPath) && editPath.length > 0;
    const root = getRoot();
    const rule = isEdit
      ? getNodeAtPath(root, editPath)
      : { type: 'rule', outputKey: '', gtColumns: [], matchType: MATCH_TYPE_STRICT.value };
    const ruleData = rule && rule.type === 'rule' ? rule : { outputKey: '', gtColumns: [], matchType: MATCH_TYPE_STRICT.value };
    const runColumns = getRunResultColumns();
    const gtHeaders = getGroundTruthHeaders(selectedNodeId);
    const resultSelectOpts = runColumns.map((c) => {
      const label = (c.label || '').trim() || c.key || '—';
      const key = c.key || '';
      const sel = key === (ruleData.outputKey || '') ? ' selected' : '';
      return `<option value="${escapeAttr(key)}"${sel}>${escapeHtml(label)}</option>`;
    }).join('');
    const matchSelectOpts = MATCH_METHODS.map((m) => {
      const sel = (m.value || '') === (ruleData.matchType || '') ? ' selected' : '';
      return `<option value="${escapeAttr(m.value)}"${sel}>${escapeHtml(m.label || m.value)}</option>`;
    }).join('');
    const currentGtColumn = (ruleData.gtColumns && ruleData.gtColumns[0]) ? ruleData.gtColumns[0] : '';
    const defaultGtColumn = currentGtColumn || ((gtHeaders && gtHeaders[0]) ? gtHeaders[0] : '');
    const gtSelectOpts = (gtHeaders || []).map((h) => {
      const sel = h === defaultGtColumn ? ' selected' : '';
      return `<option value="${escapeAttr(h)}"${sel}>${escapeHtml(h)}</option>`;
    }).join('');
    const gtSelectEmptyOpt = (gtHeaders && gtHeaders.length > 0) ? '' : '<option value="">— Select column —</option>';

    const editorOverlay = document.createElement('div');
    editorOverlay.className = 'modal-overlay modal-overlay--section-editor modal-overlay--rule-editor';
    editorOverlay.setAttribute('aria-modal', 'true');
    editorOverlay.innerHTML = `
      <div class="modal-panel modal-panel--section-editor modal-panel--rule-editor">
        <div class="modal-header">
          <h3 class="modal-title">${isEdit ? 'Edit rule' : 'Add rule'}</h3>
          <button type="button" class="modal-close" aria-label="Close">×</button>
        </div>
        <div class="modal-body">
          <div class="dataset-meta-wrap">
            <div class="dataset-meta-field">
              <label class="dataset-meta-label" for="rule-editor-result-column">Result column</label>
              <select id="rule-editor-result-column" class="dataset-meta-input rule-editor-select" aria-label="Result column">${resultSelectOpts}</select>
            </div>
            <div class="dataset-meta-field">
              <label class="dataset-meta-label" for="rule-editor-gt-column">Ground truth column</label>
              <select id="rule-editor-gt-column" class="dataset-meta-input rule-editor-select" aria-label="Ground truth column">
                ${gtSelectEmptyOpt}${gtSelectOpts}
              </select>
            </div>
            <div class="dataset-meta-field">
              <label class="dataset-meta-label" for="rule-editor-match-type">Match method</label>
              <select id="rule-editor-match-type" class="dataset-meta-input rule-editor-select" aria-label="Match method">${matchSelectOpts}</select>
            </div>
            ${isEdit ? `
            <div class="dataset-meta-field rule-editor-field-group">
              <label class="dataset-meta-label rule-editor-checkbox-label">
                <input type="checkbox" id="rule-editor-make-group" class="rule-editor-checkbox" aria-label="Make this a rule group">
                Make this a rule group
              </label>
              <p class="rule-editor-hint">Convert to a group and edit its rules like the score list.</p>
            </div>
            ` : (parentPath && parentPath.length > 0 ? '' : `
            <div class="dataset-meta-field rule-editor-field-group">
              <label class="dataset-meta-label rule-editor-checkbox-label">
                <input type="checkbox" id="rule-editor-add-as-group" class="rule-editor-checkbox" aria-label="Add as rule group">
                Add as rule group
              </label>
              <p class="rule-editor-hint">Create a group with this rule; you can add more rules to the group after.</p>
            </div>
            `)}
          </div>
          <div class="prompt-form-error section-editor-error rule-editor-error" role="alert" aria-live="polite" hidden></div>
          <div class="modal-footer-actions">
            <button type="button" class="btn btn-secondary section-editor-cancel rule-editor-cancel">Cancel</button>
            <button type="button" class="btn btn-secondary section-editor-save rule-editor-save">${isEdit ? 'Save' : 'Add rule'}</button>
          </div>
        </div>
      </div>
    `;

    const resultSelectEl = editorOverlay.querySelector('#rule-editor-result-column');
    const matchSelectEl = editorOverlay.querySelector('#rule-editor-match-type');
    const gtSelectEl = editorOverlay.querySelector('#rule-editor-gt-column');
    const errorEl = editorOverlay.querySelector('.rule-editor-error');

    function closeEditor() {
      editorOverlay.remove();
    }

    function showError(msg) {
      if (errorEl) {
        errorEl.textContent = msg;
        errorEl.hidden = false;
      }
    }

    function clearError() {
      if (errorEl) {
        errorEl.textContent = '';
        errorEl.hidden = true;
      }
    }

    resultSelectEl.addEventListener('change', clearError);
    gtSelectEl.addEventListener('change', clearError);
    matchSelectEl.addEventListener('change', clearError);

    function save() {
      const outputKey = (resultSelectEl?.value ?? '').trim();
      if (!outputKey) {
        showError('Please select a result column.');
        return;
      }
      const gtColumn = (gtSelectEl?.value ?? '').trim();
      if (!gtColumn) {
        showError('Please select a ground truth column.');
        return;
      }
      const matchType = (matchSelectEl?.value ?? '').trim() || MATCH_TYPE_STRICT.value;
      const newRule = { type: 'rule', outputKey, gtColumns: [gtColumn], matchType };
      const root = getRoot();
      const makeGroupEl = editorOverlay.querySelector('#rule-editor-make-group');
      const addAsGroupEl = editorOverlay.querySelector('#rule-editor-add-as-group');
      const makeGroup = isEdit && makeGroupEl && makeGroupEl.checked;
      const addAsGroup = !isEdit && addAsGroupEl && addAsGroupEl.checked;
      if (isEdit) {
        if (makeGroup) {
          setRoot(setNodeAtPath(root, editPath, { type: 'group', ops: [], children: [newRule] }));
        } else {
          setRoot(setNodeAtPath(root, editPath, newRule));
        }
      } else {
        if (addAsGroup) {
          setRoot(insertChildAtPath(root, parentPath, { type: 'group', ops: [], children: [newRule] }, indexInParent));
        } else {
          setRoot(insertChildAtPath(root, parentPath, newRule, indexInParent));
        }
      }
      closeEditor();
      onDone();
    }

    editorOverlay.querySelector('.modal-close').addEventListener('click', closeEditor);
    editorOverlay.querySelector('.rule-editor-cancel').addEventListener('click', closeEditor);
    editorOverlay.querySelector('.rule-editor-save').addEventListener('click', save);
    editorOverlay.addEventListener('click', (e) => {
      if (e.target === editorOverlay) closeEditor();
    });
    document.body.appendChild(editorOverlay);
    resultSelectEl?.focus();
  }

  /** Rule card: optional AND/OR on left (opValue/opIndex), then click to edit, × to delete. */
  function createRuleCard(rule, path, opts = {}) {
    const runColumns = getRunResultColumns();
    const runLabel = runColumns.find((c) => c.key === (rule.outputKey || ''))?.label || rule.outputKey || '—';
    const gtLabel = (rule.gtColumns || []).length === 0 ? '—' : (rule.gtColumns || []).join(', ');
    const matchLabel = MATCH_METHODS.find((m) => m.value === (rule.matchType || ''))?.label || MATCH_TYPE_STRICT.label;
    const summary = `${runLabel} → ${gtLabel} · ${matchLabel}`;
    const card = document.createElement('div');
    card.className = 'score-rule-card';
    const openEditor = () => openRuleEditor(path, [], 0, () => renderRules());
    card.innerHTML = `
      <div class="score-rule-card-inner" tabindex="0" role="button">
        <span class="score-rule-card-summary">${escapeHtml(summary)}</span>
      </div>
      <button type="button" class="score-rule-card-remove" aria-label="Remove rule">×</button>
    `;
    const parentPathForOp = opts.parentPath !== undefined ? opts.parentPath : (path.length > 0 ? path.slice(0, -1) : []);
    if (opts.opValue != null && opts.opIndex != null) {
      const opBtn = document.createElement('button');
      opBtn.type = 'button';
      opBtn.className = 'score-rule-card-op';
      opBtn.setAttribute('aria-label', 'Toggle AND/OR');
      opBtn.textContent = opts.opValue || 'AND';
      opBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const r = getRoot();
        const parent = parentPathForOp.length > 0 ? getNodeAtPath(r, parentPathForOp) : r;
        if (!parent || parent.type !== 'group') return;
        const nextOps = (parent.ops || []).slice();
        nextOps[opts.opIndex] = nextOps[opts.opIndex] === 'OR' ? 'AND' : 'OR';
        setRoot(setNodeAtPath(r, parentPathForOp, { ...parent, ops: nextOps }));
        renderRules();
        if (opts.onAfterChange) opts.onAfterChange();
      });
      card.insertBefore(opBtn, card.firstChild);
    }
    const inner = card.querySelector('.score-rule-card-inner');
    const removeBtn = card.querySelector('.score-rule-card-remove');
    inner.addEventListener('click', openEditor);
    inner.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openEditor();
      }
    });
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setRoot(removeNodeAtPath(getRoot(), path));
      renderRules();
      if (opts.onAfterChange) opts.onAfterChange();
    });
    return card;
  }

  /** Group card: same look as rule card, shows "Rule group N". Click to edit group. */
  function createGroupCard(path, groupIndex, opts = {}) {
    const label = `Rule group ${groupIndex}`;
    const card = document.createElement('div');
    card.className = 'score-rule-card score-rule-card--group';
    const openGroupEditor = () => openGroupEditorModal(path, () => renderRules());
    card.innerHTML = `
      <div class="score-rule-card-inner" tabindex="0" role="button">
        <span class="score-rule-card-summary">${escapeHtml(label)}</span>
      </div>
      <button type="button" class="score-rule-card-remove" aria-label="Remove group">×</button>
    `;
    if (opts.opValue != null && opts.opIndex != null) {
      const opBtn = document.createElement('button');
      opBtn.type = 'button';
      opBtn.className = 'score-rule-card-op';
      opBtn.setAttribute('aria-label', 'Toggle AND/OR');
      opBtn.textContent = opts.opValue || 'AND';
      opBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const r = getRoot();
        const nextOps = (r.ops || []).slice();
        nextOps[opts.opIndex] = nextOps[opts.opIndex] === 'OR' ? 'AND' : 'OR';
        setRoot({ ...r, ops: nextOps });
        renderRules();
      });
      card.insertBefore(opBtn, card.firstChild);
    }
    const inner = card.querySelector('.score-rule-card-inner');
    const removeBtn = card.querySelector('.score-rule-card-remove');
    inner.addEventListener('click', openGroupEditor);
    inner.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openGroupEditor();
      }
    });
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setRoot(removeNodeAtPath(getRoot(), path));
      renderRules();
    });
    return card;
  }

  /** Modal to edit a group's rules (same UI as score rules list). */
  function openGroupEditorModal(groupPath, onDone) {
    const root = getRoot();
    const group = getNodeAtPath(root, groupPath);
    if (!group || group.type !== 'group') return;
    const firstIndex = groupPath[0];
    const groupIndex = (root.children || []).slice(0, firstIndex + 1).filter((c) => c && c.type === 'group').length;
    const title = `Edit Rule group ${groupIndex}`;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay modal-overlay--section-editor modal-overlay--rule-editor';
    overlay.setAttribute('aria-modal', 'true');
    overlay.innerHTML = `
      <div class="modal-panel modal-panel--section-editor modal-panel--rule-editor modal-panel--group-editor">
        <div class="modal-header">
          <h3 class="modal-title">${escapeHtml(title)}</h3>
          <button type="button" class="modal-close" aria-label="Close">×</button>
        </div>
        <div class="modal-body modal-body--group-editor">
          <div class="score-group-editor-list" id="score-group-editor-list"></div>
          <div class="score-group-editor-actions">
            <button type="button" class="score-tree-add-rule-box" id="score-group-editor-add-rule">+ Add rule</button>
          </div>
        </div>
      </div>
    `;
    const listEl = overlay.querySelector('#score-group-editor-list');
    const addBtn = overlay.querySelector('#score-group-editor-add-rule');

    function getGroup() {
      return getNodeAtPath(getRoot(), groupPath) || { type: 'group', ops: [], children: [] };
    }

    function setGroup(newGroup) {
      setRoot(setNodeAtPath(getRoot(), groupPath, newGroup));
      renderGroupEditorList();
    }

    function renderGroupEditorList() {
      listEl.innerHTML = '';
      const g = getGroup();
      const children = (g.children || []).slice();
      const ops = (g.ops || []).slice();
      const onAfterChange = () => {
        renderGroupEditorList();
        document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
      };
      children.forEach((node, i) => {
        if (node.type === 'rule') {
          const row = document.createElement('div');
          row.className = 'score-tree-row score-tree-row--flat';
          const cardWrap = document.createElement('div');
          cardWrap.className = 'score-tree-row-card';
          const pathI = groupPath.concat(i);
          const cardOpts = i > 0 ? { opValue: ops[i - 1] || 'AND', opIndex: i - 1 } : {};
          cardOpts.onAfterChange = onAfterChange;
          cardOpts.parentPath = groupPath;
          cardWrap.appendChild(createRuleCard(node, pathI, cardOpts));
          row.appendChild(cardWrap);
          listEl.appendChild(row);
        }
      });
    }

    addBtn.addEventListener('click', () => {
      openRuleEditor(null, groupPath, (getGroup().children || []).length, () => {
        renderGroupEditorList();
        document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
      });
    });

    overlay.querySelector('.modal-close').addEventListener('click', () => {
      overlay.remove();
      onDone();
    });
    renderGroupEditorList();
    document.body.appendChild(overlay);
  }

  function renderRules() {
    rulesListEl.innerHTML = '';

    if (!selectedNodeId) {
      const p = document.createElement('p');
      p.className = 'score-detail-placeholder';
      p.textContent = 'Select a dataset as ground truth, then add rules. Click a rule to edit; use AND/OR to combine.';
      rulesListEl.appendChild(p);
      renderResults();
      return;
    }
    const runColumns = getRunResultColumns();
    const gtHeaders = getGroundTruthHeaders(selectedNodeId);
    if (runColumns.length === 0 || gtHeaders.length === 0) {
      const p = document.createElement('p');
      p.className = 'score-detail-placeholder';
      p.textContent = runColumns.length === 0
        ? 'No run connected or run has no result columns (run once with a dataset to see columns).'
        : 'Ground truth dataset has no columns.';
      rulesListEl.appendChild(p);
      renderResults();
      return;
    }

    const root = getRoot();
    if (root.type !== 'group' || !Array.isArray(root.children)) {
      renderResults();
      return;
    }
    const children = root.children || [];
    const ops = root.ops || Array(Math.max(0, children.length - 1)).fill('AND');
    let groupCount = 0;

    const treeWrap = document.createElement('div');
    treeWrap.className = 'score-rules-tree score-rules-tree--flat';
    children.forEach((node, i) => {
      const row = document.createElement('div');
      row.className = 'score-tree-row score-tree-row--flat';
      const cardWrap = document.createElement('div');
      cardWrap.className = 'score-tree-row-card';
      const cardOpts = i > 0 ? { opValue: ops[i - 1] || 'AND', opIndex: i - 1 } : {};
      if (node.type === 'group') {
        groupCount += 1;
        cardWrap.appendChild(createGroupCard([i], groupCount, cardOpts));
      } else {
        cardWrap.appendChild(createRuleCard(node, [i], cardOpts));
      }
      row.appendChild(cardWrap);
      treeWrap.appendChild(row);
    });
    const addRow = document.createElement('div');
    addRow.className = 'score-tree-add-row score-tree-row--flat';
    const addBox = document.createElement('button');
    addBox.type = 'button';
    addBox.className = 'score-tree-add-rule-box';
    addBox.setAttribute('aria-label', 'Add rule');
    addBox.textContent = '+ Add rule';
    addBox.addEventListener('click', () => {
      const r = getRoot();
      const len = (r.children || []).length;
      openRuleEditor(null, [], len, () => renderRules());
    });
    const cardWrap = document.createElement('div');
    cardWrap.className = 'score-tree-row-card';
    cardWrap.appendChild(addBox);
    addRow.appendChild(cardWrap);
    treeWrap.appendChild(addRow);
    rulesListEl.appendChild(treeWrap);
    renderResults();
  }

  function renderResults() {
    if (!resultsBody) return;
    resultsBody.innerHTML = '';
    updateSaveToWorkspaceButton();
    const root = getRoot();
    const rulesFlat = getRulesFlat();
    if (!selectedNodeId) {
      updatePanelExpanded(false);
      resultsBody.innerHTML = '<p class="score-detail-placeholder">Select ground truth and add rules to see comparison results.</p>';
      if (resultsToolbar) { resultsToolbar.style.display = 'none'; resultsToolbar.innerHTML = ''; }
      return;
    }
    if (rulesFlat.length === 0) {
      updatePanelExpanded(false);
      resultsBody.innerHTML = '<p class="score-detail-placeholder">Add at least one rule to compare.</p>';
      if (resultsToolbar) { resultsToolbar.style.display = 'none'; resultsToolbar.innerHTML = ''; }
      return;
    }
    const { results, outputFields } = getRunResults();
    const runWs = getRunWorkingSetContent();
    const gtContent = getGroundTruthContent(selectedNodeId);
    const gtHeaders = gtContent.headers || [];
    const gtRows = gtContent.rows || [];
    const runColumns = getRunResultColumns();
    const resultsByIndex = new Map();
    (results || []).forEach((r) => { resultsByIndex.set(r.row_index, r); });
    const maxRunRow = results.length ? Math.max(...(results || []).map((r) => r.row_index), 0) : -1;
    const maxGtRow = gtRows.length ? gtRows.length - 1 : -1;
    const maxRow = Math.max(maxRunRow, maxGtRow, 0);
    const hasAnyRows = maxRow >= 0;

    if (!hasAnyRows) {
      updatePanelExpanded(false);
      resultsBody.innerHTML = '<p class="score-detail-placeholder">No run results and no ground truth rows.</p>';
      if (resultsToolbar) { resultsToolbar.style.display = 'none'; resultsToolbar.innerHTML = ''; }
      return;
    }

    updatePanelExpanded(true);
    const { matched, runToGt, total, matchedCount } = computeMatchPerRow(root, results, outputFields, runWs, gtContent);
    const runCount = total;
    const gtToRun = new Array(gtRows.length).fill(-1);
    for (let i = 0; i < (runToGt || []).length; i++) {
      if (runToGt[i] >= 0) gtToRun[runToGt[i]] = i;
    }

    const descriptors = [];
    for (let j = 0; j < gtRows.length; j++) {
      if (gtToRun[j] >= 0) descriptors.push({ type: 'gt', j });
    }
    for (let j = 0; j < gtRows.length; j++) {
      if (gtToRun[j] < 0) descriptors.push({ type: 'gt', j });
    }
    for (let i = 0; i < runCount; i++) {
      if (runToGt[i] >= 0) continue;
      // 去重：多出来的 run 行（与某 GT 规则匹配但未拿到 1-to-1 配对）也算配对上了，不显示为 run-only，且不影响分数
      let matchesAnyGt = false;
      for (let j = 0; j < gtRows.length; j++) {
        if (evaluateNode(root, i, j, resultsByIndex, runWs, outputFields, gtContent)) {
          matchesAnyGt = true;
          break;
        }
      }
      if (!matchesAnyGt) descriptors.push({ type: 'runOnly', i });
    }

    const comments = getResultComments();
    const q = (scoreDetailPagination.searchQuery || '').trim().toLowerCase();
    function getRowStringsForSearch(d) {
      const parts = [];
      if (d.type === 'gt') {
        const j = d.j;
        const runRowIndex = gtToRun[j];
        const runResult = runRowIndex >= 0 ? resultsByIndex.get(runRowIndex) || null : null;
        parts.push(String(j + 1), runRowIndex >= 0 ? String(runRowIndex + 1) : '—');
        gtColsUsed.forEach((col) => { parts.push(getGtValue(gtContent, j, col)); });
        rulesFlat.forEach((rule) => {
          parts.push(runResult ? getRunValue(runResult, rule.outputKey, runRowIndex, runWs, outputFields) : '');
        });
        parts.push(runRowIndex >= 0 && evaluateNode(root, runRowIndex, j, resultsByIndex, runWs, outputFields, gtContent) ? '1' : '0');
        parts.push(comments[String(j)] ?? '');
      } else {
        const i = d.i;
        const runResult = resultsByIndex.get(i) || null;
        parts.push('—', String(i + 1));
        gtColsUsed.forEach(() => { parts.push('—'); });
        rulesFlat.forEach((rule) => { parts.push(runResult ? getRunValue(runResult, rule.outputKey, i, runWs, outputFields) : ''); });
        parts.push('0');
        parts.push(comments['run:' + i] ?? '');
      }
      return parts.map((v) => (v === null || v === undefined ? '' : String(v)));
    }
    const gtColsUsed = [];
    for (const r of rulesFlat) {
      for (const c of (r.gtColumns || [])) {
        if (c && !gtColsUsed.includes(c)) gtColsUsed.push(c);
      }
    }
    let filteredDescriptors = descriptors;
    if (q) {
      filteredDescriptors = descriptors.filter((d) => getRowStringsForSearch(d).some((s) => s.toLowerCase().includes(q)));
    }
    const totalUnfiltered = descriptors.length;
    const totalRows = filteredDescriptors.length;
    const totalPages = Math.max(1, Math.ceil(totalRows / scoreDetailPagination.rowsPerPage));
    scoreDetailPagination.currentPage = Math.min(Math.max(1, scoreDetailPagination.currentPage), totalPages);
    const start = (scoreDetailPagination.currentPage - 1) * scoreDetailPagination.rowsPerPage;
    const end = Math.min(start + scoreDetailPagination.rowsPerPage, totalRows);
    const pageDescriptors = filteredDescriptors.slice(start, end);

    const runOnlyCount = total > 0 ? total - matchedCount : 0;
    const unmatchedGtCount = gtRows.length - matchedCount;
    let tp = 0;
    for (let j = 0; j < gtRows.length; j++) {
      const runRowIndex = gtToRun[j];
      if (runRowIndex >= 0 && evaluateNode(root, runRowIndex, j, resultsByIndex, runWs, outputFields, gtContent)) tp++;
    }
    const precision = runCount > 0 ? (tp / runCount) * 100 : 0;
    const recall = gtRows.length > 0 ? (tp / gtRows.length) * 100 : 0;
    const f1 = (precision + recall) > 0 ? (2 * (precision / 100) * (recall / 100) / ((precision + recall) / 100)) * 100 : 0;
    const fmt = (x) => (Number.isFinite(x) ? x.toFixed(2) : '—');
    const metricsText = `Precision ${fmt(precision)}% · Recall ${fmt(recall)}% · F1 ${fmt(f1)}%`;

    const summaryText = `Run result ${runCount} rows · Ground truth ${gtRows.length} rows · ${tp} matched`;

    const topRow = document.createElement('div');
    topRow.className = 'score-detail-results-top-row';
    topRow.innerHTML = `
      <div class="score-detail-results-summary-wrap">
        <span class="score-detail-results-summary">${escapeHtml(summaryText)}</span>
        <span class="score-detail-results-metrics" aria-label="Precision, Recall, F1">${escapeHtml(metricsText)}</span>
      </div>
      <div class="score-detail-results-search-inline">
        <label class="dataset-detail-search-label" for="score-detail-results-search">Search</label>
        <input type="text" id="score-detail-results-search" class="dataset-detail-input dataset-detail-preview-search-inp" placeholder="Filter rows by cell content..." aria-label="Search in table" value="${escapeAttr(scoreDetailPagination.searchQuery)}" />
      </div>
    `;
    const searchInp = topRow.querySelector('#score-detail-results-search');
    if (searchInp) {
      searchInp.addEventListener('input', () => {
        scoreDetailPagination.searchQuery = searchInp.value;
        scoreDetailPagination.currentPage = 1;
        renderResults();
      });
    }
    resultsBody.appendChild(topRow);

    function cellText(val, maxLen = 32) {
      const s = val === null || val === undefined ? '—' : (typeof val === 'string' ? val : String(val));
      return s.length > maxLen ? s.slice(0, maxLen) + '…' : s;
    }

    const runColLabels = rulesFlat.map((r) => (runColumns.find((c) => c.key === (r.outputKey || ''))?.label || r.outputKey || '—').trim() || '—');

    let headerRow = '<thead><tr><th class="score-detail-results-th score-detail-results-th--idx score-detail-results-th--gt-block" title="Ground truth row index">Ground truth #</th>';
    if (gtColsUsed.length > 0) {
      gtColsUsed.forEach((col) => { headerRow += `<th class="score-detail-results-th score-detail-results-th--gt score-detail-results-th--gt-block">${escapeHtml(col)}</th>`; });
    } else {
      headerRow += '<th class="score-detail-results-th score-detail-results-th--gt score-detail-results-th--gt-block">Ground truth</th>';
    }
    headerRow += '<th class="score-detail-results-th score-detail-results-th--idx score-detail-results-th--run-block score-detail-results-th--block-sep" title="Run result row index (matched to this ground truth row)">Run result #</th>';
    runColLabels.forEach((label) => { headerRow += `<th class="score-detail-results-th score-detail-results-th--run score-detail-results-th--run-block">${escapeHtml(label)}</th>`; });
    headerRow += '<th class="score-detail-results-th score-detail-results-th--match score-detail-results-th--result-block">Match</th><th class="score-detail-results-th score-detail-results-th--comment score-detail-results-th--result-block">Comment</th></tr></thead><tbody>';
    const tableWrap = document.createElement('div');
    tableWrap.className = 'score-detail-results-table-wrap';
    const tbl = document.createElement('table');
    tbl.className = 'score-detail-results-table';
    tbl.innerHTML = headerRow;
    const tbody = tbl.querySelector('tbody');

    function appendGtRow(j) {
      const runRowIndex = gtToRun[j];
      const runResult = runRowIndex >= 0 ? resultsByIndex.get(runRowIndex) || null : null;
      const isMatch = runRowIndex >= 0 && evaluateNode(root, runRowIndex, j, resultsByIndex, runWs, outputFields, gtContent);
      const rowClass = isMatch ? 'score-detail-results-tr--match' : 'score-detail-results-tr--unmatch';
      const runNum = runRowIndex >= 0 ? String(runRowIndex + 1) : '—';
      const commentKey = String(j);
      let tr = `<tr class="score-detail-results-tr ${rowClass}" data-comment-key="${escapeAttr(commentKey)}"><td class="score-detail-results-td score-detail-results-td--idx" title="GT row ${j + 1}">${j + 1}</td>`;
      if (gtColsUsed.length > 0) {
        gtColsUsed.forEach((col) => {
          const val = getGtValue(gtContent, j, col);
          tr += `<td class="score-detail-results-td score-detail-results-td--gt" title="${escapeAttr(val)}">${escapeHtml(cellText(val))}</td>`;
        });
      } else {
        tr += '<td class="score-detail-results-td score-detail-results-td--gt">—</td>';
      }
      tr += `<td class="score-detail-results-td score-detail-results-td--idx score-detail-results-td--block-sep" title="${runRowIndex >= 0 ? 'Run result row ' + (runRowIndex + 1) : 'No match'}">${runNum}</td>`;
      for (let ri = 0; ri < rulesFlat.length; ri++) {
        const rule = rulesFlat[ri];
        const runVal = runResult ? getRunValue(runResult, rule.outputKey, runRowIndex, runWs, outputFields) : null;
        tr += `<td class="score-detail-results-td score-detail-results-td--run" title="${escapeAttr(runVal)}">${escapeHtml(cellText(runVal))}</td>`;
      }
      tr += `<td class="score-detail-results-td score-detail-results-td--match" aria-label="${isMatch ? 'Matched' : 'Not matched'}">${isMatch ? '1' : '0'}</td>`;
      tr += '<td class="score-detail-results-td score-detail-results-td--comment"></td></tr>';
      tbody.insertAdjacentHTML('beforeend', tr);
    }

    function appendRunOnlyRow(i) {
      const runResult = resultsByIndex.get(i) || null;
      const rowClass = 'score-detail-results-tr--run-only';
      const commentKey = 'run:' + i;
      let tr = `<tr class="score-detail-results-tr ${rowClass}" data-comment-key="${escapeAttr(commentKey)}"><td class="score-detail-results-td score-detail-results-td--idx" title="No GT row">—</td>`;
      if (gtColsUsed.length > 0) {
        gtColsUsed.forEach(() => { tr += '<td class="score-detail-results-td score-detail-results-td--gt">—</td>'; });
      } else {
        tr += '<td class="score-detail-results-td score-detail-results-td--gt">—</td>';
      }
      tr += `<td class="score-detail-results-td score-detail-results-td--idx score-detail-results-td--block-sep" title="Run result row ${i + 1}">${i + 1}</td>`;
      for (let ri = 0; ri < rulesFlat.length; ri++) {
        const rule = rulesFlat[ri];
        const runVal = runResult ? getRunValue(runResult, rule.outputKey, i, runWs, outputFields) : '';
        tr += `<td class="score-detail-results-td score-detail-results-td--run" title="${escapeAttr(runVal)}">${escapeHtml(cellText(runVal))}</td>`;
      }
      tr += '<td class="score-detail-results-td score-detail-results-td--match" aria-label="Run result row without ground truth match">0</td>';
      tr += '<td class="score-detail-results-td score-detail-results-td--comment"></td></tr>';
      tbody.insertAdjacentHTML('beforeend', tr);
    }

    for (const d of pageDescriptors) {
      if (d.type === 'gt') appendGtRow(d.j);
      else appendRunOnlyRow(d.i);
    }

    tbody.querySelectorAll('tr').forEach((tr) => {
      const commentKey = tr.getAttribute('data-comment-key');
      const td = tr.querySelector('.score-detail-results-td--comment');
      if (!td || commentKey == null) return;
      const textarea = document.createElement('textarea');
      textarea.rows = 2;
      textarea.className = 'score-detail-results-comment-textarea';
      textarea.placeholder = 'Comment...';
      textarea.value = comments[commentKey] ?? '';
      textarea.setAttribute('aria-label', 'Comment');
      textarea.addEventListener('change', () => {
        const c = getResultComments();
        const v = (textarea.value || '').trim();
        if (v) c[commentKey] = textarea.value;
        else delete c[commentKey];
        setResultComments(c);
      });
      td.appendChild(textarea);
    });

    const commentTh = tbl.querySelector('thead .score-detail-results-th--comment');
    if (commentTh) {
      const resizeHandle = document.createElement('div');
      resizeHandle.className = 'score-detail-results-comment-resize-handle';
      resizeHandle.setAttribute('aria-label', 'Resize column');
      resizeHandle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        const startW = commentTh.offsetWidth;
        document.body.classList.add('wd-col-resizing');
        const onMove = (moveE) => {
          const dx = moveE.clientX - startX;
          const newW = Math.max(100, startW + dx);
          commentTh.style.width = `${newW}px`;
          commentTh.style.minWidth = `${newW}px`;
        };
        const onUp = () => {
          document.body.classList.remove('wd-col-resizing');
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
      commentTh.appendChild(resizeHandle);
    }

    tableWrap.appendChild(tbl);
    resultsBody.appendChild(tableWrap);

    if (resultsToolbar) {
      resultsToolbar.style.display = '';
      resultsToolbar.innerHTML = `
        <label class="dataset-detail-rows-label" for="score-detail-rows-per-page">Rows per page</label>
        <select id="score-detail-rows-per-page" class="dataset-detail-rows-select" aria-label="Rows per page">
          ${ROWS_PER_PAGE_OPTIONS.map((n) => `<option value="${n}" ${n === scoreDetailPagination.rowsPerPage ? 'selected' : ''}>${n}</option>`).join('')}
        </select>
        <span class="dataset-detail-pagination-info score-detail-pagination-info" aria-live="polite">${totalRows === 0 ? (totalUnfiltered === 0 ? '0 rows' : `0 rows (filtered from ${totalUnfiltered})`) : (totalRows === totalUnfiltered ? `Showing ${start + 1}–${end} of ${totalRows} rows` : `Showing ${start + 1}–${end} of ${totalRows} (filtered from ${totalUnfiltered}) rows`)}</span>
        <label class="dataset-detail-page-label" for="score-detail-page-inp">Page</label>
        <input type="number" id="score-detail-page-inp" class="dataset-detail-page-inp" min="1" max="${totalPages}" value="${scoreDetailPagination.currentPage}" aria-label="Page number" />
        <span class="dataset-detail-page-of score-detail-page-of">/ ${totalPages}</span>
        <div class="dataset-detail-pagination-btns">
          <button type="button" class="btn btn-secondary score-detail-prev-page" aria-label="Previous page">Previous</button>
          <button type="button" class="btn btn-secondary score-detail-next-page" aria-label="Next page">Next</button>
        </div>
      `;
      const rowsPerPageSelect = resultsToolbar.querySelector('#score-detail-rows-per-page');
      const pageInp = resultsToolbar.querySelector('#score-detail-page-inp');
      const prevBtn = resultsToolbar.querySelector('.score-detail-prev-page');
      const nextBtn = resultsToolbar.querySelector('.score-detail-next-page');
      if (rowsPerPageSelect) {
        rowsPerPageSelect.addEventListener('change', () => {
          scoreDetailPagination.rowsPerPage = Number(rowsPerPageSelect.value) || 25;
          scoreDetailPagination.currentPage = 1;
          renderResults();
        });
      }
      if (pageInp) {
        pageInp.addEventListener('change', () => {
          scoreDetailPagination.currentPage = Math.max(1, Math.min(totalPages, parseInt(pageInp.value, 10) || 1));
          renderResults();
        });
      }
      if (prevBtn) {
        prevBtn.disabled = scoreDetailPagination.currentPage <= 1;
        prevBtn.addEventListener('click', () => {
          scoreDetailPagination.currentPage = Math.max(1, scoreDetailPagination.currentPage - 1);
          renderResults();
        });
      }
      if (nextBtn) {
        nextBtn.disabled = scoreDetailPagination.currentPage >= totalPages;
        nextBtn.addEventListener('click', () => {
          scoreDetailPagination.currentPage = Math.min(totalPages, scoreDetailPagination.currentPage + 1);
          renderResults();
        });
      }
    }
    updateSaveToWorkspaceButton();
  }

  async function loadReviewCredentials() {
    try {
      const res = await fetch(`${API_BASE}/api/credentials`);
      if (!res.ok) return;
      const list = await res.json();
      llmSelect.innerHTML = '<option value="">— Select —</option>' + (list || []).map((c) => `<option value="${escapeAttr(c.id)}">${escapeHtml(c.name || c.llm || '')}</option>`).join('');
      const savedId = (node?.dataset?.reviewCredentialId || '').trim();
      if (savedId && list?.some((c) => c.id === savedId)) llmSelect.value = savedId;
    } catch (_) {}
    const payload = getReviewPayload();
    addPromptReviewBtn.disabled = !payload || !payload.prompt_sections || payload.prompt_sections.length === 0;
    updateSaveToWorkspaceButton();
  }

  function updateSaveToWorkspaceButton() {
    if (!saveToWorkspaceBtn) return;
    const payload = getScoreExportData({ node, getRunResults, getRunWorkingSetContent, getGroundTruthContent, getGroundTruthHeaders, getRunResultColumns });
    saveToWorkspaceBtn.disabled = !payload || !payload.headers || !payload.rows.length;
  }

  llmSelect.addEventListener('change', () => {
    const v = (llmSelect.value || '').trim();
    if (node) {
      node.dataset.reviewCredentialId = v;
      document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
    }
  });

  if (saveToWorkspaceBtn) {
    saveToWorkspaceBtn.addEventListener('click', () => {
      const payload = getScoreExportData({ node, getRunResults, getRunWorkingSetContent, getGroundTruthContent, getGroundTruthHeaders, getRunResultColumns });
      if (!payload || !payload.headers || !payload.rows) return;
      const scoreName = (node?.querySelector?.('.workflow-node__title')?.textContent || '').trim() || 'Score';
      document.dispatchEvent(new CustomEvent('workflow:score-export-to-workspace', {
        detail: { scoreNodeId: node?.dataset?.nodeId || '', scoreName, headers: payload.headers, rows: payload.rows },
      }));
    });
  }

  addPromptReviewBtn.addEventListener('click', async () => {
    const scoreNodeId = node?.dataset?.nodeId || '';
    if (!scoreNodeId) return;
    const credentialId = (llmSelect?.value || '').trim();
    const payload = getReviewPayload();
    if (!credentialId || !payload || !payload.prompt_sections || !payload.prompt_sections.length) return;
    const addEvent = new CustomEvent('workflow:add-prompt-review-node', { detail: { scoreNodeId } });
    document.dispatchEvent(addEvent);
    const reviewNodeId = addEvent.detail?.reviewNodeId || '';
    close();
    if (reviewNodeId) await runReviewStream({ reviewNodeId, payload, credentialId });
  });

  function selectGroundTruth(id) {
    selectedNodeId = id || '';
    if (node) {
      node.dataset.scoreGroundTruthId = selectedNodeId || '';
      document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
    }
    updateTriggerDisplay();
    updateScoreNodeBorder();
    closeDropdown();
    dropdownEl.querySelectorAll('[role="option"]').forEach((o) => o.setAttribute('aria-selected', o.dataset.nodeId === selectedNodeId ? 'true' : 'false'));
    renderRules();
  }

  function populateDropdown() {
    dropdownEl.innerHTML = '';
    const emptyOption = document.createElement('div');
    emptyOption.className = 'run-detail-ws-option';
    emptyOption.setAttribute('role', 'option');
    emptyOption.setAttribute('aria-selected', !selectedNodeId ? 'true' : 'false');
    emptyOption.innerHTML = '<span class="run-detail-ws-option-color run-detail-ws-option-color--empty"></span><span class="run-detail-ws-option-text">— Select dataset —</span>';
    emptyOption.dataset.nodeId = '';
    emptyOption.addEventListener('click', () => selectGroundTruth(''));
    dropdownEl.appendChild(emptyOption);
    workingSets.forEach((ws) => {
      const option = document.createElement('div');
      option.className = 'run-detail-ws-option';
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', ws.nodeId === selectedNodeId ? 'true' : 'false');
      option.innerHTML = `<span class="run-detail-ws-option-color" style="background:${escapeHtml(ws.color || 'transparent')}"></span><span class="run-detail-ws-option-text">${escapeHtml(ws.name || 'Dataset')}</span>`;
      option.dataset.nodeId = ws.nodeId;
      option.addEventListener('click', () => selectGroundTruth(ws.nodeId));
      dropdownEl.appendChild(option);
    });
  }

  triggerEl.addEventListener('click', (e) => {
    e.preventDefault();
    if (dropdownEl.hidden) {
      populateDropdown();
      openDropdown();
    } else {
      closeDropdown();
    }
  });
  triggerEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (dropdownEl.hidden) {
        populateDropdown();
        openDropdown();
      } else {
        closeDropdown();
      }
    }
  });
  overlay.addEventListener('click', (e) => {
    if (pickerEl.contains(e.target)) return;
    closeDropdown();
  });

  function close() {
    overlay.remove();
    document.body.style.overflow = '';
  }

  overlay.querySelector('.modal-close').addEventListener('click', close);

  updateTriggerDisplay();
  updateScoreNodeBorder();
  renderRules();
  loadReviewCredentials();
  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);
  if (autoTriggerReview && addPromptReviewBtn) {
    setTimeout(() => {
      if (addPromptReviewBtn.disabled) return;
      addPromptReviewBtn.click();
    }, 200);
  }
}

/**
 * Build score comparison table for export (Save to workspace).
 * Column names and order match the Score page display.
 * @param {{ node: HTMLElement, getRunResults: () => { results, outputFields }, getRunWorkingSetContent: () => { headers, rows }, getGroundTruthContent: (wsNodeId: string) => { headers, rows }, getGroundTruthHeaders: (wsNodeId: string) => string[], getRunResultColumns?: () => Array<{ key: string, label: string }> }} options
 * @returns {{ headers: string[], rows: string[][] } | null}
 */
export function getScoreExportData({ node, getRunResults, getRunWorkingSetContent, getGroundTruthContent, getGroundTruthHeaders, getRunResultColumns }) {
  if (!node) return null;
  const selectedNodeId = (node.dataset.scoreGroundTruthId || '').trim();
  if (!selectedNodeId) return null;
  const raw = (node.dataset.scoreMapping || '[]').trim();
  let data;
  try {
    data = JSON.parse(raw || '[]');
  } catch (_) {
    return null;
  }
  function normalizeToRules(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return [];
    const first = arr[0];
    if (first && typeof first === 'object' && Array.isArray(first.gtColumns)) {
      return arr.map((r) => ({
        outputKey: r.outputKey || '',
        gtColumns: Array.isArray(r.gtColumns) ? r.gtColumns.filter(Boolean) : [],
        matchType: r.matchType || 'exact',
      })).filter((r) => r.outputKey || r.gtColumns.length > 0);
    }
    const pairs = [];
    if (first && first.outputKey !== undefined && !first.rules) {
      arr.forEach((r) => { pairs.push({ outputKey: r.outputKey || '', gtColumn: r.gtColumn || '', matchType: r.matchType || 'exact' }); });
    } else if (first && first.rules) {
      arr.forEach((g) => { (g.rules || []).forEach((r) => { pairs.push({ outputKey: r.outputKey || '', gtColumn: r.gtColumn || '', matchType: r.matchType || 'exact' }); }); });
    } else return [];
    const byKey = {};
    pairs.forEach((p) => {
      if (!byKey[p.outputKey]) byKey[p.outputKey] = { outputKey: p.outputKey, gtColumns: [], matchType: p.matchType || 'exact' };
      if (p.gtColumn && !byKey[p.outputKey].gtColumns.includes(p.gtColumn)) byKey[p.outputKey].gtColumns.push(p.gtColumn);
    });
    return Object.values(byKey).filter((r) => r.outputKey || r.gtColumns.length > 0);
  }
  function ensureGroupOps(data, children) {
    const n = (children || []).length;
    const len = Math.max(0, n - 1);
    if (Array.isArray(data.ops) && data.ops.length >= len) return data.ops.slice(0, len).map((o) => (o === 'OR' ? 'OR' : 'AND'));
    return Array(len).fill(data && data.op === 'OR' ? 'OR' : 'AND');
  }
  function normalizeChild(c) {
    if (!c || c.type === 'rule') return { type: 'rule', outputKey: (c && c.outputKey) || '', gtColumns: Array.isArray(c && c.gtColumns) ? c.gtColumns.filter(Boolean) : [], matchType: (c && c.matchType) || 'exact' };
    return normalizeGroupChild(c);
  }
  function normalizeGroupChild(c) {
    const children = (c.children || []).map((ch) => (ch && ch.type === 'group') ? normalizeGroupChild(ch) : normalizeChild(ch));
    return { type: 'group', ops: ensureGroupOps(c, children), children };
  }
  function parseRoot() {
    if (data && data.type === 'group' && Array.isArray(data.children)) {
      const children = (data.children || []).map((c) => (c && c.type === 'group') ? normalizeGroupChild(c) : normalizeChild(c));
      return { type: 'group', ops: ensureGroupOps(data, children), children };
    }
    const rules = normalizeToRules(Array.isArray(data) ? data : []);
    const children = rules.map((r) => ({ type: 'rule', outputKey: r.outputKey || '', gtColumns: (r.gtColumns || []).slice(), matchType: r.matchType || 'exact' }));
    return { type: 'group', ops: Array(Math.max(0, children.length - 1)).fill('AND'), children };
  }
  const root = parseRoot();
  function collectRulesFlat(r, path = []) {
    if (!r) return [];
    if (r.type === 'rule') return [{ rule: r, path: path.slice() }];
    if (r.type === 'group' && Array.isArray(r.children)) {
      const out = [];
      (r.children || []).forEach((ch, i) => { out.push(...collectRulesFlat(ch, path.concat(i))); });
      return out;
    }
    return [];
  }
  const rulesFlat = collectRulesFlat(root).map((x) => x.rule);
  if (rulesFlat.length === 0) return null;
  const toCompareStr = (v) => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v.trim();
    if (Array.isArray(v)) return v.map((x) => toCompareStr(x)).join(', ').trim();
    return String(v).trim();
  };
  const getRunValue = (runResult, outputKey, rowIndex, runWs, outputFields) => {
    if (outputKey === '#' || outputKey === '[#]') return toCompareStr(rowIndex);
    const keyStr = String(outputKey || '').trim();
    if (!keyStr) return '';
    if (keyStr.startsWith('[') && keyStr.endsWith(']')) {
      const header = keyStr.slice(1, -1).trim();
      const rows = runWs.rows || [];
      const headers = runWs.headers || [];
      const colIdx = headers.findIndex((h) => String(h).trim() === header);
      if (colIdx >= 0 && rows[rowIndex]) return toCompareStr(rows[rowIndex][colIdx]);
      return '';
    }
    if (runResult && runResult.output && typeof runResult.output === 'object' && keyStr in runResult.output) return toCompareStr(runResult.output[keyStr]);
    return '';
  };
  const getGtValue = (gtContent, rowIndex, columnName) => {
    const headers = gtContent.headers || [];
    const rows = gtContent.rows || [];
    const colIdx = headers.findIndex((h) => String(h).trim() === String(columnName).trim());
    if (colIdx >= 0 && rows[rowIndex]) return toCompareStr(rows[rowIndex][colIdx]);
    return '';
  };
  const ruleMatchesRow = (rule, runRowIndex, gtRowIndex, resultsByIndex, runWs, outputFields, gtContent) => {
    const runResult = resultsByIndex.get(runRowIndex) || null;
    const runVal = getRunValue(runResult, rule.outputKey, runRowIndex, runWs, outputFields);
    const gtVals = (rule.gtColumns || []).map((col) => getGtValue(gtContent, gtRowIndex, col));
    return gtVals.some((g) => g === runVal);
  };
  const countMatchingRules = (r, runRowIndex, gtRowIndex, resultsByIndex, runWs, outputFields, gtContent) =>
    collectRulesFlat(r).map((x) => x.rule).filter((rule) => ruleMatchesRow(rule, runRowIndex, gtRowIndex, resultsByIndex, runWs, outputFields, gtContent)).length;
  const evaluateNode = (nd, runRowIndex, gtRowIndex, resultsByIndex, runWs, outputFields, gtContent) => {
    if (!nd) return false;
    if (nd.type === 'rule') return ruleMatchesRow(nd, runRowIndex, gtRowIndex, resultsByIndex, runWs, outputFields, gtContent);
    if (nd.type === 'group' && Array.isArray(nd.children)) {
      if (nd.children.length === 0) return false;
      const ops = nd.ops || Array(Math.max(0, nd.children.length - 1)).fill('AND');
      let r = evaluateNode(nd.children[0], runRowIndex, gtRowIndex, resultsByIndex, runWs, outputFields, gtContent);
      for (let i = 1; i < nd.children.length; i++) {
        const next = evaluateNode(nd.children[i], runRowIndex, gtRowIndex, resultsByIndex, runWs, outputFields, gtContent);
        r = (ops[i - 1] === 'OR') ? (r || next) : (r && next);
      }
      return r;
    }
    return false;
  };
  const computeMatchPerRow = (r, results, outputFields, runWs, gtContent) => {
    const gtRows = gtContent.rows || [];
    const resultsByIndex = new Map();
    (results || []).forEach((res) => { resultsByIndex.set(res.row_index, res); });
    const runCount = runWs?.rows?.length ?? 0;
    const gtCount = gtRows.length;
    const runToGt = new Array(Math.max(runCount, gtCount)).fill(-1);
    const gtUsed = new Array(gtCount).fill(false);
    const pairs = [];
    for (let i = 0; i < runCount; i++) {
      for (let j = 0; j < gtCount; j++) {
        const score = countMatchingRules(r, i, j, resultsByIndex, runWs, outputFields, gtContent);
        if (score > 0) pairs.push({ i, j, score });
      }
    }
    pairs.sort((a, b) => b.score - a.score);
    for (const { i, j } of pairs) {
      if (runToGt[i] >= 0 || gtUsed[j]) continue;
      runToGt[i] = j;
      gtUsed[j] = true;
    }
    return { runToGt, total: runCount };
  };

  const { results, outputFields } = getRunResults();
  const runWs = getRunWorkingSetContent();
  const gtContent = getGroundTruthContent(selectedNodeId);
  const gtRows = gtContent.rows || [];
  const gtHeaders = gtContent.headers || [];
  if (!Array.isArray(gtRows)) return null;
  if (gtRows.length === 0 && (!results || results.length === 0)) return null;
  const resultsByIndex = new Map();
  (results || []).forEach((r) => { resultsByIndex.set(r.row_index, r); });
  const runCount = runWs?.rows?.length ?? 0;
  const { runToGt, total } = computeMatchPerRow(root, results, outputFields, runWs, gtContent);
  const gtToRun = new Array(gtRows.length).fill(-1);
  for (let i = 0; i < (runToGt || []).length; i++) {
    if (runToGt[i] >= 0) gtToRun[runToGt[i]] = i;
  }
  const gtColsUsed = [];
  for (const r of rulesFlat) {
    for (const c of (r.gtColumns || [])) {
      if (c && !gtColsUsed.includes(c)) gtColsUsed.push(c);
    }
  }
  const descriptors = [];
  for (let j = 0; j < gtRows.length; j++) {
    if (gtToRun[j] >= 0) descriptors.push({ type: 'gt', j });
  }
  for (let j = 0; j < gtRows.length; j++) {
    if (gtToRun[j] < 0) descriptors.push({ type: 'gt', j });
  }
  for (let i = 0; i < runCount; i++) {
    if (runToGt[i] >= 0) continue;
    let matchesAnyGt = false;
    for (let j = 0; j < gtRows.length; j++) {
      if (evaluateNode(root, i, j, resultsByIndex, runWs, outputFields, gtContent)) { matchesAnyGt = true; break; }
    }
    if (!matchesAnyGt) descriptors.push({ type: 'runOnly', i });
  }
  let comments = {};
  try {
    comments = JSON.parse(node.dataset.scoreResultComments || '{}');
  } catch (_) {}
  const runColumns = typeof getRunResultColumns === 'function' ? getRunResultColumns() : [];
  const runLabels = rulesFlat.map((r) => (runColumns.find((c) => c.key === (r.outputKey || ''))?.label || r.outputKey || '—').trim() || '—');
  const headers = ['Ground truth #', ...(gtColsUsed.length > 0 ? gtColsUsed : ['Ground truth']), 'Run result #', ...runLabels, 'Match', 'Comment'];
  const rows = descriptors.map((d) => {
    const parts = [];
    if (d.type === 'gt') {
      const j = d.j;
      const runRowIndex = gtToRun[j];
      const runResult = runRowIndex >= 0 ? resultsByIndex.get(runRowIndex) || null : null;
      parts.push(String(j + 1));
      if (gtColsUsed.length === 0) parts.push('—');
      gtColsUsed.forEach((col) => { parts.push(getGtValue(gtContent, j, col)); });
      parts.push(runRowIndex >= 0 ? String(runRowIndex + 1) : '—');
      rulesFlat.forEach((rule) => { parts.push(runResult ? getRunValue(runResult, rule.outputKey, runRowIndex, runWs, outputFields) : ''); });
      parts.push(runRowIndex >= 0 && evaluateNode(root, runRowIndex, j, resultsByIndex, runWs, outputFields, gtContent) ? '1' : '0');
      parts.push(comments[String(j)] ?? '');
    } else {
      const i = d.i;
      const runResult = resultsByIndex.get(i) || null;
      parts.push('—');
      if (gtColsUsed.length === 0) parts.push('—');
      gtColsUsed.forEach(() => { parts.push('—'); });
      parts.push(String(i + 1));
      rulesFlat.forEach((rule) => { parts.push(runResult ? getRunValue(runResult, rule.outputKey, i, runWs, outputFields) : ''); });
      parts.push('0');
      parts.push(comments['run:' + i] ?? '');
    }
    return parts.map((v) => (v === null || v === undefined ? '' : String(v)));
  });
  return { headers, rows };
}
