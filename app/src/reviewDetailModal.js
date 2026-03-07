/**
 * Review: left = prompt in prompt-detail style; right = suggestions.
 * Hover a suggestion: left shows that section with red (removed) / green (added) minimal diff.
 * Result is saved on the Score node and persisted with the project.
 */

import { showConfirm } from './alertModal.js';

const API_BASE = 'http://localhost:8000';

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
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

/** Render a single line with sentence-level diff (red/green only, no structure change). */
function renderLineDiff(oldLine, newLine) {
  if (oldLine === newLine) return escapeHtml(oldLine || '');
  if (!newLine) return `<span class="review-removed">${escapeHtml(oldLine)}</span>`;
  const segments = sentenceDiff(oldLine, newLine);
  return segments.map((seg) => {
    if (seg.type === 'equal') return escapeHtml(seg.text);
    if (seg.type === 'remove') return `<span class="review-removed">${escapeHtml(seg.text)}</span>`;
    return `<span class="review-added">${escapeHtml(seg.text)}</span>`;
  }).join(' ');
}

/** Render one section's content, optionally with diff or highlight. Preserves line breaks (one div per line). */
function renderSectionContent(content, newContent, withDiff, removeSpan, highlightSpan, highlightAsRemoved, highlightAddSpan) {
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
      return escapeHtml(before) + `<span class="review-removed">${escapeHtml(span)}</span>` + escapeHtml(after);
    });
    return lineHtmls.map((html) => `<div class="preview-field-content-line">${html}</div>`).join('');
  }
  if (oldC === newC) {
    return oldLines.length > 0
      ? oldLines.map((line) => `<div class="preview-field-content-line">${escapeHtml(line)}</div>`).join('')
      : '<div class="preview-field-content-line"></div>';
  }
  if (newC === '') {
    return oldLines.map((line) => `<div class="preview-field-content-line"><span class="review-removed">${escapeHtml(line)}</span></div>`).join('');
  }
  const numLines = Math.max(oldLines.length, newLines.length);
  const lineHtmls = [];
  for (let i = 0; i < numLines; i++) {
    const oldLine = oldLines[i] || '';
    const newLine = newLines[i] || '';
    lineHtmls.push(renderLineDiff(oldLine, newLine));
  }
  return lineHtmls.map((html) => `<div class="preview-field-content-line">${html}</div>`).join('');
}

