/**
 * Review: left = prompt in prompt-detail style; right = suggestions.
 * Hover a suggestion: left shows that section with red (removed) / green (added) minimal diff.
 * Result is saved on the Score node and persisted with the project.
 */

import { showConfirm } from './alertModal.js';
import {
  runSuggestionOptimizationCompositional,
  registerOptimizationSession,
  unregisterOptimizationSession,
  hasActiveOptimizationSessions,
} from './reviewSuggestionOptimization.js';
import { comparisonRowIsMatched } from './scoreDetailModal.js';
import {
  rebuildWorkingFromApplied,
  getLocatableSegment,
  findSectionIndexForOldSentence,
  effectiveNewSentenceForApply,
  suggestionTargetScoreRowIndices,
} from './reviewWorkingSections.js';
import { normalizeUnicodeDashesForDisplay } from './displayTextNormalize.js';
import { attachModalPaneToggle } from './paneToggleButton.js';
import {
  ensureReviewResultIds,
  ensureSuggestionObjectId,
  formatSuggestionIdDisplay,
  parseNumericSuggestionId,
} from './reviewSuggestionIds.js';
import { BACKEND_API_BASE } from './backendConfig.js';
import { evaluateScoreOutputGt } from './scoreOutputGtMatcher.js';

const API_BASE = BACKEND_API_BASE;

/** Module-level verify state so verification survives review modal close/reopen.
 *  Keys are `reviewNodeId:sugIdx`. */
const _verifyStates = new Map();   // → 'idle' | 'verifying'
const _verifyResults = new Map();  // → result object | null
const _verifyPromises = new Map(); // → in-flight Promise | undefined

/** Review node progress reaches 100% when the stream ends (workflowCanvas). */

/** Placeholder pill only; verify/optimization flows removed pending redesign. */
const REVIEW_SUGGESTION_CLICK_VERIFY_LABEL = 'Click to Verify';
const REVIEW_SUGGESTION_VERIFYING_LABEL = 'Verifying\u2026';
const REVIEW_SUGGESTION_VERIFIED_LABEL = 'Verified';
const REVIEW_SUGGESTION_OPTIMIZATION_LABEL = 'Click to Optimize';
const REVIEW_SUGGESTION_OPTIMIZING_LABEL = 'Optimizing\u2026';
const REVIEW_SUGGESTION_OPTIMIZED_LABEL = 'Optimized';

const REVIEW_SUGGESTION_TITLE_PILL_CLASS = 'review-suggestion-title-pill';

/** Returns true when all verify rows matched their GT rows and there were no errors. */
function isVerifyFullPass(result) {
  if (!result || result.status !== 'complete') return false;
  const rows = result.verifyRows;
  if (!Array.isArray(rows) || rows.length === 0) return false;
  return rows.every((r) => r.matched === true && !r.error);
}

/**
 * Returns pill specs for the suggestion title line.
 * @param {string} [verifyState] - 'idle' | 'verifying' | 'verified' | 'optimization'
 */
function collectSuggestionTitlePills(_sug, _noButton, _actionsFull, _originals, _promptSections, streamComplete, verifyState) {
  if (streamComplete !== true) return [];
  if (verifyState === 'verifying') {
    return [{ cls: 'review-suggestion-verifying-pill', text: REVIEW_SUGGESTION_VERIFYING_LABEL, ariaLabel: 'Verifying…' }];
  }
  if (verifyState === 'verified') {
    return [{ cls: 'review-suggestion-verified-pill', text: REVIEW_SUGGESTION_VERIFIED_LABEL, ariaLabel: 'All outputs matched ground truth' }];
  }
  if (verifyState === 'optimization') {
    return [{ cls: 'review-suggestion-optimization-pill review-suggestion-optimization-pill--clickable', text: REVIEW_SUGGESTION_OPTIMIZATION_LABEL, ariaLabel: 'Some outputs did not match — click to optimize' }];
  }
  if (verifyState === 'optimizing') {
    return [{ cls: 'review-suggestion-optimizing-pill', text: REVIEW_SUGGESTION_OPTIMIZING_LABEL, ariaLabel: 'Optimization in progress…' }];
  }
  if (verifyState === 'optimized') {
    return [{ cls: 'review-suggestion-optimized-pill', text: REVIEW_SUGGESTION_OPTIMIZED_LABEL, ariaLabel: 'Optimization complete — some outputs still differ from ground truth' }];
  }
  if (verifyState === 'optimized-pass') {
    return [{ cls: 'review-suggestion-optimized-pass-pill', text: REVIEW_SUGGESTION_OPTIMIZED_LABEL, ariaLabel: 'Optimization complete — all outputs matched ground truth' }];
  }
  return [{ cls: 'review-suggestion-verify-pill review-suggestion-verify-pill--clickable', text: REVIEW_SUGGESTION_CLICK_VERIFY_LABEL, ariaLabel: 'Click to Verify this suggestion' }];
}

function buildSuggestionTitlePillsHtml(sug, noButton, actionsFull, originals, promptSections, streamComplete, verifyState) {
  return collectSuggestionTitlePills(sug, noButton, actionsFull, originals, promptSections, streamComplete, verifyState)
    .map((spec) => {
      const aria =
        typeof spec.ariaLabel === 'string' && spec.ariaLabel.trim()
          ? ` aria-label="${escapeHtml(spec.ariaLabel)}"`
          : '';
      return `<span class="${spec.cls} ${REVIEW_SUGGESTION_TITLE_PILL_CLASS}"${aria}>${escapeHtml(spec.text)}</span>`;
    })
    .join('');
}

/** Shown when persisted review has streamComplete:false but no live job (e.g. app closed mid-review). Mirrors Run: “Last run did not complete.” */
const REVIEW_INCOMPLETE_USER_MSG = 'Last review did not complete. Please run Review again.';

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = normalizeUnicodeDashesForDisplay(String(str ?? ''));
  return div.innerHTML;
}

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build the inner HTML for the "Verify results" section of the debug overlay.
 * verifyResult: null | { status: 'running' }
 *             | { status: 'complete', verifyRows: [{inputNum, output, error}] }
 *             | { status: 'error', message: string }
 */
function buildVerifySectionHtml(verifyResult) {
  if (!verifyResult) return '';

  if (verifyResult.status === 'running') {
    return `<p class="review-verify-status-running">\u23f3 Running\u2026</p>`;
  }

  if (verifyResult.status === 'error') {
    return `<p class="review-verify-status-error">\u26a0 ${escapeHtml(verifyResult.message || 'Unknown error')}</p>`;
  }

  if (verifyResult.status === 'complete') {
    const rows = verifyResult.verifyRows || [];
    if (rows.length === 0) return `<p class="review-verify-status-empty">No results.</p>`;

    // Collect GT field names (only GT keys that exist), and output field names
    const gtFieldNames = [...new Set(rows.flatMap((r) => (r.gt ? Object.keys(r.gt) : [])))];
    const outFieldNames = [...new Set(rows.flatMap((r) => (r.output ? Object.keys(r.output) : [])))];
    // Show output fields; for each GT field show its expected value in a separate "GT: field" column
    const hasMatch = rows.some((r) => r.matched !== null && r.matched !== undefined);
    const headerCells = [
      ...outFieldNames.map((f) => `<th>${escapeHtml(f)}</th>`),
      ...gtFieldNames.map((f) => `<th class="review-verify-cell-gt-header">GT: ${escapeHtml(f)}</th>`),
      ...(hasMatch ? ['<th>Match</th>'] : []),
    ].join('');
    const bodyRows = rows.map((row) => {
      if (row.error) {
        const span = outFieldNames.length + gtFieldNames.length + (hasMatch ? 1 : 0) || 1;
        return `<tr class="review-verify-row-error">
          <td colspan="${span}" class="review-verify-error-cell">${escapeHtml(row.error)}</td>
        </tr>`;
      }
      const outCells = outFieldNames.map(
        (f) => `<td class="review-verify-cell-output">${escapeHtml(String(row.output?.[f] ?? ''))}</td>`,
      );
      const gtCells = gtFieldNames.map(
        (f) => `<td class="review-verify-cell-gt">${escapeHtml(String(row.gt?.[f] ?? '—'))}</td>`,
      );
      const matchCell = hasMatch
        ? (row.matched === null
          ? '<td>—</td>'
          : row.matched
            ? '<td><span class="review-debug-pass-badge">\u2714</span></td>'
            : '<td><span class="review-debug-fail-badge">\u2718</span></td>')
        : '';
      return `<tr>${outCells.join('')}${gtCells.join('')}${matchCell}</tr>`;
    }).join('');

    return `<table class="review-suggestion-debug-table review-verify-results-table">
      <thead><tr>${headerCells}</tr></thead>
      <tbody>${bodyRows}</tbody>
    </table>`;
  }

  return '';
}

const DIAG_LIST_PREVIEW_CHARS = 200;

function truncateWithEllipsis(text, maxChars) {
  const t = normalizeUnicodeDashesForDisplay(String(text ?? '')).trim();
  if (!t) return '';
  if (t.length <= maxChars) return t;
  return `${t.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

/**
 * Uppercase the first Unicode letter in a short title (skip leading punctuation/digits).
 * Keeps LLM/phrases like "cross-check …" consistent in the Findings cards.
 */
function ensureCardTitleSentenceLead(text) {
  const s = normalizeUnicodeDashesForDisplay(String(text ?? ''));
  if (!s.trim()) return s;
  const chars = Array.from(s);
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    const lower = c.toLowerCase();
    const upper = c.toUpperCase();
    if (upper !== lower) {
      if (c !== upper) chars[i] = upper;
      break;
    }
  }
  return chars.join('');
}

/** 0-based run/comparison row_index → 1-based label (same as Score table “Run result #”). */
function formatRunRowIndexForDisplay(zeroBased) {
  const n = Number(zeroBased);
  if (zeroBased === null || zeroBased === undefined || zeroBased === '' || Number.isNaN(n) || n < 0) return '—';
  return String(n + 1);
}

/** 1-based Score table position from saved comparison row when `score_table_row` is set. */
function scoreTableRowNumberForComparisonIndex(comparisonRows, rowIndex) {
  const rows = Array.isArray(comparisonRows) ? comparisonRows : [];
  const r = rows.find((x) => Number(x?.row_index) === Number(rowIndex));
  const n = r && r.score_table_row != null ? Number(r.score_table_row) : NaN;
  if (Number.isFinite(n) && n >= 1) return n;
  return null;
}

/**
 * Labels like "#1, #2" for target comparison `row_index` values (uses `score_table_row` when present).
 * Sorted by Score table # (`score_table_row`) so display reads e.g. "#5, #6, #7, #8" not "#5, #7, #6, #8".
 */
function formatScoreTableTargetLabels(comparisonRows, zeroBasedRowIndices) {
  if (!Array.isArray(zeroBasedRowIndices) || zeroBasedRowIndices.length === 0) return '';
  const seen = new Set();
  const pairs = [];
  for (const raw of zeroBasedRowIndices) {
    const idx = Number(raw);
    if (Number.isNaN(idx) || idx < 0 || seen.has(idx)) continue;
    seen.add(idx);
    const scoreNum = scoreTableRowNumberForComparisonIndex(comparisonRows, idx);
    pairs.push({ idx, scoreNum });
  }
  pairs.sort((a, b) => {
    const aOk = a.scoreNum != null;
    const bOk = b.scoreNum != null;
    if (aOk && bOk) return a.scoreNum - b.scoreNum;
    if (aOk && !bOk) return -1;
    if (!aOk && bOk) return 1;
    return a.idx - b.idx;
  });
  return pairs
    .map(({ idx, scoreNum }) => (scoreNum != null ? `#${scoreNum}` : `(row_index ${idx})`))
    .join(', ');
}

/** 1-based worksheet input # from persisted diagnosis (`input_index` only). */
function diagnosisInputOneBased(diagnostic) {
  if (!diagnostic || typeof diagnostic !== 'object') return NaN;
  const i = Number(diagnostic.input_index);
  return !Number.isNaN(i) && i >= 1 ? i : NaN;
}

/** 0-based comparison row indices from `row_indices` (Score table). */
function diagnosticComparisonRowIndices(diagnostic) {
  const raw = Array.isArray(diagnostic?.row_indices) ? diagnostic.row_indices : [];
  return raw.map((x) => parseInt(x, 10)).filter((x) => !Number.isNaN(x));
}

