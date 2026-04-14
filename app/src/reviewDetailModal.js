/**
 * Review: left = prompt in prompt-detail style; right = suggestions.
 * Hover a suggestion: left shows that section with red (removed) / green (added) minimal diff.
 * Result is saved on the Score node and persisted with the project.
 */

import { showConfirm, showAlert } from './alertModal.js';
import { comparisonRowIsMatched } from './scoreDetailModal.js';
import {
  runSuggestionRowTests,
  abortAllVerifyJobs,
  registerVerifySession,
  unregisterVerifySession,
  hasActiveVerifySessions,
} from './reviewSuggestionTest.js';
import {
  runSuggestionFinetuneMIPROv2,
  runSuggestionFinetuneCompositional,
  abortAllFinetuneJobs,
  registerFinetuneSession,
  unregisterFinetuneSession,
  hasActiveFinetuneSessions,
} from './reviewSuggestionFinetune.js';
import {
  rebuildWorkingFromApplied,
  getLocatableSegment,
  effectiveNewSentenceForApply,
  suggestionTargetInputRowIndices,
  suggestionNeedsAutoRowCheck,
} from './reviewWorkingSections.js';
import { normalizeUnicodeDashesForDisplay } from './displayTextNormalize.js';
import {
  ensureReviewResultIds,
  ensureSuggestionObjectId,
  formatSuggestionIdDisplay,
  parseNumericSuggestionId,
} from './reviewSuggestionIds.js';

const API_BASE = 'http://localhost:8000';

/** LLM stream ends here; remaining bar is Run+Score checks (most wall time). Must match workflowCanvas. */
const REVIEW_PROGRESS_PIPELINE_DONE = 30;
const REVIEW_PROGRESS_CHECK_SPAN = 100 - REVIEW_PROGRESS_PIPELINE_DONE;

/** Only on full app/tab unload: cancel in-flight row-check + Finetune HTTP/poll. Closing the review modal does NOT call this — jobs keep running and persist when done. */
function abortReviewBackgroundJobsOnAppUnload() {
  abortAllFinetuneJobs();
  abortAllVerifyJobs();
}

/** After Run+Score row check succeeds (shown next to suggestion title; clearer than “Passed”). */
const REVIEW_SUGGESTION_ROWCHECK_PASS_LABEL = 'Verified';
/** Row check failed (title pill); same label always. Modifier class makes it clickable when finetune can start. */
const REVIEW_SUGGESTION_ROWCHECK_FAIL_TRY_FINETUNE = 'Click to Finetune';
/** Row-check (Run+Score) in progress for this card. */
const REVIEW_SUGGESTION_VERIFYING_LABEL = 'Verifying';
/** Finetune optimization finished (title pill). */
const REVIEW_SUGGESTION_FINETUNED_PILL_LABEL = 'Finetuned';
/** Title tag for assistant-owned edits: dialogue proposal, not pipeline verify. */
const REVIEW_SUGGESTION_PROPOSAL_TAG_LABEL = 'Proposal';
const REVIEW_SUGGESTION_PROPOSAL_TAG_ARIA = 'Edit proposed in chat; not Run+Score verified';

const REVIEW_FINETUNE_LABEL_TUNING = 'Finetuning';

/** Finetuned suggestions may store row-check in `review_test_result_finetune_after`; otherwise legacy `review_test_result`. */
const REVIEW_TEST_RESULT_FINETUNE_AFTER = 'review_test_result_finetune_after';
const REVIEW_TEST_RESULT_FINETUNE_BEFORE = 'review_test_result_finetune_before';

/** True when finetune finished and meta has a distinct pre-finetune proposal (row-check targets finetuned `new_sentence` only). */
function suggestionFinetuneHasBeforeAfterText(sug) {
  if (!sug || sug.review_finetune_completed !== true) return false;
  const meta = sug.review_finetune_meta && typeof sug.review_finetune_meta === 'object' ? sug.review_finetune_meta : null;
  const beforeRaw = meta && typeof meta.newSentenceBeforeFinetune === 'string' ? meta.newSentenceBeforeFinetune : '';
  const before = String(beforeRaw);
  const after = String(sug.new_sentence ?? '');
  return before.trim() !== '' && before !== after;
}

/** When true, row-check fail pill must not offer 'Click to Finetune' (tuning, or tuned with no retry). */
function suggestionFinetuneRowCheckNudgeBlocked(sug) {
  if (sug.review_finetune_in_progress === true) return true;
  if (sug.review_finetune_completed === true) return !suggestionFinetuneHasBeforeAfterText(sug);
  return false;
}

/** True when row-check fail pill should start finetune on click (idle, locatable, not blocked / already tuned). */
function rowCheckFailPillCanStartFinetune(sug, noButton) {
  if (noButton || getSuggestionTestOutcome(sug) !== 'fail') return false;
  if (sug.review_finetune_in_progress === true) return false;
  if (suggestionFinetuneRowCheckNudgeBlocked(sug)) return false;
  if (sug.review_finetune_completed === true) return false;
  return true;
}

const REVIEW_SUGGESTION_TITLE_PILL_CLASS = 'review-suggestion-title-pill';

/**
 * At most one title pill. Pipeline: verify/finetune state. Assistant: only the Proposal tag.
 */
function collectSuggestionTitlePills(sug, noButton, actionsFull) {
  if (!sug || typeof sug !== 'object') return [];
  if (String(sug.source || '').toLowerCase() === 'assistant') {
    return [
      {
        cls: 'review-suggestion-proposal-tag-pill',
        text: REVIEW_SUGGESTION_PROPOSAL_TAG_LABEL,
        ariaLabel: REVIEW_SUGGESTION_PROPOSAL_TAG_ARIA,
      },
    ];
  }
  if (sug.review_finetune_in_progress === true) {
    return [{ cls: 'review-suggestion-tuning-pill', text: REVIEW_FINETUNE_LABEL_TUNING }];
  }
  if (sug.review_finetune_completed === true && isReviewRowCheckInProgress(sug)) {
    return [{ cls: 'review-suggestion-tuning-pill', text: REVIEW_FINETUNE_LABEL_TUNING }];
  }
  if (sug.review_finetune_completed === true) {
    const fo = getSuggestionTestOutcome(sug);
    let finCls = 'review-suggestion-finetuned-pill';
    if (fo === 'pass') finCls += ' review-suggestion-finetuned-pill--pass';
    else if (fo === 'fail') finCls += ' review-suggestion-finetuned-pill--fail';
    return [{ cls: finCls, text: REVIEW_SUGGESTION_FINETUNED_PILL_LABEL }];
  }
  if (isReviewRowCheckInProgress(sug)) {
    return [{ cls: 'review-suggestion-verifying-pill', text: REVIEW_SUGGESTION_VERIFYING_LABEL }];
  }
  if (actionsFull) {
    const outcome = getSuggestionTestOutcome(sug);
    if (outcome === 'pass') {
      return [{ cls: 'review-suggestion-verified-pill', text: REVIEW_SUGGESTION_ROWCHECK_PASS_LABEL }];
    }
    if (outcome === 'fail') {
      const clickFinetune = rowCheckFailPillCanStartFinetune(sug, noButton);
      const text = REVIEW_SUGGESTION_ROWCHECK_FAIL_TRY_FINETUNE;
      return [
        {
          cls:
            'review-suggestion-rowcheck-fail-pill' +
            (clickFinetune ? ' review-suggestion-rowcheck-fail-pill--click-finetune' : ''),
          text,
          clickFinetune,
        },
      ];
    }
  }
  return [];
}

function buildSuggestionTitlePillsHtml(sug, noButton, actionsFull) {
  return collectSuggestionTitlePills(sug, noButton, actionsFull)
    .map((spec) => {
      if (spec.clickFinetune === true) {
        return `<button type="button" class="${spec.cls} ${REVIEW_SUGGESTION_TITLE_PILL_CLASS}" aria-label="Finetune this suggestion" data-review-title-pill-action="finetune">${escapeHtml(spec.text)}</button>`;
      }
      const aria =
        typeof spec.ariaLabel === 'string' && spec.ariaLabel.trim()
          ? ` aria-label="${escapeHtml(spec.ariaLabel)}"`
          : '';
      return `<span class="${spec.cls} ${REVIEW_SUGGESTION_TITLE_PILL_CLASS}"${aria}>${escapeHtml(spec.text)}</span>`;
    })
    .join('');
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    abortReviewBackgroundJobsOnAppUnload();
  });
}

/** Shown when persisted review has streamComplete:false but no live job (e.g. app closed mid-review). Mirrors Run: “Last run did not complete.” */
const REVIEW_INCOMPLETE_USER_MSG = 'Last review did not complete. Please run Review again.';

/** Sliding window for /api/chat: max user+assistant messages (≈20 turns if strictly alternating). Full history still kept in UI and project JSON. */
const REVIEW_ASSISTANT_MAX_MESSAGES = 40;

/** Shown when the Review assistant chat is empty (or after clear). */
const REVIEW_ASSISTANT_WELCOME_MSG = 'Chat here about prompt changes.';

/**
 * Take only the newest messages so the request stays within context limits.
 * If the slice starts with an assistant message, drop from the front until a user message leads (clearer for the model).
 */
