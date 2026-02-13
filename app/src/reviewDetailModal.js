/**
 * Review: left = prompt in prompt-detail style; right = suggestions.
 * Hover a suggestion: left shows that section with red (removed) / green (added) minimal diff.
 * Result is saved on the Score node and persisted with the project.
 */

const API_BASE = 'http://localhost:8000';

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
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

/** Tokenize into words and spaces for minimal diff. */
function tokenize(str) {
  if (str == null || str === '') return [];
  const s = String(str);
  const tokens = [];
  let i = 0;
  while (i < s.length) {
    const ws = s.slice(i).match(/^\s+/);
    if (ws) {
      tokens.push(ws[0]);
      i += ws[0].length;
      continue;
    }
    const word = s.slice(i).match(/^\S+/);
    if (word) {
      tokens.push(word[0]);
      i += word[0].length;
      continue;
    }
    i++;
  }
  return tokens;
}

/** Minimal word-level diff. Returns [{ type: 'equal'|'remove'|'add', text }]. */
function wordDiff(oldStr, newStr) {
  const a = tokenize(oldStr);
  const b = tokenize(newStr);
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

/** Render one section's content, optionally with diff (red remove, green add). */
function renderSectionContent(content, newContent, withDiff) {
  const oldC = (content || '').trim();
  const newC = (newContent || '').trim();
  if (!withDiff || oldC === newC) return escapeHtml(oldC || '');
  const segments = wordDiff(oldC, newC);
  return segments.map((seg) => {
    if (seg.type === 'equal') return escapeHtml(seg.text);
    if (seg.type === 'remove') return `<span class="review-removed">${escapeHtml(seg.text)}</span>`;
    return `<span class="review-added">${escapeHtml(seg.text)}</span>`;
  }).join('');
}

/** Render sections in prompt-detail style (preview-field-block). Optionally show diff for one section. */
function renderSectionsAsPromptDetail(sections, diffSectionIndex, diffNewContent) {
  if (!Array.isArray(sections) || sections.length === 0) return '<p class="prompt-detail-placeholder">No sections.</p>';
  return sections.map((s, i) => {
    const name = (s.name || '').trim() || 'Unnamed';
    const content = s.content || '';
    const withDiff = diffSectionIndex === i && diffNewContent !== undefined;
    const contentHtml = renderSectionContent(content, diffNewContent, withDiff);
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
  const { promptSections, suggestions, promptFullText, title, resultId, saved = {}, onReviewResultChange, onExportNewPrompt } = options;
  const promptWrap = overlay.querySelector('.review-detail-prompt-wrap');
  const suggestionsEl = overlay.querySelector('.review-detail-suggestions');
  if (!promptWrap || !suggestionsEl) return;

  const PREVIEW_LEN = 60;
  const originals = (promptSections || []).map((s) => ({ name: s.name || '', content: (s.content || '').slice() }));
  const savedWorking = Array.isArray(saved.workingSections) && saved.workingSections.length === originals.length
    ? saved.workingSections.map((s) => ({ name: s.name || '', content: (s.content || '').slice() }))
    : null;
  const working = savedWorking || originals.map((s) => ({ name: s.name, content: s.content }));
  let activeCard = null;
  let activeSuggestion = null;

  function persistWorking() {
    if (typeof onReviewResultChange !== 'function') return;
    const next = {
      ...saved,
      summary: saved.summary ?? '',
      suggestions: saved.suggestions ?? [],
      promptSections: saved.promptSections ?? promptSections,
      promptFullText: saved.promptFullText ?? promptFullText,
      workingSections: working.map((s) => ({ name: s.name, content: s.content })),
    };
    onReviewResultChange(next);
  }

  function renderLeft(showDiffSectionIndex, diffNewContent) {
    const sectionsToRender = working.map((s, i) => ({ name: s.name, content: s.content }));
    if (showDiffSectionIndex >= 0 && showDiffSectionIndex < originals.length && diffNewContent !== undefined) {
      promptSectionsEl.innerHTML = renderSectionsAsPromptDetail(sectionsToRender, showDiffSectionIndex, diffNewContent);
    } else {
      promptSectionsEl.innerHTML = renderSectionsAsPromptDetail(sectionsToRender);
    }
  }

  promptWrap.innerHTML = '<div class="review-detail-prompt-sections preview-field-block-wrap">' + renderSectionsAsPromptDetail(working) + '</div>';
  const promptSectionsEl = promptWrap.querySelector('.review-detail-prompt-sections');

  function setCardReasonToPreview(card) {
    const reasonEl = card.querySelector('.review-detail-suggestion-reason');
    const full = (card.dataset.fullReason || '').trim();
    if (reasonEl) reasonEl.textContent = full ? (full.slice(0, PREVIEW_LEN) + (full.length > PREVIEW_LEN ? '…' : '')) : '';
  }

  function setCardReasonToFull(card) {
    const reasonEl = card.querySelector('.review-detail-suggestion-reason');
    if (reasonEl) reasonEl.textContent = card.dataset.fullReason || '';
  }

  function showDiff(sectionIndex, newContent, card) {
    renderLeft(sectionIndex, newContent);
    setCardReasonToFull(card);
  }

  function showNoDiff(card) {
    renderLeft(-1);
    if (card) setCardReasonToPreview(card);
  }

  const sectionNames = (promptSections || []).map((s, i) => (s.name || '').trim() || `Section ${i}`);
  suggestionsEl.innerHTML = '';
  (suggestions || []).forEach((sug) => {
    const secIdx = Math.max(0, Math.min(sug.section_index, (promptSections || []).length - 1));
    const name = sectionNames[secIdx] || `Section ${secIdx}`;
    const newContent = (sug.new_content || '').trim();
    const isApplied = working[secIdx] && working[secIdx].content === newContent;
    const reasonPreview = (sug.reason || '').slice(0, PREVIEW_LEN) + ((sug.reason || '').length > PREVIEW_LEN ? '…' : '');

    const card = document.createElement('div');
    card.className = 'review-detail-suggestion-card';
    card.dataset.sectionIndex = String(secIdx);
    card.dataset.fullReason = sug.reason || '';
    card.innerHTML = `
      <div class="review-detail-suggestion-card__main">
        <strong>${escapeHtml(name)}</strong>
        <p class="review-detail-suggestion-reason">${escapeHtml(reasonPreview)}</p>
      </div>
      <div class="review-detail-suggestion-card__actions">
        <button type="button" class="btn btn-secondary review-detail-accept-btn">${isApplied ? 'Revert' : 'Accept'}</button>
      </div>
    `;
    const mainEl = card.querySelector('.review-detail-suggestion-card__main');
    const acceptBtn = card.querySelector('.review-detail-accept-btn');

    mainEl.setAttribute('role', 'button');
    mainEl.tabIndex = 0;
    mainEl.addEventListener('click', (e) => {
      e.stopPropagation();
      if (activeCard === card) {
        showNoDiff(card);
        card.classList.remove('review-detail-suggestion-card--active');
        activeCard = null;
        activeSuggestion = null;
      } else {
        suggestionsEl.querySelectorAll('.review-detail-suggestion-card').forEach((c) => {
          setCardReasonToPreview(c);
          c.classList.remove('review-detail-suggestion-card--active');
        });
        showDiff(secIdx, newContent, card);
        card.classList.add('review-detail-suggestion-card--active');
        activeCard = card;
        activeSuggestion = sug;
      }
    });
    mainEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        mainEl.click();
      }
    });

    function updateAcceptButtonLabels() {
      suggestionsEl.querySelectorAll('.review-detail-suggestion-card').forEach((c) => {
        const idx = parseInt(c.dataset.sectionIndex, 10);
        const btn = c.querySelector('.review-detail-accept-btn');
        if (!btn) return;
        const sug = (suggestions || []).find((s) => Math.max(0, Math.min(s.section_index, (promptSections || []).length - 1)) === idx && (s.new_content || '').trim() === (working[idx] && working[idx].content));
        btn.textContent = sug ? 'Revert' : 'Accept';
      });
    }

    acceptBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (working[secIdx].content === newContent) {
        working[secIdx].content = originals[secIdx].content;
      } else {
        working[secIdx].content = newContent;
      }
      updateAcceptButtonLabels();
      if (activeCard === card && activeSuggestion) {
        renderLeft(secIdx, newContent);
      } else {
        renderLeft(-1);
      }
      persistWorking();
    });

    suggestionsEl.appendChild(card);
  });
  if (!suggestions || suggestions.length === 0) {
    suggestionsEl.innerHTML = '<p class="review-detail-placeholder">No suggestions.</p>';
  }

  const footer = overlay.querySelector('.review-detail-suggestions-footer');
  if (footer) {
    footer.innerHTML = '';
    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.className = 'btn btn-secondary review-detail-export-btn';
    exportBtn.textContent = 'Export new prompt';
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
            setTimeout(() => { exportBtn.textContent = 'Export new prompt'; }, 1500);
          }).catch(() => {
            exportBtn.textContent = 'Copy failed';
            setTimeout(() => { exportBtn.textContent = 'Export new prompt'; }, 1500);
          });
        }
      }
    });
    footer.appendChild(exportBtn);
  }
}