/** Normalize saved Issue analysis row; invalid entries are dropped. */
function normalizeRowDiagnosticFromSaved(d) {
  if (!d || typeof d !== 'object') return null;
  const input_index = Number(d.input_index);
  if (Number.isNaN(input_index) || input_index < 1) return null;
  const row_indices = Array.isArray(d.row_indices)
    ? d.row_indices.map((x) => Number(x)).filter((x) => !Number.isNaN(x))
    : [];
  return {
    input_index,
    row_indices,
    card_title: String(d.card_title || ''),
    issue_summary: String(d.issue_summary || ''),
    rough_modification_opinion: String(d.rough_modification_opinion || ''),
    problem_category_hint: String(d.problem_category_hint || ''),
    gt_suspect_note: String(d.gt_suspect_note || ''),
  };
}

/** Turn snake_case category hints into a short phrase (not a “variable”). */
function humanizeSnakeCaseHint(hint) {
  const h = String(hint || '').trim();
  if (!h) return '';
  return h
    .split(/_+/)
    .filter(Boolean)
    .map((w) => {
      const lower = w.toLowerCase();
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');
}

/** First sentence or line of issue_summary as a suggestion-style title (short sentence). */
function shortSentenceTitleFromSummary(summary, maxLen = 88) {
  let t = normalizeUnicodeDashesForDisplay(String(summary || '')).trim();
  if (!t) return '';
  const firstLine = t.split(/\r?\n/)[0].trim();
  t = firstLine;
  const sentMatch = t.match(/^.{1,200}?[.!?](?=\s|$)/);
  if (sentMatch && sentMatch[0].length <= maxLen + 24) {
    t = sentMatch[0].trim();
  }
  if (t.length > maxLen) {
    let cut = t.slice(0, maxLen - 1).trimEnd();
    const sp = cut.lastIndexOf(' ');
    if (sp >= Math.floor(maxLen * 0.45)) cut = cut.slice(0, sp);
    t = `${cut}…`;
  }
  return t;
}

function diagnosisCardTitleLine(d) {
  const fromLlm = (d.card_title || '').trim();
  if (fromLlm) return ensureCardTitleSentenceLead(truncateWithEllipsis(fromLlm, 100));
  const fromIssue = shortSentenceTitleFromSummary(d.issue_summary, 88);
  if (fromIssue) return ensureCardTitleSentenceLead(fromIssue);
  const fromHint = humanizeSnakeCaseHint(d.problem_category_hint);
  if (fromHint) return ensureCardTitleSentenceLead(fromHint);
  const fromRough = truncateWithEllipsis(d.rough_modification_opinion, 88);
  if (fromRough) return ensureCardTitleSentenceLead(fromRough);
  return ensureCardTitleSentenceLead('Issue analysis');
}

/** Short sentence-style card title for Suggested changes (mirrors diagnosis list line). */
function suggestionCardTitleLine({ explicitName, reason, sectionFallback, defaultLabel }) {
  const fromName = String(explicitName || '').trim();
  if (fromName) {
    const sentence = shortSentenceTitleFromSummary(fromName, 100) || fromName;
    return ensureCardTitleSentenceLead(truncateWithEllipsis(sentence, 100));
  }
  const fromReason = shortSentenceTitleFromSummary(reason, 88);
  if (fromReason) return ensureCardTitleSentenceLead(fromReason);
  const sec = String(sectionFallback || '').trim();
  if (sec) return ensureCardTitleSentenceLead(truncateWithEllipsis(sec, 88));
  return ensureCardTitleSentenceLead(defaultLabel);
}

/**
 * Second-layer modal: analysis text only + which Score comparison row this refers to.
 * @param {{ input_index: number, row_indices?: number[], card_title?: string, issue_summary: string, rough_modification_opinion: string, problem_category_hint?: string }} diagnostic
 * @param {Array<Record<string, unknown>>} comparisonRows - saved comparison rows (for score_table_row lookup)
 * @param {number} displayNumber - 1-based order in the Issue analysis list (same as # on the card)
 */
function openRowDiagnosisDetailOverlay(diagnostic, comparisonRows, displayNumber) {
  const num = Math.max(1, parseInt(String(displayNumber), 10) || 1);
  const issue = (diagnostic.issue_summary || '').trim();
  const rough = (diagnostic.rough_modification_opinion || '').trim();
  const cardTitle = (diagnostic.card_title || '').trim();
  const gtNote = (diagnostic.gt_suspect_note || '').trim();
  const rows = Array.isArray(comparisonRows) ? comparisonRows : [];
  const compIdxs = diagnosticComparisonRowIndices(diagnostic);
  const multiIdx = compIdxs.length > 1 ? compIdxs : null;
  const sourceLine = multiIdx
    ? `Score table ${formatScoreTableTargetLabels(rows, multiIdx)}`
    : (() => {
      const anchor = compIdxs[0];
      if (anchor === undefined) {
        const inp = diagnosisInputOneBased(diagnostic);
        return !Number.isNaN(inp) && inp >= 1 ? `Worksheet input #${inp}` : 'Score comparison (unknown row)';
      }
      const t = scoreTableRowNumberForComparisonIndex(rows, anchor);
      return t != null
        ? `Score table #${t}`
        : `Score comparison (row_index ${anchor})`;
    })();

  const mainHeading = ensureCardTitleSentenceLead(cardTitle || `Analysis #${num}`);

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay review-diagnosis-detail-overlay';
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'review-diagnosis-detail-title');
  overlay.innerHTML = `
    <div class="modal-panel modal-panel--review-diagnosis-detail">
      <div class="modal-header">
        <h2 id="review-diagnosis-detail-title" class="modal-title">${escapeHtml(mainHeading)}</h2>
        <button type="button" class="modal-close" aria-label="Close">×</button>
      </div>
      <div class="modal-body review-diagnosis-detail-body">
        <p class="review-diagnosis-detail-prose"><span class="review-diagnosis-detail-lead">Source:</span> ${escapeHtml(sourceLine)}</p>
        <p class="review-diagnosis-detail-prose"><span class="review-diagnosis-detail-lead">Issue:</span> ${issue ? escapeHtml(issue) : '<span class="review-diagnosis-detail-empty">(none)</span>'}</p>
        <p class="review-diagnosis-detail-prose"><span class="review-diagnosis-detail-lead">Suggested direction:</span> ${rough ? escapeHtml(rough) : '<span class="review-diagnosis-detail-empty">(none)</span>'}</p>
        ${gtNote ? `<p class="review-diagnosis-detail-prose review-diagnosis-gt-suspect"><span class="review-diagnosis-detail-lead review-diagnosis-gt-suspect__lead">⚠ Possible ground truth issue:</span> ${escapeHtml(gtNote)}</p>` : ''}
      </div>
    </div>
  `;

  function close() {
    overlay.remove();
  }

  overlay.querySelector('.modal-close').addEventListener('click', close);
  document.body.appendChild(overlay);
}

const SUGGESTION_CARD_PREVIEW_TITLE_CHARS = 100;
const SUGGESTION_CARD_PREVIEW_REASON_CHARS = 220;

/**
 * Full text for a prompt-edit suggestion (focus + rationale; diff on prompt hover / Accept).
 * Assistant proposals: Focus line (score table + optional `chat_focus`) + `chat_focus_bullets` + Rationale. Pipeline: phase1 + score + Rationale.
 * @param {Record<string, unknown>} sug
 * @param {{ titleLine: string, comparisonRows?: Array<Record<string, unknown>> }} meta
 */
function openPromptEditSuggestionDetailOverlay(sug, meta) {
  const heading = String(meta.titleLine || '').trim() || 'Suggestion';
  const reason = String(sug.reason || '').trim();
  const inputIdx = suggestionTargetScoreRowIndices(sug);
  const compRows = Array.isArray(meta?.comparisonRows) ? meta.comparisonRows : [];
  const scoreLbl = formatScoreTableTargetLabels(compRows, inputIdx);
  const scorePhrase = scoreLbl !== '' ? `Score table ${scoreLbl}` : '';
  const p1 = Array.isArray(sug.phase1_addresses)
    ? sug.phase1_addresses.map((x) => String(x || '').trim()).filter(Boolean)
    : [];
  const respondsToHead =
    scorePhrase !== ''
      ? `<span class="review-diagnosis-detail-lead">Focus:</span> ${escapeHtml(scorePhrase)}`
      : `<span class="review-diagnosis-detail-lead">Focus:</span>`;
  const respondsToHtml = p1.length
    ? `<p class="review-diagnosis-detail-prose">${respondsToHead}</p><ul class="review-suggestion-detail-list">${p1.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>`
    : `<p class="review-diagnosis-detail-prose">${respondsToHead} <span class="review-diagnosis-detail-empty">(none)</span></p>`;
  const detailBodyHtml =
    respondsToHtml +
    `<p class="review-diagnosis-detail-prose"><span class="review-diagnosis-detail-lead">Rationale:</span> ${reason ? escapeHtml(reason) : '<span class="review-diagnosis-detail-empty">(none)</span>'}</p>`;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay review-suggestion-detail-overlay';
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'review-suggestion-detail-title');
  overlay.innerHTML = `
    <div class="modal-panel modal-panel--review-diagnosis-detail">
      <div class="modal-header">
        <h2 id="review-suggestion-detail-title" class="modal-title">${escapeHtml(ensureCardTitleSentenceLead(heading))}</h2>
        <button type="button" class="modal-close" aria-label="Close">×</button>
      </div>
      <div class="modal-body review-diagnosis-detail-body">
        ${detailBodyHtml}
      </div>
    </div>
  `;

  function close() {
    overlay.remove();
  }
  overlay.querySelector('.modal-close').addEventListener('click', close);
  document.body.appendChild(overlay);
}

/** Render a key-value object as a definition list for the debug overlay. */
/** Mirror of Python _is_model_facing_output_key: skip internal keys like #, [#], [rule_targets]. */
function isModelFacingKey(k) {
  const key = String(k || '').trim();
  if (!key || key === '#' || key === '[#]') return false;
  if (key.length >= 2 && key.startsWith('[') && key.endsWith(']')) return false;
  return true;
}

function debugKvHtml(obj) {
  if (!obj || typeof obj !== 'object') return '<span class="review-diagnosis-detail-empty">—</span>';
  const pairs = Object.entries(obj).filter(([k]) => isModelFacingKey(k));
  if (pairs.length === 0) return '<span class="review-diagnosis-detail-empty">—</span>';
  const MAX = 480;
  const cellHtml = (raw) => {
    if (raw == null || raw === '') return '<span class="review-diagnosis-detail-empty">—</span>';
    let s = typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
    s = s.replace(/\s+/g, ' ').trim();
    if (!s) return '<span class="review-diagnosis-detail-empty">—</span>';
    if (s.length > MAX) return `<span title="${escapeHtml(s)}">${escapeHtml(s.slice(0, MAX))}\u2026</span>`;
    return escapeHtml(s);
  };
  return `<dl class="review-suggestion-debug-kv">${pairs.map(([k, v]) =>
    `<div class="review-suggestion-debug-kv-pair"><dt>${escapeHtml(k)}</dt><dd>${cellHtml(v)}</dd></div>`
  ).join('')}</dl>`;
}

/**
 * Debug overlay: shows per-suggestion run info.
 * @param {object} sug
 * @param {{ inputNums: string, gtNums: string, scoreNums: string, targetRows: any[] } | null} [debugData]
 * @param {{ status: 'running'|'complete'|'error', ... } | null} [verifyResult]
 */