function sliceChatHistoryForApi(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;
  if (messages.length <= REVIEW_ASSISTANT_MAX_MESSAGES) return messages.slice();
  let sliced = messages.slice(-REVIEW_ASSISTANT_MAX_MESSAGES);
  while (sliced.length > 1 && sliced[0].role !== 'user') {
    sliced = sliced.slice(1);
  }
  return sliced;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = normalizeUnicodeDashesForDisplay(String(str ?? ''));
  return div.innerHTML;
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
 */
function formatScoreTableTargetLabels(comparisonRows, zeroBasedRowIndices) {
  if (!Array.isArray(zeroBasedRowIndices) || zeroBasedRowIndices.length === 0) return '';
  return zeroBasedRowIndices
    .map((idx) => {
      const t = scoreTableRowNumberForComparisonIndex(comparisonRows, idx);
      return t != null ? `#${t}` : `(row_index ${idx})`;
    })
    .join(', ');
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
 * @param {{ row_index: number, row_indices?: number[], card_title?: string, issue_summary: string, rough_modification_opinion: string, problem_category_hint?: string }} diagnostic
 * @param {Array<Record<string, unknown>>} comparisonRows - saved comparison rows (for score_table_row lookup)
 * @param {number} displayNumber - 1-based order in the Issue analysis list (same as # on the card)
 */
function openRowDiagnosisDetailOverlay(diagnostic, comparisonRows, displayNumber) {
  const num = Math.max(1, parseInt(String(displayNumber), 10) || 1);
  const issue = (diagnostic.issue_summary || '').trim();
  const rough = (diagnostic.rough_modification_opinion || '').trim();
  const cardTitle = (diagnostic.card_title || '').trim();
  const rows = Array.isArray(comparisonRows) ? comparisonRows : [];
  const multiIdx = Array.isArray(diagnostic.row_indices) && diagnostic.row_indices.length > 1
    ? diagnostic.row_indices
    : null;
  const sourceLine = multiIdx
    ? `Score table ${formatScoreTableTargetLabels(rows, multiIdx)}`
    : (() => {
      const t = scoreTableRowNumberForComparisonIndex(rows, diagnostic.row_index);
      return t != null
        ? `Score table #${t}`
        : `Score comparison (row_index ${diagnostic.row_index})`;
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
  const isAssistant = String(sug.source || '').toLowerCase() === 'assistant';

  let detailBodyHtml;
  if (isAssistant) {
    const inputIdx = suggestionTargetInputRowIndices(sug);
    const compRows = Array.isArray(meta?.comparisonRows) ? meta.comparisonRows : [];
    const scoreLbl = formatScoreTableTargetLabels(compRows, inputIdx);
    const scorePhrase = scoreLbl !== '' ? `Score table ${scoreLbl}` : '';
    const chatFocus = String(sug.chat_focus || '').trim();
    const bullets = Array.isArray(sug.chat_focus_bullets)
      ? sug.chat_focus_bullets.map((x) => String(x || '').trim()).filter(Boolean)
      : [];
    const respondsToHead = scorePhrase
      ? `<span class="review-diagnosis-detail-lead">Focus:</span> ${escapeHtml(scorePhrase)}`
      : chatFocus
        ? `<span class="review-diagnosis-detail-lead">Focus:</span> ${escapeHtml(chatFocus)}`
        : `<span class="review-diagnosis-detail-lead">Focus:</span>`;
    const focusHtml = bullets.length
      ? `<p class="review-diagnosis-detail-prose">${respondsToHead}</p><ul class="review-suggestion-detail-list">${bullets.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>`
      : `<p class="review-diagnosis-detail-prose">${respondsToHead} <span class="review-diagnosis-detail-empty">(none)</span></p>`;
    const rationalePara = `<p class="review-diagnosis-detail-prose"><span class="review-diagnosis-detail-lead">Rationale:</span> ${
      reason ? escapeHtml(reason) : '<span class="review-diagnosis-detail-empty">(none)</span>'
    }</p>`;
    detailBodyHtml = focusHtml + rationalePara;
  } else {
    const inputIdx = suggestionTargetInputRowIndices(sug);
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
    detailBodyHtml =
      respondsToHtml +
      `<p class="review-diagnosis-detail-prose"><span class="review-diagnosis-detail-lead">Rationale:</span> ${reason ? escapeHtml(reason) : '<span class="review-diagnosis-detail-empty">(none)</span>'}</p>`;
  }

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

function suggestionHasAnyTerminalTestOutcome(s) {
  if (!s || typeof s !== 'object') return false;
  const a = s[REVIEW_TEST_RESULT_FINETUNE_AFTER];
  const b = s[REVIEW_TEST_RESULT_FINETUNE_BEFORE];
  const c = s.review_test_result;
  if (a === 'pass' || a === 'fail' || b === 'pass' || b === 'fail' || c === 'pass' || c === 'fail') return true;
  if (s.review_test_passed === true) return true;
  return false;
}

function clearFinetuneRowCheckOutcome(sug) {
  if (!sug || typeof sug !== 'object') return;
  if (!suggestionFinetuneHasBeforeAfterText(sug)) {
    delete sug.review_test_result;
    delete sug.review_test_passed;
    return;
  }
  delete sug[REVIEW_TEST_RESULT_FINETUNE_AFTER];
  delete sug[REVIEW_TEST_RESULT_FINETUNE_BEFORE];
  delete sug.review_test_result;
  delete sug.review_test_passed;
}

function setFinetuneRowCheckOutcome(sug, outcome) {
  if (!sug || typeof sug !== 'object') return;
  if (outcome !== 'pass' && outcome !== 'fail') return;
  if (!suggestionFinetuneHasBeforeAfterText(sug)) {
    sug.review_test_result = outcome;
    delete sug.review_test_passed;
    return;
  }
  sug[REVIEW_TEST_RESULT_FINETUNE_AFTER] = outcome;
  delete sug[REVIEW_TEST_RESULT_FINETUNE_BEFORE];
  delete sug.review_test_result;
  delete sug.review_test_passed;
}

/** @returns {'pass'|'fail'|null} */
function getSuggestionTestOutcomeAfterSlot(sug) {
  if (!sug || typeof sug !== 'object') return null;
  const rAfter = sug[REVIEW_TEST_RESULT_FINETUNE_AFTER];
  if (rAfter === 'pass' || rAfter === 'fail') return rAfter;
  const legacy = sug.review_test_result;
  if (legacy === 'pass' || legacy === 'fail') return legacy;
  if (sug.review_test_passed === true) return 'pass';
  return null;
}

/** @returns {'pass'|'fail'|null} */
function getSuggestionTestOutcome(sug) {
  if (!sug || typeof sug !== 'object') return null;
  if (suggestionFinetuneHasBeforeAfterText(sug)) return getSuggestionTestOutcomeAfterSlot(sug);
  const r = sug.review_test_result;
  if (r === 'pass' || r === 'fail') return r;
  if (sug.review_test_passed === true) return 'pass';
  return null;
}

/** Row-check (Run+Score) in flight on this suggestion — use everywhere UI reads this flag (reconcile/persist may not be strict boolean). */
function isReviewRowCheckInProgress(sug) {
  if (!sug || typeof sug !== 'object') return false;
  const v = sug.review_test_in_progress;
  return v === true || v === 1;
}

/** Truncated title line for suggestion cards (pass/fail shown via pill / not at all, not in the title string). */
function formatSuggestionCardPreviewTitle(titleLine) {
  const baseRaw = normalizeUnicodeDashesForDisplay(String(titleLine ?? ''));
  return truncateWithEllipsis(baseRaw, SUGGESTION_CARD_PREVIEW_TITLE_CHARS);
}

function clearSuggestionTestOutcome(sug) {
  if (!sug || typeof sug !== 'object') return;
  delete sug.review_test_result;
  delete sug.review_test_passed;
  delete sug[REVIEW_TEST_RESULT_FINETUNE_AFTER];
  delete sug[REVIEW_TEST_RESULT_FINETUNE_BEFORE];
  delete sug.review_test_in_progress;
}

/**
 * Clear stale `review_test_in_progress` only when no row-check session is active (e.g. app killed).
 * If a job is still running in the background, keep the flag so reopen shows progress.
 */
function stripAbortedReviewTests(suggestions) {
  if (!Array.isArray(suggestions)) return false;
  if (hasActiveVerifySessions()) return false;
  let changed = false;
  for (const s of suggestions) {
    if (!s || typeof s !== 'object') continue;
    if (isReviewRowCheckInProgress(s)) {
      delete s.review_test_in_progress;
      if (!suggestionHasAnyTerminalTestOutcome(s)) {
        delete s.review_test_result;
        delete s.review_test_passed;
        delete s[REVIEW_TEST_RESULT_FINETUNE_AFTER];
        delete s[REVIEW_TEST_RESULT_FINETUNE_BEFORE];
      }
      changed = true;
    }
  }
  return changed;
}

/**
 * Drop persisted finetune-in-progress only when no finetune session is active (crash / stale JSON).
 * While Finetune runs in the background after closing the modal, keep flags so reopen shows "Finetuning".
 */
function clearStaleFinetuneRunningFlags(suggestions) {
  if (!Array.isArray(suggestions)) return false;
  if (hasActiveFinetuneSessions()) return false;
  let changed = false;
  for (const s of suggestions) {
    if (!s || typeof s !== 'object') continue;
    if (s.review_finetune_in_progress === true || s.review_finetune_progress != null) {
      delete s.review_finetune_in_progress;
      delete s.review_finetune_progress;
      changed = true;
    }
  }
  return changed;
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
    ? saved.row_diagnostics
      .map((d) => {
        const rid = Number(d && d.row_index);
        const ri = Array.isArray(d && d.row_indices)
          ? d.row_indices.map((x) => Number(x)).filter((x) => !Number.isNaN(x))
          : [];
        return {
          row_index: rid,
          row_indices: ri.length ? ri : (!Number.isNaN(rid) ? [rid] : []),
          card_title: String((d && d.card_title) || ''),
          issue_summary: String((d && d.issue_summary) || ''),
          rough_modification_opinion: String((d && d.rough_modification_opinion) || ''),
          problem_category_hint: String((d && d.problem_category_hint) || ''),
        };
      })
      .filter((d) => !Number.isNaN(d.row_index))
    : [];
  rowDiagnostics.sort((a, b) => a.row_index - b.row_index);

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
      const r = data.suggestions.find((x) => x && String(x.suggestion_id) === String(id));
      if (r && typeof r === 'object') {
        const keepInProgress =
          hasActiveVerifySessions() &&
          isReviewRowCheckInProgress(loc) &&
          !isReviewRowCheckInProgress(r);
        Object.assign(loc, r);
        if (keepInProgress) loc.review_test_in_progress = true;
      }
    }
  }

  function refreshAllEditSuggestionCardsVisuals() {
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
    const suggestionsToSave = allSuggestions.map((s) => {
      const next = { ...s, applied: s.applied === true };
      delete next._finetuneAbort;
      delete next._finetunePersistScheduled;
      return next;
    });
    const live = typeof getReviewResult === 'function' ? getReviewResult() : null;
    const base = live && typeof live === 'object' ? { ...live } : { ...saved };
    const next = {
      ...base,
      summary: base.summary ?? saved.summary ?? '',
      suggestions: suggestionsToSave,
      design_suggestions: [],
      data_refinement: dataRefinement,
      row_diagnostics: rowDiagnostics,
      promptSections: base.promptSections ?? saved.promptSections ?? promptSections,
      promptFullText: base.promptFullText ?? saved.promptFullText ?? promptFullText,
      workingSections: working.map((s) => ({ name: s.name, content: s.content })),
    };
    delete next.review_finetune_last_result;
    onReviewResultChange(next);
    refreshAllEditSuggestionCardsVisuals();
  }

  if (stripAbortedReviewTests(allSuggestions) && typeof onReviewResultChange === 'function') {
    persistWorking();
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

  /** Shared Run+Score check: prompt = originals + only this suggestion applied (ignore other accepted rows). */
  async function runRowVerifyWithPayload(sug, sugIdx, payload, signal) {
    const targets = suggestionTargetInputRowIndices(sug);
    if (targets.length === 0) return { emptyTargets: true };
    const patched = allSuggestions.map((s, i) => ({ ...s, applied: i === sugIdx }));
    const testSections = rebuildWorkingFromApplied(originals, patched);
    if (!testSections || testSections.length !== originals.length) {
      return { buildError: true };
    }
    const runWs = typeof payload.getRunWorkingSetContent === 'function' ? payload.getRunWorkingSetContent() : null;
    const gtContent = typeof payload.getGroundTruthContent === 'function' ? payload.getGroundTruthContent() : null;
    const result = await runSuggestionRowTests({
      apiBase: API_BASE,
      credentialId: payload.run_credential_id,
      testSections,
      targetComparisonRowIndices: targets,
      comparisonRows: payload.comparison_rows || [],
      runResults: payload.run_results || [],
      outputFields: payload.output_fields || [],
      outputSchema: payload.output_schema,
      scoreMappingJson: payload.score_mapping || '[]',
      runWs: runWs || { headers: [], rows: [] },
      gtContent: gtContent || { headers: [], rows: [] },
      signal,
    });
    return { result };
  }

  /** Run+Score check for one card (e.g. after finetune completes). Always re-resolve the card from the DOM so refresh/reconcile cannot leave a stale element reference. */
  async function runAutoRowCheckForSuggestion(sugIdx) {
    const sug = allSuggestions[sugIdx];
    if (!sug || typeof sug !== 'object') return;
    if (isReviewStreamingNow()) return;
    if (typeof getPayload !== 'function') return;
    if (suggestionTargetInputRowIndices(sug).length === 0) return;

    function cardEl() {
      return editContainer.querySelector(`.review-detail-suggestion-card[data-suggestion-index="${sugIdx}"]`);
    }
    function paintCard() {
      const el = cardEl();
      if (el) updateSuggestionTestOutcomeVisual(el, sug, suggestionActionsFullForCard(sug), originals, promptSections);
    }

    const verifyAc = new AbortController();
    registerVerifySession(verifyAc);

    function exitBeforeVerifyRequest() {
      delete sug.review_test_in_progress;
      paintCard();
      persistWorking();
    }

    try {
      sug.review_test_in_progress = true;
      persistWorking();
      paintCard();

      let payload;
      try {
        payload = await getPayload();
      } catch (_) {
        exitBeforeVerifyRequest();
        return;
      }
      if (!payload || !payload.run_credential_id) {
        exitBeforeVerifyRequest();
        return;
      }
      if (!payload.output_schema || !Array.isArray(payload.output_schema.fields) || payload.output_schema.fields.length === 0) {
        exitBeforeVerifyRequest();
        return;
      }

      try {
        const out = await runRowVerifyWithPayload(sug, sugIdx, payload, verifyAc.signal);
        if (out.emptyTargets) {
          clearFinetuneRowCheckOutcome(sug);
        } else if (out.buildError) {
          setFinetuneRowCheckOutcome(sug, 'fail');
        } else {
          const { result } = out;
          if (result.aborted) {
            clearFinetuneRowCheckOutcome(sug);
          } else if (result.ok) {
            setFinetuneRowCheckOutcome(sug, 'pass');
          } else {
            setFinetuneRowCheckOutcome(sug, 'fail');
          }
        }
      } catch (err) {
        if (isReviewRowCheckInProgress(sug)) {
          if (err && err.name === 'AbortError') {
            clearFinetuneRowCheckOutcome(sug);
          } else {
            setFinetuneRowCheckOutcome(sug, 'fail');
          }
        }
      }
    } finally {
      unregisterVerifySession(verifyAc);
      delete sug.review_test_in_progress;
      paintCard();
      persistWorking();
    }
  }

  let pipelineAutoCheckInFlight = false;

  function clearAllPipelineAutoCheckInProgressFlags() {
    for (const sug of allSuggestions) {
      if (!sug || typeof sug !== 'object') continue;
      delete sug.review_test_in_progress;
    }
  }

  let editCardsRefreshScheduled = false;
  function scheduleEditSuggestionCardsRefresh() {
    if (editCardsRefreshScheduled) return;
    editCardsRefreshScheduled = true;
    queueMicrotask(() => {
      editCardsRefreshScheduled = false;
      renderEditSuggestionCards();
      updateSuggestionsFooter();
    });
  }

  async function runPipelineAutoCheckAfterStreamDone() {
    if (pipelineAutoCheckInFlight) return;
    if (typeof getPayload !== 'function') {
      persistReviewProgressToNode(100);
      return;
    }
    pipelineAutoCheckInFlight = true;
    try {
      let payload;
      try {
        payload = await getPayload();
      } catch (_) {
        clearAllPipelineAutoCheckInProgressFlags();
        persistWorking();
        persistReviewProgressToNode(100);
        return;
      }
      if (!payload || !payload.run_credential_id) {
        clearAllPipelineAutoCheckInProgressFlags();
        persistWorking();
        persistReviewProgressToNode(100);
        return;
      }
      if (!payload.output_schema || !Array.isArray(payload.output_schema.fields) || payload.output_schema.fields.length === 0) {
        clearAllPipelineAutoCheckInProgressFlags();
        persistWorking();
        persistReviewProgressToNode(100);
        return;
      }
      const indicesToVerify = [];
      for (let sugIdx = 0; sugIdx < allSuggestions.length; sugIdx++) {
        const s = allSuggestions[sugIdx];
        if (String(s?.source || '').toLowerCase() === 'assistant') continue;
        if (suggestionNeedsAutoRowCheck(s, originals, promptSections)) indicesToVerify.push(sugIdx);
      }
      const verifyTotal = indicesToVerify.length;
      if (verifyTotal === 0) {
        clearAllPipelineAutoCheckInProgressFlags();
        persistWorking();
        persistReviewProgressToNode(100);
        return;
      }
      const batchAc = new AbortController();
      registerVerifySession(batchAc);
      try {
        let verifyDone = 0;
        const tasks = indicesToVerify.map((sugIdx) => (async () => {
          const sug = allSuggestions[sugIdx];
          persistWorking();

          try {
            const out = await runRowVerifyWithPayload(sug, sugIdx, payload, batchAc.signal);
            if (out.emptyTargets) {
              /* no outcome */
            } else if (out.buildError) {
              setFinetuneRowCheckOutcome(sug, 'fail');
            } else {
              const { result } = out;
              try {
                if (result.aborted) {
                  clearFinetuneRowCheckOutcome(sug);
                } else if (result.ok) {
                  setFinetuneRowCheckOutcome(sug, 'pass');
                } else {
                  setFinetuneRowCheckOutcome(sug, 'fail');
                }
              } catch (err) {
                if (err && err.name === 'AbortError') {
                  clearFinetuneRowCheckOutcome(sug);
                } else {
                  setFinetuneRowCheckOutcome(sug, 'fail');
                }
              }
            }
          } catch (err) {
            if (isReviewRowCheckInProgress(sug)) {
              if (err && err.name === 'AbortError') {
                clearFinetuneRowCheckOutcome(sug);
              } else {
                setFinetuneRowCheckOutcome(sug, 'fail');
              }
            }
          } finally {
            delete sug.review_test_in_progress;
            persistWorking();
            verifyDone += 1;
            emitReviewBarProgress(
              REVIEW_PROGRESS_PIPELINE_DONE + Math.round((REVIEW_PROGRESS_CHECK_SPAN * verifyDone) / verifyTotal),
            );
            scheduleEditSuggestionCardsRefresh();
          }
        })());
        await Promise.all(tasks);
      } finally {
        unregisterVerifySession(batchAc);
      }
      persistReviewProgressToNode(100);
    } finally {
      pipelineAutoCheckInFlight = false;
    }
  }

  /** Full actions per card: stream still running, or this suggestion's auto row-check not in flight (or not needed). */
  function suggestionActionsFullForCard(sug) {
    const isAssistant = sug && String(sug.source || '').toLowerCase() === 'assistant';
    /* Assistant edits: full actions (View detail + Accept); title shows Proposal tag only. */
    if (isAssistant) return true;
    if (saved.streamComplete !== true) {
      return allSuggestions.length === 0;
    }
    if (!suggestionNeedsAutoRowCheck(sug, originals, promptSections)) return true;
    return !isReviewRowCheckInProgress(sug);
  }

  /** Title-line “Click to Finetune” only: one listener per pill (pipeline suggestions). */
  function wireInteractiveTitlePillsOnCard(card) {
    if (!card) return;
    card.querySelectorAll('[data-review-title-pill-action="finetune"]').forEach((pill) => {
      const onActivate = (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        const sugIdx = parseInt(card.dataset.suggestionIndex, 10);
        if (Number.isNaN(sugIdx) || !allSuggestions[sugIdx]) return;
        const sug = allSuggestions[sugIdx];
        void handleFinetuneActionForCard(card, sug, sugIdx);
      };
      pill.addEventListener('click', onActivate);
      pill.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        onActivate(e);
      });
    });
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
      titleWrap.querySelectorAll(`.${REVIEW_SUGGESTION_TITLE_PILL_CLASS}`).forEach((el) => el.remove());
      const specs = collectSuggestionTitlePills(sug, noButton, actionsFull);
      for (const spec of specs) {
        const interactive = spec.clickFinetune === true;
        const el = document.createElement(interactive ? 'button' : 'span');
        if (interactive) el.type = 'button';
        el.className = `${spec.cls} ${REVIEW_SUGGESTION_TITLE_PILL_CLASS}`;
        el.textContent = spec.text;
        if (spec.clickFinetune === true) {
          el.setAttribute('aria-label', 'Finetune this suggestion');
          el.setAttribute('data-review-title-pill-action', 'finetune');
        } else if (typeof spec.ariaLabel === 'string' && spec.ariaLabel.trim()) {
          el.setAttribute('aria-label', spec.ariaLabel);
        }
        titleWrap.appendChild(el);
      }
      wireInteractiveTitlePillsOnCard(card);
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

  /** After stream: show cards (View detail only while that card's check runs), concurrent checks, unlock per card when done. */
  async function revealSuggestionsAfterReview() {
    if (!allSuggestions || allSuggestions.length === 0) {
      renderEditSuggestionCards();
      updateSuggestionsFooter();
      persistReviewProgressToNode(100);
      return;
    }
    const willRunChecks =
      typeof getPayload === 'function' &&
      allSuggestions.some(
        (s) =>
          String(s.source || '').toLowerCase() !== 'assistant' &&
          suggestionNeedsAutoRowCheck(s, originals, promptSections),
      );
    if (willRunChecks) {
      for (const sug of allSuggestions) {
        if (String(sug.source || '').toLowerCase() === 'assistant') continue;
        if (suggestionNeedsAutoRowCheck(sug, originals, promptSections)) {
          sug.review_test_in_progress = true;
        }
      }
      persistWorking();
    }
    renderEditSuggestionCards();
    updateSuggestionsFooter();
    try {
      if (typeof getPayload === 'function') {
        await runPipelineAutoCheckAfterStreamDone();
      } else {
        persistReviewProgressToNode(100);
      }
    } finally {
      renderEditSuggestionCards();
      updateSuggestionsFooter();
    }
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

  async function handleFinetuneActionForCard(card, sug, sugIdx) {
    const actionsFull = suggestionActionsFullForCard(sug);
    if (sug.review_finetune_completed === true) return;
    if (sug.review_finetune_in_progress === true) return;
    if (isReviewRowCheckInProgress(sug)) return;
    if (isReviewStreamingNow()) {
      showAlert('Wait until the review finishes before running finetune.', { title: 'Review in progress' });
      return;
    }
    const targets = suggestionTargetInputRowIndices(sug);
    if (targets.length === 0) {
      showAlert('This suggestion has no target input rows.', { title: 'Cannot finetune' });
      return;
    }
    const oldSentence = (sug.old_sentence || '').trim();
    if (typeof getPayload !== 'function') return;
    let finetuneAc = null;
    try {
      const payload = await getPayload();
      if (!payload || !payload.run_credential_id) {
        showAlert('Configure a Run credential on the Run node, then try again.', { title: 'Missing credential' });
        return;
      }
      if (!payload.output_schema || !Array.isArray(payload.output_schema.fields) || payload.output_schema.fields.length === 0) {
        showAlert('The prompt needs an output schema (Run / prompt settings) to finetune.', { title: 'Missing output schema' });
        return;
      }
      const improvementRationale = String(sug.reason || '').trim();
      finetuneAc = new AbortController();
      registerFinetuneSession(finetuneAc);
      sug._finetuneAbort = finetuneAc;
      sug.review_finetune_in_progress = true;
      updateSuggestionTestOutcomeVisual(card, sug, actionsFull, originals, promptSections);
      persistWorking();
      const runWs = typeof payload.getRunWorkingSetContent === 'function' ? payload.getRunWorkingSetContent() : null;
      const gtContent = typeof payload.getGroundTruthContent === 'function' ? payload.getGroundTruthContent() : null;
      let reviewCredForFinetune = '';
      let miprov2Auto = 'light';
      let finetuneMode = 'miprov2';
      let compMaxTrials = 40;
      let compCandidates = 4;
      let compMaxSegments = 5;
      try {
        const sres = await fetch(`${API_BASE}/api/settings`);
        if (sres.ok) {
          const s = await sres.json();
          reviewCredForFinetune = String(s.default_review_credential_id || '').trim();
          const a = String(s.review_finetune_miprov2_auto || 'light').trim().toLowerCase();
          if (a === 'medium' || a === 'heavy') miprov2Auto = a;
          const m = String(s.review_finetune_mode || 'miprov2').trim().toLowerCase();
          finetuneMode = m === 'compositional' ? 'compositional' : 'miprov2';
          compMaxTrials = Math.min(200, Math.max(8, Number(s.review_finetune_comp_max_trials) || 40));
          compCandidates = Math.min(8, Math.max(2, Number(s.review_finetune_comp_candidates_per_segment) || 4));
          compMaxSegments = Math.min(8, Math.max(2, Number(s.review_finetune_comp_max_segments) || 5));
        }
      } catch (_) {
        /* use defaults */
      }
      if (!reviewCredForFinetune) reviewCredForFinetune = payload.run_credential_id;
      if (finetuneMode === 'compositional' && !improvementRationale) {
        showAlert('Compositional finetune needs this suggestion’s reason (from Review). Re-run review or pick an edit that includes a reason.', {
          title: 'Missing reason',
        });
        return;
      }
      const proposalNew = (sug.new_sentence || '').trim();
      const onFinetuneProgress = ({ trial, trials }) => {
        sug.review_finetune_progress = { trial, trials };
        if (!sug._finetunePersistScheduled) {
          sug._finetunePersistScheduled = true;
          requestAnimationFrame(() => {
            delete sug._finetunePersistScheduled;
            persistWorking();
          });
        }
      };
      let result;
      if (finetuneMode === 'compositional') {
        result = await runSuggestionFinetuneCompositional({
          apiBase: API_BASE,
          llmCredentialId: reviewCredForFinetune,
          runCredentialId: payload.run_credential_id,
          oldSentence,
          newSentence: proposalNew,
          improvementRationale,
          maxSegments: compMaxSegments,
          candidatesPerSegment: compCandidates,
          maxTrials: compMaxTrials,
          allSuggestions,
          sugIdx,
          originals,
          targets,
          comparisonRows: payload.comparison_rows || [],
          runResults: payload.run_results || [],
          outputFields: payload.output_fields || [],
          outputSchema: payload.output_schema,
          scoreMappingJson: payload.score_mapping || '[]',
          runWs: runWs || { headers: [], rows: [] },
          gtContent: gtContent || { headers: [], rows: [] },
          abortController: finetuneAc,
          onProgress: onFinetuneProgress,
        });
      } else {
        result = await runSuggestionFinetuneMIPROv2({
          apiBase: API_BASE,
          llmCredentialId: reviewCredForFinetune,
          runCredentialId: payload.run_credential_id,
          oldSentence,
          newSentence: proposalNew,
          allSuggestions,
          sugIdx,
          originals,
          targets,
          comparisonRows: payload.comparison_rows || [],
          runResults: payload.run_results || [],
          outputFields: payload.output_fields || [],
          outputSchema: payload.output_schema,
          scoreMappingJson: payload.score_mapping || '[]',
          runWs: runWs || { headers: [], rows: [] },
          gtContent: gtContent || { headers: [], rows: [] },
          miprov2Auto,
          abortController: finetuneAc,
          onProgress: onFinetuneProgress,
        });
      }
      sug.new_sentence = result.bestText;
      sug.review_finetune_meta = {
        bestPassPct: Math.round(Number(result.bestObservedRate) * 100),
        candidatesCount: result.candidates.length,
        trialsRun: Array.isArray(result.trialLog) ? result.trialLog.length : 0,
        bestArmIndex: result.bestIndex,
        optimizer: result.optimizer || finetuneMode,
        newSentenceBeforeFinetune: proposalNew,
      };
      delete saved.review_finetune_last_result;
      sug.review_finetune_completed = true;
      delete sug.review_finetune_use_before;
      delete sug.review_test_result;
      delete sug.review_test_passed;
      delete sug[REVIEW_TEST_RESULT_FINETUNE_AFTER];
      delete sug[REVIEW_TEST_RESULT_FINETUNE_BEFORE];
      if (sug.applied === true) syncWorkingFromApplied();
      updateSuggestionTestOutcomeVisual(card, sug, actionsFull, originals, promptSections);
      renderLeft(-1);
      persistWorking();
    } catch (err) {
      if (err && err.name === 'AbortError') {
        /* user cancelled or window closed */
      } else {
        showAlert(String(err?.message || err || 'Finetune failed'), { title: 'Finetune failed' });
      }
    } finally {
      if (finetuneAc) unregisterFinetuneSession(finetuneAc);
      delete sug.review_finetune_in_progress;
      delete sug._finetuneAbort;
      delete sug.review_finetune_progress;
      updateSuggestionTestOutcomeVisual(card, sug, actionsFull, originals, promptSections);
      persistWorking();
      if (sug.review_finetune_completed === true) {
        void runAutoRowCheckForSuggestion(sugIdx);
      }
    }
  }

  const sectionNames = (promptSections || []).map((s, i) => (s.name || '').trim() || `Section ${i}`);

  function updateAnalysisFooter() {
    if (!analysisFooterEl) return;
    const isComplete = saved.streamComplete === true;
    const inProgress = !isComplete && isReviewStreamingNow();
    let statusClass = 'review-detail-status-note--incomplete';
    let statusText = REVIEW_INCOMPLETE_USER_MSG;
    if (isComplete) {
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
    const rowChecksPending =
      isComplete &&
      typeof getPayload === 'function' &&
      allSuggestions.some((s) => suggestionNeedsAutoRowCheck(s, originals, promptSections) && isReviewRowCheckInProgress(s));
    if (rowChecksPending) {
      statusClass = 'review-detail-status-note--generating';
      statusText = 'Checking suggested changes…';
    } else if (isComplete) {
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
    const statusNote = document.createElement('p');
    statusNote.className = `review-detail-status-note ${statusClass}`;
    statusNote.setAttribute('aria-live', 'polite');
    statusNote.textContent = statusText;
    suggestionsFooterEl.appendChild(statusNote);
  }

  function renderRowDiagnostics() {
    if (!diagnosisEl) return;
    diagnosisEl.innerHTML = '';
    if (!rowDiagnostics.length) {
      const p = document.createElement('p');
      p.className = 'review-detail-placeholder';
      const streaming = isReviewStreamingNow();
      const stale = saved.streamComplete === false && !streaming;
      p.textContent = streaming
        ? 'Analyzing row results…'
        : stale
          ? REVIEW_INCOMPLETE_USER_MSG
          : 'No row-level analysis for this run.';
      diagnosisEl.appendChild(p);
      return;
    }
    const comparisonRows = Array.isArray(saved.comparison_rows) ? saved.comparison_rows : [];
    function findComparisonRow(idx) {
      const n = Number(idx);
      return comparisonRows.find((r) => Number(r?.row_index) === n) || null;
    }

    rowDiagnostics.forEach((d, displayIdx) => {
      const displayNum = displayIdx + 1;
      const issue = (d.issue_summary || '').trim();
      const rough = (d.rough_modification_opinion || '').trim();
      const primaryBlurb = issue || rough;
      const preview = truncateWithEllipsis(primaryBlurb, DIAG_LIST_PREVIEW_CHARS);
      const titleLine = diagnosisCardTitleLine(d);
      const compRow = findComparisonRow(d.row_index);
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

  function addOneDataRefinementCard(item) {
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
    const secIdx = Math.max(0, Math.min(sug.section_index, (promptSections || []).length - 1));
    const name = sectionNames[secIdx] || `Section ${secIdx}`;
    const useSentenceEdit = sug.old_sentence != null && sug.new_sentence != null;
    const oldSentence = (sug.old_sentence || '').trim();
    const newSentence = (sug.new_sentence || '').trim();
    const legacyNewContent = (sug.new_content || '').trim();
    const currentContent = working[secIdx] ? (working[secIdx].content || '') : '';
    const originalContent = (originals[secIdx] && originals[secIdx].content) ? originals[secIdx].content : '';
    const segmentInOriginal = useSentenceEdit ? getLocatableSegment(originalContent, oldSentence) : null;
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
    const acceptBtnHtml =
      actionsFull && !noButton
        ? '<button type="button" class="btn btn-secondary review-detail-accept-btn' + (isApplied ? ' review-detail-accept-btn--revert' : '') + '">' + (isApplied ? 'Revert' : 'Accept') + '</button>'
        : '';
    const titlePillsHtml = buildSuggestionTitlePillsHtml(sug, noButton, actionsFull);
    const actionsHtml = `${detailsBtnHtml}${acceptBtnHtml ? ` ${acceptBtnHtml}` : ''}`;

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

    function currentNewSentence() {
      return effectiveNewSentenceForApply(sug);
    }
    function getDiffContent() {
      const c = working[secIdx] ? (working[secIdx].content || '') : '';
      if (!useSentenceEdit) return legacyNewContent;
      const ns = currentNewSentence();
      const seg = getLocatableSegment(c, oldSentence);
      return seg ? c.replace(seg, ns, 1) : c.replace(oldSentence, ns, 1);
    }
    function getRemoveSpanForDiff() {
      if (!useSentenceEdit || currentNewSentence() !== '') return undefined;
      const c = working[secIdx] ? (working[secIdx].content || '') : '';
      return getLocatableSegment(c, oldSentence) || oldSentence;
    }
    /** Reverted section content (current with new_sentence -> old_sentence, or original for legacy). */
    function getRevertedContent() {
      const c = working[secIdx] ? (working[secIdx].content || '') : '';
      if (!useSentenceEdit) return originalContent || '';
      const ns = currentNewSentence();
      const seg = getLocatableSegment(c, ns);
      return seg ? c.replace(seg, oldSentence, 1) : c.replace(ns, oldSentence, 1);
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
        'Show this change in the prompt; click again to clear. Use Accept or View detail from the buttons below.',
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

    if (!noButton && actionsFull) {
      acceptBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (secIdx < 0 || secIdx >= working.length) return;
        const wasApplied = sug.applied === true;
        sug.applied = !wasApplied;
        syncWorkingFromApplied();
        updateAcceptButtonLabels();
        updateSuggestionTestOutcomeVisual(card, sug, actionsFull, originals, promptSections);
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

  dataRefinement.forEach((item) => addOneDataRefinementCard(item));

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
      const n = name === 'analysis' || name === 'suggestions' ? name : 'suggestions';
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
      const phase1Only =
        saved.streamComplete === false &&
        rowDiagnostics.length > 0 &&
        allSuggestions.length === 0 &&
        dataRefinement.length === 0;
      initial = phase1Only ? 'analysis' : 'suggestions';
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
    };
  }

}

/** Review node modal: show saved result (sections + suggestions) or empty state. */
export function openReviewDetailModal({ node, getPayload, getReviewResult, updateReviewResult, onExportNewPrompt, getIsReviewStreaming }) {
  const saved = getReviewResult ? getReviewResult() : null;
  if (saved && typeof saved === 'object' && clearStaleFinetuneRunningFlags(saved.suggestions) && typeof updateReviewResult === 'function') {
    try {
      updateReviewResult({ ...saved });
    } catch (_) {}
  }
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
        <div class="review-detail-third-column">
          <h3 class="review-detail-preview-title">Review assistant</h3>
          <div class="review-assistant-chat-wrap">
            <div class="review-assistant-messages" id="review-detail-assistant-messages"></div>
            <div class="review-assistant-clear-bar">
              <button type="button" class="review-assistant-clear-btn" aria-label="Clear chat history">Clear chat history</button>
            </div>
            <div class="review-assistant-input-wrap">
              <div class="review-assistant-input-inner">
                <textarea class="review-assistant-input" id="review-detail-assistant-input" placeholder="Ask anything" rows="2"></textarea>
              </div>
            </div>
          </div>
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

  const chatRefreshRef = { current: null };
  function refreshFromSaved(data) {
    if (!data || typeof data !== 'object') return;
    baseOptions.saved = data;
    baseOptions.promptSections = (Array.isArray(data.promptSections) && data.promptSections.length > 0) ? data.promptSections : baseOptions.promptSections;
    baseOptions.suggestions = Array.isArray(data.suggestions) ? data.suggestions : baseOptions.suggestions;
    buildReviewResultUI(overlay, baseOptions);
    if (chatRefreshRef.current) chatRefreshRef.current(data);
  }

  function onSaveReviewResult(e) {
    if (e.detail?.reviewNodeId !== reviewNodeId) return;
    // 使用节点上的最新状态（workflow 已合并 workingSections 与 .applied），避免被流式原始数据覆盖导致 hover 时绿标不显示
    const data = (getReviewResult && getReviewResult()) ?? e.detail?.data;
    if (!data) return;
    if (hasActiveVerifySessions() || hasActiveFinetuneSessions()) {
      if (typeof overlay._reviewDetailReconcile === 'function') {
        overlay._reviewDetailReconcile(data);
      }
      return;
    }
    refreshFromSaved(data);
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

  if (reviewNodeId) {
    document.addEventListener('workflow:save-review-result', onSaveReviewResult);
  }

  overlay.querySelector('.modal-close').addEventListener('click', close);

  function close() {
    if (reviewNodeId) document.removeEventListener('workflow:save-review-result', onSaveReviewResult);
    delete overlay._reviewDetailReconcile;
    overlay.remove();
    document.body.style.overflow = '';
  }

  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);
  initReviewAssistantChat(overlay, {
    getPayload,
    getReviewResult,
    onReviewResultChange: updateReviewResult || null,
    refreshFromSaved,
    chatRefreshRef,
    getIsReviewStreaming: getIsReviewStreaming || null,
  });
}

/** Build context text for Review assistant from saved + payload. */
async function buildReviewAssistantContext(getPayload, getReviewResult) {
  const saved = typeof getReviewResult === 'function' ? getReviewResult() : null;
  const payload = await Promise.resolve(typeof getPayload === 'function' ? getPayload() : null);
  const rowDiagnostics = Array.isArray(saved?.row_diagnostics)
    ? saved.row_diagnostics
        .map((d) => {
          const rid = Number(d && d.row_index);
          const ri = Array.isArray(d && d.row_indices)
            ? d.row_indices.map((x) => Number(x)).filter((x) => !Number.isNaN(x))
            : [];
          return {
            row_index: rid,
            row_indices: ri.length ? ri : (!Number.isNaN(rid) ? [rid] : []),
            card_title: String((d && d.card_title) || ''),
            issue_summary: String((d && d.issue_summary) || ''),
            rough_modification_opinion: String((d && d.rough_modification_opinion) || ''),
            problem_category_hint: String((d && d.problem_category_hint) || ''),
          };
        })
        .filter((d) => !Number.isNaN(d.row_index))
    : [];
  rowDiagnostics.sort((a, b) => a.row_index - b.row_index);
  const lines = [
    'You are a prompt improvement assistant. Your ONLY job is to help improve the current prompt below. Do not discuss general prompt engineering, other prompts, or unrelated topics. Everything you say and do must directly serve improving this prompt.',
    '',
    'Do NOT expose internal context to the user. Do not mention sections, run results structure, or how you receive data. Just answer directly and focus on solving the problem. Be concise and actionable.',
    '',
    'STRICT: Follow the user request exactly. If they ask to delete a segment, use new_sentence: "" (empty) — do NOT add any replacement. If they ask to add something, add only that. Never combine delete+add or add extra changes the user did not ask for.',
    '',
    '## Current Prompt (working copy)',
  ];
  const sections = saved?.workingSections || saved?.promptSections || [];
  if (sections.length === 0) {
    lines.push('(No sections)');
  } else {
    sections.forEach((s, i) => {
      const name = (s.name || '').trim() || '(unnamed)';
      const content = (s.content || '').trim() || '(empty)';
      lines.push(`[Section ${i}: ${name}]`);
      lines.push(content);
      lines.push('');
    });
  }
  if (rowDiagnostics.length > 0) {
    lines.push('## Issue analysis (read-only — same as the "Issue analysis" tab in the UI)');
    lines.push(
      'Use these per-row failure notes as context when reasoning about prompt changes. You CANNOT edit, delete, or replace this list — there is no tool for it. Your only structured actions are [ASSISTANT_SUGGESTION] (prompt edits) and [ASSISTANT_REMOVE_SUGGESTION] (items in "Suggestions" below).',
    );
    lines.push('');
    rowDiagnostics.forEach((d, i) => {
      const n = i + 1;
      const multi = Array.isArray(d.row_indices) && d.row_indices.length > 1;
      const rowLabel = multi
        ? d.row_indices.map((x) => formatRunRowIndexForDisplay(x)).join(', ')
        : formatRunRowIndexForDisplay(d.row_index);
      const rowSuffix = multi ? `rows ${rowLabel} (same input)` : `row ${rowLabel}`;
      lines.push(`### Issue analysis #${n} · Score comparison run result ${rowSuffix}`);
      const ct = (d.card_title || '').trim();
      if (ct) lines.push(`Headline: ${ct}`);
      lines.push(`Issue: ${(d.issue_summary || '').trim() || '(none)'}`);
      lines.push(`Suggested direction (prompt-level): ${(d.rough_modification_opinion || '').trim() || '(none)'}`);
      const hint = (d.problem_category_hint || '').trim();
      if (hint) lines.push(`Category hint: ${hint}`);
      lines.push('');
    });
  }
  const comparisonRows = saved?.comparison_rows || payload?.comparison_rows || [];
  const runResults = saved?.run_results || payload?.run_results || [];
  if (comparisonRows.length > 0 || runResults.length > 0) {
    lines.push('## Run Results');
    const failed = comparisonRows.filter((r) => !comparisonRowIsMatched(r));
    if (failed.length > 0) {
      lines.push(`Sample failed rows (${failed.length} of ${comparisonRows.length} total):`);
      failed.slice(0, 10).forEach((r, i) => {
        lines.push(`Run result row ${formatRunRowIndexForDisplay(r.row_index)}: NOT matched`);
        if (r.row_input && Object.keys(r.row_input || {}).length > 0) {
          lines.push(`  Input: ${JSON.stringify(r.row_input)}`);
        }
        lines.push(`  Model output: ${JSON.stringify(r.run_output || {})}`);
        lines.push(`  Expected: ${JSON.stringify(r.expected || '')}`);
        if (r.comparison_types?.length) {
          lines.push(`  Comparison: ${r.comparison_types.join(', ')}`);
        }
        lines.push('');
      });
      if (failed.length > 10) lines.push(`... and ${failed.length - 10} more failed rows`);
    } else if (comparisonRows.length > 0) {
      lines.push('All rows matched.');
    }
    lines.push('');
  }
  const suggestions = saved?.suggestions || [];
  const dataRefinement = saved?.data_refinement || [];
  lines.push('## Your permissions');
  lines.push(
    'READ: Issue analysis (if listed above) is read-only context. Do not tell the user you changed it or try to remove it — you can only change items under "Suggestions" below.',
  );
  lines.push(
    'CRITICAL — Review-generated suggestions (marked [pipeline] below): You CANNOT change their old_sentence/new_sentence, replace them, or “update” them via chat. There is no tool for that. If the user asks you to modify, rewrite, fix, or adjust those initial cards, reply clearly: **they cannot be edited from this chat** — they must use **Accept** or **Revert** on the card in the Suggested changes panel. Optionally suggest they **Revert** first, then you can add a **new** [ASSISTANT_SUGGESTION] with different wording (that new card is assistant-owned).',
  );
  lines.push(
    'Reply in the user’s language when explaining this (e.g. Chinese: 无法在对话里修改 Review 自动生成的建议卡片，请在左侧「Suggested changes」里对该条使用 Accept 或 Revert；若要换一种改法，可先 Revert，再让我添加一条新的建议).',
  );
  lines.push('ADD: New prompt-only edit cards via [ASSISTANT_SUGGESTION] (assistant-owned; source=assistant).');
  lines.push(
    'REMOVE via chat: **Only** items marked [assistant — removable]. **Do not** use [ASSISTANT_REMOVE_SUGGESTION] on [pipeline] items — the app will **not** delete them.',
  );
  lines.push(
    '**Never** tell the user you deleted or removed a suggestion if it was [pipeline] or data refinement. If they ask to delete #1 and #1 is pipeline, **refuse in plain language** (e.g. cannot remove from chat; use Accept/Revert)—**do not** output [ASSISTANT_REMOVE_SUGGESTION] for that id and **do not** say “已删除”.',
  );
  lines.push('');
  if (suggestions.length > 0 || dataRefinement.length > 0) {
    lines.push('## Suggestions (persistent numeric suggestion_id per review; matches UI #N)');
    dataRefinement.forEach((d) => {
      const sid = (d && d.suggestion_id) ? String(d.suggestion_id) : '';
      const shortLabel = formatSuggestionIdDisplay(sid);
      const rows =
        (d.row_indices || []).length > 0
          ? `Rows ${(d.row_indices || []).map((x) => formatRunRowIndexForDisplay(x)).join(', ')}: `
          : '';
      const title = rows + ((d.reason || '').trim().slice(0, 100) || 'Possible ground truth issue');
      lines.push(`#${shortLabel} [Data refinement] [pipeline — not editable via chat] suggestion_id="${sid}" ${title}`);
      if ((d.reason || '').trim().length > 100) lines.push(`   Full: ${(d.reason || '').trim()}`);
    });
    suggestions.forEach((s) => {
      const sid = (s && s.suggestion_id) ? String(s.suggestion_id) : '';
      const shortLabel = formatSuggestionIdDisplay(sid);
      const title = (s.name || '').trim() || (s.reason || '').trim().slice(0, 80) || `[Section ${s.section_index ?? 0}] "${(s.old_sentence || '').slice(0, 40)}..." → "${(s.new_sentence || '').slice(0, 40)}..."`;
      const applied = s.applied === true ? ' [applied]' : '';
      const src = String(s?.source || '').trim().toLowerCase();
      const tag = src === 'assistant' ? '[assistant — removable]' : '[pipeline — not editable via chat]';
      lines.push(`#${shortLabel} [Edit] ${tag} suggestion_id="${sid}" ${title}${applied}`);
      const p1s = Array.isArray(s.phase1_addresses)
        ? s.phase1_addresses.map((x) => String(x || '').trim()).filter(Boolean)
        : [];
      if (p1s.length) lines.push(`   Responds to: ${p1s.join(' · ')}`);
      const tIdx = suggestionTargetInputRowIndices(s);
      const tLbl = formatScoreTableTargetLabels(comparisonRows, tIdx);
      if (tLbl) lines.push(`   Score table ${tLbl}`);
      const cf = String(s.chat_focus || '').trim();
      if (src === 'assistant' && cf) lines.push(`   Focus (chat): ${cf}`);
      if (src === 'assistant' && Array.isArray(s.chat_focus_bullets) && s.chat_focus_bullets.length) {
        for (const b of s.chat_focus_bullets) {
          const t = String(b || '').trim();
          if (t) lines.push(`   · ${t}`);
        }
      }
      lines.push(`   Reason: ${(s.reason || '').trim()}`);
    });
    lines.push('');
  }
  lines.push('## Adding suggestions');
  lines.push('[ASSISTANT_SUGGESTION] adds edits to the PROMPT (old_sentence → new_sentence). It does NOT remove items from the suggestions list. To remove suggestions from the list, use [ASSISTANT_REMOVE_SUGGESTION] (see Removing section).');
  lines.push('Do NOT add suggestions when the user is only asking a question, seeking clarification, or discussing. Just answer in text. Only use [ASSISTANT_SUGGESTION] when the user explicitly asks you to make a change, add a suggestion, or edit the prompt.');
  lines.push('When you decide to suggest a concrete edit, include one or more blocks in this exact format:');
  lines.push('[ASSISTANT_SUGGESTION]');
  lines.push(
    '{"section_index": 0, "old_sentence": "exact text to replace from prompt", "new_sentence": "replacement", "focus": "One-line summary from this chat (optional if focus_bullets carry the detail)", "focus_bullets": ["Concrete point from chat, like pipeline phase-1 bullets", "Second point"], "reason": "Why this edit helps (from this chat)", "name": "Short title", "target_input_row_indices": [0]}',
  );
  lines.push('[/ASSISTANT_SUGGESTION]');
  lines.push(
    'Each block MUST include **reason** and usually **focus_bullets**: a non-empty JSON **array of short English strings** — one bullet per distinct issue or instruction the user raised in **this chat** (same style as pipeline “Focus” bullets under the score row). **focus** is an optional one-line lead; **focus_bullets** are required when the user gave more than a single vague ask. Summarize **only from chat**, not from pipeline findings you cannot see. **reason** = why your new_sentence addresses those points.',
  );
  lines.push('When adding suggestions, also write a brief comment (e.g. what you changed or why it helps). The user will see this instead of a generic message. If you omit the comment, we show "Added. Please check the Suggestions panel on the left and choose Accept or Revert."');
  lines.push(
    'Rules: old_sentence must match the current prompt content exactly. new_sentence: use "" (empty string) for pure deletion; use the exact replacement for edits. **target_input_row_indices** is required: non-empty JSON array of **0-based comparison row_index** for every input row this edit addresses (same as Run/Review). The UI labels those rows **Score table #N** using `score_table_row` when present. Do NOT add content when the user asked only to delete. Only suggest what the user explicitly asked for — no extra additions.',
  );
  lines.push('');
  lines.push('## Removing suggestions');
  lines.push('When the user asks to DELETE or REMOVE **assistant-added** cards only: use [ASSISTANT_REMOVE_SUGGESTION]. Do NOT use [ASSISTANT_SUGGESTION] for list removal.');
  lines.push('Prefer suggestion_id for items tagged [assistant — removable]. Example: [ASSISTANT_REMOVE_SUGGESTION]{"suggestion_id":3}[/ASSISTANT_REMOVE_SUGGESTION].');
  lines.push('Legacy (positional): [ASSISTANT_REMOVE_SUGGESTION]{"suggestion_index": N}[/ASSISTANT_REMOVE_SUGGESTION] where N is 1-based global order (data refinement, then edits).');
  lines.push(
    'If the target is **[pipeline]** or **[Data refinement]**: **do not** emit REMOVE blocks. Reply that it **cannot** be deleted from this chat and they must use **Accept** or **Revert** on the card. Claiming deletion when nothing was removed is **forbidden**.',
  );
  lines.push('Never target error analysis rows with REMOVE — they are not in the suggestion list and cannot be deleted here.');
  lines.push('');
  lines.push('Stay focused ONLY on improving the current prompt. Answer directly and solve problems. Do not describe your context or internal structure to the user. If the user asks something unrelated to this prompt, briefly redirect to prompt improvement.');
  return lines.join('\n');
}

/** Parse [ASSISTANT_SUGGESTION]...[/ASSISTANT_SUGGESTION] blocks from assistant response. */
function parseAssistantSuggestions(text, dataRoot) {
  const blocks = [];
  const re = /\[ASSISTANT_SUGGESTION\]\s*([\s\S]*?)\s*\[\/ASSISTANT_SUGGESTION\]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    try {
      const obj = JSON.parse(m[1].trim());
      if (obj && typeof obj.section_index === 'number') {
        const ri = suggestionTargetInputRowIndices({
          target_input_row_indices: obj.target_input_row_indices,
          row_indices: obj.row_indices,
        });
        if (ri.length === 0) continue;
        const rawBullets = obj.focus_bullets ?? obj.chat_focus_bullets;
        const chat_focus_bullets = Array.isArray(rawBullets)
          ? rawBullets.map((x) => String(x || '').trim()).filter(Boolean)
          : [];
        blocks.push(
          ensureSuggestionObjectId(
            {
              section_index: obj.section_index,
              old_sentence: String(obj.old_sentence || '').trim(),
              new_sentence: String(obj.new_sentence || '').trim(),
              chat_focus: String(obj.focus ?? obj.chat_focus ?? '').trim(),
              chat_focus_bullets,
              reason: String(obj.reason || '').trim(),
              name: String(obj.name || '').trim(),
              target_input_row_indices: ri,
              row_indices: ri,
              source: 'assistant',
            },
            dataRoot
          )
        );
      }
    } catch (_) {}
  }
  return blocks;
}

/**
 * Parse [ASSISTANT_REMOVE_SUGGESTION]...[/ASSISTANT_REMOVE_SUGGESTION] blocks.
 * Prefers suggestion_id (stable); legacy suggestion_index is 1-based global order (data refinement, then edits).
 */
function parseAssistantRemoveSuggestions(text) {
  const ops = [];
  const re = /\[ASSISTANT_REMOVE_SUGGESTION\]\s*([\s\S]*?)\s*\[\/ASSISTANT_REMOVE_SUGGESTION\]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    try {
      const obj = JSON.parse(m[1].trim());
      const sid = obj?.suggestion_id;
      if (sid != null && sid !== '') {
        const num = parseNumericSuggestionId(sid);
        if (num != null) {
          ops.push({ suggestion_id: num });
          continue;
        }
        if (typeof sid === 'string' && sid.trim()) {
          ops.push({ suggestion_id: sid.trim() });
          continue;
        }
      }
      const idx = obj?.suggestion_index;
      if (typeof idx === 'number' && idx >= 1) ops.push({ suggestion_index: idx });
    } catch (_) {}
  }
  return ops;
}

/**
 * Review / stream–originated items are locked for chat: cannot remove or “rewrite” via assistant tools.
 * Chat-added edits use source === 'assistant'. Legacy items without source are treated as locked.
 */
function isPipelineLockedSuggestionItem(item, isDataRefinementRow) {
  if (!item || typeof item !== 'object') return true;
  if (isDataRefinementRow) return true;
  const src = String(item.source || '').trim().toLowerCase();
  return src !== 'assistant';
}

/** @param {{ data_refinement?: unknown[], suggestions?: unknown[] }} st */
function removeSuggestionByGlobalIndexFromState(st, oneBased) {
  if (!st || typeof oneBased !== 'number' || oneBased < 1) return false;
  const R = (st.data_refinement || []).length;
  const n = Math.floor(oneBased);
  if (n >= 1 && n <= R) {
    const row = st.data_refinement[n - 1];
    if (isPipelineLockedSuggestionItem(row, true)) return false;
    st.data_refinement.splice(n - 1, 1);
    return true;
  }
  const editIdx = n - R - 1;
  const sg = st.suggestions || [];
  if (editIdx >= 0 && editIdx < sg.length) {
    const row = sg[editIdx];
    if (isPipelineLockedSuggestionItem(row, false)) return false;
    sg.splice(editIdx, 1);
    return true;
  }
  return false;
}

function removeSuggestionByIdFromState(st, suggestionId) {
  if (!st || suggestionId == null || suggestionId === '') return false;
  const wantNum = parseNumericSuggestionId(suggestionId);
  const match = (x) => {
    if (!x || typeof x !== 'object') return false;
    if (wantNum != null) return parseNumericSuggestionId(x.suggestion_id) === wantNum;
    return String(x.suggestion_id) === String(suggestionId).trim();
  };
  const dr = st.data_refinement;
  const sg = st.suggestions;
  let i = Array.isArray(dr) ? dr.findIndex(match) : -1;
  if (i >= 0) {
    if (isPipelineLockedSuggestionItem(dr[i], true)) return false;
    dr.splice(i, 1);
    return true;
  }
  i = Array.isArray(sg) ? sg.findIndex(match) : -1;
  if (i >= 0) {
    if (isPipelineLockedSuggestionItem(sg[i], false)) return false;
    sg.splice(i, 1);
    return true;
  }
  return false;
}

/** Strip [ASSISTANT_SUGGESTION] and [ASSISTANT_REMOVE_SUGGESTION] blocks for display. */
function stripAssistantSuggestionBlocks(text) {
  return text
    .replace(/\[ASSISTANT_SUGGESTION\][\s\S]*?\[\/ASSISTANT_SUGGESTION\]/g, '')
    .replace(/\[ASSISTANT_REMOVE_SUGGESTION\][\s\S]*?\[\/ASSISTANT_REMOVE_SUGGESTION\]/g, '')
    .trim()
    .replace(/\n{3,}/g, '\n\n');
}

/** Shown when the model issued REMOVE but no pipeline/locked items were actually removed (must not claim success). */
const REVIEW_ASSISTANT_REMOVE_BLOCKED_MSG =
  'Cannot remove that suggestion from chat. Cards from automated Review are locked here—you must use **Accept** or **Revert** on the card in Suggested changes.\n\n无法在对话中删除该建议。Review 自动生成的条目请直接在左侧「Suggested changes」里对该卡片使用 Accept 或 Revert。';

function reviewAssistantRemoveOutcomeMessage(succeeded, attempted) {
  if (attempted <= 0) return '';
  if (succeeded <= 0) return REVIEW_ASSISTANT_REMOVE_BLOCKED_MSG;
  if (succeeded >= attempted) {
    return attempted > 1
      ? 'Removed. The suggestions have been deleted from the list.'
      : 'Removed. The suggestion has been deleted from the list.';
  }
  return `Removed ${succeeded} of ${attempted}. The rest are from automated Review and cannot be removed from chat—use **Accept** or **Revert** on those cards.\n\n其余条目为 Review 自动生成，无法在对话中删除，请在对应卡片上使用 Accept 或 Revert。`;
}

/** Init Review assistant chat: uses default_review_credential_id from settings. */
function initReviewAssistantChat(overlay, contextOptions = {}) {
  const { getPayload, getReviewResult, onReviewResultChange, refreshFromSaved, chatRefreshRef, getIsReviewStreaming } = contextOptions;
  const messagesEl = overlay.querySelector('.review-assistant-messages');
  const inputEl = overlay.querySelector('.review-assistant-input');
  if (!messagesEl || !inputEl) return;

  let credentialId = '';
  let chatSendInFlight = false;
  const assistantInputPlaceholderReady = 'Ask anything';

  function updateInputState() {
    const streaming = typeof getIsReviewStreaming === 'function' && getIsReviewStreaming();
    if (!credentialId) {
      inputEl.disabled = true;
      inputEl.placeholder = 'Select a model in Settings first';
    } else if (streaming) {
      inputEl.disabled = true;
      inputEl.placeholder = 'Wait for review to complete...';
    } else {
      inputEl.disabled = false;
      inputEl.placeholder = assistantInputPlaceholderReady;
    }
  }
  const saved0 = typeof getReviewResult === 'function' ? getReviewResult() : null;
  const initialChat = Array.isArray(saved0?.chatHistory) ? saved0.chatHistory : [];
  const chatHistory = initialChat.map((m) => ({ role: m.role, content: String(m.content || '').trim() }));

  async function getSystemContext() {
    const ctx = await buildReviewAssistantContext(getPayload, getReviewResult);
    return ctx.trim() ? ctx : null;
  }

  async function loadCredential() {
    try {
      const [list, settings] = await Promise.all([
        fetch(`${API_BASE}/api/credentials`).then((r) => r.ok ? r.json() : []),
        fetch(`${API_BASE}/api/settings`).then((r) => r.ok ? r.json() : null),
      ]);
      const reviewId = (settings?.default_review_credential_id || '').trim();
      if (reviewId && (list || []).some((c) => c.id === reviewId)) {
        credentialId = reviewId;
      }
    } catch (_) {}
  }

  const TYPEWRITER_MS_PER_CHAR = 10;

  function appendMessage(role, content) {
    const div = document.createElement('div');
    div.className = `review-assistant-msg review-assistant-msg--${role}`;
    const label = document.createElement('span');
    label.className = 'review-assistant-msg-label';
    label.textContent = role === 'user' ? 'You' : 'Assistant';
    const body = document.createElement('div');
    body.className = 'review-assistant-msg-body';
    body.textContent = content;
    div.appendChild(label);
    div.appendChild(body);
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function appendMessageWithTypewriter(role, content) {
    const div = document.createElement('div');
    div.className = `review-assistant-msg review-assistant-msg--${role}`;
    const label = document.createElement('span');
    label.className = 'review-assistant-msg-label';
    label.textContent = role === 'user' ? 'You' : 'Assistant';
    const body = document.createElement('div');
    body.className = 'review-assistant-msg-body';
    div.appendChild(label);
    div.appendChild(body);
    messagesEl.appendChild(div);

    let i = 0;
    function tick() {
      if (i < content.length) {
        body.textContent = content.slice(0, i + 1);
        i += 1;
        messagesEl.scrollTop = messagesEl.scrollHeight;
        setTimeout(tick, TYPEWRITER_MS_PER_CHAR);
      }
    }
    tick();
  }

  function isModalOpen() {
    return overlay.isConnected;
  }

  function persistChatResult(merged) {
    if (typeof onReviewResultChange === 'function' && typeof refreshFromSaved === 'function' && merged) {
      onReviewResultChange(merged);
      if (isModalOpen()) refreshFromSaved(merged);
    }
  }

  async function sendMessage() {
    const text = (inputEl.value || '').trim();
    const streaming = typeof getIsReviewStreaming === 'function' && getIsReviewStreaming();
    if (!text || !credentialId || streaming || chatSendInFlight) return;
    chatSendInFlight = true;
    try {
    inputEl.value = '';
    appendMessage('user', text);
    chatHistory.push({ role: 'user', content: text });
    const saved = typeof getReviewResult === 'function' ? getReviewResult() : null;
    if (saved && typeof saved === 'object') {
      persistChatResult({ ...saved, chatHistory: chatHistory.slice(), chatRequestInProgress: true });
    }
    // Only add placeholder when we didn't persist: persistChatResult+refreshFromSaved already adds one when modal is open
    const placeholder = (!saved || typeof saved !== 'object') ? (() => {
      const el = document.createElement('div');
      el.className = 'review-assistant-msg review-assistant-msg--assistant review-assistant-msg--loading';
      el.innerHTML = '<span class="review-assistant-msg-label">Assistant</span><div class="review-assistant-msg-body"><span class="review-assistant-spinner" aria-hidden="true"></span><span class="review-assistant-loading-text">Thinking…</span></div>';
      messagesEl.appendChild(el);
      return el;
    })() : null;
    messagesEl.scrollTop = messagesEl.scrollHeight;
    const systemContext = await getSystemContext();
    const historyForApi = sliceChatHistoryForApi(chatHistory);
    const messagesToSend = systemContext
      ? [{ role: 'system', content: systemContext }, ...historyForApi]
      : historyForApi;
    try {
      const res = await fetch(`${API_BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential_id: credentialId, messages: messagesToSend }),
      });
      if (isModalOpen() && placeholder) placeholder.remove();
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const errMsg = `Error: ${err.detail || res.statusText}`;
        chatHistory.push({ role: 'assistant', content: errMsg });
        if (isModalOpen()) appendMessage('assistant', errMsg);
        const saved = typeof getReviewResult === 'function' ? getReviewResult() : null;
        if (saved && typeof saved === 'object') persistChatResult({ ...saved, chatHistory: chatHistory.slice(), chatRequestInProgress: false });
        return;
      }
      const data = await res.json();
      const rawContent = (data.content || '').trim() || '(No response)';
      const reviewSaved = typeof getReviewResult === 'function' ? getReviewResult() : null;
      const parsedSuggestions = parseAssistantSuggestions(rawContent, reviewSaved);
      const removeOps = parseAssistantRemoveSuggestions(rawContent);
      const removeAttempted = removeOps.length > 0;
      const removeOpsCount = removeOps.length;
      let displayContent = stripAssistantSuggestionBlocks(rawContent);

      let dataRefinement = (reviewSaved && typeof reviewSaved === 'object')
        ? (reviewSaved.data_refinement || []).slice()
        : [];
      let suggestions = (reviewSaved && typeof reviewSaved === 'object')
        ? (reviewSaved.suggestions || []).slice()
        : [];
      let removeSucceeded = 0;
      if (reviewSaved && typeof reviewSaved === 'object' && removeAttempted) {
        const st = { data_refinement: dataRefinement, suggestions };
        const idOps = removeOps.filter((o) => o.suggestion_id != null && o.suggestion_id !== '').map((o) => o.suggestion_id);
        const indexOps = removeOps
          .filter((o) => o.suggestion_index != null)
          .map((o) => o.suggestion_index)
          .sort((a, b) => b - a);
        idOps.forEach((id) => {
          if (removeSuggestionByIdFromState(st, id)) removeSucceeded += 1;
        });
        indexOps.forEach((n) => {
          if (removeSuggestionByGlobalIndexFromState(st, n)) removeSucceeded += 1;
        });
        dataRefinement = st.data_refinement;
        suggestions = st.suggestions;
      }

      if (removeAttempted && removeSucceeded === 0) {
        displayContent = REVIEW_ASSISTANT_REMOVE_BLOCKED_MSG;
      } else if (removeAttempted && removeSucceeded > 0 && removeSucceeded < removeOpsCount) {
        displayContent = reviewAssistantRemoveOutcomeMessage(removeSucceeded, removeOpsCount);
      } else if (!displayContent || !displayContent.trim()) {
        displayContent = parsedSuggestions.length > 0
          ? 'Added. Please check the Suggestions panel on the left and choose Accept or Revert.'
          : removeAttempted && removeSucceeded === removeOpsCount
            ? reviewAssistantRemoveOutcomeMessage(removeSucceeded, removeOpsCount)
            : '(No response)';
      }

      chatHistory.push({ role: 'assistant', content: displayContent });
      if (isModalOpen()) appendMessageWithTypewriter('assistant', displayContent);
      if (reviewSaved && typeof reviewSaved === 'object') {
        if (parsedSuggestions.length > 0) {
          const sections = reviewSaved.workingSections || reviewSaved.promptSections || [];
          const validSuggestions = parsedSuggestions.filter((s) => s.section_index >= 0 && s.section_index < sections.length);
          suggestions = suggestions.concat(validSuggestions);
        }
        persistChatResult({
          ...reviewSaved,
          design_suggestions: [],
          data_refinement: dataRefinement,
          suggestions,
          chatHistory: chatHistory.slice(),
          chatRequestInProgress: false,
        });
      }
    } catch (e) {
      if (isModalOpen() && placeholder) placeholder.remove();
      const errMsg = `Error: ${e.message || 'Request failed'}`;
      chatHistory.push({ role: 'assistant', content: errMsg });
      if (isModalOpen()) appendMessage('assistant', errMsg);
      const saved = typeof getReviewResult === 'function' ? getReviewResult() : null;
      if (saved && typeof saved === 'object') persistChatResult({ ...saved, chatHistory: chatHistory.slice(), chatRequestInProgress: false });
    }
    } finally {
      chatSendInFlight = false;
    }
  }

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  const clearBtn = overlay.querySelector('.review-assistant-clear-btn');
  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      const ok = await showConfirm('Clear all chat history? This cannot be undone.', { title: 'Clear chat', confirmText: 'Clear' });
      if (!ok) return;
      chatHistory.length = 0;
      messagesEl.innerHTML = '';
      if (typeof onReviewResultChange === 'function' && typeof refreshFromSaved === 'function') {
        const saved = typeof getReviewResult === 'function' ? getReviewResult() : null;
        if (saved && typeof saved === 'object') {
          const merged = { ...saved, chatHistory: [] };
          onReviewResultChange(merged);
          refreshFromSaved(merged);
        }
      }
      if (credentialId) {
        appendMessage('assistant', REVIEW_ASSISTANT_WELCOME_MSG);
      }
    });
  }

  chatHistory.forEach((m) => appendMessage(m.role, m.content || '(empty)'));

  updateInputState();

  const inProgress = saved0?.chatRequestInProgress === true;
  if (inProgress) {
    const placeholder = document.createElement('div');
    placeholder.className = 'review-assistant-msg review-assistant-msg--assistant review-assistant-msg--loading';
    placeholder.dataset.chatLoadingPlaceholder = '1';
    placeholder.innerHTML = '<span class="review-assistant-msg-label">Assistant</span><div class="review-assistant-msg-body"><span class="review-assistant-spinner" aria-hidden="true"></span><span class="review-assistant-loading-text">Thinking…</span></div>';
    messagesEl.appendChild(placeholder);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  if (chatRefreshRef && typeof chatRefreshRef === 'object') {
    chatRefreshRef.current = (data) => {
      if (!overlay.isConnected) return;
      const hist = Array.isArray(data?.chatHistory) ? data.chatHistory : [];
      const loading = data?.chatRequestInProgress === true;
      messagesEl.innerHTML = '';
      hist.forEach((m) => appendMessage(m.role, m.content || '(empty)'));
      if (loading) {
        const ph = document.createElement('div');
        ph.className = 'review-assistant-msg review-assistant-msg--assistant review-assistant-msg--loading';
        ph.innerHTML = '<span class="review-assistant-msg-label">Assistant</span><div class="review-assistant-msg-body"><span class="review-assistant-spinner" aria-hidden="true"></span><span class="review-assistant-loading-text">Thinking…</span></div>';
        messagesEl.appendChild(ph);
      }
      messagesEl.scrollTop = messagesEl.scrollHeight;
      updateInputState();
    };
  }

  loadCredential().then(() => {
    updateInputState();
    if (!credentialId) {
      if (chatHistory.length === 0) {
        appendMessage('assistant', 'Please select a default model in Settings → Review to use the Assistant.');
      }
    } else if (chatHistory.length === 0) {
      const streaming = typeof getIsReviewStreaming === 'function' && getIsReviewStreaming();
      if (!streaming) {
        appendMessage('assistant', REVIEW_ASSISTANT_WELCOME_MSG);
      }
    }
  });
}
