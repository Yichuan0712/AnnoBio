/**
 * Review: left = prompt in prompt-detail style; right = suggestions.
 * Hover a suggestion: left shows that section with red (removed) / green (added) minimal diff.
 * Result is saved on the Score node and persisted with the project.
 */

import { showConfirm, showAlert } from './alertModal.js';
import { comparisonRowIsMatched } from './scoreDetailModal.js';
import { normalizeUnicodeDashesForDisplay } from './displayTextNormalize.js';
import {
  ensureReviewResultIds,
  ensureSuggestionObjectId,
  formatSuggestionIdDisplay,
  parseNumericSuggestionId,
} from './reviewSuggestionIds.js';

const API_BASE = 'http://localhost:8000';

/** Shown when persisted review has streamComplete:false but no live job (e.g. app closed mid-review). Mirrors Run: “Last run did not complete.” */
const REVIEW_INCOMPLETE_USER_MSG = 'Last review did not complete. Please run Review again.';

/** Sliding window for /api/chat: max user+assistant messages (≈20 turns if strictly alternating). Full history still kept in UI and project JSON. */
const REVIEW_ASSISTANT_MAX_MESSAGES = 40;

/** Shown when the Review assistant chat is empty (or after clear): Suggested changes add/remove + Accept / Revert. */
const REVIEW_ASSISTANT_WELCOME_MSG =
  'Ask questions, propose edits, or ask me to add or remove items in Suggested changes. Use Accept or Revert on each card to apply or roll back the working prompt.';

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
  return ensureCardTitleSentenceLead('Error analysis');
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
 * @param {{ row_index: number, card_title?: string, issue_summary: string, rough_modification_opinion: string, problem_category_hint?: string }} diagnostic
 * @param {Record<string, unknown> | null} comparisonRow - unused; kept for caller compatibility
 * @param {number} displayNumber - 1-based order in the Error analysis list (same as # on the card)
 */
function openRowDiagnosisDetailOverlay(diagnostic, _comparisonRow, displayNumber) {
  const num = Math.max(1, parseInt(String(displayNumber), 10) || 1);
  const issue = (diagnostic.issue_summary || '').trim();
  const rough = (diagnostic.rough_modification_opinion || '').trim();
  const cardTitle = (diagnostic.card_title || '').trim();
  const scoreRowIdx = diagnostic.row_index;
  const scoreRowLabel = formatRunRowIndexForDisplay(scoreRowIdx);

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
        <p class="review-diagnosis-detail-prose"><span class="review-diagnosis-detail-lead">Source:</span> Score comparison table #${escapeHtml(scoreRowLabel)}</p>
        <p class="review-diagnosis-detail-prose"><span class="review-diagnosis-detail-lead">Issue:</span> ${issue ? escapeHtml(issue) : '<span class="review-diagnosis-detail-empty">(none)</span>'}</p>
        <p class="review-diagnosis-detail-prose"><span class="review-diagnosis-detail-lead">Suggested direction:</span> ${rough ? escapeHtml(rough) : '<span class="review-diagnosis-detail-empty">(none)</span>'}</p>
      </div>
    </div>
  `;

  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKeyDown);
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') close();
  }

  overlay.querySelector('.modal-close').addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', onKeyDown);
  document.body.appendChild(overlay);
}

/**
 * Find the segment in content that matches oldSentence, so we can replace it even if whitespace differs.
 * Returns the exact substring in content to replace, or null if not found.
 */
function findSegmentInContent(content, oldSentence) {
  if (content == null || content === '' || oldSentence == null) return null;
  const trimmed = String(oldSentence).trim();
  if (trimmed === '') return null;
  if (content.includes(trimmed)) return trimmed;
  const pattern = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  try {
    const regex = new RegExp(pattern);
    const m = content.match(regex);
    return m ? m[0] : null;
  } catch (_) {
    return null;
  }
}

/**
 * Fallback: find the segment in content that best matches oldSentence (e.g. by sentence boundaries).
 * Returns a substring of content, or null if no good match.
 */
function findBestMatchingSegment(content, oldSentence) {
  if (content == null || content === '' || oldSentence == null) return null;
  const trimmed = String(oldSentence).trim();
  if (trimmed === '') return null;
  const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
  const normOld = norm(trimmed);
  const parts = content.split(/(?<=[.!?\n])\s*|\n/);
  let best = null;
  let bestScore = 0;
  for (const part of parts) {
    const seg = part.trim();
    if (seg.length < 2) continue;
    const normSeg = norm(seg);
    if (normSeg === normOld) return seg;
    const segInOld = normOld.includes(normSeg);
    const oldInSeg = normSeg.includes(normOld);
    if (segInOld || oldInSeg) {
      const score = segInOld ? normSeg.length : normOld.length;
      if (score > bestScore) {
        bestScore = score;
        best = seg;
      }
    }
  }
  if (best) return best;
  const words = normOld.split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  for (const part of parts) {
    const seg = part.trim();
    if (seg.length < 2) continue;
    let match = 0;
    for (const w of words) {
      if (seg.includes(w) || norm(seg).includes(w)) match += 1;
    }
    const score = match / words.length;
    if (score >= 0.6 && score > bestScore) {
      bestScore = score;
      best = seg;
    }
  }
  return best;
}

/** Get segment in content for replacement: exact/flexible first, then best-match fallback. */
function getLocatableSegment(content, oldSentence) {
  return findSegmentInContent(content, oldSentence) || findBestMatchingSegment(content, oldSentence);
}

/**
 * Rebuild working sections from originals by applying all suggestions that have applied === true.
 * Used when reopening review so Accept/Revert state is correct even if workingSections was lost.
 */
function rebuildWorkingFromApplied(originals, suggestions) {
  if (!Array.isArray(originals) || !Array.isArray(suggestions)) return null;
  const sections = originals.map((s) => ({ name: s.name || '', content: (s.content || '').slice() }));
  for (let i = 0; i < suggestions.length; i++) {
    const s = suggestions[i];
    if (s.applied !== true) continue;
    const secIdx = Math.max(0, Math.min(s.section_index ?? 0, sections.length - 1));
    const useSentenceEdit = s.old_sentence != null && s.new_sentence != null;
    const oldSentence = (s.old_sentence || '').trim();
    const newSentence = (s.new_sentence || '').trim();
    const legacyNewContent = (s.new_content || '').trim();
    const content = sections[secIdx] ? (sections[secIdx].content || '') : '';
    if (useSentenceEdit) {
      const seg = getLocatableSegment(content, oldSentence);
      const toReplace = seg || oldSentence;
      if (content.includes(toReplace)) {
        sections[secIdx].content = content.replace(toReplace, newSentence);
      } else {
        const segNew = getLocatableSegment(content, newSentence);
        if (segNew) sections[secIdx].content = content.replace(segNew, oldSentence);
        else sections[secIdx].content = content.replace(newSentence, oldSentence);
      }
    } else {
      sections[secIdx].content = legacyNewContent;
    }
  }
  return sections;
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
  const { promptSections, suggestions: initialSuggestions, promptFullText, title, resultId, saved = {}, onReviewResultChange, onExportNewPrompt, streamRef, getIsReviewStreaming, getPayload } = options;
  const promptWrap = overlay.querySelector('.review-detail-prompt-wrap');
  const suggestionsEl = overlay.querySelector('#review-detail-suggestions') || overlay.querySelector('#review-result-suggestions');
  const suggestionsFooterEl = overlay.querySelector('#review-detail-suggestions-footer') || overlay.querySelector('#review-result-suggestions-footer');
  const diagnosisEl = overlay.querySelector('#review-detail-row-diagnostics') || overlay.querySelector('#review-result-row-diagnostics');
  const analysisFooterEl =
    overlay.querySelector('#review-detail-analysis-footer') || overlay.querySelector('#review-result-analysis-footer');
  if (!promptWrap || !suggestionsEl) return;

  if (saved && typeof saved === 'object') {
    const idsAdded = ensureReviewResultIds(saved);
    if (idsAdded && typeof onReviewResultChange === 'function') {
      onReviewResultChange({ ...saved });
    }
  }

  const PREVIEW_LEN = 60;
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
      .map((d) => ({
        row_index: Number(d && d.row_index),
        card_title: String((d && d.card_title) || ''),
        issue_summary: String((d && d.issue_summary) || ''),
        rough_modification_opinion: String((d && d.rough_modification_opinion) || ''),
        problem_category_hint: String((d && d.problem_category_hint) || ''),
      }))
      .filter((d) => !Number.isNaN(d.row_index))
    : [];
  rowDiagnostics.sort((a, b) => a.row_index - b.row_index);

  const statusEl = overlay.querySelector('.review-detail-stream-status');

  function isReviewStreamingNow() {
    const byNode = typeof getIsReviewStreaming === 'function' && getIsReviewStreaming();
    const byRef = !!streamRef && saved.streamComplete !== true;
    return byNode || byRef;
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

  function persistWorking() {
    if (typeof onReviewResultChange !== 'function') return;
    const suggestionsToSave = allSuggestions.map((s) => ({ ...s, applied: s.applied === true }));
    const next = {
      ...saved,
      summary: saved.summary ?? '',
      suggestions: suggestionsToSave,
      design_suggestions: [],
      data_refinement: dataRefinement,
      row_diagnostics: rowDiagnostics,
      promptSections: saved.promptSections ?? promptSections,
      promptFullText: saved.promptFullText ?? promptFullText,
      workingSections: working.map((s) => ({ name: s.name, content: s.content })),
    };
    onReviewResultChange(next);
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
    const isComplete = saved.streamComplete === true;
    const inProgress = !isComplete && isReviewStreamingNow();
    let statusClass = 'review-detail-status-note--incomplete';
    let statusText = REVIEW_INCOMPLETE_USER_MSG;
    if (isComplete) {
      statusClass = 'review-detail-status-note--complete';
      const n = rowDiagnostics.length;
      statusText =
        n > 0
          ? `Error analysis complete. ${n} issue${n === 1 ? '' : 's'} listed.`
          : 'Error analysis complete. No failed rows.';
    } else if (inProgress) {
      statusClass = 'review-detail-status-note--generating';
      statusText = 'Error analysis in progress…';
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
        ? 'Analyzing failed rows…'
        : stale
          ? REVIEW_INCOMPLETE_USER_MSG
          : 'No error analysis for this run.';
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
            <span class="review-detail-suggestion-num" aria-label="Error analysis id" title="ID ${badgeLabel}">#${badgeLabel}</span>
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
          openRowDiagnosisDetailOverlay(d, compRow, displayNum);
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

    const acceptBtnHtml = !noButton ? '<button type="button" class="btn btn-secondary review-detail-accept-btn' + (isApplied ? ' review-detail-accept-btn--revert' : '') + '">' + (isApplied ? 'Revert' : 'Accept') + '</button>' : '';
    const actionsHtml = acceptBtnHtml;

    const card = document.createElement('div');
    card.className = 'review-detail-suggestion-card' + (noButton ? ' review-detail-suggestion-card--unlocatable' : '');
    card.dataset.sectionIndex = String(secIdx);
    card.dataset.suggestionIndex = String(sugIdx);
    if (sid !== '' && sid != null) card.dataset.suggestionId = String(sid);
    card.innerHTML = `
      <div class="review-detail-suggestion-card__main">
        <span class="review-detail-suggestion-header"><span class="review-detail-suggestion-num" aria-label="Suggestion id" title="ID ${escapeHtml(String(sid))}">#${escapeHtml(shortLabel)}</span> <strong class="review-detail-suggestion-section-name">${escapeHtml(titleLine)}</strong></span>
        <p class="review-detail-suggestion-reason">${escapeHtml(fullReason)}</p>
      </div>
      <div class="review-detail-suggestion-card__actions">
        ${actionsHtml}
      </div>
    `;
    const mainEl = card.querySelector('.review-detail-suggestion-card__main');
    const acceptBtn = card.querySelector('.review-detail-accept-btn');

    function getDiffContent() {
      const c = working[secIdx] ? (working[secIdx].content || '') : '';
      if (!useSentenceEdit) return legacyNewContent;
      const seg = getLocatableSegment(c, oldSentence);
      return seg ? c.replace(seg, newSentence, 1) : c.replace(oldSentence, newSentence, 1);
    }
    function getRemoveSpanForDiff() {
      if (!useSentenceEdit || newSentence !== '') return undefined;
      const c = working[secIdx] ? (working[secIdx].content || '') : '';
      return getLocatableSegment(c, oldSentence) || oldSentence;
    }
    /** Reverted section content (current with new_sentence -> old_sentence, or original for legacy). */
    function getRevertedContent() {
      const c = working[secIdx] ? (working[secIdx].content || '') : '';
      if (!useSentenceEdit) return originalContent || '';
      const seg = getLocatableSegment(c, newSentence);
      return seg ? c.replace(seg, oldSentence, 1) : c.replace(newSentence, oldSentence, 1);
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

    mainEl.removeAttribute('role');
    mainEl.tabIndex = -1;
    const deleteOnly = useSentenceEdit && newSentence === '';

    if (!noButton) {
      card.addEventListener('mouseenter', () => showPreview());
      card.addEventListener('mouseleave', () => clearDiffOnRight());

      acceptBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (secIdx < 0 || secIdx >= working.length) return;
        sug.applied = sug.applied !== true;
        syncWorkingFromApplied();
        updateAcceptButtonLabels();
        renderLeft(-1);
        persistWorking();
      });
    }

    editContainer.appendChild(card);
  }

  renderRowDiagnostics();

  dataRefinement.forEach((item) => addOneDataRefinementCard(item));

  if (streamRef) {
    if (statusEl) {
      if (isReviewStreamingNow()) statusEl.textContent = 'Generating suggestions…';
      else if (staleIncompletePersisted) statusEl.textContent = REVIEW_INCOMPLETE_USER_MSG;
      else if (saved.streamComplete === true) statusEl.textContent = 'Suggestions complete.';
      else statusEl.textContent = '';
    }
    streamRef.appendDataRefinement = (arr) => {
      if (!Array.isArray(arr)) return;
      dataRefinement = arr
        .map((item) => (item && typeof item === 'object' ? ensureSuggestionObjectId({ ...item }, saved) : null))
        .filter(Boolean);
      dataRefinementContainer.innerHTML = '';
      dataRefinement.forEach((item) => addOneDataRefinementCard(item));
      saved.data_refinement = dataRefinement;
      if (typeof onReviewResultChange === 'function') {
        onReviewResultChange({ ...saved, data_refinement: dataRefinement, row_diagnostics: rowDiagnostics });
      }
    };
    streamRef.appendSuggestions = (batch) => {
      if (statusEl) statusEl.textContent = 'Generating suggestions…';
      batch.forEach((sug) => {
        const s = sug && typeof sug === 'object' ? ensureSuggestionObjectId({ ...sug }, saved) : null;
        if (!s) return;
        const sugIdx = allSuggestions.length;
        allSuggestions.push(s);
        addOneSuggestionCard(s, sugIdx);
      });
      saved.suggestions = allSuggestions.slice();
      if (typeof onReviewResultChange === 'function') {
        onReviewResultChange({ ...saved, suggestions: saved.suggestions, row_diagnostics: rowDiagnostics });
      }
    };
    streamRef.streamDone = () => {
      if (statusEl) statusEl.textContent = 'Suggestions complete.';
      if (allSuggestions.length === 0 && dataRefinement.length === 0) {
        editContainer.innerHTML = '<p class="review-detail-placeholder">No suggestions.</p>';
      }
      saved.suggestions = allSuggestions.slice();
      saved.design_suggestions = [];
      saved.data_refinement = dataRefinement;
      saved.streamComplete = true;
      if (typeof onReviewResultChange === 'function') {
        onReviewResultChange({
          ...saved,
          suggestions: saved.suggestions,
          design_suggestions: [],
          data_refinement: dataRefinement,
          row_diagnostics: rowDiagnostics,
          streamComplete: true,
        });
      }
      updateAnalysisFooter();
      updateSuggestionsFooter();
    };
    streamRef.streamError = () => {
      if (statusEl) statusEl.textContent = 'Failed.';
      if (allSuggestions.length === 0 && dataRefinement.length === 0) {
        editContainer.innerHTML = '<p class="review-detail-placeholder">Request failed.</p>';
      }
      const failedNote = () => {
        const errNote = document.createElement('p');
        errNote.className = 'review-detail-status-note review-detail-status-note--incomplete';
        errNote.setAttribute('aria-live', 'polite');
        errNote.textContent = 'Review failed.';
        return errNote;
      };
      if (analysisFooterEl) {
        analysisFooterEl.innerHTML = '';
        analysisFooterEl.appendChild(failedNote());
      }
      if (suggestionsFooterEl) {
        suggestionsFooterEl.innerHTML = '';
        suggestionsFooterEl.appendChild(failedNote());
      }
    };
  } else {
    allSuggestions.forEach((sug, sugIdx) => {
      addOneSuggestionCard(sug, sugIdx);
    });
    if (!allSuggestions || allSuggestions.length === 0) {
      const noData = dataRefinement.length === 0;
      if (noData) {
        const showNoSuggestions = saved.streamComplete === true || !reviewStillGenerating;
        editContainer.innerHTML = staleIncompletePersisted
          ? `<p class="review-detail-placeholder">${escapeHtml(REVIEW_INCOMPLETE_USER_MSG)}</p>`
          : showNoSuggestions
            ? '<p class="review-detail-placeholder">No suggestions.</p>'
            : '<p class="review-detail-placeholder">Generating suggestions…</p>';
      }
    }
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

  updateSuggestionsFooter();
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
              <button type="button" class="btn btn-secondary review-detail-view-switch__btn review-detail-tab review-detail-tab--active" role="tab" aria-selected="true" aria-controls="review-detail-panel-analysis" id="review-detail-tab-analysis" data-tab="analysis">Error analysis</button>
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
                <textarea class="review-assistant-input" id="review-detail-assistant-input" placeholder="Ask anything..." rows="2"></textarea>
                <button type="button" class="review-assistant-send-inline" id="review-detail-assistant-send" aria-label="Send">↑</button>
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
    title,
    resultId: 'detail',
    saved: saved || {},
    onReviewResultChange: updateReviewResult || null,
    onExportNewPrompt: onExportNewPrompt || null,
    getIsReviewStreaming: getIsReviewStreaming || null,
    getPayload: getPayload || null,
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
    if (data) refreshFromSaved(data);
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
        .map((d) => ({
          row_index: Number(d && d.row_index),
          card_title: String((d && d.card_title) || ''),
          issue_summary: String((d && d.issue_summary) || ''),
          rough_modification_opinion: String((d && d.rough_modification_opinion) || ''),
          problem_category_hint: String((d && d.problem_category_hint) || ''),
        }))
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
    lines.push('## Error analysis (read-only — same as the "Error analysis" tab in the UI)');
    lines.push(
      'Use these per-row failure notes as context when reasoning about prompt changes. You CANNOT edit, delete, or replace this list — there is no tool for it. Your only structured actions are [ASSISTANT_SUGGESTION] (prompt edits) and [ASSISTANT_REMOVE_SUGGESTION] (items in "Suggestions" below).',
    );
    lines.push('');
    rowDiagnostics.forEach((d, i) => {
      const n = i + 1;
      const rowLabel = formatRunRowIndexForDisplay(d.row_index);
      lines.push(`### Error analysis #${n} · Score comparison run result row ${rowLabel}`);
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
    'READ: Error analysis (if listed above) is read-only context. Do not tell the user you changed it or try to remove it — you can only change items under "Suggestions" below.',
  );
  lines.push('ADD: New prompt edit cards via [ASSISTANT_SUGGESTION] (these appear under Suggested changes).');
  lines.push('REMOVE: Only suggestion list items — by suggestion_id (same as UI #1, #2, …) or legacy suggestion_index (data refinement first, then edits).');
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
      lines.push(`#${shortLabel} [Data refinement] suggestion_id="${sid}" ${title} [removable]`);
      if ((d.reason || '').trim().length > 100) lines.push(`   Full: ${(d.reason || '').trim()}`);
    });
    suggestions.forEach((s) => {
      const sid = (s && s.suggestion_id) ? String(s.suggestion_id) : '';
      const shortLabel = formatSuggestionIdDisplay(sid);
      const title = (s.name || '').trim() || (s.reason || '').trim().slice(0, 80) || `[Section ${s.section_index ?? 0}] "${(s.old_sentence || '').slice(0, 40)}..." → "${(s.new_sentence || '').slice(0, 40)}..."`;
      const applied = s.applied === true ? ' [applied]' : '';
      lines.push(`#${shortLabel} [Edit] suggestion_id="${sid}" ${title}${applied} [removable]`);
      lines.push(`   Reason: ${(s.reason || '').trim()}`);
    });
    lines.push('You may remove any item using [ASSISTANT_REMOVE_SUGGESTION] with suggestion_id (preferred) or suggestion_index (legacy).');
    lines.push('');
  }
  lines.push('## Adding suggestions');
  lines.push('[ASSISTANT_SUGGESTION] adds edits to the PROMPT (old_sentence → new_sentence). It does NOT remove items from the suggestions list. To remove suggestions from the list, use [ASSISTANT_REMOVE_SUGGESTION] (see Removing section).');
  lines.push('Do NOT add suggestions when the user is only asking a question, seeking clarification, or discussing. Just answer in text. Only use [ASSISTANT_SUGGESTION] when the user explicitly asks you to make a change, add a suggestion, or edit the prompt.');
  lines.push('When you decide to suggest a concrete edit, include one or more blocks in this exact format:');
  lines.push('[ASSISTANT_SUGGESTION]');
  lines.push('{"section_index": 0, "old_sentence": "exact text to replace from prompt", "new_sentence": "replacement", "reason": "why", "name": "Short title"}');
  lines.push('[/ASSISTANT_SUGGESTION]');
  lines.push('When adding suggestions, also write a brief comment (e.g. what you changed or why it helps). The user will see this instead of a generic message. If you omit the comment, we show "Added. Please check the Suggestions panel on the left and choose Accept or Revert."');
  lines.push('Rules: old_sentence must match the current prompt content exactly. new_sentence: use "" (empty string) for pure deletion; use the exact replacement for edits. Do NOT add content when the user asked only to delete. Only suggest what the user explicitly asked for — no extra additions.');
  lines.push('');
  lines.push('## Removing suggestions');
  lines.push('When the user asks to DELETE or REMOVE suggestions (e.g. 删除, 移除, remove, delete): use [ASSISTANT_REMOVE_SUGGESTION]. Do NOT use [ASSISTANT_SUGGESTION] — that is for adding edits to the prompt, not for removing suggestions from the list.');
  lines.push('Prefer removing by suggestion_id from the list above. Example: [ASSISTANT_REMOVE_SUGGESTION]{"suggestion_id":3}[/ASSISTANT_REMOVE_SUGGESTION]. For multiple removals, output one block per item.');
  lines.push('Legacy (positional): [ASSISTANT_REMOVE_SUGGESTION]{"suggestion_index": N}[/ASSISTANT_REMOVE_SUGGESTION] where N is 1-based global order (all data refinement items, then all edits).');
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
        blocks.push(
          ensureSuggestionObjectId(
            {
              section_index: obj.section_index,
              old_sentence: String(obj.old_sentence || '').trim(),
              new_sentence: String(obj.new_sentence || '').trim(),
              reason: String(obj.reason || '').trim(),
              name: String(obj.name || '').trim(),
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

/** @param {{ data_refinement?: unknown[], suggestions?: unknown[] }} st */
function removeSuggestionByGlobalIndexFromState(st, oneBased) {
  if (!st || typeof oneBased !== 'number' || oneBased < 1) return;
  const R = (st.data_refinement || []).length;
  const n = Math.floor(oneBased);
  if (n >= 1 && n <= R) {
    st.data_refinement.splice(n - 1, 1);
    return;
  }
  const editIdx = n - R - 1;
  const sg = st.suggestions || [];
  if (editIdx >= 0 && editIdx < sg.length) sg.splice(editIdx, 1);
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
    dr.splice(i, 1);
    return true;
  }
  i = Array.isArray(sg) ? sg.findIndex(match) : -1;
  if (i >= 0) {
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

/** Init Review assistant chat: uses default_review_credential_id from settings. */
function initReviewAssistantChat(overlay, contextOptions = {}) {
  const { getPayload, getReviewResult, onReviewResultChange, refreshFromSaved, chatRefreshRef, getIsReviewStreaming } = contextOptions;
  const messagesEl = overlay.querySelector('.review-assistant-messages');
  const inputEl = overlay.querySelector('.review-assistant-input');
  const sendBtn = overlay.querySelector('.review-assistant-send-inline');
  if (!messagesEl || !inputEl || !sendBtn) return;

  let credentialId = '';

  function updateInputState() {
    const streaming = typeof getIsReviewStreaming === 'function' && getIsReviewStreaming();
    if (!credentialId) {
      inputEl.disabled = true;
      inputEl.placeholder = 'Select a model in Settings first';
      sendBtn.disabled = true;
    } else if (streaming) {
      inputEl.disabled = true;
      inputEl.placeholder = 'Wait for review to complete...';
      sendBtn.disabled = true;
    } else {
      inputEl.disabled = false;
      inputEl.placeholder = 'Ask anything...';
      sendBtn.disabled = false;
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
      const assistantId = (settings?.default_review_assistant_credential_id || '').trim();
      const reviewId = (settings?.default_review_credential_id || '').trim();
      const candidateId = assistantId || reviewId;
      if (candidateId && (list || []).some((c) => c.id === candidateId)) {
        credentialId = candidateId;
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
    if (!text || !credentialId || streaming) return;
    inputEl.value = '';
    sendBtn.disabled = true;
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
      let displayContent = stripAssistantSuggestionBlocks(rawContent);
      if (!displayContent || !displayContent.trim()) {
        displayContent = parsedSuggestions.length > 0
          ? 'Added. Please check the Suggestions panel on the left and choose Accept or Revert.'
          : removeOps.length > 0
            ? removeOps.length > 1
              ? 'Removed. The suggestions have been deleted from the list.'
              : 'Removed. The suggestion has been deleted from the list.'
            : '(No response)';
      }
      chatHistory.push({ role: 'assistant', content: displayContent });
      if (isModalOpen()) appendMessageWithTypewriter('assistant', displayContent);
      if (reviewSaved && typeof reviewSaved === 'object') {
        let dataRefinement = (reviewSaved.data_refinement || []).slice();
        let suggestions = (reviewSaved.suggestions || []).slice();
        if (removeOps.length > 0) {
          const st = { data_refinement: dataRefinement, suggestions };
          const idOps = removeOps.filter((o) => o.suggestion_id).map((o) => o.suggestion_id);
          const indexOps = removeOps
            .filter((o) => o.suggestion_index != null)
            .map((o) => o.suggestion_index)
            .sort((a, b) => b - a);
          idOps.forEach((id) => removeSuggestionByIdFromState(st, id));
          indexOps.forEach((n) => removeSuggestionByGlobalIndexFromState(st, n));
        }
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
    } finally {
      if (isModalOpen()) sendBtn.disabled = false;
    }
  }

  sendBtn.addEventListener('click', sendMessage);
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
        appendMessage('assistant', 'Please select a model in Settings → Prompt Reviewer (Default model or Assistant model) to use the Assistant.');
      }
    } else if (chatHistory.length === 0) {
      const streaming = typeof getIsReviewStreaming === 'function' && getIsReviewStreaming();
      if (!streaming) {
        appendMessage('assistant', REVIEW_ASSISTANT_WELCOME_MSG);
      }
    }
  });
}

/** Open modal with review result (from Score Add Review). Saves result to reviewNode (via reviewNodeId) or scoreNode. Pass streamRef to show suggestions incrementally. 右侧 Prompt sections 一打开就填好，左侧 Suggestions 流式一条条出现。 */
export function openReviewResultModal({ summary, suggestions = [], promptSections = [], promptFullText = '', scoreNode, reviewNodeId, onExportNewPrompt, streamRef, saved: initialSaved }) {
  const workingSections = Array.isArray(promptSections) && promptSections.length > 0
    ? promptSections.map((s) => ({ name: s.name || '', content: (s.content || '').slice() }))
    : [];
  const promptSectionsHtml = workingSections.length > 0
    ? renderSectionsAsPromptDetail(workingSections)
    : '';

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'review-result-title');
  overlay.innerHTML = `
    <div class="modal-panel modal-panel--review-detail">
      <div class="modal-header">
        <h2 id="review-result-title" class="modal-title">Review result</h2>
        <button type="button" class="modal-close" aria-label="Close">×</button>
      </div>
      <div class="modal-body review-detail-body">
        <div class="review-detail-main">
          <h3 class="review-detail-preview-title review-detail-output-title">Findings</h3>
          <p class="review-detail-stream-status" id="review-result-stream-status" aria-live="polite"></p>
          <div class="review-detail-output-toolbar">
            <div class="review-detail-view-switch review-detail-right-tabs" role="tablist" aria-label="Switch findings view">
              <button type="button" class="btn btn-secondary review-detail-view-switch__btn review-detail-tab review-detail-tab--active" role="tab" aria-selected="true" aria-controls="review-result-panel-analysis" id="review-result-tab-analysis" data-tab="analysis">Error analysis</button>
              <button type="button" class="btn btn-secondary review-detail-view-switch__btn review-detail-tab" role="tab" aria-selected="false" aria-controls="review-result-panel-suggestions" id="review-result-tab-suggestions" data-tab="suggestions">Suggested changes</button>
            </div>
          </div>
          <div class="review-detail-preview-content">
            <div class="review-detail-tab-panels">
              <div class="review-detail-tab-panel review-detail-tab-panel--active" id="review-result-panel-analysis" role="tabpanel" aria-labelledby="review-result-tab-analysis" data-panel="analysis">
                <div class="review-detail-row-diagnostics" id="review-result-row-diagnostics"></div>
                <div class="review-detail-analysis-footer" id="review-result-analysis-footer"></div>
              </div>
              <div class="review-detail-tab-panel" id="review-result-panel-suggestions" role="tabpanel" aria-labelledby="review-result-tab-suggestions" data-panel="suggestions">
                <div class="review-detail-suggestions" id="review-result-suggestions"></div>
                <div class="review-detail-suggestions-footer" id="review-result-suggestions-footer"></div>
              </div>
            </div>
          </div>
        </div>
        <div class="review-detail-preview-wrap">
          <p class="prompt-step-label">Prompt sections</p>
          <div class="prompt-detail-sections-scroll">
            <div class="prompt-detail-sections-wrap">
              <div class="review-detail-prompt-wrap prompt-detail-sections-view">${promptSectionsHtml}</div>
            </div>
          </div>
          <div class="review-detail-prompt-footer" id="review-result-prompt-footer"></div>
        </div>
        <div class="review-detail-third-column">
          <h3 class="review-detail-preview-title">Review assistant</h3>
          <div class="review-assistant-chat-wrap">
            <div class="review-assistant-messages" id="review-result-assistant-messages"></div>
            <div class="review-assistant-clear-bar">
              <button type="button" class="review-assistant-clear-btn" aria-label="Clear chat history">Clear chat history</button>
            </div>
            <div class="review-assistant-input-wrap">
              <div class="review-assistant-input-inner">
                <textarea class="review-assistant-input" id="review-result-assistant-input" placeholder="Ask anything..." rows="2"></textarea>
                <button type="button" class="review-assistant-send-inline" id="review-result-assistant-send" aria-label="Send">↑</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  const baseSaved = {
    summary: summary || '',
    suggestions: suggestions || [],
    promptSections: (promptSections || []).slice(),
    promptFullText: promptFullText || sectionsToFullText(promptSections || []),
    workingSections: workingSections.length ? workingSections.map((s) => ({ name: s.name, content: s.content })) : [],
  };
  const savedRef = {
    current: initialSaved && typeof initialSaved === 'object' ? { ...baseSaved, ...initialSaved } : baseSaved,
  };
  const saved = savedRef.current;
  ensureReviewResultIds(saved);
  const persistResult = (updated) => {
    savedRef.current = updated;
    if (reviewNodeId) {
      document.dispatchEvent(new CustomEvent('workflow:save-review-result', { detail: { reviewNodeId, data: updated } }));
    } else if (scoreNode) {
      try {
        scoreNode.dataset.reviewResult = JSON.stringify(updated);
        document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
      } catch (_) {}
    }
  };
  if (reviewNodeId || scoreNode) persistResult(saved);

  const baseOptions = {
    promptSections: saved.promptSections.length ? saved.promptSections : workingSections,
    suggestions: saved.suggestions || [],
    promptFullText: saved.promptFullText || '',
    title: 'Review result',
    resultId: 'result',
    saved,
    onReviewResultChange: (reviewNodeId || scoreNode) ? persistResult : null,
    onExportNewPrompt: onExportNewPrompt || null,
    streamRef: streamRef || null,
  };
  const chatRefreshRef = { current: null };
  const refreshFromSaved = (data) => {
    if (!data || typeof data !== 'object') return;
    savedRef.current = data;
    if (reviewNodeId || scoreNode) persistResult(data);
    buildReviewResultUI(overlay, {
      ...baseOptions,
      promptSections: (data.promptSections || []).length ? data.promptSections : workingSections,
      suggestions: data.suggestions || [],
      saved: data,
    });
    if (chatRefreshRef.current) chatRefreshRef.current(data);
  };

  overlay.querySelector('.modal-close').addEventListener('click', () => { overlay.remove(); document.body.style.overflow = ''; });
  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);
  initReviewAssistantChat(overlay, {
    getPayload: () => null,
    getReviewResult: () => savedRef.current,
    onReviewResultChange: (reviewNodeId || scoreNode) ? persistResult : null,
    refreshFromSaved,
    chatRefreshRef,
  });

  buildReviewResultUI(overlay, baseOptions);
}
