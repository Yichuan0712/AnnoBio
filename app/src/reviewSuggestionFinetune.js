/**
 * Finetune (Review suggestion): compositional (reason-guided segments + Thompson search); objective = Verify pass rate.
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

function previewSnippet(s, max = 72) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

function gtWorksheetRowSummary(gtContent, gtRowIndex) {
  const headers = Array.isArray(gtContent?.headers) ? gtContent.headers : [];
  const gRows = Array.isArray(gtContent?.rows) ? gtContent.rows : [];
  const row = gRows[Number(gtRowIndex)];
  if (!Array.isArray(row)) return '';
  const parts = [];
  for (let i = 0; i < headers.length; i++) {
    const h = String(headers[i] ?? '').trim();
    const v = row[i];
    if (!h || v == null || String(v).trim() === '') continue;
    parts.push(`${h}: ${String(v)}`);
  }
  return parts.join('; ');
}

/** GT-only / unpaired Score rows: tell the segment LLM the model extracted nothing and what GT expects. */
function augmentRationaleForSyntheticGtOnly(baseRationale, expandedRows, gtContent) {
  const bits = [];
  for (const r of expandedRows || []) {
    if (!r || !r.synthetic_empty_baseline) continue;
    const gj = r.source_gt_row_index;
    const summary =
      typeof gj === 'number' && !Number.isNaN(gj) ? gtWorksheetRowSummary(gtContent, gj) : '';
    const ri = typeof r.row_index === 'number' && !Number.isNaN(r.row_index) ? r.row_index : '?';
    bits.push(
      `[comparison row_index ${ri}] This line is ground truth only: there was no paired model output (nothing was extracted for this case). ` +
        `Expected ground truth${summary ? `: ${summary}` : ' is in the paired ground truth row.'} ` +
        `Improve the prompt so the model actually extracts these expected values.`,
    );
  }
  if (!bits.length) return String(baseRationale || '').trim();
  const extra = bits.join('\n');
  const base = String(baseRationale || '').trim();
  return base ? `${base}\n\n${extra}` : extra;
}

function randomGaussian() {
  return Math.sqrt(-2 * Math.log(Math.random())) * Math.cos(2 * Math.PI * Math.random());
}

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

function sampleBeta(a, b) {
  if (!(a > 0) || !(b > 0)) return 0.5;
  const x = gammaMarsagliaTsang(a);
  const y = gammaMarsagliaTsang(b);
  const s = x + y;
  return s > 0 ? x / s : 0.5;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
}

/**
 * Compositional finetune: LLM splits improved sentence + per-segment paraphrases; factorized Thompson sampling over segment arms; same pass rate as Verify.
 * @param {object} options
 * @param {string} options.improvementRationale — typically suggestion.reason
 * @returns {Promise<{ bestText: string, bestObservedRate: number, trialLog: object[], optimizer: string, segments?: string[], lattice?: string[][] }>}
 */