/** Render sections: optionally diff or highlight one section. highlightSpan/highlightAsRemoved: Revert state; highlightAddSpan: green text to show after red (what will be restored). */
function renderSectionsAsPromptDetail(sections, diffSectionIndex, diffNewContent, removeSpan, highlightSpan, highlightAsRemoved, highlightAddSpan) {
  if (!Array.isArray(sections) || sections.length === 0) return '<p class="prompt-detail-placeholder">No sections.</p>';
  return sections.map((s, i) => {
    const name = (s.name || '').trim() || 'Unnamed';
    const content = s.content || '';
    const isTargetSection = diffSectionIndex === i;
    const useHighlightOnly = isTargetSection && highlightSpan !== undefined && highlightSpan !== null;
    const withDiff = isTargetSection && !useHighlightOnly && diffNewContent !== undefined;
    let contentHtml;
    if (useHighlightOnly || withDiff) {
      contentHtml = renderSectionContent(content, withDiff ? diffNewContent : null, withDiff, removeSpan, highlightSpan, highlightAsRemoved, highlightAddSpan);
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

/** Build the shared result UI: left = sections (working copy), right = suggestions with accept/revert; full reason shown in card when selected. */
function buildReviewResultUI(overlay, options) {
  const { promptSections, suggestions: initialSuggestions, promptFullText, title, resultId, saved = {}, onReviewResultChange, onExportNewPrompt, streamRef, getIsReviewStreaming } = options;
  const promptWrap = overlay.querySelector('.review-detail-prompt-wrap');
  const suggestionsEl = overlay.querySelector('.review-detail-suggestions');
  const suggestionsFooterEl = overlay.querySelector('.review-detail-suggestions-footer');
  if (!promptWrap || !suggestionsEl) return;

  const PREVIEW_LEN = 60;
  const originals = (promptSections || []).map((s) => ({ name: s.name || '', content: (s.content || '').slice() }));
  const savedSuggestions = Array.isArray(saved.suggestions) ? saved.suggestions : [];
  const savedWorking = Array.isArray(saved.workingSections) && saved.workingSections.length === originals.length
    ? saved.workingSections.map((s) => ({ name: s.name || '', content: (s.content || '').slice() }))
    : null;
  const workingFromApplied = rebuildWorkingFromApplied(originals, savedSuggestions);
  /** Working copy: always kept in sync by recomputing from originals + suggestions where .applied === true */
  let working = savedWorking || (workingFromApplied && workingFromApplied.length === originals.length ? workingFromApplied : null) || originals.map((s) => ({ name: s.name, content: s.content }));
  const allSuggestions = Array.isArray(initialSuggestions) ? initialSuggestions.slice() : [];
  /** Design suggestions: global guidance only, no accept/revert */
  let designSuggestions = Array.isArray(saved.design_suggestions) ? saved.design_suggestions.slice() : [];
  /** Data refinement: GT 质疑汇总 */
  let dataRefinement = Array.isArray(saved.data_refinement) ? saved.data_refinement.slice() : [];

  if (promptWrap) {
    promptWrap.innerHTML = renderSectionsAsPromptDetail(working);
  }

  suggestionsEl.innerHTML = '';
  const designContainer = document.createElement('div');
  designContainer.className = 'review-detail-design-suggestions';
  suggestionsEl.appendChild(designContainer);
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
      design_suggestions: designSuggestions,
      data_refinement: dataRefinement,
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
      const blocks = promptSectionsEl.querySelectorAll('.preview-field-block');
      const block = blocks[sectionIndex];
      if (block) block.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  }

  const promptSectionsEl = promptWrap;

  function renderLeft(showDiffSectionIndex, diffNewContent, removeSpan, highlightSpan, highlightAsRemoved, highlightAddSpan) {
    const sectionsToRender = working.map((s, i) => ({ name: s.name, content: s.content }));
    if (showDiffSectionIndex >= 0 && showDiffSectionIndex < originals.length && (diffNewContent !== undefined || (highlightSpan !== undefined && highlightSpan !== null))) {
      promptSectionsEl.innerHTML = renderSectionsAsPromptDetail(sectionsToRender, showDiffSectionIndex, diffNewContent, removeSpan, highlightSpan, highlightAsRemoved, highlightAddSpan);
      scrollRightToSection(showDiffSectionIndex);
    } else {
      promptSectionsEl.innerHTML = renderSectionsAsPromptDetail(sectionsToRender);
    }
  }

  function showDiffOnRight(sectionIndex, newContent, removeSpan, highlightSpan, highlightAsRemoved, highlightAddSpan) {
    renderLeft(sectionIndex, newContent, removeSpan, highlightSpan, highlightAsRemoved, highlightAddSpan);
  }

  function clearDiffOnRight() {
    renderLeft(-1);
  }

  const sectionNames = (promptSections || []).map((s, i) => (s.name || '').trim() || `Section ${i}`);

  const statusEl = overlay.querySelector('.review-detail-stream-status');

  function addOneDesignCard(d, displayNum) {
    const card = document.createElement('div');
    card.className = 'review-detail-suggestion-card review-detail-design-card';
    card.innerHTML = `
      <div class="review-detail-suggestion-card__main">
        <span class="review-detail-suggestion-header"><span class="review-detail-suggestion-num" aria-label="Suggestion number">#${displayNum}</span> <strong class="review-detail-suggestion-section-name">${escapeHtml((d.name || '').trim() || 'Design')}</strong></span>
        <p class="review-detail-suggestion-reason">${escapeHtml((d.reason || '').trim())}</p>
      </div>
    `;
    designContainer.appendChild(card);
  }

  function addOneDataRefinementCard(item, displayNum) {
    const rowIndices = Array.isArray(item.row_indices) ? item.row_indices : [];
    const rowsText = rowIndices.length > 0 ? `Rows ${rowIndices.join(', ')}` : 'Some rows';
    const card = document.createElement('div');
    card.className = 'review-detail-suggestion-card review-detail-data-refinement-card';
    card.innerHTML = `
      <div class="review-detail-suggestion-card__main">
        <span class="review-detail-suggestion-header"><span class="review-detail-suggestion-num" aria-label="Suggestion number">#${displayNum}</span> <strong class="review-detail-suggestion-section-name">Possible ground truth issue</strong></span>
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

  function addOneSuggestionCard(sug, sugIdx, displayNum) {
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
    const changeName = (sug.name || '').trim() || name;

    const card = document.createElement('div');
    card.className = 'review-detail-suggestion-card' + (noButton ? ' review-detail-suggestion-card--unlocatable' : '');
    card.dataset.sectionIndex = String(secIdx);
    card.dataset.suggestionIndex = String(sugIdx);
    card.innerHTML = `
      <div class="review-detail-suggestion-card__main">
        <span class="review-detail-suggestion-header"><span class="review-detail-suggestion-num" aria-label="Suggestion number">#${displayNum}</span> <strong class="review-detail-suggestion-section-name">${escapeHtml(changeName)}</strong></span>
        <p class="review-detail-suggestion-reason">${escapeHtml(fullReason)}</p>
      </div>
      <div class="review-detail-suggestion-card__actions">
        ${noButton ? '' : '<button type="button" class="btn btn-secondary review-detail-accept-btn' + (isApplied ? ' review-detail-accept-btn--revert' : '') + '">' + (isApplied ? 'Revert' : 'Accept') + '</button>'}
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
        showDiffOnRight(secIdx, getRevertedContent(), getRemoveSpanForDiff());
      } else {
        showDiffOnRight(secIdx, getDiffContent(), getRemoveSpanForDiff());
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

  let displayNum = 0;
  designSuggestions.forEach((d) => { displayNum += 1; addOneDesignCard(d, displayNum); });
  dataRefinement.forEach((item) => { displayNum += 1; addOneDataRefinementCard(item, displayNum); });
  function updateSuggestionsDesignEmptyClass() {
    if (suggestionsEl) suggestionsEl.classList.toggle('review-detail-suggestions--design-empty', designContainer.children.length === 0);
  }
  updateSuggestionsDesignEmptyClass();

  if (streamRef) {
    if (statusEl) statusEl.textContent = 'Generating suggestions…';
    streamRef.appendDesignSuggestions = (arr) => {
      if (!Array.isArray(arr)) return;
      designSuggestions = arr.slice();
      designContainer.innerHTML = '';
      designSuggestions.forEach((d, i) => addOneDesignCard(d, i + 1));
      updateSuggestionsDesignEmptyClass();
      saved.design_suggestions = designSuggestions;
      if (typeof onReviewResultChange === 'function') {
        onReviewResultChange({ ...saved, design_suggestions: designSuggestions });
      }
    };
    streamRef.appendDataRefinement = (arr) => {
      if (!Array.isArray(arr)) return;
      dataRefinement = arr.slice();
      dataRefinementContainer.innerHTML = '';
      dataRefinement.forEach((item, i) => addOneDataRefinementCard(item, designSuggestions.length + i + 1));
      saved.data_refinement = dataRefinement;
      if (typeof onReviewResultChange === 'function') {
        onReviewResultChange({ ...saved, data_refinement: dataRefinement });
      }
    };
    streamRef.appendSuggestions = (batch) => {
      if (statusEl) statusEl.textContent = 'Generating suggestions…';
      batch.forEach((sug, i) => {
        const sugIdx = allSuggestions.length;
        allSuggestions.push(sug);
        const displayNum = designSuggestions.length + dataRefinement.length + i + 1;
        addOneSuggestionCard(sug, sugIdx, displayNum);
      });
      saved.suggestions = allSuggestions.slice();
      if (typeof onReviewResultChange === 'function') {
        onReviewResultChange({ ...saved, suggestions: saved.suggestions });
      }
    };
    streamRef.streamDone = () => {
      if (statusEl) statusEl.textContent = 'Suggestions complete.';
      if (allSuggestions.length === 0 && designSuggestions.length === 0 && dataRefinement.length === 0) {
        editContainer.innerHTML = '<p class="review-detail-placeholder">Generating suggestions…</p>';
      }
      saved.suggestions = allSuggestions.slice();
      saved.design_suggestions = designSuggestions;
      saved.data_refinement = dataRefinement;
      if (typeof onReviewResultChange === 'function') {
        onReviewResultChange({ ...saved, suggestions: saved.suggestions, design_suggestions: designSuggestions, data_refinement: dataRefinement });
      }
    };
    streamRef.streamError = () => {
      if (statusEl) statusEl.textContent = 'Failed.';
      if (allSuggestions.length === 0 && designSuggestions.length === 0) {
        editContainer.innerHTML = '<p class="review-detail-placeholder">Request failed.</p>';
      }
    };
  } else {
    (initialSuggestions || []).forEach((sug, sugIdx) => {
      displayNum += 1;
      addOneSuggestionCard(sug, sugIdx, displayNum);
    });
    if (!initialSuggestions || initialSuggestions.length === 0) {
      if (designSuggestions.length === 0) {
        editContainer.innerHTML = '<p class="review-detail-placeholder">Generating suggestions…</p>';
      }
    }
  }

  if (suggestionsFooterEl && (allSuggestions.length > 0 || designSuggestions.length > 0)) {
    const isComplete = saved.streamComplete === true;
    const isStreaming = !isComplete && typeof getIsReviewStreaming === 'function' && getIsReviewStreaming();
    let statusClass = 'review-detail-status-note--incomplete';
    let statusText = 'Last run did not complete. Please run Review again.';
    if (isComplete) {
      statusClass = 'review-detail-status-note--complete';
      statusText = 'Suggestions complete.';
    } else if (isStreaming) {
      statusClass = 'review-detail-status-note--generating';
      statusText = 'Suggestions are still generating…';
    }
    const statusNote = document.createElement('p');
    statusNote.className = 'review-detail-status-note ' + statusClass;
    statusNote.setAttribute('aria-live', 'polite');
    statusNote.textContent = statusText;
    suggestionsFooterEl.innerHTML = '';
    suggestionsFooterEl.appendChild(statusNote);
  }

  const footer = overlay.querySelector('.review-detail-prompt-footer');
  if (footer) {
    footer.innerHTML = '';
    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.className = 'btn btn-primary review-detail-export-btn';
    exportBtn.textContent = 'Apply';
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
  const payload = getPayload ? getPayload() : null;
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
          <h3 class="review-detail-preview-title">Suggestions</h3>
          <div class="review-detail-preview-content">
            <div class="review-detail-suggestions" id="review-detail-suggestions"></div>
            <div class="review-detail-suggestions-footer" id="review-detail-suggestions-footer"></div>
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
    if (!promptWrap.innerHTML.trim()) promptWrap.innerHTML = '<p class="review-detail-placeholder">Running analysis…</p>';
    suggestionsEl.innerHTML = '<p class="review-detail-placeholder">Running analysis…</p>';
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
  });
}

/** Build context text for Review assistant from saved + payload. */
function buildReviewAssistantContext(getPayload, getReviewResult) {
  const saved = typeof getReviewResult === 'function' ? getReviewResult() : null;
  const payload = typeof getPayload === 'function' ? getPayload() : null;
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
  const comparisonRows = saved?.comparison_rows || payload?.comparison_rows || [];
  const runResults = saved?.run_results || payload?.run_results || [];
  if (comparisonRows.length > 0 || runResults.length > 0) {
    lines.push('## Run Results');
    const failed = comparisonRows.filter((r) => !r.matched);
    if (failed.length > 0) {
      lines.push(`Sample failed rows (${failed.length} of ${comparisonRows.length} total):`);
      failed.slice(0, 10).forEach((r, i) => {
        lines.push(`Row ${r.row_index}: NOT matched`);
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
  const designSuggestions = saved?.design_suggestions || [];
  const dataRefinement = saved?.data_refinement || [];
  lines.push('## Your permissions');
  lines.push('ADD: You can add new edit suggestions anytime via [ASSISTANT_SUGGESTION].');
  lines.push('REMOVE: You can ONLY remove suggestions marked [removable]. These are edit suggestions YOU added in this chat.');
  lines.push('CANNOT REMOVE: [Design], [Data refinement], and [Edit] marked [not removable] — these come from the initial Review and you must not delete them.');
  lines.push('');
  if (suggestions.length > 0 || designSuggestions.length > 0 || dataRefinement.length > 0) {
    lines.push('## Suggestions (in display order, same numbering as UI)');
    const removableNums = [];
    let num = 0;
    designSuggestions.forEach((d) => {
      num += 1;
      const title = (d.name || '').trim() || (d.reason || '').trim().slice(0, 80);
      lines.push(`#${num}. [Design] ${title} [not removable]`);
      if ((d.reason || '').trim()) lines.push(`   Reason: ${(d.reason || '').trim()}`);
    });
    dataRefinement.forEach((d) => {
      num += 1;
      const rows = (d.row_indices || []).length > 0 ? `Rows ${(d.row_indices || []).join(', ')}: ` : '';
      const title = rows + ((d.reason || '').trim().slice(0, 100) || 'Possible ground truth issue');
      lines.push(`#${num}. [Data refinement] ${title} [not removable]`);
      if ((d.reason || '').trim().length > 100) lines.push(`   Full: ${(d.reason || '').trim()}`);
    });
    suggestions.forEach((s) => {
      num += 1;
      if (s.source === 'assistant') removableNums.push(num);
      const title = (s.name || '').trim() || (s.reason || '').trim().slice(0, 80) || `[Section ${s.section_index ?? 0}] "${(s.old_sentence || '').slice(0, 40)}..." → "${(s.new_sentence || '').slice(0, 40)}..."`;
      const applied = s.applied === true ? ' [applied]' : '';
      const removable = s.source === 'assistant' ? ' [removable]' : ' [not removable]';
      lines.push(`#${num}. [Edit] ${title}${applied}${removable}`);
      lines.push(`   Reason: ${(s.reason || '').trim()}`);
    });
    if (removableNums.length > 0) {
      lines.push(`You may remove only: #${removableNums.join(', #')}.`);
    } else {
      lines.push('You may remove: none (no suggestions were added by you in this chat).');
    }
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
  lines.push('When the user asks to DELETE or REMOVE suggestions (e.g. 删除, 移除, remove, delete, "delete #6 and #7"): use [ASSISTANT_REMOVE_SUGGESTION]. Do NOT use [ASSISTANT_SUGGESTION] — that is for adding edits to the prompt, not for removing suggestions from the list.');
  lines.push('1. If it is [not removable] (Design, Data refinement, or Edit from the initial Review): say you cannot remove it — only suggestions you added in this chat can be removed.');
  lines.push('2. If it is [removable]: confirm "Do you want me to remove suggestion #N? Please confirm.", then only when they confirm, output [ASSISTANT_REMOVE_SUGGESTION]{"suggestion_index": N}[/ASSISTANT_REMOVE_SUGGESTION]. For multiple removals (e.g. #6 and #7), output one block per suggestion.');
  lines.push('Never output ASSISTANT_REMOVE_SUGGESTION for a [not removable] suggestion — it will be ignored.');
  lines.push('');
  lines.push('Stay focused ONLY on improving the current prompt. Answer directly and solve problems. Do not describe your context or internal structure to the user. If the user asks something unrelated to this prompt, briefly redirect to prompt improvement.');
  return lines.join('\n');
}

/** Parse [ASSISTANT_SUGGESTION]...[/ASSISTANT_SUGGESTION] blocks from assistant response. */
function parseAssistantSuggestions(text) {
  const blocks = [];
  const re = /\[ASSISTANT_SUGGESTION\]\s*([\s\S]*?)\s*\[\/ASSISTANT_SUGGESTION\]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    try {
      const obj = JSON.parse(m[1].trim());
      if (obj && typeof obj.section_index === 'number') {
        blocks.push({
          section_index: obj.section_index,
          old_sentence: String(obj.old_sentence || '').trim(),
          new_sentence: String(obj.new_sentence || '').trim(),
          reason: String(obj.reason || '').trim(),
          name: String(obj.name || '').trim(),
          source: 'assistant',
        });
      }
    } catch (_) {}
  }
  return blocks;
}

/** Parse [ASSISTANT_REMOVE_SUGGESTION]...[/ASSISTANT_REMOVE_SUGGESTION] blocks. Returns 1-based indices to remove. */
function parseAssistantRemoveSuggestions(text) {
  const indices = [];
  const re = /\[ASSISTANT_REMOVE_SUGGESTION\]\s*([\s\S]*?)\s*\[\/ASSISTANT_REMOVE_SUGGESTION\]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    try {
      const obj = JSON.parse(m[1].trim());
      const idx = obj?.suggestion_index;
      if (typeof idx === 'number' && idx >= 1) indices.push(idx);
    } catch (_) {}
  }
  return indices;
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
  const { getPayload, getReviewResult, onReviewResultChange, refreshFromSaved, chatRefreshRef } = contextOptions;
  const messagesEl = overlay.querySelector('.review-assistant-messages');
  const inputEl = overlay.querySelector('.review-assistant-input');
  const sendBtn = overlay.querySelector('.review-assistant-send-inline');
  if (!messagesEl || !inputEl || !sendBtn) return;

  let credentialId = '';
  const saved0 = typeof getReviewResult === 'function' ? getReviewResult() : null;
  const initialChat = Array.isArray(saved0?.chatHistory) ? saved0.chatHistory : [];
  const chatHistory = initialChat.map((m) => ({ role: m.role, content: String(m.content || '').trim() }));

  function getSystemContext() {
    const ctx = buildReviewAssistantContext(getPayload, getReviewResult);
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
    if (!text || !credentialId) return;
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
    const systemContext = getSystemContext();
    const messagesToSend = systemContext
      ? [{ role: 'system', content: systemContext }, ...chatHistory]
      : chatHistory;
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
      const parsedSuggestions = parseAssistantSuggestions(rawContent);
      const removeIndices = parseAssistantRemoveSuggestions(rawContent);
      let displayContent = stripAssistantSuggestionBlocks(rawContent);
      if (!displayContent || !displayContent.trim()) {
        displayContent = parsedSuggestions.length > 0
          ? 'Added. Please check the Suggestions panel on the left and choose Accept or Revert.'
          : removeIndices.length > 0
            ? 'Removed. The suggestion has been deleted from the list.'
            : '(No response)';
      }
      chatHistory.push({ role: 'assistant', content: displayContent });
      if (isModalOpen()) appendMessageWithTypewriter('assistant', displayContent);
      const saved = typeof getReviewResult === 'function' ? getReviewResult() : null;
      if (saved && typeof saved === 'object') {
        let suggestions = (saved.suggestions || []).slice();
        if (removeIndices.length > 0) {
          const designCount = (saved.design_suggestions || []).length;
          const dataRefinementCount = (saved.data_refinement || []).length;
          const editStartGlobal = designCount + dataRefinementCount + 1;
          const toRemoveGlobal = new Set(removeIndices);
          suggestions = suggestions.filter((s, i) => {
            const globalIndex = editStartGlobal + i;
            if (!toRemoveGlobal.has(globalIndex)) return true;
            return s.source !== 'assistant';
          });
        }
        if (parsedSuggestions.length > 0) {
          const sections = saved.workingSections || saved.promptSections || [];
          const validSuggestions = parsedSuggestions.filter((s) => s.section_index >= 0 && s.section_index < sections.length);
          suggestions = suggestions.concat(validSuggestions);
        }
        persistChatResult({ ...saved, suggestions, chatHistory: chatHistory.slice(), chatRequestInProgress: false });
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
        appendMessage('assistant', 'You can chat with me to discuss how to improve the prompt. Ask questions, request edits, or ask me to add or remove suggestions.');
      }
    });
  }

  chatHistory.forEach((m) => appendMessage(m.role, m.content || '(empty)'));

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
    };
  }

  loadCredential().then(() => {
    if (!credentialId) {
      if (chatHistory.length === 0) {
        appendMessage('assistant', 'Please select a model in Settings → Prompt Reviewer (Default model or Assistant model) to use the Assistant.');
      }
      inputEl.disabled = true;
      inputEl.placeholder = 'Select a model in Settings first';
      sendBtn.disabled = true;
    } else if (chatHistory.length === 0) {
      appendMessage('assistant', 'You can chat with me to discuss how to improve the prompt. Ask questions, request edits, or ask me to add or remove suggestions.');
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
          <h3 class="review-detail-preview-title">Suggestions</h3>
          <p class="review-detail-stream-status" id="review-result-stream-status" aria-live="polite"></p>
          <div class="review-detail-preview-content">
            <div class="review-detail-suggestions" id="review-result-suggestions"></div>
            <div class="review-detail-suggestions-footer" id="review-result-suggestions-footer"></div>
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
