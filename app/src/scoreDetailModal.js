/**
 * Score detail modal: left = Working dataset as ground truth picker + field mapping table; right = results.
 * @param {{ node: HTMLElement, getWorkingSets?: () => Array<...>, getRunResultColumns?: () => Array<{ key: string, label: string }>, getGroundTruthHeaders?: (wsNodeId: string) => string[] }} options
 */

const MATCH_TYPE_STRICT = { value: 'exact', label: 'Strict match' };

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  const s = String(str ?? '');
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

export function openScoreDetailModal({ node, getWorkingSets, getRunResultColumns, getGroundTruthHeaders, getRunResults, getRunWorkingSetContent, getGroundTruthContent }) {
  getWorkingSets = getWorkingSets || (() => []);
  getRunResultColumns = getRunResultColumns || (() => []);
  getGroundTruthHeaders = getGroundTruthHeaders || (() => []);
  getRunResults = getRunResults || (() => ({ results: [], outputFields: [] }));
  getRunWorkingSetContent = getRunWorkingSetContent || (() => ({ headers: [], rows: [] }));
  getGroundTruthContent = getGroundTruthContent || (() => ({ headers: [], rows: [] }));

  const workingSets = getWorkingSets();

  const name = (node?.querySelector?.('.workflow-node__title')?.textContent?.trim()) || 'Score';
  const n = (name.match(/Score\s*(\d+)/i) || [])[1] || '1';
  const title = `Scorecard ${n} details`;

  let selectedNodeId = (node?.dataset?.scoreGroundTruthId || '').trim();

  /** Normalize to rules: [{ outputKey, gtColumns: string[], matchType }]. All rules are AND; within gtColumns is OR. Migrate from old groups/flat format. */
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

  function getRules() {
    try {
      const raw = node?.dataset?.scoreMapping || '[]';
      const arr = JSON.parse(raw);
      const rules = normalizeToRules(Array.isArray(arr) ? arr : []);
      return rules.length ? rules : [];
    } catch (_) { return []; }
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

  /** Returns { matched: boolean[], total, matchedCount }. */
  function computeMatchPerRow(rules, results, outputFields, runWs, gtContent) {
    const gtRows = gtContent.rows || [];
    const matched = [];
    const resultsByIndex = new Map();
    (results || []).forEach((r) => { resultsByIndex.set(r.row_index, r); });
    for (let i = 0; i < gtRows.length; i++) {
      const runResult = resultsByIndex.get(i) || null;
      let rowMatch = true;
      for (const rule of rules) {
        const runVal = getRunValue(runResult, rule.outputKey, i, runWs, outputFields);
        const gtVals = (rule.gtColumns || []).map((col) => getGtValue(gtContent, i, col));
        const rulePass = gtVals.some((g) => g === runVal);
        if (!rulePass) {
          rowMatch = false;
          break;
        }
      }
      matched.push(rowMatch);
    }
    return {
      matched,
      total: gtRows.length,
      matchedCount: matched.filter(Boolean).length,
    };
  }

  function setRules(rules) {
    if (!node) return;
    node.dataset.scoreMapping = JSON.stringify(rules);
    document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
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
    <div class="modal-panel modal-panel--score-detail">
      <div class="modal-header">
        <h2 id="score-detail-title" class="modal-title">${escapeHtml(title)}</h2>
        <button type="button" class="modal-close" aria-label="Close">×</button>
      </div>
      <div class="modal-body score-detail-body">
        <div class="score-detail-col score-detail-col--left">
          <div class="score-detail-card">
            <div class="score-detail-block score-detail-block--gt">
              <div class="run-detail-row">
                <label class="run-detail-label" for="score-detail-gt-picker">Ground truth</label>
                <div class="run-detail-ws-picker" id="score-detail-gt-picker" role="combobox" aria-expanded="false" aria-haspopup="listbox" aria-label="Select working dataset as ground truth">
                  <div class="run-detail-ws-trigger" tabindex="0">
                    <span class="run-detail-ws-trigger-color" id="score-detail-gt-trigger-color"></span>
                    <span class="run-detail-ws-trigger-text" id="score-detail-gt-trigger-text">— Select —</span>
                    <span class="run-detail-ws-trigger-arrow" aria-hidden="true">⌵</span>
                  </div>
                  <div class="run-detail-ws-dropdown" id="score-detail-gt-dropdown" role="listbox" hidden></div>
                </div>
              </div>
            </div>
            <div class="score-detail-block score-detail-block--rules">
              <h3 class="score-detail-section-title">Rules</h3>
              <p class="score-detail-rules-hint">All rules must match (AND). For each rule, run column matches if it equals any selected ground truth column (OR).</p>
              <div id="score-detail-mapping-wrap" class="score-detail-rules-wrap"></div>
              <div class="score-detail-mapping-actions">
                <button type="button" class="btn btn-secondary score-detail-add-rule" id="score-detail-add-rule">+ Add rule</button>
              </div>
            </div>
          </div>
        </div>
        <div class="score-detail-col score-detail-col--right">
          <div class="score-detail-card score-detail-results-card" id="score-detail-results-card">
            <div class="score-detail-results-head">
              <h3 class="score-detail-section-title">Results</h3>
              <button type="button" class="btn btn-secondary score-detail-add-prompt-review" id="score-detail-add-prompt-review" title="Add a Review node after this Score to analyze results with LLM">Add Review</button>
            </div>
            <div id="score-detail-results-body"></div>
          </div>
        </div>
      </div>
    </div>
  `;

  const pickerEl = overlay.querySelector('#score-detail-gt-picker');
  const triggerEl = overlay.querySelector('.run-detail-ws-trigger');
  const triggerColorEl = overlay.querySelector('#score-detail-gt-trigger-color');
  const triggerTextEl = overlay.querySelector('#score-detail-gt-trigger-text');
  const dropdownEl = overlay.querySelector('#score-detail-gt-dropdown');
  const mappingWrap = overlay.querySelector('#score-detail-mapping-wrap');
  const addRuleBtn = overlay.querySelector('#score-detail-add-rule');
  const addPromptReviewBtn = overlay.querySelector('#score-detail-add-prompt-review');
  const resultsBody = overlay.querySelector('#score-detail-results-body');

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
      triggerTextEl.textContent = ws.name || 'Working dataset';
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

  function renderRules() {
    mappingWrap.innerHTML = '';

    if (!selectedNodeId) {
      const p = document.createElement('p');
      p.className = 'score-detail-placeholder';
      p.textContent = 'Select a working dataset as ground truth, then add rules.';
      mappingWrap.appendChild(p);
      return;
    }
    const runColumns = getRunResultColumns();
    const gtHeaders = getGroundTruthHeaders(selectedNodeId);
    if (runColumns.length === 0 || gtHeaders.length === 0) {
      const p = document.createElement('p');
      p.className = 'score-detail-placeholder';
      p.textContent = runColumns.length === 0
        ? 'No run connected or run has no result columns (run once with a working dataset to see columns).'
        : 'Ground truth dataset has no columns.';
      mappingWrap.appendChild(p);
      return;
    }

    const rules = getRules();

    const table = document.createElement('div');
    table.className = 'score-detail-mapping-table';
    table.setAttribute('role', 'table');
    table.innerHTML = `
      <div class="score-detail-mapping-head" role="row">
        <span class="score-detail-mapping-th" role="columnheader">Run column</span>
        <span class="score-detail-mapping-th" role="columnheader">Ground truth columns (OR)</span>
        <span class="score-detail-mapping-th" role="columnheader">Match</span>
        <span class="score-detail-mapping-th score-detail-mapping-th--action" role="columnheader"></span>
      </div>
    `;

    rules.forEach((rule, ruleIndex) => {
      const runOpts = runColumns.map((c) => `<option value="${escapeAttr(c.key)}" ${c.key === (rule.outputKey || '') ? 'selected' : ''}>${escapeHtml((c.label || '').trim() || c.key || '—')}</option>`).join('');
      const row = document.createElement('div');
      row.className = 'score-detail-mapping-row';
      row.setAttribute('role', 'row');
      const gtChipsHtml = (rule.gtColumns || []).map((h) => `<span class="score-detail-gt-chip">${escapeHtml(h)}<button type="button" class="score-detail-gt-chip-remove" data-gt="${escapeAttr(h)}" aria-label="Remove">×</button></span>`).join('');
      const gtAddOpts = ['', ...gtHeaders].map((h) => `<option value="${escapeAttr(h)}">${h ? escapeHtml(h) : '— Add —'}</option>`).join('');
      row.innerHTML = `
        <span class="score-detail-mapping-cell score-detail-mapping-cell--field" role="cell">
          <select class="score-detail-mapping-select score-detail-run-column-select" data-rule-index="${ruleIndex}" aria-label="Run result column">
            ${runOpts}
          </select>
        </span>
        <span class="score-detail-mapping-cell score-detail-mapping-cell--gt-cols" role="cell">
          <div class="score-detail-gt-chips">${gtChipsHtml}</div>
          <div class="score-detail-gt-add-wrap">
            <select class="score-detail-gt-add-select" data-rule-index="${ruleIndex}" aria-label="Add ground truth column">
              ${gtAddOpts}
            </select>
            <span class="score-detail-gt-add-label" aria-hidden="true">+ Add</span>
          </div>
        </span>
        <span class="score-detail-mapping-cell score-detail-mapping-cell--match" role="cell">${escapeHtml(MATCH_TYPE_STRICT.label)}</span>
        <span class="score-detail-mapping-cell score-detail-mapping-cell--action" role="cell">
          <button type="button" class="btn btn-secondary score-detail-remove-mapping" data-rule-index="${ruleIndex}" aria-label="Remove rule">×</button>
        </span>
      `;

      const runSelect = row.querySelector('.score-detail-run-column-select');
      const gtAddSelect = row.querySelector('.score-detail-gt-add-select');
      const removeBtn = row.querySelector('.score-detail-remove-mapping');

      runSelect.addEventListener('change', () => {
        const r = getRules();
        if (r[ruleIndex]) {
          r[ruleIndex] = { ...r[ruleIndex], outputKey: (runSelect.value || '').trim() };
          setRules(r);
        }
      });
      gtAddSelect.addEventListener('change', () => {
        const gt = (gtAddSelect.value || '').trim();
        if (!gt) return;
        const r = getRules();
        if (r[ruleIndex] && !(r[ruleIndex].gtColumns || []).includes(gt)) {
          r[ruleIndex].gtColumns = [...(r[ruleIndex].gtColumns || []), gt];
          setRules(r);
          renderRules();
        }
        gtAddSelect.value = '';
      });
      row.querySelectorAll('.score-detail-gt-chip-remove').forEach((btn) => {
        btn.addEventListener('click', () => {
          const gt = btn.dataset.gt || '';
          const r = getRules();
          if (r[ruleIndex]) {
            r[ruleIndex].gtColumns = (r[ruleIndex].gtColumns || []).filter((c) => c !== gt);
            setRules(r);
            renderRules();
          }
        });
      });
      removeBtn.addEventListener('click', () => {
        const r = getRules().filter((_, i) => i !== ruleIndex);
        setRules(r);
        renderRules();
      });

      table.appendChild(row);
    });

    if (rules.length > 0) {
      mappingWrap.appendChild(table);
    } else {
      const emptyP = document.createElement('p');
      emptyP.className = 'score-detail-placeholder score-detail-mapping-empty';
      emptyP.textContent = 'No rules. Click "+ Add rule" to add one.';
      mappingWrap.appendChild(emptyP);
    }
    renderResults();
  }

  function renderResults() {
    if (!resultsBody) return;
    resultsBody.innerHTML = '';
    const rules = getRules();
    if (!selectedNodeId) {
      resultsBody.innerHTML = '<p class="score-detail-placeholder">Select ground truth and add rules to see comparison results.</p>';
      return;
    }
    if (rules.length === 0) {
      resultsBody.innerHTML = '<p class="score-detail-placeholder">Add at least one rule to compare.</p>';
      return;
    }
    const { results, outputFields } = getRunResults();
    const runWs = getRunWorkingSetContent();
    const gtContent = getGroundTruthContent(selectedNodeId);
    const gtHeaders = gtContent.headers || [];
    const gtRows = gtContent.rows || [];
    const resultsByIndex = new Map();
    (results || []).forEach((r) => { resultsByIndex.set(r.row_index, r); });
    const maxRunRow = results.length ? Math.max(...(results || []).map((r) => r.row_index), 0) : -1;
    const maxGtRow = gtRows.length ? gtRows.length - 1 : -1;
    const maxRow = Math.max(maxRunRow, maxGtRow, 0);
    const hasAnyRows = maxRow >= 0;

    if (!hasAnyRows) {
      resultsBody.innerHTML = '<p class="score-detail-placeholder">No run results and no ground truth rows.</p>';
      return;
    }

    const { matched, total, matchedCount } = computeMatchPerRow(rules, results, outputFields, runWs, gtContent);

    const summary = document.createElement('p');
    summary.className = 'score-detail-results-summary';
    const runOnlyCount = maxRunRow > maxGtRow ? maxRunRow - maxGtRow : 0;
    summary.textContent = `${matchedCount} of ${total} rows matched` + (runOnlyCount > 0 ? ` · ${runOnlyCount} run row(s) without GT` : '');
    resultsBody.appendChild(summary);
    const table = document.createElement('div');
    table.className = 'score-detail-results-table-wrap';
    const tbl = document.createElement('table');
    tbl.className = 'score-detail-results-table';
    let headerRow = '<thead><tr><th class="score-detail-results-th score-detail-results-th--idx">#</th>';
    rules.forEach((rule) => {
      const runLabel = String(rule.outputKey || '').trim() || '—';
      const gtLabel = (rule.gtColumns || []).join(', ') || '—';
      headerRow += `<th class="score-detail-results-th score-detail-results-th--run">Run: ${escapeHtml(runLabel)}</th>`;
      headerRow += `<th class="score-detail-results-th score-detail-results-th--gt">GT: ${escapeHtml(gtLabel)}</th>`;
    });
    headerRow += '<th class="score-detail-results-th score-detail-results-th--match">Match</th><th class="score-detail-results-th score-detail-results-th--comment">Comment</th></tr></thead><tbody>';
    tbl.innerHTML = headerRow;
    const tbody = tbl.querySelector('tbody');
    const comments = getResultComments();

    function cellText(val, maxLen = 24) {
      const s = val === null || val === undefined ? '—' : (typeof val === 'string' ? val : String(val));
      return s.length > maxLen ? s.slice(0, maxLen) + '…' : s;
    }

    for (let i = 0; i <= maxRow; i++) {
      const runResult = resultsByIndex.get(i) || null;
      const hasGt = i < gtRows.length;
      const isMatch = hasGt && runResult && (matched[i] === true);
      const hasRunNoGt = runResult && !hasGt;
      const rowClass = isMatch ? 'score-detail-results-tr--match' : (hasRunNoGt ? 'score-detail-results-tr--run-only' : 'score-detail-results-tr--unmatch');
      let tr = `<tr class="score-detail-results-tr ${rowClass}"><td class="score-detail-results-td score-detail-results-td--idx">${i + 1}</td>`;
      for (const rule of rules) {
        const runVal = getRunValue(runResult, rule.outputKey, i, runWs, outputFields);
        const gtVals = hasGt ? (rule.gtColumns || []).map((col) => getGtValue(gtContent, i, col)) : [];
        const gtDisplay = gtVals.length === 0 ? (hasGt ? '—' : '—') : gtVals.join(' | ');
        tr += `<td class="score-detail-results-td score-detail-results-td--run" title="${escapeAttr(runVal)}">${escapeHtml(cellText(runVal))}</td>`;
        tr += `<td class="score-detail-results-td score-detail-results-td--gt" title="${escapeAttr(gtDisplay)}">${escapeHtml(cellText(gtDisplay, 30))}</td>`;
      }
      tr += `<td class="score-detail-results-td score-detail-results-td--match" aria-label="${isMatch ? 'Matched' : hasRunNoGt ? 'Run only (no GT)' : 'Not matched'}">${isMatch ? '✓' : '✗'}</td>`;
      tr += '<td class="score-detail-results-td score-detail-results-td--comment"></td></tr>';
      tbody.insertAdjacentHTML('beforeend', tr);
    }
    const commentCells = tbody.querySelectorAll('.score-detail-results-td--comment');
    commentCells.forEach((td, idx) => {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'score-detail-results-comment-input';
      input.placeholder = 'Comment...';
      input.value = comments[String(idx)] ?? '';
      input.setAttribute('aria-label', `Comment for row ${idx + 1}`);
      input.addEventListener('change', () => {
        const c = getResultComments();
        const v = (input.value || '').trim();
        if (v) c[String(idx)] = input.value;
        else delete c[String(idx)];
        setResultComments(c);
      });
      td.appendChild(input);
    });
    table.appendChild(tbl);
    resultsBody.appendChild(table);
  }

  addPromptReviewBtn.addEventListener('click', () => {
    const scoreNodeId = node?.dataset?.nodeId || '';
    if (!scoreNodeId) return;
    document.dispatchEvent(new CustomEvent('workflow:add-prompt-review-node', { detail: { scoreNodeId } }));
  });

  addRuleBtn.addEventListener('click', () => {
    const runColumns = getRunResultColumns();
    const gtHeaders = getGroundTruthHeaders(selectedNodeId);
    if (runColumns.length === 0 || gtHeaders.length === 0) return;
    const rules = getRules();
    rules.push({
      outputKey: runColumns[0].key || '',
      gtColumns: gtHeaders[0] ? [gtHeaders[0]] : [],
      matchType: MATCH_TYPE_STRICT.value,
    });
    setRules(rules);
    renderRules();
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
    emptyOption.innerHTML = '<span class="run-detail-ws-option-color run-detail-ws-option-color--empty"></span><span class="run-detail-ws-option-text">— Select working dataset —</span>';
    emptyOption.dataset.nodeId = '';
    emptyOption.addEventListener('click', () => selectGroundTruth(''));
    dropdownEl.appendChild(emptyOption);
    workingSets.forEach((ws) => {
      const option = document.createElement('div');
      option.className = 'run-detail-ws-option';
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', ws.nodeId === selectedNodeId ? 'true' : 'false');
      option.innerHTML = `<span class="run-detail-ws-option-color" style="background:${escapeHtml(ws.color || 'transparent')}"></span><span class="run-detail-ws-option-text">${escapeHtml(ws.name || 'Working dataset')}</span>`;
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
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  updateTriggerDisplay();
  updateScoreNodeBorder();
  renderRules();
  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);
}