export async function runSuggestionFinetuneCompositional(options) {
  const {
    apiBase = 'http://localhost:8000',
    llmCredentialId,
    runCredentialId,
    oldSentence,
    newSentence,
    improvementRationale,
    maxSegments = 5,
    candidatesPerSegment = 4,
    maxTrials = 40,
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
    abortController,
    onProgress,
  } = options;

  const ac = abortController || null;
  const signal = ac?.signal;
  const base = String(apiBase || 'http://localhost:8000').replace(/\/$/, '');
  const proposal = String(newSentence || '').trim();
  if (!proposal) {
    throw new Error('Empty improved sentence for compositional finetune.');
  }
  const inspectRunId = `${Date.now()}_${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2, 14)}`;

  try {
    const expanded = expandTargetsToRunnableComparisonRows(comparisonRows || [], [...(targets || [])]);
    if (expanded.error) {
      throw new Error(expanded.error);
    }
    const expandedRows = expanded.rows;
    if (!expandedRows.length) {
      throw new Error('No runnable comparison rows to verify.');
    }

    const rationaleForLlm = augmentRationaleForSyntheticGtOnly(improvementRationale, expandedRows, gtContent);

    throwIfAborted(signal);
    const segRes = await fetch(`${base}/api/review/finetune-compositional/segments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        credential_id: llmCredentialId,
        old_sentence: oldSentence || '',
        new_sentence: proposal,
        improvement_rationale: rationaleForLlm,
        max_segments: Math.min(8, Math.max(2, Number(maxSegments) || 5)),
        inspect_run_id: inspectRunId,
      }),
    });
    const segData = await segRes.json().catch(() => ({}));
    if (!segRes.ok) {
      const rawDetail = typeof segData.detail === 'string' ? segData.detail : JSON.stringify(segData.detail || segData) || segRes.statusText;
      throw new Error(rawDetail || 'finetune-compositional/segments failed');
    }
    const segments = Array.isArray(segData.segments) ? segData.segments.map((x) => String(x || '')) : [];
    if (!segments.length || segments.join('') !== proposal) {
      throw new Error('Invalid segmentation from server.');
    }

    /** @type {string[][]} */
    const lattice = [];
    let offset = 0;
    const kCand = Math.min(8, Math.max(2, Number(candidatesPerSegment) || 4));
    for (let i = 0; i < segments.length; i++) {
      throwIfAborted(signal);
      const seg = segments[i];
      const prefix = proposal.slice(0, offset);
      const suffix = proposal.slice(offset + seg.length);
      const cRes = await fetch(`${base}/api/review/finetune-compositional/candidates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          credential_id: llmCredentialId,
          old_sentence: oldSentence || '',
          new_sentence: proposal,
          improvement_rationale: rationaleForLlm,
          segment_text: seg,
          prefix,
          suffix,
          num_candidates: kCand,
          segment_index: i,
          inspect_run_id: inspectRunId,
        }),
      });
      const cData = await cRes.json().catch(() => ({}));
      if (!cRes.ok) {
        const rawDetail = typeof cData.detail === 'string' ? cData.detail : JSON.stringify(cData.detail || cData) || cRes.statusText;
        throw new Error(rawDetail || 'finetune-compositional/candidates failed');
      }
      const cands = Array.isArray(cData.candidates) ? cData.candidates.map((x) => String(x || '').trim()).filter(Boolean) : [];
      if (!cands.length) {
        throw new Error('No candidates for a segment.');
      }
      lattice.push(cands);
      offset += seg.length;
    }

    void fetch(`${base}/api/review/finetune-compositional/lattice-log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ segments, lattice, inspect_run_id: inspectRunId }),
    }).catch(() => {});

    const S = lattice.length;
    const alpha = lattice.map((row) => row.map(() => 1));
    const beta = lattice.map((row) => row.map(() => 1));
    let bestText = proposal;
    let bestRate = -1;
    /** @type {Array<{ round: number, picks: number[], preview: string, passRate: number | null, ok: boolean, note?: string }>} */
    const trialLog = [];
    const trials = Math.min(200, Math.max(8, Number(maxTrials) || 40));

    function recordCompositionalTrial(entry) {
      trialLog.push(entry);
      void fetch(`${base}/api/review/finetune-compositional/trial-log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          round: entry.round,
          picks: entry.picks,
          composed_preview: entry.preview || '',
          pass_rate: entry.passRate == null ? null : Number(entry.passRate),
          ok: entry.ok,
          note: entry.note ?? null,
          inspect_run_id: inspectRunId,
        }),
      }).catch(() => {});
    }

    for (let t = 0; t < trials; t++) {
      throwIfAborted(signal);
      const picks = lattice.map((row, s) => {
        let pick = 0;
        let bestDraw = -1;
        for (let k = 0; k < row.length; k++) {
          const draw = sampleBeta(alpha[s][k], beta[s][k]);
          if (draw > bestDraw) {
            bestDraw = draw;
            pick = k;
          }
        }
        return pick;
      });

      const composed = lattice.map((row, s) => row[picks[s]]).join('');
      if (typeof onProgress === 'function') {
        onProgress({ trial: t + 1, trials, arm: 0 });
      }

      const patched = allSuggestions.map((sug, i) => ({
        ...sug,
        applied: i === sugIdx,
        ...(i === sugIdx ? { new_sentence: composed } : {}),
      }));
      const testSections = rebuildWorkingFromApplied(originals, patched);
      if (!testSections || testSections.length !== originals.length) {
        for (let s = 0; s < S; s++) {
          beta[s][picks[s]] += 1;
        }
        recordCompositionalTrial({
          round: t + 1,
          picks: picks.slice(),
          preview: previewSnippet(composed, 200),
          passRate: null,
          ok: false,
          note: 'prompt rebuild failed',
        });
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
        for (let s = 0; s < S; s++) {
          beta[s][picks[s]] += 1;
        }
        recordCompositionalTrial({
          round: t + 1,
          picks: picks.slice(),
          preview: previewSnippet(composed, 200),
          passRate: typeof metrics.passRate === 'number' ? metrics.passRate : null,
          ok: false,
          note: 'evaluation failed',
        });
        continue;
      }

      const r = typeof metrics.passRate === 'number' ? metrics.passRate : 0;
      for (let s = 0; s < S; s++) {
        alpha[s][picks[s]] += r;
        beta[s][picks[s]] += 1 - r;
      }
      recordCompositionalTrial({
        round: t + 1,
        picks: picks.slice(),
        preview: previewSnippet(composed, 200),
        passRate: r,
        ok: true,
      });
      if (r > bestRate) {
        bestRate = r;
        bestText = composed;
      }
    }

    return {
      bestIndex: 0,
      bestText,
      candidates: [bestText],
      posteriorMeans: [bestRate < 0 ? 0 : bestRate],
      bestObservedRate: bestRate < 0 ? 0 : bestRate,
      trialLog,
      optimizer: 'compositional',
      segments,
      lattice,
    };
  } finally {
    if (ac) unregisterFinetuneSession(ac);
  }
}
