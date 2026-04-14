/**
 * Finetune (Review suggestion): DSPy MIPROv2 optimizes a span-rewrite module; objective = same pass rate as Verify.
 * Abort via AbortController (Cancel button or window close → abortAllFinetuneJobs).
 */

import { expandTargetsToRunnableComparisonRows } from './reviewSuggestionTest.js';

/** @type {Set<AbortController>} */
const finetuneAbortControllers = new Set();

export function registerFinetuneSession(ac) {
  if (ac && typeof ac.abort === 'function') finetuneAbortControllers.add(ac);
}

export function unregisterFinetuneSession(ac) {
  finetuneAbortControllers.delete(ac);
}

/** Call on window beforeunload so finetune stops and run jobs are cancelled from the poll loop. */
export function abortAllFinetuneJobs() {
  for (const c of finetuneAbortControllers) {
    try {
      c.abort();
    } catch (_) {}
  }
  finetuneAbortControllers.clear();
}

/** True while any finetune run has registered an AbortController (modal closed = job may still run). */
export function hasActiveFinetuneSessions() {
  return finetuneAbortControllers.size > 0;
}

function previewSnippet(s, max = 72) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

/**
 * MIPROv2 finetune: single POST /api/review/finetune-miprov2 (may run several minutes).
 * @param {object} options
 * @param {string} [options.miprov2Auto]
 * @returns {Promise<{ bestIndex: number, bestText: string, candidates: string[], posteriorMeans: number[], bestObservedRate: number, trialLog: object[], optimizer: string, miprov2Meta?: object }>}
 */
export async function runSuggestionFinetuneMIPROv2(options) {
  const {
    apiBase = 'http://localhost:8000',
    llmCredentialId,
    runCredentialId,
    oldSentence,
    newSentence,
    allSuggestions,
    sugIdx,
    originals,
    targets,
    comparisonRows,
    runResults,
    outputFields,
    outputSchema,
    scoreMappingJson,
    runWs,
    gtContent,
    miprov2Auto = 'light',
    abortController,
    onProgress,
  } = options;

  const ac = abortController || null;
  const signal = ac?.signal;
  try {
    const expanded = expandTargetsToRunnableComparisonRows(comparisonRows || [], [...(targets || [])]);
    if (expanded.error) {
      throw new Error(expanded.error);
    }
    const expandedRows = expanded.rows;
    if (!expandedRows.length) {
      throw new Error('No runnable comparison rows to verify.');
    }

    if (typeof onProgress === 'function') {
      onProgress({ trial: 0, trials: 1, arm: 0 });
    }

    const base = String(apiBase || 'http://localhost:8000').replace(/\/$/, '');
    const res = await fetch(`${base}/api/review/finetune-miprov2`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        finetune_credential_id: llmCredentialId,
        run_credential_id: runCredentialId,
        old_sentence: oldSentence || '',
        new_sentence: newSentence || '',
        originals: (originals || []).map((s) => ({ name: s.name || '', content: s.content || '' })),
        all_suggestions: allSuggestions || [],
        suggestion_index: sugIdx,
        expanded_comparison_rows: expandedRows,
        run_results: runResults || [],
        output_fields: outputFields || [],
        output_schema: outputSchema || {},
        score_mapping_json: scoreMappingJson,
        run_ws: runWs || { headers: [], rows: [] },
        gt_content: gtContent || { headers: [], rows: [] },
        miprov2_auto: miprov2Auto,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const rawDetail = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail || data) || res.statusText;
      throw new Error(rawDetail || 'finetune-miprov2 failed');
    }
    const best = String(data.best_text || '').trim();
    if (!best) {
      throw new Error('MIPROv2 returned an empty rewrite.');
    }
    const rate = typeof data.best_pass_rate === 'number' ? data.best_pass_rate : 0;
    if (typeof onProgress === 'function') {
      onProgress({ trial: 1, trials: 1, arm: 0 });
    }
    return {
      bestIndex: 0,
      bestText: best,
      candidates: [best],
      posteriorMeans: [rate],
      bestObservedRate: rate,
      trialLog: [
        {
          round: 1,
          arm: 0,
          preview: previewSnippet(best),
          passRate: rate,
          ok: data.eval_ok !== false,
          note: 'miprov2',
        },
      ],
      optimizer: 'miprov2',
      miprov2Meta: { eval_ok: data.eval_ok, eval_error: data.eval_error, auto: data.auto },
    };
  } finally {
    if (ac) unregisterFinetuneSession(ac);
  }
}