/** Review node modal: show saved result (sections + suggestions) or empty state. */
export function openReviewDetailModal({ node, getPayload, getReviewResult, updateReviewResult, onExportNewPrompt }) {
  const payload = getPayload ? getPayload() : null;
  const saved = getReviewResult ? getReviewResult() : null;
  const title = (node?.querySelector?.('.workflow-node__title')?.textContent?.trim()) || 'Review';
  const hasResult = saved && Array.isArray(saved.promptSections) && saved.promptSections.length > 0;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'review-detail-title');
  overlay.innerHTML = `
    <div class="modal-panel modal-panel--review-detail">
      <div class="modal-header">
        <h2 id="review-detail-title" class="modal-title">${escapeHtml(title)}</h2>
        <button type="button" class="modal-close" aria-label="Close">×</button>
      </div>
      <div class="modal-body review-detail-body">
        <div class="review-detail-step review-detail-step--result">
          <div class="review-detail-cols">
            <div class="review-detail-col review-detail-col--left">
              <div class="review-detail-card review-detail-card--prompt">
                <div class="review-detail-prompt-wrap"></div>
              </div>
            </div>
            <div class="review-detail-col review-detail-col--right">
              <div class="review-detail-card review-detail-card--suggestions">
                <div class="review-detail-suggestions" id="review-detail-suggestions"></div>
                <div class="review-detail-suggestions-footer" id="review-detail-suggestions-footer"></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  const promptWrap = overlay.querySelector('.review-detail-prompt-wrap');
  const suggestionsEl = overlay.querySelector('#review-detail-suggestions');

  if (hasResult) {
    buildReviewResultUI(overlay, {
      promptSections: saved.promptSections,
      suggestions: saved.suggestions || [],
      promptFullText: saved.promptFullText || '',
      title,
      resultId: 'detail',
      saved,
      onReviewResultChange: updateReviewResult || null,
      onExportNewPrompt: onExportNewPrompt || null,
    });
  } else {
    promptWrap.innerHTML = '<p class="review-detail-placeholder">Open the Score detail, select an LLM, and click Add Review to run analysis.</p>';
    suggestionsEl.innerHTML = '<p class="review-detail-placeholder">Open the Score detail, select an LLM, and click Add Review to run analysis.</p>';
  }

  overlay.querySelector('.modal-close').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  function close() {
    overlay.remove();
    document.body.style.overflow = '';
  }

  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);
}

/** Open modal with review result (from Score Add Review). Saves result to scoreNode and shows prompt-detail style + red/green diff on hover. */
export function openReviewResultModal({ summary, suggestions = [], promptSections = [], promptFullText = '', scoreNode, onExportNewPrompt }) {
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
        <div class="review-detail-step review-detail-step--result">
          <div class="review-detail-cols">
            <div class="review-detail-col review-detail-col--left">
              <div class="review-detail-card review-detail-card--prompt">
                <div class="review-detail-prompt-wrap"></div>
              </div>
            </div>
            <div class="review-detail-col review-detail-col--right">
              <div class="review-detail-card review-detail-card--suggestions">
                <div class="review-detail-suggestions" id="review-result-suggestions"></div>
                <div class="review-detail-suggestions-footer" id="review-result-suggestions-footer"></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  const saved = {
    summary: summary || '',
    suggestions: suggestions || [],
    promptSections: promptSections || [],
    promptFullText: promptFullText || sectionsToFullText(promptSections || []),
    workingSections: (promptSections || []).map((s) => ({ name: s.name || '', content: (s.content || '').slice() })),
  };
  if (scoreNode && promptSections && promptSections.length) {
    try {
      scoreNode.dataset.reviewResult = JSON.stringify(saved);
      document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
    } catch (_) {}
  }

  buildReviewResultUI(overlay, {
    promptSections: promptSections || [],
    suggestions,
    promptFullText,
    title: 'Review result',
    resultId: 'result',
    saved,
    onReviewResultChange: scoreNode ? (updated) => {
      try {
        scoreNode.dataset.reviewResult = JSON.stringify(updated);
        document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
      } catch (_) {}
    } : null,
    onExportNewPrompt: onExportNewPrompt || null,
  });

  overlay.querySelector('.modal-close').addEventListener('click', () => { overlay.remove(); document.body.style.overflow = ''; });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); document.body.style.overflow = ''; } });
  document.body.style.overflow = 'hidden';
  document.body.appendChild(overlay);
}
