/**
 * Finetune (Review suggestion): DSPy MIPROv2 optimizes a span-rewrite module; objective = same pass rate as Verify.
 * Legacy: runSuggestionFinetuneBayesian (Thompson sampling over /api/review/finetune-candidates) kept for reference.
 * Abort via AbortController (Cancel button or window close → abortAllFinetuneJobs).
 */

import { rebuildWorkingFromApplied } from './reviewWorkingSections.js';
import { expandTargetsToRunnableComparisonRows, runSuggestionRowTestsMetrics } from './reviewSuggestionTest.js';

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

function randomGaussian() {
  return Math.sqrt(-2 * Math.log(Math.random())) * Math.cos(2 * Math.PI * Math.random());
}

/** Marsaglia–Tsang Gamma sampler (shape > 0). */
function gammaMarsagliaTsang(shape) {
  if (shape < 1) {
    return gammaMarsagliaTsang(1 + shape) * Math.pow(Math.random(), 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x;
    let v;
    do {
      x = randomGaussian();
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** Sample Beta(a,b) via independent Gamma ratio. */
function sampleBeta(a, b) {
  if (!(a > 0) || !(b > 0)) return 0.5;
  const x = gammaMarsagliaTsang(a);
  const y = gammaMarsagliaTsang(b);
  const s = x + y;
  return s > 0 ? x / s : 0.5;
}

function dedupeCandidateStrings(seed, extras) {
  const out = [];
  const seen = new Set();
  const push = (s) => {
    const t = String(s ?? '').trim();
    if (!t) return;
    const key = t.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(t);
  };
  push(seed);
  if (Array.isArray(extras)) extras.forEach(push);
  return out;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}

function previewSnippet(s, max = 72) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

/**
 * @param {string} apiBase
 * @param {string} credentialId
 * @param {{ oldSentence: string, newSentence: string, numVariants?: number, signal?: AbortSignal }} opts
 * @returns {Promise<string[]>}
 */
export async function fetchFinetuneCandidates(apiBase, credentialId, opts) {
  const base = String(apiBase || 'http://localhost:8000').replace(/\/$/, '');
  const res = await fetch(`${base}/api/review/finetune-candidates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: opts.signal,
    body: JSON.stringify({
      credential_id: credentialId,
      old_sentence: opts.oldSentence || '',
      new_sentence: opts.newSentence || '',
      num_variants: Math.max(4, Math.min(18, Number(opts.numVariants) || 10)),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const rawDetail = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail || data) || res.statusText;
    if (res.status === 404) {
      if (String(rawDetail).toLowerCase().includes('credential')) {
        throw new Error(
          'Credential not found. Set a Run credential on the Run node (or Settings → default Run credential), then try again.',
        );
      }
      throw new Error(
        'Finetune API not found (404). Restart the Python backend so it includes POST /api/review/finetune-candidates.',
      );
    }
    throw new Error(rawDetail || 'finetune-candidates failed');
  }
  const arr = data.candidates;
  return Array.isArray(arr) ? arr.map((x) => String(x || '').trim()).filter(Boolean) : [];
}

/**
 * @param {object} options
 * @param {AbortController} [options.abortController] — register for abortAllFinetuneJobs; uses .signal for fetches
 * @param {(p: { trial: number, trials: number, arm: number }) => void} [options.onProgress]
 * @returns {Promise<{ bestIndex: number, bestText: string, candidates: string[], posteriorMeans: number[], bestObservedRate: number, trialLog: Array<{ round: number, arm: number, preview: string, passRate: number | null, ok: boolean, note?: string }> }>}
 */
export async function runSuggestionFinetuneBayesian(options) {
  const {
    apiBase = 'http://localhost:8000',
    llmCredentialId,
    runCredentialId,
    oldSentence,
    newSentence,
    numCandidates = 10,
    maxTrials = 22,
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
    onProgress,
    abortController,
  } = options;

  const ac = abortController || null;
  const signal = ac?.signal;
  try {
    const llmList = await fetchFinetuneCandidates(apiBase, llmCredentialId, {
      oldSentence,
      newSentence,
      numVariants: numCandidates,
      signal,
    });
    throwIfAborted(signal);

    const candidates = dedupeCandidateStrings(newSentence, llmList);
    if (candidates.length === 0) {
      throw new Error('No finetune candidates returned.');
    }

    const K = candidates.length;
    const alpha = Array(K).fill(1);
    const beta = Array(K).fill(1);
    let bestObservedRate = -1;
    /** @type {Array<{ round: number, arm: number, preview: string, passRate: number | null, ok: boolean, note?: string }>} */
    const trialLog = [];
    /** Total evaluation rounds from settings (Max trials); not tied to candidate count K. */
    const trials = Math.min(200, Math.max(4, Number(maxTrials) || 22));

    for (let t = 0; t < trials; t++) {
      throwIfAborted(signal);

      let pick = 0;
      let bestDraw = -1;
      for (let k = 0; k < K; k++) {
        const draw = sampleBeta(alpha[k], beta[k]);
        if (draw > bestDraw) {
          bestDraw = draw;
          pick = k;
        }
      }
      if (typeof onProgress === 'function') onProgress({ trial: t + 1, trials, arm: pick });

      const patched = allSuggestions.map((s, i) => ({
        ...s,
        applied: i === sugIdx,
        ...(i === sugIdx ? { new_sentence: candidates[pick] } : {}),
      }));
      const testSections = rebuildWorkingFromApplied(originals, patched);
      if (!testSections || testSections.length !== originals.length) {
        trialLog.push({
          round: t + 1,
          arm: pick,
          preview: previewSnippet(candidates[pick]),
          passRate: null,
          ok: false,
          note: 'prompt rebuild failed',
        });
        beta[pick] += 1;
        continue;
      }

      const metrics = await runSuggestionRowTestsMetrics({
        apiBase,
        credentialId: runCredentialId,
        testSections,
        targetComparisonRowIndices: targets,
        comparisonRows: comparisonRows || [],
        runResults: runResults || [],
        outputFields: outputFields || [],
        outputSchema,
        scoreMappingJson,
        runWs: runWs || { headers: [], rows: [] },
        gtContent: gtContent || { headers: [], rows: [] },
        signal,
      });

      if (metrics.aborted || (metrics.detail === 'aborted' && !metrics.ok)) {
        throw new DOMException('Aborted', 'AbortError');
      }

      if (!metrics.ok) {
        trialLog.push({
          round: t + 1,
          arm: pick,
          preview: previewSnippet(candidates[pick]),
          passRate: typeof metrics.passRate === 'number' ? metrics.passRate : null,
          ok: false,
          note: 'evaluation failed',
        });
        beta[pick] += 1;
        continue;
      }
      const r = typeof metrics.passRate === 'number' ? metrics.passRate : 0;
      trialLog.push({
        round: t + 1,
        arm: pick,
        preview: previewSnippet(candidates[pick]),
        passRate: r,
        ok: true,
      });
      alpha[pick] += r;
      beta[pick] += 1 - r;
      if (r > bestObservedRate) bestObservedRate = r;
    }

    const posteriorMeans = candidates.map((_, k) => alpha[k] / (alpha[k] + beta[k]));
    let winner = 0;
    let bestMean = posteriorMeans[0];
    for (let k = 1; k < K; k++) {
      if (posteriorMeans[k] > bestMean) {
        bestMean = posteriorMeans[k];
        winner = k;
      }
    }

    return {
      bestIndex: winner,
      bestText: candidates[winner],
      candidates,
      posteriorMeans,
      bestObservedRate: bestObservedRate < 0 ? 0 : bestObservedRate,
      trialLog,
      optimizer: 'bandit',
    };
  } finally {
    if (ac) unregisterFinetuneSession(ac);
  }
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