function openSuggestionDebugOverlay(sug, debugData, verifyResult = null) {
  const sid = sug && sug.suggestion_id != null ? String(sug.suggestion_id) : '(no id)';

  // If the overlay for this suggestion is already open and we only need to update the verify section, do it in-place.
  const existing = document.querySelector('.review-suggestion-debug-overlay');
  if (existing && existing.dataset.suggestionId === String(sid) && verifyResult !== null) {
    const verifySection = existing.querySelector('.review-suggest-verify-section');
    if (verifySection) {
      verifySection.innerHTML = buildVerifySectionHtml(verifyResult);
      return;
    }
  }

  let bodyHtml;
  if (debugData) {
    // Summary row
    const optimizationInputCell = debugData.optimizationInputNums
      ? escapeHtml(debugData.optimizationInputNums) + (debugData.optimizationExtraInputNums ? ` <span style="opacity:0.6">(extra: ${escapeHtml(debugData.optimizationExtraInputNums)})</span>` : '')
      : null;
    const summaryHtml = `
      <table class="review-suggestion-debug-table">
        <tbody>
          <tr><th scope="row">Input</th><td>${escapeHtml(debugData.inputNums)}</td></tr>
          <tr><th scope="row">Ground truth</th><td>${escapeHtml(debugData.gtNums)}</td></tr>
          <tr><th scope="row">Score table</th><td>${escapeHtml(debugData.scoreNums)}</td></tr>
          ${optimizationInputCell ? `<tr><th scope="row">Optimization inputs</th><td>${optimizationInputCell}</td></tr>` : ''}
          ${debugData.optimizationGtNums ? `<tr><th scope="row">Optimization GT</th><td>${escapeHtml(debugData.optimizationGtNums)}</td></tr>` : ''}
        </tbody>
      </table>`;

    // Input sub-tables: one block per unique input_row_index; first non-empty row_input
    const seenInput = new Map();
    for (const r of (debugData.targetRows || [])) {
      const key = r.input_row_index != null ? r.input_row_index : null;
      if (key !== null && !seenInput.has(key) && r.row_input && typeof r.row_input === 'object' && Object.keys(r.row_input).length > 0) {
        seenInput.set(key, r.row_input);
      }
    }
    const inputBlocksHtml = seenInput.size > 0
      ? [...seenInput.entries()]
          .sort(([a], [b]) => a - b)
          .map(([idx, rowInput]) =>
            `<section class="review-suggestion-debug-section">
              <h3 class="review-suggestion-debug-section-title">Input #${escapeHtml(String(idx + 1))}</h3>
              ${debugKvHtml(rowInput)}
            </section>`)
          .join('')
      : '<p class="review-diagnosis-detail-prose review-diagnosis-detail-empty">No input data.</p>';

    // Ground truth sub-tables: deduplicated by source_gt_row_index; same key filter as pipeline
    const seenGt = new Map();
    for (const r of (debugData.targetRows || [])) {
      const gtNum = r.source_gt_row_index != null ? r.source_gt_row_index + 1 : null;
      if (gtNum !== null && !seenGt.has(gtNum) && r.ground_truth_output && typeof r.ground_truth_output === 'object') {
        const filtered = Object.fromEntries(Object.entries(r.ground_truth_output).filter(([k]) => isModelFacingKey(k)));
        if (Object.keys(filtered).length > 0) seenGt.set(gtNum, filtered);
      }
    }
    const gtBlocksHtml = seenGt.size > 0
      ? [...seenGt.entries()].sort(([a], [b]) => a - b).map(([gtNum, gto]) =>
          `<section class="review-suggestion-debug-section">
            <h3 class="review-suggestion-debug-section-title">Ground truth #${escapeHtml(String(gtNum))}</h3>
            ${debugKvHtml(gto)}
          </section>`)
          .join('')
      : '<p class="review-diagnosis-detail-prose review-diagnosis-detail-empty">No ground truth data.</p>';

    const verifyHtml = `<h2 class="review-suggestion-debug-group-title">Verify results</h2>
      <div class="review-suggest-verify-section">${buildVerifySectionHtml(verifyResult)}</div>`;

    bodyHtml = summaryHtml +
      `<h2 class="review-suggestion-debug-group-title">Input</h2>${inputBlocksHtml}` +
      `<h2 class="review-suggestion-debug-group-title">Ground truth</h2>${gtBlocksHtml}` +
      verifyHtml;
  } else {
    bodyHtml = '<p class="review-diagnosis-detail-prose review-diagnosis-detail-empty">(Run information will appear here.)</p>';
  }

  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay review-suggestion-detail-overlay review-suggestion-debug-overlay';
  overlay.dataset.suggestionId = String(sid);
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'review-suggestion-debug-title');
  overlay.innerHTML = `
    <div class="modal-panel modal-panel--review-diagnosis-detail">
      <div class="modal-header">
        <h2 id="review-suggestion-debug-title" class="modal-title">Debug info – #${escapeHtml(sid)}</h2>
        <button type="button" class="modal-close" aria-label="Close">×</button>
      </div>
      <div class="modal-body review-diagnosis-detail-body review-suggestion-debug-body">
        ${bodyHtml}
      </div>
    </div>
  `;
  overlay.querySelector('.modal-close').addEventListener('click', () => overlay.remove());
  document.body.appendChild(overlay);
}

/** Truncated title line for suggestion cards. */
function formatSuggestionCardPreviewTitle(titleLine) {
  const baseRaw = normalizeUnicodeDashesForDisplay(String(titleLine ?? ''));
  return truncateWithEllipsis(baseRaw, SUGGESTION_CARD_PREVIEW_TITLE_CHARS);
}

function sectionsToFullText(sections) {
  if (!Array.isArray(sections) || sections.length === 0) return '';
  return sections
    .map((s) => {
      const name = (s.name || '').trim() || '(unnamed)';
      const content = (s.content || '').trim() || '';
      return `## ${name}\n\n${content}`;
    })
    .join('\n\n');
}

/** Split text into sentences (by . ! ? followed by space or newline). */
function splitSentences(str) {
  if (str == null || typeof str !== 'string') return [];
  const s = str.trim();
  if (!s) return [];
  return s.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean);
}

/** Sentence-level diff. Returns [{ type: 'equal'|'remove'|'add', text }] with full sentence in each segment. */
function sentenceDiff(oldStr, newStr) {
  const a = splitSentences(oldStr);
  const b = splitSentences(newStr);
  const n = a.length;
  const m = b.length;
  const dp = Array(n + 1).fill(null).map(() => Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const segments = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      segments.push({ type: 'equal', text: a[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      segments.push({ type: 'add', text: b[j - 1] });
      j--;
    } else if (i > 0) {
      segments.push({ type: 'remove', text: a[i - 1] });
      i--;
    }
  }
  segments.reverse();
  return segments;
}

/** Render a single line with sentence-level diff (red/green only, no structure change).
 * @param {boolean} revertPreview — true when hovering Revert: show green strikethrough for text being removed (new) and red for restored (old). */
function renderLineDiff(oldLine, newLine, revertPreview = false) {
  if (oldLine === newLine) return escapeHtml(oldLine || '');
  if (!newLine) {
    return revertPreview
      ? `<span class="review-revert-remove">${escapeHtml(oldLine)}</span>`
      : `<span class="review-removed">${escapeHtml(oldLine)}</span>`;
  }
  const segments = sentenceDiff(oldLine, newLine);
  return segments.map((seg) => {
    if (seg.type === 'equal') return escapeHtml(seg.text);
    if (revertPreview) {
      if (seg.type === 'remove') return `<span class="review-revert-remove">${escapeHtml(seg.text)}</span>`;
      return `<span class="review-revert-restore">${escapeHtml(seg.text)}</span>`;
    }
    if (seg.type === 'remove') return `<span class="review-removed">${escapeHtml(seg.text)}</span>`;
    return `<span class="review-added">${escapeHtml(seg.text)}</span>`;
  }).join(' ');
}

/** Render one section's content, optionally with diff or highlight. Preserves line breaks (one div per line). */
function renderSectionContent(content, newContent, withDiff, removeSpan, highlightSpan, highlightAsRemoved, highlightAddSpan, revertPreview = false) {
  const oldC = (content || '').trim();
  const oldLines = oldC.split('\n');
  const newC = (newContent || '').trim();
  const newLines = newC.split('\n');

  if (highlightSpan != null && (highlightSpan = (highlightSpan || '').trim())) {
    let spanToUse = oldC.includes(highlightSpan) ? highlightSpan : (getLocatableSegment(oldC, highlightSpan) || highlightSpan);
    if (spanToUse && oldC.includes(spanToUse)) {
      const spanStart = oldC.indexOf(spanToUse);
      const spanEnd = spanStart + spanToUse.length;
      const cssClass = highlightAsRemoved ? 'review-removed' : 'review-added';
      const greenPart = (highlightAddSpan != null && (highlightAddSpan = (highlightAddSpan || '').trim()))
        ? `<span class="review-added">${escapeHtml(highlightAddSpan)}</span>`
        : '';
      let offset = 0;
      const lineHtmls = oldLines.map((line) => {
        const lineStart = offset;
        const lineEnd = offset + line.length;
        offset = lineEnd + 1;
        if (spanEnd <= lineStart || spanStart >= lineEnd) {
          return escapeHtml(line);
        }
        const startInLine = Math.max(0, spanStart - lineStart);
        const endInLine = Math.min(line.length, spanEnd - lineStart);
        const before = line.slice(0, startInLine);
        const span = line.slice(startInLine, endInLine);
        const after = line.slice(endInLine);
        const isLastLineOfSpan = spanEnd <= lineEnd;
        return escapeHtml(before) + `<span class="${cssClass}">${escapeHtml(span)}</span>` + (isLastLineOfSpan ? greenPart : '') + escapeHtml(after);
      });
      return lineHtmls.map((html) => `<div class="preview-field-content-line">${html}</div>`).join('');
    }
  }

  if (!withDiff) {
    return oldLines.length > 0
      ? oldLines.map((line) => `<div class="preview-field-content-line">${escapeHtml(line)}</div>`).join('')
      : '<div class="preview-field-content-line"></div>';
  }
  if (removeSpan != null && (removeSpan = (removeSpan || '').trim()) && oldC.includes(removeSpan)) {
    const idx = oldC.indexOf(removeSpan);
    const rmCls = revertPreview ? 'review-revert-remove' : 'review-removed';
    let offset = 0;
    const lineHtmls = oldLines.map((line) => {
      const lineStart = offset;
      const lineEnd = offset + line.length;
      offset = lineEnd + 1;
      if (idx >= lineEnd || idx + removeSpan.length <= lineStart) return escapeHtml(line);
      const startInLine = Math.max(0, idx - lineStart);
      const endInLine = Math.min(line.length, idx + removeSpan.length - lineStart);
      const before = line.slice(0, startInLine);
      const span = line.slice(startInLine, endInLine);
      const after = line.slice(endInLine);
      return escapeHtml(before) + `<span class="${rmCls}">${escapeHtml(span)}</span>` + escapeHtml(after);
    });
    return lineHtmls.map((html) => `<div class="preview-field-content-line">${html}</div>`).join('');
  }
  if (oldC === newC) {
    return oldLines.length > 0
      ? oldLines.map((line) => `<div class="preview-field-content-line">${escapeHtml(line)}</div>`).join('')
      : '<div class="preview-field-content-line"></div>';
  }
  if (newC === '') {
    const delCls = revertPreview ? 'review-revert-remove' : 'review-removed';
    return oldLines.map((line) => `<div class="preview-field-content-line"><span class="${delCls}">${escapeHtml(line)}</span></div>`).join('');
  }
  const numLines = Math.max(oldLines.length, newLines.length);
  const lineHtmls = [];
  for (let i = 0; i < numLines; i++) {
    const oldLine = oldLines[i] || '';
    const newLine = newLines[i] || '';
    lineHtmls.push(renderLineDiff(oldLine, newLine, revertPreview));
  }
  return lineHtmls.map((html) => `<div class="preview-field-content-line">${html}</div>`).join('');
}

/** Render sections: optionally diff or highlight one section. highlightSpan/highlightAsRemoved: Revert state; highlightAddSpan: green text to show after red (what will be restored). */
function renderSectionsAsPromptDetail(sections, diffSectionIndex, diffNewContent, removeSpan, highlightSpan, highlightAsRemoved, highlightAddSpan, revertPreview = false) {
  if (!Array.isArray(sections) || sections.length === 0) return '<p class="prompt-detail-placeholder">No sections.</p>';
  return sections.map((s, i) => {
    const name = (s.name || '').trim() || 'Unnamed';
    const content = s.content || '';
    const isTargetSection = diffSectionIndex === i;
    const useHighlightOnly = isTargetSection && highlightSpan !== undefined && highlightSpan !== null;
    const withDiff = isTargetSection && !useHighlightOnly && diffNewContent !== undefined;
    let contentHtml;
    if (useHighlightOnly || withDiff) {
      contentHtml = renderSectionContent(content, withDiff ? diffNewContent : null, withDiff, removeSpan, highlightSpan, highlightAsRemoved, highlightAddSpan, isTargetSection && withDiff ? revertPreview : false);
    } else {
      const lines = content.split('\n');
      const lineEls = lines.length > 0
        ? lines.map((line) => `<div class="preview-field-content-line">${escapeHtml(line)}</div>`).join('')
        : '<div class="preview-field-content-line"></div>';
      contentHtml = lineEls;
    }
    return `
      <div class="preview-field-block">
        <div class="preview-field-divider">
          <span class="preview-field-line" aria-hidden="true"></span>
          <span class="preview-field-name">${escapeHtml(name)}</span>
          <span class="preview-field-line" aria-hidden="true"></span>
        </div>
        <div class="preview-field-content">${contentHtml}</div>
      </div>`;
  }).join('');
}

/** Spans used for suggestion hover / revert preview in the prompt column. */
const REVIEW_PROMPT_DIFF_MARK_SELECTOR =
  '.review-removed, .review-added, .review-revert-remove, .review-revert-restore';

/**
 * Review modal has nested overflow-y regions (.prompt-detail-sections-scroll + .review-detail-prompt-wrap).
 * scrollIntoView({ block: 'nearest' }) often leaves the actual diff marks off-screen; walk ancestors and adjust scrollTop.
 */
function scrollNestedToReveal(el, boundary) {
  if (!el || !boundary || !boundary.contains(el)) return;
  const margin = 16;
  for (let pass = 0; pass < 2; pass++) {
    let parent = el.parentElement;
    let adjusted = false;
    while (parent && parent !== boundary) {
      const st = getComputedStyle(parent);
      const oy = st.overflowY;
      const canY =
        (oy === 'auto' || oy === 'scroll') &&
        parent.scrollHeight > parent.clientHeight + 1;
      if (canY) {
        const er = el.getBoundingClientRect();
        const pr = parent.getBoundingClientRect();
        if (er.top < pr.top + margin) {
          parent.scrollTop += er.top - pr.top - margin;
          adjusted = true;
        } else if (er.bottom > pr.bottom - margin) {
          parent.scrollTop += er.bottom - pr.bottom + margin;
          adjusted = true;
        }
      }
      parent = parent.parentElement;
    }
    if (!adjusted) break;
  }
}

/** Build the shared result UI: left = sections (working copy), right = suggestions with accept/revert; full reason shown in card when selected. */
function buildReviewResultUI(overlay, options) {
  const {
    promptSections,
    suggestions: initialSuggestions,
    promptFullText,
    saved = {},
    onReviewResultChange,
    onExportNewPrompt,
    getIsReviewStreaming,
    getPayload,
    getReviewResult,
    reviewNodeId: reviewNodeIdOpt,
  } = options;
  const reviewNodeId = (reviewNodeIdOpt && String(reviewNodeIdOpt).trim()) || '';
  const promptWrap = overlay.querySelector('.review-detail-prompt-wrap');
  const suggestionsEl = overlay.querySelector('#review-detail-suggestions');
  const suggestionsFooterEl = overlay.querySelector('#review-detail-suggestions-footer');
  const diagnosisEl = overlay.querySelector('#review-detail-row-diagnostics');
  const analysisFooterEl = overlay.querySelector('#review-detail-analysis-footer');
  if (!promptWrap || !suggestionsEl) return;

  if (saved && typeof saved === 'object') {
    const idsAdded = ensureReviewResultIds(saved);
    if (idsAdded && typeof onReviewResultChange === 'function') {
      onReviewResultChange({ ...saved });
    }
  }

  const originals = (promptSections || []).map((s) => ({ name: s.name || '', content: (s.content || '').slice() }));
  const savedSuggestions = Array.isArray(saved.suggestions) ? saved.suggestions : [];
  const savedWorking = Array.isArray(saved.workingSections) && saved.workingSections.length === originals.length
    ? saved.workingSections.map((s) => ({ name: s.name || '', content: (s.content || '').slice() }))
    : null;
  const workingFromApplied = rebuildWorkingFromApplied(originals, savedSuggestions);
  /** Working copy: always kept in sync by recomputing from originals + suggestions where .applied === true */
  let working = savedWorking || (workingFromApplied && workingFromApplied.length === originals.length ? workingFromApplied : null) || originals.map((s) => ({ name: s.name, content: s.content }));
  let allSuggestions =
    Array.isArray(saved.suggestions) && saved.suggestions.length > 0
      ? saved.suggestions.slice()
      : (Array.isArray(initialSuggestions)
        ? initialSuggestions.slice().map((s) => (s && typeof s === 'object' ? ensureSuggestionObjectId({ ...s }, saved) : null)).filter(Boolean)
        : []);
  /** Data refinement: GT 质疑汇总 */
  let dataRefinement = Array.isArray(saved.data_refinement) ? saved.data_refinement.slice() : [];
  /** Phase 1 per-row LLM notes (persisted on review node) */
  let rowDiagnostics = Array.isArray(saved.row_diagnostics)
    ? saved.row_diagnostics.map((d) => normalizeRowDiagnosticFromSaved(d)).filter(Boolean)
    : [];
  rowDiagnostics.sort((a, b) => a.input_index - b.input_index);

  function isReviewStreamingNow() {
    return typeof getIsReviewStreaming === 'function' && getIsReviewStreaming();
  }

  const reviewStreaming = isReviewStreamingNow();
  const staleIncompletePersisted = saved.streamComplete === false && !reviewStreaming;
  const reviewStillGenerating = reviewStreaming;

  if (promptWrap) {
    promptWrap.innerHTML = renderSectionsAsPromptDetail(working);
  }

  suggestionsEl.innerHTML = '';
  const dataRefinementContainer = document.createElement('div');
  dataRefinementContainer.className = 'review-detail-data-refinement';
  suggestionsEl.appendChild(dataRefinementContainer);
  const editContainer = document.createElement('div');
  editContainer.className = 'review-detail-edit-suggestions';
  suggestionsEl.appendChild(editContainer);

  /** Click-to-pin: keep left-column diff visible without hover (Suggested changes cards only). */
  let previewSelectedSuggestionIndex = null;

  /** Compound key for module-level verify maps. */
  function verifyKey(sugIdx) { return `${reviewNodeId}:${sugIdx}`; }
  /** Per-card debug verify state: 'idle' (default) | 'verifying'. Key = sugIdx.
   *  Backed by module-level _verifyStates so state survives modal close/reopen. */
  const cardVerifyStates = {
    get: (si) => _verifyStates.get(verifyKey(si)) || 'idle',
    set: (si, v) => _verifyStates.set(verifyKey(si), v),
    delete: (si) => _verifyStates.delete(verifyKey(si)),
  };
  /** Per-card last verify result (null = never run). Key = sugIdx. */
  const cardVerifyResults = {
    get: (si) => _verifyResults.get(verifyKey(si)) ?? null,
    set: (si, v) => _verifyResults.set(verifyKey(si), v),
    delete: (si) => _verifyResults.delete(verifyKey(si)),
  };

  // Restore persisted verify states from saved review result (survives app restart)
  const _savedVerifyStates = (saved && typeof saved.verify_states === 'object' && saved.verify_states) ? saved.verify_states : {};
  const _savedVerifyResults = (saved && typeof saved.verify_results === 'object' && saved.verify_results) ? saved.verify_results : {};
  const savedSuggestionsForVerify = Array.isArray(saved.suggestions) ? saved.suggestions : [];
  savedSuggestionsForVerify.forEach((sug, si) => {
    const sid = sug && sug.suggestion_id != null ? String(sug.suggestion_id) : '';
    if (!sid) return;
    // Don't overwrite an in-flight state that's already tracked in memory.
    const currentSt = _verifyStates.get(verifyKey(si));
    const isInFlight = currentSt === 'verifying' || currentSt === 'finetuning';
    if (!isInFlight) {
      const st = _savedVerifyStates[sid];
      if (st && st !== 'idle') _verifyStates.set(verifyKey(si), st);
      const res = _savedVerifyResults[sid];
      if (res) _verifyResults.set(verifyKey(si), res);
    }
  });

  function updateSuggestionPreviewSelectionVisual() {
    editContainer.querySelectorAll('.review-detail-suggestion-card').forEach((c) => {
      const i = parseInt(c.dataset.suggestionIndex, 10);
      const on = !Number.isNaN(i) && previewSelectedSuggestionIndex === i;
      c.classList.toggle('review-detail-suggestion-card--preview-selected', on);
    });
  }

  function applyPinnedPreviewIfAny() {
    if (previewSelectedSuggestionIndex == null) return;
    const c = editContainer.querySelector(
      `.review-detail-suggestion-card[data-suggestion-index="${previewSelectedSuggestionIndex}"]`,
    );
    if (c && typeof c._reviewShowPreview === 'function') {
      c._reviewShowPreview();
    } else {
      previewSelectedSuggestionIndex = null;
      updateSuggestionPreviewSelectionVisual();
    }
  }

  function reconcileAllSuggestionsFromSavedData(data) {
    if (!data || !Array.isArray(data.suggestions)) return;
    for (let i = 0; i < allSuggestions.length; i++) {
      const loc = allSuggestions[i];
      if (!loc || typeof loc !== 'object') continue;
      const id = loc.suggestion_id;
      if (id == null || id === '') continue;
      const idStr = String(id);
      const r = data.suggestions.find((x) => x && String(x.suggestion_id) === idStr);
      if (r && typeof r === 'object') {
        Object.assign(loc, r);
      }
    }
  }

  function refreshAllEditSuggestionCardsVisuals() {
    let needFullRerender = false;
    editContainer.querySelectorAll('.review-detail-suggestion-card').forEach((card) => {
      const i = parseInt(card.dataset.suggestionIndex, 10);
      if (Number.isNaN(i) || !allSuggestions[i]) return;
      const s = allSuggestions[i];
      const actionsFull = suggestionActionsFullForCard(s);
      const isApplied = s.applied === true;
      const noButton = card.classList.contains('review-detail-suggestion-card--unlocatable');
      const shouldShowAccept = !noButton && (isApplied || actionsFull);
      const hasAccept = !!card.querySelector('.review-detail-accept-btn');
      if (shouldShowAccept !== hasAccept) needFullRerender = true;
    });
    if (needFullRerender) {
      renderEditSuggestionCards();
      updateSuggestionsFooter();
      return;
    }
    editContainer.querySelectorAll('.review-detail-suggestion-card').forEach((card) => {
      const i = parseInt(card.dataset.suggestionIndex, 10);
      if (Number.isNaN(i) || !allSuggestions[i]) return;
      const s = allSuggestions[i];
      updateSuggestionTestOutcomeVisual(card, s, suggestionActionsFullForCard(s), originals, promptSections);
      const acceptBtn = card.querySelector('.review-detail-accept-btn');
      if (acceptBtn) {
        const applied = s.applied === true;
        acceptBtn.textContent = applied ? 'Revert' : 'Accept';
        acceptBtn.classList.toggle('review-detail-accept-btn--revert', applied);
      }
    });
  }

  function persistWorking() {
    if (typeof onReviewResultChange !== 'function') return;
    const suggestionsToSave = allSuggestions.map((s) => ({ ...s, applied: s.applied === true }));
    const dataRefinementToSave = dataRefinement.map((it) => {
      if (!it || typeof it !== 'object') return it;
      return { ...it };
    });
    const live = typeof getReviewResult === 'function' ? getReviewResult() : null;
    const base = live && typeof live === 'object' ? { ...live } : { ...saved };
    const next = {
      ...base,
      summary: base.summary ?? saved.summary ?? '',
      suggestions: suggestionsToSave,
      design_suggestions: [],
      data_refinement: dataRefinementToSave,
      row_diagnostics: rowDiagnostics,
      promptSections: base.promptSections ?? saved.promptSections ?? promptSections,
      promptFullText: base.promptFullText ?? saved.promptFullText ?? promptFullText,
      workingSections: working.map((s) => ({ name: s.name, content: s.content })),
    };
    onReviewResultChange(next);
    refreshAllEditSuggestionCardsVisuals();
  }

  /** Persist the verify state and result for one suggestion so they survive app restart. */
  function persistVerifyState(sugIdx, state, result) {
    if (typeof onReviewResultChange !== 'function') return;
    const sug = allSuggestions[sugIdx];
    if (!sug) return;
    const sid = sug.suggestion_id != null ? String(sug.suggestion_id) : '';
    if (!sid) return;
    const live = typeof getReviewResult === 'function' ? getReviewResult() : null;
    const base = live && typeof live === 'object' ? { ...live } : { ...saved };
    const verifyStates = typeof base.verify_states === 'object' && base.verify_states ? { ...base.verify_states } : {};
    const verifyResults = typeof base.verify_results === 'object' && base.verify_results ? { ...base.verify_results } : {};
    verifyStates[sid] = state;
    if (state === 'idle') {
      delete verifyResults[sid];
    } else if (result) {
      verifyResults[sid] = result;
    }
    onReviewResultChange({ ...base, verify_states: verifyStates, verify_results: verifyResults });
  }

  function emitReviewBarProgress(percent) {
    const pct = Math.min(100, Math.max(0, Math.round(percent)));
    if (!reviewNodeId) return;
    document.dispatchEvent(new CustomEvent('workflow:review-progress', {
      detail: { reviewNodeId, percent: pct },
    }));
  }

  function persistReviewProgressToNode(percent) {
    const pct = Math.min(100, Math.max(0, Math.round(percent)));
    emitReviewBarProgress(pct);
    if (typeof onReviewResultChange !== 'function' || typeof getReviewResult !== 'function') return;
    const live = getReviewResult();
    if (!live || typeof live !== 'object' || live.reviewProgress === pct) return;
    onReviewResultChange({ ...live, reviewProgress: pct });
  }

  /** Recompute working from originals by applying every suggestion that has .applied === true (in order). */
  function syncWorkingFromApplied() {
    const next = rebuildWorkingFromApplied(originals, allSuggestions);
    if (!next || next.length !== working.length) return;
    for (let i = 0; i < next.length; i++) {
      working[i].name = next[i].name;
      working[i].content = next[i].content;
    }
  }

  /**
   * Card actions “ready”: View detail always; Accept/Revert only when true.
   * Off while the review stream is still generating (if any suggestion exists).
   */
  function suggestionActionsFullForCard(_sug) {
    if (saved.streamComplete !== true) {
      return allSuggestions.length === 0;
    }
    return true;
  }

  function updateSuggestionTitleAndPassPill(card, sug, actionsFull, originals, promptSections) {
    const plain = Object.prototype.hasOwnProperty.call(card.dataset, 'reviewTitlePlain')
      ? card.dataset.reviewTitlePlain || ''
      : '';
    const titleWrap = card.querySelector('.review-detail-suggestion-title-wrap');
    const strong = titleWrap
      ? titleWrap.querySelector('.review-detail-suggestion-section-name')
      : card.querySelector('.review-detail-suggestion-section-name');
    if (strong && plain !== '') {
      strong.textContent = formatSuggestionCardPreviewTitle(plain);
    }
    const noButton = card.classList.contains('review-detail-suggestion-card--unlocatable');
    if (titleWrap) {
      titleWrap.querySelectorAll(`.${REVIEW_SUGGESTION_TITLE_PILL_CLASS}`).forEach((el) => {
        el.remove();
      });
      const sugIdx = parseInt(card.dataset.suggestionIndex, 10);
      const verifyState = !Number.isNaN(sugIdx) ? (cardVerifyStates.get(sugIdx) || 'idle') : 'idle';
      const specs = collectSuggestionTitlePills(
        sug,
        noButton,
        actionsFull,
        originals,
        promptSections,
        saved.streamComplete === true,
        verifyState,
      );
      for (const spec of specs) {
        const el = document.createElement('span');
        el.className = `${spec.cls} ${REVIEW_SUGGESTION_TITLE_PILL_CLASS}`;
        el.textContent = spec.text;
        if (typeof spec.ariaLabel === 'string' && spec.ariaLabel.trim()) {
          el.setAttribute('aria-label', spec.ariaLabel);
        }
        titleWrap.appendChild(el);
      }
      if (typeof card._bindVerifyPillClick === 'function') {
        card._bindVerifyPillClick();
      }
    }
  }

  function updateSuggestionTestOutcomeVisual(card, sug, actionsFull, originals, promptSections) {
    updateSuggestionTitleAndPassPill(card, sug, actionsFull !== false, originals, promptSections);
  }

  function renderEditSuggestionCards() {
    editContainer.innerHTML = '';
    if (!allSuggestions || allSuggestions.length === 0) {
      previewSelectedSuggestionIndex = null;
      clearDiffOnRight();
      if (dataRefinement.length === 0) {
        editContainer.innerHTML = '<p class="review-detail-placeholder">No suggestions.</p>';
      } else {
        editContainer.innerHTML = '<p class="review-detail-placeholder">No prompt edit suggestions.</p>';
      }
      return;
    }
    allSuggestions.forEach((sug, sugIdx) => addOneSuggestionCard(sug, sugIdx));
    if (previewSelectedSuggestionIndex != null) {
      const still = previewSelectedSuggestionIndex < allSuggestions.length;
      if (!still) {
        previewSelectedSuggestionIndex = null;
        clearDiffOnRight();
      }
      updateSuggestionPreviewSelectionVisual();
      if (still) applyPinnedPreviewIfAny();
    } else {
      updateSuggestionPreviewSelectionVisual();
    }
  }

  /** After stream: show suggestion cards and complete review progress. */
  async function revealSuggestionsAfterReview() {
    if (!allSuggestions || allSuggestions.length === 0) {
      renderEditSuggestionCards();
      updateSuggestionsFooter();
      persistReviewProgressToNode(100);
      return;
    }
    renderEditSuggestionCards();
    updateSuggestionsFooter();
    persistReviewProgressToNode(100);
  }

  function scrollRightToSection(sectionIndex) {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const blocks = promptSectionsEl.querySelectorAll('.preview-field-block');
        const block = blocks[sectionIndex];
        if (!block) return;
        const diffEl = block.querySelector(REVIEW_PROMPT_DIFF_MARK_SELECTOR);
        const target = diffEl || block;
        const boundary =
          promptSectionsEl.closest('.review-detail-preview-wrap') ||
          promptSectionsEl.closest('.modal-panel--review-detail') ||
          promptSectionsEl.closest('.modal-panel') ||
          document.body;
        scrollNestedToReveal(target, boundary);
      });
    });
  }

  const promptSectionsEl = promptWrap;

  function renderLeft(showDiffSectionIndex, diffNewContent, removeSpan, highlightSpan, highlightAsRemoved, highlightAddSpan, revertPreview = false) {
    const sectionsToRender = working.map((s, i) => ({ name: s.name, content: s.content }));
    if (showDiffSectionIndex >= 0 && showDiffSectionIndex < originals.length && (diffNewContent !== undefined || (highlightSpan !== undefined && highlightSpan !== null))) {
      promptSectionsEl.innerHTML = renderSectionsAsPromptDetail(sectionsToRender, showDiffSectionIndex, diffNewContent, removeSpan, highlightSpan, highlightAsRemoved, highlightAddSpan, revertPreview);
      scrollRightToSection(showDiffSectionIndex);
    } else {
      promptSectionsEl.innerHTML = renderSectionsAsPromptDetail(sectionsToRender);
    }
  }

  function showDiffOnRight(sectionIndex, newContent, removeSpan, highlightSpan, highlightAsRemoved, highlightAddSpan, revertPreview = false) {
    renderLeft(sectionIndex, newContent, removeSpan, highlightSpan, highlightAsRemoved, highlightAddSpan, revertPreview);
  }

  function clearDiffOnRight() {
    renderLeft(-1);
  }

  const sectionNames = (promptSections || []).map((s, i) => (s.name || '').trim() || `Section ${i}`);

  function updateAnalysisFooter() {
    if (!analysisFooterEl) return;
    const issueAnalysisComplete =
      saved.streamComplete === true || saved.diagnosisComplete === true;
    const inProgress = !issueAnalysisComplete && isReviewStreamingNow();
    let statusClass = 'review-detail-status-note--incomplete';
    let statusText = REVIEW_INCOMPLETE_USER_MSG;
    if (issueAnalysisComplete) {
      statusClass = 'review-detail-status-note--complete';
      const n = rowDiagnostics.length;
      statusText =
        n > 0
          ? `Issue analysis complete. ${n} issue${n === 1 ? '' : 's'} listed.`
          : 'Issue analysis complete. No failed rows.';
    } else if (inProgress) {
      statusClass = 'review-detail-status-note--generating';
      statusText = 'Issue analysis in progress…';
    }
    analysisFooterEl.innerHTML = '';
    const statusNote = document.createElement('p');
    statusNote.className = `review-detail-status-note ${statusClass}`;
    statusNote.setAttribute('aria-live', 'polite');
    statusNote.textContent = statusText;
    analysisFooterEl.appendChild(statusNote);
  }

  function updateSuggestionsFooter() {
    if (!suggestionsFooterEl) return;
    const isComplete = saved.streamComplete === true;
    const inProgress = !isComplete && isReviewStreamingNow();
    let statusClass = 'review-detail-status-note--incomplete';
    let statusText = REVIEW_INCOMPLETE_USER_MSG;
    if (isComplete) {
      statusClass = 'review-detail-status-note--complete';
      const ne = allSuggestions.length;
      const nr = dataRefinement.length;
      const parts = [];
      if (ne) parts.push(`${ne} prompt edit${ne === 1 ? '' : 's'}`);
      if (nr) parts.push(`${nr} data note${nr === 1 ? '' : 's'}`);
      statusText =
        parts.length > 0
          ? `Suggested changes complete. ${parts.join(', ')}.`
          : 'Suggested changes complete. No items.';
    } else if (inProgress) {
      statusClass = 'review-detail-status-note--generating';
      statusText = 'Suggested changes in progress…';
    }
    suggestionsFooterEl.innerHTML = '';
    const stack = document.createElement('div');
    stack.className = 'review-detail-suggestions-footer-stack';
    const statusNote = document.createElement('p');
    statusNote.className = `review-detail-status-note ${statusClass}`;
    statusNote.setAttribute('aria-live', 'polite');
    statusNote.textContent = statusText;
    stack.appendChild(statusNote);
    suggestionsFooterEl.appendChild(stack);
  }

  function renderRowDiagnostics() {
    if (!diagnosisEl) return;
    diagnosisEl.innerHTML = '';
    if (!rowDiagnostics.length) {
      const p = document.createElement('p');
      p.className = 'review-detail-placeholder';
      const streaming = isReviewStreamingNow();
      const phase1Done =
        saved.diagnosisComplete === true || saved.streamComplete === true;
      const stale = saved.streamComplete === false && !streaming;
      p.textContent = streaming && !phase1Done
        ? 'Analyzing row results…'
        : stale
          ? REVIEW_INCOMPLETE_USER_MSG
          : 'No row-level analysis for this run.';
      diagnosisEl.appendChild(p);
      return;
    }
    const comparisonRows = Array.isArray(saved.comparison_rows) ? saved.comparison_rows : [];
    rowDiagnostics.forEach((d, displayIdx) => {
      const displayNum = displayIdx + 1;
      const issue = (d.issue_summary || '').trim();
      const rough = (d.rough_modification_opinion || '').trim();
      const primaryBlurb = issue || rough;
      const preview = truncateWithEllipsis(primaryBlurb, DIAG_LIST_PREVIEW_CHARS);
      const titleLine = diagnosisCardTitleLine(d);
      const badgeLabel = escapeHtml(String(displayNum));

      const card = document.createElement('div');
      card.className = 'review-detail-suggestion-card review-detail-diagnosis-card';
      card.innerHTML = `
        <div class="review-detail-suggestion-card__main review-detail-diagnosis-card__main">
          <span class="review-detail-suggestion-header">
            <span class="review-detail-suggestion-num" aria-label="Issue analysis id" title="ID ${badgeLabel}">#${badgeLabel}</span>
            <strong class="review-detail-suggestion-section-name">${escapeHtml(titleLine)}</strong>
          </span>
          <p class="review-detail-suggestion-reason review-detail-diagnosis-preview">${escapeHtml(preview || '—')}</p>
        </div>
        <div class="review-detail-suggestion-card__actions">
          <button type="button" class="btn btn-secondary review-detail-diagnosis-detail-btn">View detail</button>
        </div>
      `;
      const detailBtn = card.querySelector('.review-detail-diagnosis-detail-btn');
      if (detailBtn) {
        detailBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          openRowDiagnosisDetailOverlay(d, comparisonRows, displayNum);
        });
      }
      diagnosisEl.appendChild(card);
    });
  }

  function addOneDataRefinementCard(item, itemIdx) {
    const sid = item && item.suggestion_id != null && item.suggestion_id !== '' ? item.suggestion_id : '';
    const shortLabel = formatSuggestionIdDisplay(sid);
    const rowIndices = Array.isArray(item.row_indices) ? item.row_indices : [];
    const rowsText =
      rowIndices.length > 0
        ? `Rows ${rowIndices.map((x) => formatRunRowIndexForDisplay(x)).join(', ')}`
        : 'Some rows';
    const titleLine = suggestionCardTitleLine({
      explicitName: item.name || item.card_title,
      reason: item.reason,
      sectionFallback: '',
      defaultLabel: 'Possible ground truth issue',
    });
    const card = document.createElement('div');
    card.className = 'review-detail-suggestion-card review-detail-data-refinement-card';
    card.dataset.dataRefinementIndex = String(itemIdx);
    card.innerHTML = `
      <div class="review-detail-suggestion-card__main">
        <span class="review-detail-suggestion-header"><span class="review-detail-suggestion-num" aria-label="Suggestion id" title="ID ${escapeHtml(String(sid))}">#${escapeHtml(shortLabel)}</span> <strong class="review-detail-suggestion-section-name">${escapeHtml(titleLine)}</strong></span>
        <p class="review-detail-suggestion-reason"><span class="review-detail-data-refinement-rows">${escapeHtml(rowsText)}</span>: ${escapeHtml((item.reason || '').trim())}</p>
      </div>
    `;
    dataRefinementContainer.appendChild(card);
  }

  function updateAcceptButtonLabels() {
    editContainer.querySelectorAll('.review-detail-suggestion-card').forEach((c) => {
      const btn = c.querySelector('.review-detail-accept-btn');
      if (!btn) return;
      const i = parseInt(c.dataset.suggestionIndex, 10);
      const s = allSuggestions[i];
      if (!s) return;
      const applied = s.applied === true;
      btn.textContent = applied ? 'Revert' : 'Accept';
      btn.classList.toggle('review-detail-accept-btn--revert', applied);
    });
  }

  function addOneSuggestionCard(sug, sugIdx) {
    const actionsFull = suggestionActionsFullForCard(sug);
    const sid = sug && sug.suggestion_id != null && sug.suggestion_id !== '' ? sug.suggestion_id : '';
    const shortLabel = formatSuggestionIdDisplay(sid);
    const useSentenceEdit = sug.old_sentence != null && sug.new_sentence != null;
    const rawOldSentence = sug.old_sentence != null ? String(sug.old_sentence) : '';
    const oldSentence = rawOldSentence.trim();
    let secIdx = 0;
    if (useSentenceEdit && oldSentence) {
      const found = findSectionIndexForOldSentence(originals, rawOldSentence);
      if (found >= 0) secIdx = found;
    }
    const name = sectionNames[secIdx] || `Section ${secIdx}`;
    const newSentence = (sug.new_sentence || '').trim();
    const legacyNewContent = (sug.new_content || '').trim();
    const currentContent = working[secIdx] ? (working[secIdx].content || '') : '';
    const originalContent = (originals[secIdx] && originals[secIdx].content) ? originals[secIdx].content : '';
    const segmentInOriginal = useSentenceEdit
      ? getLocatableSegment(originalContent, rawOldSentence) || getLocatableSegment(originalContent, oldSentence)
      : null;
    const unlocatable = useSentenceEdit && !segmentInOriginal;
    const noButton = unlocatable;
    /* Only show Revert when user has explicitly applied (sug.applied === true from persist). Fresh suggestions must show Accept. */
    const isApplied = sug.applied === true;
    const fullReason = (sug.reason || '').trim();
    const titleLine = suggestionCardTitleLine({
      explicitName: sug.name,
      reason: sug.reason,
      sectionFallback: name,
      defaultLabel: 'Prompt edit',
    });
    const previewTitle = formatSuggestionCardPreviewTitle(titleLine);
    const previewReason = truncateWithEllipsis(fullReason, SUGGESTION_CARD_PREVIEW_REASON_CHARS);

    const detailsBtnHtml =
      '<button type="button" class="btn btn-secondary review-detail-diagnosis-detail-btn">View detail</button>';
    const showAcceptOrRevert = !noButton && (isApplied || actionsFull);
    const acceptBtnHtml = showAcceptOrRevert
      ? '<button type="button" class="btn btn-secondary review-detail-accept-btn' + (isApplied ? ' review-detail-accept-btn--revert' : '') + '">' + (isApplied ? 'Revert' : 'Accept') + '</button>'
      : '';
    const titlePillsHtml = buildSuggestionTitlePillsHtml(
      sug,
      noButton,
      actionsFull,
      originals,
      promptSections,
      saved.streamComplete === true,
      cardVerifyStates.get(sugIdx),
    );
    const debugActionsHtml =
      '<button type="button" class="review-detail-debug-reset-btn" title="Debug: reset card to Click-to-verify state">Reset</button>' +
      '<button type="button" class="review-detail-debug-info-btn" title="Debug: open run info panel">Debug</button>';
    const actionsHtml = `${detailsBtnHtml}${acceptBtnHtml ? ` ${acceptBtnHtml}` : ''} <span class="review-detail-debug-btn-group">${debugActionsHtml}</span>`;

    const card = document.createElement('div');
    card.className =
      'review-detail-suggestion-card' +
      (noButton ? ' review-detail-suggestion-card--unlocatable' : '') +
      (!actionsFull ? ' review-detail-suggestion-card--actions-pending' : '');
    card.dataset.sectionIndex = String(secIdx);
    card.dataset.suggestionIndex = String(sugIdx);
    if (sid !== '' && sid != null) card.dataset.suggestionId = String(sid);
    card.dataset.reviewTitlePlain = titleLine;
    card.innerHTML = `
      <div class="review-detail-suggestion-card__main">
        <span class="review-detail-suggestion-header"><span class="review-detail-suggestion-num" aria-label="Suggestion id" title="ID ${escapeHtml(String(sid))}">#${escapeHtml(shortLabel)}</span><span class="review-detail-suggestion-title-wrap"><strong class="review-detail-suggestion-section-name">${escapeHtml(previewTitle)}</strong>${titlePillsHtml}</span></span>
        <p class="review-detail-suggestion-reason">${escapeHtml(previewReason || '—')}</p>
      </div>
      <div class="review-detail-suggestion-card__actions">
        ${actionsHtml}
      </div>
    `;
    const mainEl = card.querySelector('.review-detail-suggestion-card__main');
    const acceptBtn = card.querySelector('.review-detail-accept-btn');
    const detailBtn = card.querySelector('.review-detail-diagnosis-detail-btn');
    const resetBtn = card.querySelector('.review-detail-debug-reset-btn');
    const debugInfoBtn = card.querySelector('.review-detail-debug-info-btn');
    if (detailBtn) {
      detailBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openPromptEditSuggestionDetailOverlay(sug, {
          titleLine,
          comparisonRows: Array.isArray(saved.comparison_rows) ? saved.comparison_rows : [],
        });
      });
    }
    if (resetBtn) {
      resetBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        cardVerifyStates.delete(sugIdx);
        cardVerifyResults.delete(sugIdx);
        try { persistVerifyState(sugIdx, 'idle', null); } catch (_) {}
        updateSuggestionTitleAndPassPill(card, sug, actionsFull, originals, promptSections);
        bindVerifyPillClick();
      });
    }
    if (debugInfoBtn) {
      debugInfoBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openSuggestionDebugOverlay(sug, buildSugDebugData(sug), cardVerifyResults.get(sugIdx) ?? null);
      });
    }

    /** Compute debug data (summary numbers + raw targetRows) for this suggestion. */
    function buildSugDebugData(s) {
      const compRows = Array.isArray(saved.comparison_rows) ? saved.comparison_rows : [];
      const rowIndices = suggestionTargetScoreRowIndices(s);
      const targetRows = rowIndices
        .map((ri) => compRows.find((r) => Number(r?.row_index) === ri))
        .filter(Boolean);

      const toNums = (arr) => arr.length ? arr.map((n) => `#${n}`).join(', ') : '—';

      const inputSet = [...new Set(
        targetRows.map((r) => r.input_row_index != null ? r.input_row_index + 1 : null).filter((n) => n != null),
      )].sort((a, b) => a - b);

      const gtSet = [...new Set(
        targetRows.map((r) => r.source_gt_row_index != null ? r.source_gt_row_index + 1 : null).filter((n) => n != null),
      )].sort((a, b) => a - b);

      const scoreLabel = formatScoreTableTargetLabels(compRows, rowIndices) || '—';

      const meta = s.review_optimization_meta;
      return {
        inputNums: toNums(inputSet),
        gtNums: toNums(gtSet),
        scoreNums: scoreLabel,
        targetRows,
        optimizationInputNums: meta?.optimizationInputNums || null,
        optimizationExtraInputNums: meta?.optimizationExtraInputNums || null,
        optimizationGtNums: meta?.optimizationGtNums || null,
      };
    }

    /**
     * Store a verify result and, if the debug overlay for this suggestion is already open,
     * update its verify section in-place. Never re-opens a closed overlay.
     */
    function storeVerifyResult(verifyResult) {
      cardVerifyResults.set(sugIdx, verifyResult);
      const sid = sug && sug.suggestion_id != null ? String(sug.suggestion_id) : '(no id)';
      const overlay = document.querySelector('.review-suggestion-debug-overlay');
      if (overlay && overlay.dataset.suggestionId === sid) {
        const verifySection = overlay.querySelector('.review-suggest-verify-section');
        if (verifySection) verifySection.innerHTML = buildVerifySectionHtml(verifyResult);
      }
    }

    /** Set to true before calling runVerification() after an optimization run so the finally
     *  block can distinguish "optimized but not fully passing" from "plain verify failed". */
    let _isPostOptimizationVerify = false;

    /** Run the modified prompt against the suggestion's target inputs and store results. */
    async function runVerification() {
      try {
        storeVerifyResult({ status: 'running' });
      } catch (_) { /* non-fatal */ }

      try {
        // 1. Get credential + output schema from canvas payload
        const payload = typeof getPayload === 'function' ? await getPayload() : null;
        const credentialId = payload?.run_credential_id;
        const outputSchema = payload?.output_schema;
        const scoreMapping = payload?.score_mapping;
        const outputFields = Array.isArray(payload?.output_fields) ? payload.output_fields : [];
        const runWs = typeof payload?.getRunWorkingSetContent === 'function'
          ? payload.getRunWorkingSetContent()
          : { headers: [], rows: [] };
        const gtContent = typeof payload?.getGroundTruthContent === 'function'
          ? payload.getGroundTruthContent()
          : { headers: [], rows: [] };
        if (!credentialId) throw new Error('No run credential configured on the Run node.');
        if (!outputSchema) throw new Error('No output schema configured on the Prompt node.');
        if (!scoreMapping) throw new Error('No Score mapping configured.');

        // 2. Build modified prompt: apply only this suggestion to originals
        const modifiedSections = rebuildWorkingFromApplied(originals, [{ ...sug, applied: true }]) || originals;
        const templateText = modifiedSections.map((s) => (s.content || '').trim()).filter(Boolean).join('\n\n');

        // 3. Collect target comparison rows
        const compRows = Array.isArray(saved.comparison_rows) ? saved.comparison_rows : [];
        const rowIndices = suggestionTargetScoreRowIndices(sug);
        const targetRows = rowIndices
          .map((ri) => compRows.find((r) => Number(r?.row_index) === ri))
          .filter(Boolean);

        // 4. Build ordered unique input list, collecting associated GTs per input
        const inputMap = new Map(); // input_row_index → { row, gtRows: [{gtNum, gtRowIndex}] }
        for (const row of targetRows) {
          const inputIdx = row.input_row_index;
          if (inputIdx == null) continue;
          if (!inputMap.has(inputIdx)) inputMap.set(inputIdx, { row, gtRows: [] });
          if (row.ground_truth_output && row.source_gt_row_index != null) {
            const gtNum = row.source_gt_row_index + 1;
            const entry = inputMap.get(inputIdx);
            if (!entry.gtRows.find((g) => g.gtNum === gtNum)) {
              entry.gtRows.push({ gtNum, gtRowIndex: row.source_gt_row_index });
            }
          }
        }
        const inputEntries = [...inputMap.entries()].sort(([a], [b]) => a - b);
        if (inputEntries.length === 0) throw new Error('No inputs found for this suggestion.');

        // 5. Fill template with row_input values (single-brace placeholder substitution)
        const prompts = inputEntries.map(([, { row }]) => {
          let text = templateText;
          for (const [key, val] of Object.entries(row.row_input || {})) {
            text = text.replace(new RegExp(`\\{${escapeRegex(key)}\\}`, 'g'), String(val ?? ''));
          }
          return text;
        });

        // 6. Submit run job
        const runRes = await fetch(`${API_BASE}/api/run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ credential_id: credentialId, prompts, output_schema: outputSchema }),
        });
        if (!runRes.ok) {
          const errText = await runRes.text().catch(() => String(runRes.status));
          throw new Error(`Run API error ${runRes.status}: ${errText}`);
        }
        const { run_id: runId } = await runRes.json();

        // 7. Poll until complete, updating stored state each tick
        let finalData = null;
        while (true) {
          await new Promise((r) => setTimeout(r, 1200));
          const pollRes = await fetch(`${API_BASE}/api/run/result/${runId}`);
          const pollData = await pollRes.json();
          if (pollData.progress) storeVerifyResult({ status: 'running', progress: pollData.progress });
          if (pollData.status === 'done' || pollData.status === 'cancelled') {
            finalData = pollData;
            break;
          }
        }

        // 8. Evaluate with the same Score output->gt rules (no simplified compare).
        if (finalData?.error) throw new Error(String(finalData.error));
        const rawResults = finalData?.results || [];
        const { verifyRows } = await evaluateScoreOutputGt({
          apiBase: API_BASE,
          scoreMapping,
          results: rawResults,
          inputEntries,
          outputFields: Array.isArray(finalData?.output_fields) ? finalData.output_fields : outputFields,
          runWs,
          gtContent,
        });

        // 9. Store final results
        try { storeVerifyResult({ status: 'complete', verifyRows }); } catch (_) { /* non-fatal */ }
      } catch (err) {
        try { storeVerifyResult({ status: 'error', message: String(err?.message || err) }); } catch (_) { /* non-fatal */ }
      } finally {
        // Determine final pill state from stored result
        const finalResult = cardVerifyResults.get(sugIdx);
        const wasPostOptimization = _isPostOptimizationVerify;
        _isPostOptimizationVerify = false;
        const postState = wasPostOptimization
          ? (isVerifyFullPass(finalResult) ? 'optimized-pass' : (finalResult?.status === 'complete' ? 'optimized' : 'idle'))
          : (isVerifyFullPass(finalResult) ? 'verified' : (finalResult?.status === 'complete' ? 'optimization' : 'idle'));
        cardVerifyStates.set(sugIdx, postState);
        _verifyPromises.delete(verifyKey(sugIdx));
        // Persist state + result so they survive app restart
        try { persistVerifyState(sugIdx, postState, postState !== 'idle' ? finalResult : null); } catch (_) {}
        // Only update the DOM if this card is still mounted; if the modal was
        // closed and reopened, the new card's .finally() hook handles the update.
        if (card.isConnected) {
          updateSuggestionTitleAndPassPill(card, sug, suggestionActionsFullForCard(sug), originals, promptSections);
          // If this card's diff is currently pinned on the right, refresh it so
          // it shows the updated new_sentence (e.g. after optimization rewrites it).
          applyPinnedPreviewIfAny();
        }
      }
    }

    /** Run compositional optimization for this suggestion. */
    async function runOptimization() {
      const ac = new AbortController();
      registerOptimizationSession(ac);
      try {
        const payload = typeof getPayload === 'function' ? await getPayload() : null;
        const credentialId = payload?.run_credential_id;
        const outputSchema = payload?.output_schema;
        const outputFields = Array.isArray(payload?.output_fields) ? payload.output_fields : [];
        const scoreMapping = payload?.score_mapping;
        const runWs = typeof payload?.getRunWorkingSetContent === 'function'
          ? payload.getRunWorkingSetContent()
          : { headers: [], rows: [] };
        const gtContent = typeof payload?.getGroundTruthContent === 'function'
          ? payload.getGroundTruthContent()
          : { headers: [], rows: [] };
        if (!credentialId) throw new Error('No run credential configured.');
        if (!outputSchema) throw new Error('No output schema configured.');
        if (!scoreMapping) throw new Error('No Score mapping configured.');

        // Build inputEntries (same as runVerification)
        const compRows = Array.isArray(saved.comparison_rows) ? saved.comparison_rows : [];
        const rowIndices = suggestionTargetScoreRowIndices(sug);
        const targetRows = rowIndices
          .map((ri) => compRows.find((r) => Number(r?.row_index) === ri))
          .filter(Boolean);
        const inputMap = new Map();
        for (const row of targetRows) {
          const inputIdx = row.input_row_index;
          if (inputIdx == null) continue;
          if (!inputMap.has(inputIdx)) inputMap.set(inputIdx, { row, gtRows: [] });
          if (row.ground_truth_output && row.source_gt_row_index != null) {
            const gtNum = row.source_gt_row_index + 1;
            const entry = inputMap.get(inputIdx);
            if (!entry.gtRows.find((g) => g.gtNum === gtNum)) {
              entry.gtRows.push({ gtNum, gtRowIndex: row.source_gt_row_index });
            }
          }
        }
        const inputEntries = [...inputMap.entries()].sort(([a], [b]) => a - b);
        if (inputEntries.length === 0) throw new Error('No inputs found for this suggestion.');

        // Expand with up to 2 extra inputs from all comparison rows.
        // Prefer inputs where every comparison row is matched (fully correct); fall back to any unused input.
        const usedInputIdxs = new Set(inputEntries.map(([idx]) => idx));
        const allGrouped = new Map();
        for (const row of compRows) {
          const iIdx = row.input_row_index;
          if (iIdx == null) continue;
          if (!allGrouped.has(iIdx)) allGrouped.set(iIdx, { row, allMatched: true, gtRows: [] });
          const g = allGrouped.get(iIdx);
          if (!comparisonRowIsMatched(row)) g.allMatched = false;
          if (row.ground_truth_output && row.source_gt_row_index != null) {
            const gtNum = row.source_gt_row_index + 1;
            if (!g.gtRows.find((x) => x.gtNum === gtNum)) {
              g.gtRows.push({ gtNum, gtRowIndex: row.source_gt_row_index });
            }
          }
        }
        const extraCandidates = [...allGrouped.entries()]
          .filter(([iIdx]) => !usedInputIdxs.has(iIdx))
          .sort(([aIdx, a], [bIdx, b]) => {
            if (a.allMatched !== b.allMatched) return b.allMatched ? 1 : -1;
            return aIdx - bIdx;
          });
        const extraEntries = extraCandidates.slice(0, 2).map(([iIdx, g]) => [iIdx, { row: g.row, gtRows: g.gtRows }]);
        const expandedInputEntries = [...inputEntries, ...extraEntries].sort(([a], [b]) => a - b);

        let optimizationMaxTrials = 40;
        try {
          const stRes = await fetch(`${API_BASE}/api/settings`);
          if (stRes.ok) {
            const st = await stRes.json();
            const v = parseInt(st?.optimization_max_trials, 10);
            if (!Number.isNaN(v) && v >= 4) optimizationMaxTrials = Math.min(200, v);
          }
        } catch (_) {}

        const result = await runSuggestionOptimizationCompositional({
          credentialId,
          oldSentence: sug.old_sentence || '',
          newSentence: sug.new_sentence || '',
          improvementRationale: sug.reason || '',
          sectionContext: originalContent || '',
          maxSegments: 5,
          candidatesPerSegment: 4,
          maxTrials: optimizationMaxTrials,
          allSuggestions,
          sugIdx,
          originals,
          inputEntries: expandedInputEntries,
          outputSchema,
          outputFields,
          scoreMapping,
          runWs,
          gtContent,
          abortController: ac,
          onProgress: ({ trial, trials, bestRate }) => {
            try {
              storeVerifyResult({ status: 'running', progress: { completed: trial, total: trials } });
            } catch (_) {}
          },
        });

        // Build human-readable input/GT # strings for the debug overlay
        const optimizationInputNums = expandedInputEntries.map(([idx]) => `#${idx + 1}`).join(', ');
        const optimizationExtraInputNums = extraEntries.length > 0 ? extraEntries.map(([idx]) => `#${idx + 1}`).join(', ') : null;
        const optimizationGtNums = [...new Set(
          expandedInputEntries.flatMap(([, { gtRows }]) => gtRows.map((g) => `#${g.gtNum}`)),
        )].sort((a, b) => parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10)).join(', ');

        // Update suggestion's new_sentence with the best found text
        sug.new_sentence = result.bestText;
        sug.review_optimization_completed = true;
        sug.review_optimization_meta = {
          bestRate: result.bestObservedRate,
          trials: result.trialLog.length,
          optimizationInputNums,
          optimizationExtraInputNums,
          optimizationGtNums,
        };
        // Persist updated suggestion so new_sentence survives app restart
        try {
          if (typeof onReviewResultChange === 'function') {
            const live = typeof getReviewResult === 'function' ? getReviewResult() : null;
            const base = live && typeof live === 'object' ? { ...live } : { ...saved };
            const suggs = Array.isArray(base.suggestions) ? [...base.suggestions] : allSuggestions.map((s) => ({ ...s }));
            suggs[sugIdx] = { ...suggs[sugIdx], new_sentence: result.bestText, review_optimization_completed: true, review_optimization_meta: sug.review_optimization_meta };
            onReviewResultChange({ ...base, suggestions: suggs });
          }
        } catch (_) {}

        return result;
      } finally {
        unregisterOptimizationSession(ac);
      }
    }

    /** Attach click handlers to verify + optimization pills (re-called after pill rebuild). */
    function bindVerifyPillClick() {
      // Assistant-added proposals don't participate in verify or optimization.
      if (String(sug?.source || '').toLowerCase() === 'assistant') return;
      const titleWrap = card.querySelector('.review-detail-suggestion-title-wrap');
      if (!titleWrap) return;

      // "Click to Verify" pill
      titleWrap.querySelectorAll('.review-suggestion-verify-pill--clickable').forEach((pill) => {
        pill.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (_verifyPromises.has(verifyKey(sugIdx))) return;
          cardVerifyStates.set(sugIdx, 'verifying');
          updateSuggestionTitleAndPassPill(card, sug, actionsFull, originals, promptSections);
          const vp = runVerification();
          _verifyPromises.set(verifyKey(sugIdx), vp);
        });
      });

      // "Click to Optimize" pill
      titleWrap.querySelectorAll('.review-suggestion-optimization-pill--clickable').forEach((pill) => {
        pill.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (_verifyPromises.has(verifyKey(sugIdx))) return;
          // If the suggestion was already accepted, revert it first so the prompt
          // reflects the optimized new_sentence once optimization completes.
          if (sug.applied === true) {
            sug.applied = false;
            syncWorkingFromApplied();
            updateAcceptButtonLabels();
            renderLeft(-1);
            persistWorking();
            if (previewSelectedSuggestionIndex === sugIdx) showPreview();
          }
          cardVerifyStates.set(sugIdx, 'optimizing');
          updateSuggestionTitleAndPassPill(card, sug, actionsFull, originals, promptSections);
          const fp = (async () => {
            try {
              await runOptimization();
            } catch (err) {
              if (err?.name !== 'AbortError') {
                try { storeVerifyResult({ status: 'error', message: String(err?.message || err) }); } catch (_) {}
              }
            } finally {
              // After optimization, auto-verify the new sentence to set the correct pill state.
              // Set the flag so runVerification's finally block uses 'optimized' (not 'optimization')
              // when verify completes but doesn't achieve full pass.
              _isPostOptimizationVerify = true;
              const vp2 = runVerification();
              _verifyPromises.set(verifyKey(sugIdx), vp2);
              await vp2;
            }
          })();
          _verifyPromises.set(verifyKey(sugIdx), fp);
        });
      });
    }
    card._bindVerifyPillClick = bindVerifyPillClick;
    bindVerifyPillClick();

    // If a verification/optimization was in-flight when the modal was closed, hook the
    // existing promise so this (newly mounted) card's pill resets when it finishes.
    if (cardVerifyStates.get(sugIdx) === 'verifying' || cardVerifyStates.get(sugIdx) === 'optimizing') {
      const inflight = _verifyPromises.get(verifyKey(sugIdx));
      if (inflight) {
        inflight.finally(() => {
          if (card.isConnected) {
            updateSuggestionTitleAndPassPill(card, sug, suggestionActionsFullForCard(sug), originals, promptSections);
            applyPinnedPreviewIfAny();
          }
        });
      }
    }

    function currentNewSentence() {
      return effectiveNewSentenceForApply(sug);
    }
    function getDiffContent() {
      const c = working[secIdx] ? (working[secIdx].content || '') : '';
      if (!useSentenceEdit) return legacyNewContent;
      const ns = currentNewSentence();
      const seg = getLocatableSegment(c, rawOldSentence) || getLocatableSegment(c, oldSentence);
      return seg ? c.replace(seg, ns, 1) : c.replace(oldSentence, ns, 1);
    }
    function getRemoveSpanForDiff() {
      if (!useSentenceEdit || currentNewSentence() !== '') return undefined;
      const c = working[secIdx] ? (working[secIdx].content || '') : '';
      return getLocatableSegment(c, rawOldSentence) || getLocatableSegment(c, oldSentence) || oldSentence;
    }
    /** Reverted section content (current with new_sentence -> old_sentence, or original for legacy). */
    function getRevertedContent() {
      const c = working[secIdx] ? (working[secIdx].content || '') : '';
      if (!useSentenceEdit) return originalContent || '';
      const ns = currentNewSentence();
      const seg = getLocatableSegment(c, ns);
      return seg ? c.replace(seg, rawOldSentence, 1) : c.replace(ns, oldSentence, 1);
    }
    function showPreview() {
      if (sug.applied) {
        /* Revert hover: green strikethrough on accepted (new) text, red for restored original */
        showDiffOnRight(secIdx, getRevertedContent(), getRemoveSpanForDiff(), undefined, undefined, undefined, true);
      } else {
        /* Accept hover: red strikethrough on old, green for new */
        showDiffOnRight(secIdx, getDiffContent(), getRemoveSpanForDiff(), undefined, undefined, undefined, false);
      }
    }

    card._reviewShowPreview = showPreview;

    if (!noButton) {
      mainEl.setAttribute('role', 'button');
      mainEl.tabIndex = 0;
      mainEl.setAttribute(
        'aria-label',
        showAcceptOrRevert
          ? 'Show this change in the prompt; click again to clear. Use Accept or View detail from the buttons below.'
          : 'Show this change in the prompt; click again to clear. Use View detail from the buttons below.',
      );
      mainEl.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        e.preventDefault();
        if (previewSelectedSuggestionIndex === sugIdx) {
          previewSelectedSuggestionIndex = null;
          updateSuggestionPreviewSelectionVisual();
          clearDiffOnRight();
        } else {
          previewSelectedSuggestionIndex = sugIdx;
          updateSuggestionPreviewSelectionVisual();
          showPreview();
        }
      });
      mainEl.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        if (!mainEl.contains(e.target)) return;
        if (e.target.closest('button')) return;
        e.preventDefault();
        mainEl.click();
      });

      card.addEventListener('mouseenter', () => showPreview());
      card.addEventListener('mouseleave', () => {
        if (previewSelectedSuggestionIndex != null) {
          applyPinnedPreviewIfAny();
        } else {
          clearDiffOnRight();
        }
      });
    } else {
      mainEl.removeAttribute('role');
      mainEl.tabIndex = -1;
      mainEl.removeAttribute('aria-label');
    }

    if (!noButton && acceptBtn && (actionsFull || isApplied)) {
      acceptBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (secIdx < 0 || secIdx >= working.length) return;
        const wasApplied = sug.applied === true;
        sug.applied = !wasApplied;
        syncWorkingFromApplied();
        updateAcceptButtonLabels();
        updateSuggestionTestOutcomeVisual(card, sug, suggestionActionsFullForCard(sug), originals, promptSections);
        renderLeft(-1);
        persistWorking();
        if (previewSelectedSuggestionIndex === sugIdx) {
          showPreview();
        }
      });
    }

    updateSuggestionTestOutcomeVisual(card, sug, suggestionActionsFullForCard(sug), originals, promptSections);

    editContainer.appendChild(card);
  }

  renderRowDiagnostics();

  dataRefinement.forEach((item, drIdx) => addOneDataRefinementCard(item, drIdx));

  if (saved.streamComplete !== true) {
    if (staleIncompletePersisted) {
      editContainer.innerHTML = `<p class="review-detail-placeholder">${escapeHtml(REVIEW_INCOMPLETE_USER_MSG)}</p>`;
    } else if (allSuggestions.length > 0) {
      renderEditSuggestionCards();
      updateSuggestionsFooter();
    } else {
      editContainer.innerHTML = '<p class="review-detail-placeholder">Generating suggestions…</p>';
    }
  } else if (allSuggestions.length > 0) {
    void revealSuggestionsAfterReview();
  } else {
    renderEditSuggestionCards();
    updateSuggestionsFooter();
    persistReviewProgressToNode(100);
  }

  function setupRightTabs() {
    const tabBar = overlay.querySelector('.review-detail-right-tabs');
    if (!tabBar) return;
    const tabs = tabBar.querySelectorAll('.review-detail-tab[data-tab]');
    const panels = overlay.querySelectorAll('.review-detail-tab-panel[data-panel]');
    if (!tabs.length || !panels.length) return;

    function activate(name) {
      const n = name === 'analysis' || name === 'suggestions' ? name : 'analysis';
      tabs.forEach((btn) => {
        const on = btn.dataset.tab === n;
        btn.classList.toggle('review-detail-tab--active', on);
        btn.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      panels.forEach((p) => {
        p.classList.toggle('review-detail-tab-panel--active', p.dataset.panel === n);
      });
      overlay.dataset.reviewRightTab = n;
    }

    const stored = overlay.dataset.reviewRightTab;
    let initial = stored === 'analysis' || stored === 'suggestions' ? stored : null;
    if (!initial) {
      initial = 'analysis';
    }
    activate(initial);

    if (tabBar.dataset.reviewTabsWired === '1') return;
    tabBar.dataset.reviewTabsWired = '1';
    tabs.forEach((btn) => {
      btn.addEventListener('click', () => activate(btn.dataset.tab));
    });
  }

  setupRightTabs();

  const deferSuggestionsFooterUntilReveal = saved.streamComplete === true && allSuggestions.length > 0;
  if (!deferSuggestionsFooterUntilReveal) {
    updateSuggestionsFooter();
  }
  updateAnalysisFooter();

  const footer = overlay.querySelector('.review-detail-prompt-footer');
  if (footer) {
    footer.innerHTML = '';
    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.className = 'btn btn-primary review-detail-export-btn';
    exportBtn.textContent = 'Apply';
    const isComplete =
      saved.streamComplete === true || (saved.streamComplete !== false && !reviewStillGenerating);
    exportBtn.disabled = !isComplete;
    exportBtn.addEventListener('click', () => {
      const sections = working.map((s) => ({ name: s.name || '', content: s.content || '' }));
      if (!sections.length) return;
      if (typeof onExportNewPrompt === 'function') {
        onExportNewPrompt(sections);
        overlay.remove();
        document.body.style.overflow = '';
      } else {
        const text = sectionsToFullText(working);
        if (text) {
          navigator.clipboard.writeText(text).then(() => {
            exportBtn.textContent = 'Copied';
            setTimeout(() => { exportBtn.textContent = 'Apply'; }, 1500);
          }).catch(() => {
            exportBtn.textContent = 'Copy failed';
            setTimeout(() => { exportBtn.textContent = 'Apply'; }, 1500);
          });
        }
      }
    });
    footer.appendChild(exportBtn);
  }

  const overlayForReviewSync = suggestionsEl.closest('.modal-overlay');
  if (overlayForReviewSync) {
    overlayForReviewSync._reviewDetailReconcile = (data) => {
      if (!data || typeof data !== 'object') return;
      reconcileAllSuggestionsFromSavedData(data);
      Object.keys(data).forEach((k) => {
        if (k === 'suggestions') return;
        saved[k] = data[k];
      });
      refreshAllEditSuggestionCardsVisuals();
      updateAnalysisFooter();
      updateSuggestionsFooter();
    };
  }

}

/** Review node modal: show saved result (sections + suggestions) or empty state. */
export function openReviewDetailModal({ node, getPayload, getReviewResult, updateReviewResult, onExportNewPrompt, getIsReviewStreaming }) {
   const saved = getReviewResult ? getReviewResult() : null;
  const reviewName = (node?.querySelector?.('.workflow-node__title')?.textContent?.trim()) || 'Review';
  const title = `Review: ${reviewName}`;
  const sectionsForDisplay = saved && (
    (Array.isArray(saved.promptSections) && saved.promptSections.length > 0)
      ? saved.promptSections
      : (Array.isArray(saved.workingSections) && saved.workingSections.length > 0)
        ? saved.workingSections
        : null
  );
  const hasResult = saved && sectionsForDisplay && sectionsForDisplay.length > 0;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'review-detail-title');
  const promptSectionsHtmlForNode = hasResult ? renderSectionsAsPromptDetail(sectionsForDisplay.map((s) => ({ name: s.name || '', content: (s.content || '').slice() }))) : '';
  overlay.innerHTML = `
    <div class="modal-panel modal-panel--review-detail">
      <div class="modal-header">
        <h2 id="review-detail-title" class="modal-title">${escapeHtml(title)}</h2>
        <button type="button" class="modal-close" aria-label="Close">×</button>
      </div>
      <div class="modal-body review-detail-body">
        <div class="review-detail-main">
          <h3 class="review-detail-preview-title review-detail-output-title">Findings</h3>
          <div class="review-detail-output-toolbar">
            <div class="review-detail-view-switch review-detail-right-tabs" role="tablist" aria-label="Switch findings view">
              <button type="button" class="btn btn-secondary review-detail-view-switch__btn review-detail-tab review-detail-tab--active" role="tab" aria-selected="true" aria-controls="review-detail-panel-analysis" id="review-detail-tab-analysis" data-tab="analysis">Issue analysis</button>
              <button type="button" class="btn btn-secondary review-detail-view-switch__btn review-detail-tab" role="tab" aria-selected="false" aria-controls="review-detail-panel-suggestions" id="review-detail-tab-suggestions" data-tab="suggestions">Suggested changes</button>
            </div>
          </div>
          <div class="review-detail-preview-content">
            <div class="review-detail-tab-panels">
              <div class="review-detail-tab-panel review-detail-tab-panel--active" id="review-detail-panel-analysis" role="tabpanel" aria-labelledby="review-detail-tab-analysis" data-panel="analysis">
                <div class="review-detail-row-diagnostics" id="review-detail-row-diagnostics"></div>
                <div class="review-detail-analysis-footer" id="review-detail-analysis-footer"></div>
              </div>
              <div class="review-detail-tab-panel" id="review-detail-panel-suggestions" role="tabpanel" aria-labelledby="review-detail-tab-suggestions" data-panel="suggestions">
                <div class="review-detail-suggestions" id="review-detail-suggestions"></div>
                <div class="review-detail-suggestions-footer" id="review-detail-suggestions-footer"></div>
              </div>
            </div>
          </div>
        </div>
        <div class="review-detail-preview-wrap">
          <p class="prompt-step-label">Prompt sections</p>
          <div class="prompt-detail-sections-scroll">
            <div class="prompt-detail-sections-wrap">
              <div class="review-detail-prompt-wrap prompt-detail-sections-view">${promptSectionsHtmlForNode}</div>
            </div>
          </div>
          <div class="review-detail-prompt-footer" id="review-detail-prompt-footer"></div>
        </div>
      </div>
    </div>
  `;

  const promptWrap = overlay.querySelector('.review-detail-prompt-wrap');
  const suggestionsEl = overlay.querySelector('#review-detail-suggestions');

  const reviewNodeId = node?.dataset?.nodeId || '';
  const baseOptions = {
    promptSections: sectionsForDisplay || [],
    suggestions: saved?.suggestions || [],
    promptFullText: saved?.promptFullText || '',
    saved: saved || {},
    onReviewResultChange: updateReviewResult || null,
    onExportNewPrompt: onExportNewPrompt || null,
    getIsReviewStreaming: getIsReviewStreaming || null,
    getPayload: getPayload || null,
    getReviewResult: getReviewResult || null,
    reviewNodeId: reviewNodeId || null,
  };

  function refreshFromSaved(data) {
    if (!data || typeof data !== 'object') return;
    baseOptions.saved = data;
    baseOptions.promptSections = (Array.isArray(data.promptSections) && data.promptSections.length > 0) ? data.promptSections : baseOptions.promptSections;
    baseOptions.suggestions = Array.isArray(data.suggestions) ? data.suggestions : baseOptions.suggestions;
    buildReviewResultUI(overlay, baseOptions);
  }

  function onSaveReviewResult(e) {
    if (e.detail?.reviewNodeId !== reviewNodeId) return;
    const detailData = e.detail?.data;
    // 延后到微任务：先让 workflowCanvas 的 save-review-result 监听器把合并后的结果写入 dataset，再读节点，避免监听器顺序导致读到旧快照。
    queueMicrotask(() => {
      const data =
        (typeof getReviewResult === 'function' ? getReviewResult() : null) ?? detailData;
      if (!data || typeof data !== 'object') return;
      // 流水线已结束时必须整页 refresh（Issue analysis / 建议列表）；reconcile 只合并已有卡片，不会重建 row_diagnostics。
      refreshFromSaved(data);
    });
  }

  if (hasResult) {
    buildReviewResultUI(overlay, baseOptions);
  } else {
    const streaming = typeof getIsReviewStreaming === 'function' && getIsReviewStreaming();
    const staleSaved = saved && typeof saved === 'object' && saved.streamComplete === false && !streaming;
    const msg = staleSaved ? REVIEW_INCOMPLETE_USER_MSG : 'Running analysis…';
    if (!promptWrap.innerHTML.trim()) promptWrap.innerHTML = `<p class="review-detail-placeholder">${escapeHtml(msg)}</p>`;
    suggestionsEl.innerHTML = `<p class="review-detail-placeholder">${escapeHtml(msg)}</p>`;
  }

  // Apply debug mode: fetch settings once and toggle the --debug class on suggestionsEl.
  // The class persists across buildReviewResultUI re-renders since they only modify content inside suggestionsEl.
  fetch(`${API_BASE}/api/settings`)
    .then((r) => r.ok ? r.json() : null)
    .then((s) => {
      suggestionsEl.classList.toggle('review-detail-suggestions--debug', s?.debug_mode === true);
    })
    .catch(() => {});

  if (reviewNodeId) {
    document.addEventListener('workflow:save-review-result', onSaveReviewResult);
  }

  overlay.querySelector('.modal-close').addEventListener('click', close);
  const reviewPaneToggle = attachModalPaneToggle({
    overlay,
    isCollapsed: () => overlay.classList.contains('modal-overlay--left-pane-collapsed'),
    onToggle: () => {
      overlay.classList.toggle('modal-overlay--left-pane-collapsed');
      reviewPaneToggle.update();
    },
    expandedLabel: 'Hide findings panel',
    collapsedLabel: 'Show findings panel',
  });

  function close() {
    if (reviewNodeId) document.removeEventListener('workflow:save-review-result', onSaveReviewResult);
    delete overlay._reviewDetailReconcile;
    overlay.remove();
    document.body.style.overflow = '';
  }

  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);
}

