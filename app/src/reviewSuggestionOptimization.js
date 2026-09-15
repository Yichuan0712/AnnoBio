/**
 * Compositional optimization for Review suggestion cards.
 *
 * Algorithm (Thompson sampling over a segment × candidate lattice):
 *   1. Backend splits improved sentence into N segments.
 *   2. Backend generates K paraphrase candidates per segment → lattice[N][K].
 *   3. For each trial (up to maxTrials):
 *        a. Sample from Beta(α,β) per segment to pick candidates.
 *        b. Compose the picked candidates → new sentence.
 *        c. Build a modified prompt (apply suggestion with new sentence).
 *        d. runVerifyPassRate: POST /api/run → poll → compare output vs GT → passRate.
 *        e. Update α/β based on passRate.
 *   4. Return bestText (highest passRate seen), bestRate, trialLog.
 *
 * Input/GT uses the same pipeline as the current branch's runVerification
 * and reuses the Score output->gt rules for pass-rate evaluation.
 */

import { rebuildWorkingFromApplied } from './reviewWorkingSections.js';
import { BACKEND_API_BASE } from './backendConfig.js';
import { evaluateScoreOutputGt } from './scoreOutputGtMatcher.js';
import { compileReviewInputs } from './runInputBuilder.js';
import { postRun } from './runClient.js';

const API_BASE = BACKEND_API_BASE;

// ─── Session management (abort on app close) ─────────────────────────────────

/** @type {Set<AbortController>} */
const _optimizationACs = new Set();

export function registerOptimizationSession(ac) {
  if (ac && typeof ac.abort === 'function') _optimizationACs.add(ac);
}
export function unregisterOptimizationSession(ac) {
  _optimizationACs.delete(ac);
}
export function abortAllOptimizationJobs() {
  for (const c of _optimizationACs) { try { c.abort(); } catch (_) {} }
  _optimizationACs.clear();
}
export function hasActiveOptimizationSessions() {
  return _optimizationACs.size > 0;
}

// ─── Utility ───────────────────────────────────────────────────────────────────

function escapeRegex(str) {
  return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── Beta / Thompson sampling ─────────────────────────────────────────────────

function randomGaussian() {
  return Math.sqrt(-2 * Math.log(Math.random())) * Math.cos(2 * Math.PI * Math.random());
}

function gammaMarsagliaTsang(shape) {
  if (shape < 1) return gammaMarsagliaTsang(1 + shape) * Math.pow(Math.random(), 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do { x = randomGaussian(); v = 1 + c * x; } while (v <= 0);
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

// ─── Verify pass-rate evaluation (one trial) ─────────────────────────────────

/**
 * Run the modified prompt against inputEntries, compare with GT, return passRate.
 * @param {{
 *   credentialId: string,
 *   templateText: string,
 *   inputEntries: Array<[number, {row: object, gtRows: Array<{gtNum:number, gtRowIndex:number}>}]>,
 *   outputSchema: object,
 *   outputFields?: Array<object>,
 *   scoreMapping?: string,
 *   runWs?: {headers?: string[], rows?: Array},
 *   gtContent?: {headers?: string[], rows?: Array},
 *   signal?: AbortSignal,
 * }} opts
 * @returns {Promise<{passRate: number, ok: boolean, aborted: boolean}>}
 */
export async function runVerifyPassRate({
  credentialId,
  templateText,
  inputEntries,
  outputSchema,
  outputFields = [],
  scoreMapping = '{}',
  runWs = { headers: [], rows: [] },
  gtContent = { headers: [], rows: [] },
  signal,
}) {
  throwIfAborted(signal);

  // Fill prompts
  const samples = compileReviewInputs(templateText, inputEntries);

  // Submit run
  const runRes = await postRun({ credential_id: credentialId, samples, output_schema: outputSchema }, signal);
  if (!runRes.ok) {
    const t = await runRes.text().catch(() => String(runRes.status));
    throw new Error(`Run API error ${runRes.status}: ${t}`);
  }
  const { run_id: runId } = await runRes.json();

  // Poll until done
  let finalData = null;
  while (true) {
    throwIfAborted(signal);
    await new Promise((r) => setTimeout(r, 1200));
    throwIfAborted(signal);
    const pollRes = await fetch(`${API_BASE}/api/run/result/${runId}`, { signal });
    const pollData = await pollRes.json();
    if (pollData.status === 'done' || pollData.status === 'cancelled') {
      finalData = pollData;
      break;
    }
  }

  if (finalData?.error) throw new Error(String(finalData.error));
  const rawResults = finalData?.results || [];
  const { matchedCount, total } = await evaluateScoreOutputGt({
    apiBase: API_BASE,
    scoreMapping,
    results: rawResults,
    inputEntries,
    outputFields: Array.isArray(finalData?.output_fields) ? finalData.output_fields : outputFields,
    runWs,
    gtContent,
  });
  const passRate = total > 0 ? matchedCount / total : 0;
  return { passRate, ok: true, aborted: false };
}

// ─── Main compositional optimization algorithm ────────────────────────────────

/**
 * @param {{
 *   credentialId: string,         — run + segments/candidates LLM credential
 *   oldSentence: string,
 *   newSentence: string,          — starting point (suggestion.new_sentence)
 *   improvementRationale: string, — suggestion.reason
 *   sectionContext?: string,      — full prompt section/paragraph (read-only context for candidates LLM)
 *   maxSegments?: number,         — default 5
 *   candidatesPerSegment?: number,— default 4
 *   maxTrials?: number,           — default 40
 *   allSuggestions: object[],
 *   sugIdx: number,
 *   originals: object[],
 *   inputEntries: Array<[number, {row:object, gtRows:object[]}]>,
 *   outputSchema: object,
 *   outputFields?: Array<object>,
 *   scoreMapping?: string,
 *   runWs?: {headers?: string[], rows?: Array},
 *   gtContent?: {headers?: string[], rows?: Array},
 *   abortController?: AbortController,
 *   onProgress?: (info:{trial:number,trials:number,bestRate:number}) => void,
 * }} options
 */
export async function runSuggestionOptimizationCompositional(options) {
  const {
    credentialId,
    oldSentence = '',
    newSentence,
    improvementRationale = '',
    sectionContext = '',
    maxSegments = 5,
    candidatesPerSegment = 4,
    maxTrials = 40,
    allSuggestions,
    sugIdx,
    originals,
    inputEntries,
    outputSchema,
    outputFields = [],
    scoreMapping = '{}',
    runWs = { headers: [], rows: [] },
    gtContent = { headers: [], rows: [] },
    abortController = null,
    onProgress,
  } = options;

  const ac = abortController;
  const signal = ac?.signal ?? null;
  const base = API_BASE;
  const proposal = String(newSentence || '').trim();
  if (!proposal) throw new Error('Empty new_sentence for optimization.');
  if (!inputEntries || inputEntries.length === 0) throw new Error('No input entries for optimization.');

  try {
    // ── Step 1: Get segments ────────────────────────────────────────────────
    throwIfAborted(signal);
    const segRes = await fetch(`${base}/api/review/optimization-compositional/segments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        credential_id: credentialId,
        old_sentence: oldSentence,
        new_sentence: proposal,
        improvement_rationale: improvementRationale,
        max_segments: Math.min(8, Math.max(1, Number(maxSegments) || 5)),
      }),
    });
    const segData = await segRes.json().catch(() => ({}));
    if (!segRes.ok) {
      const d = typeof segData.detail === 'string' ? segData.detail : JSON.stringify(segData.detail || segData);
      throw new Error(d || 'optimization/segments failed');
    }
    const segments = Array.isArray(segData.segments) ? segData.segments.map((x) => String(x || '')) : [];
    if (!segments.length) {
      throw new Error('No segments returned from server.');
    }

    // ── Step 2: Get candidates per segment ──────────────────────────────────
    const kCand = Math.min(8, Math.max(2, Number(candidatesPerSegment) || 4));
    /** @type {string[][]} */
    const lattice = [];
    let offset = 0;
    for (let i = 0; i < segments.length; i++) {
      throwIfAborted(signal);
      const seg = segments[i];
      const prefix = proposal.slice(0, offset);
      const suffix = proposal.slice(offset + seg.length);
      const cRes = await fetch(`${base}/api/review/optimization-compositional/candidates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          credential_id: credentialId,
          old_sentence: oldSentence,
          new_sentence: proposal,
          improvement_rationale: improvementRationale,
          segment_text: seg,
          prefix,
          suffix,
          section_context: sectionContext,
          num_candidates: kCand,
          segment_index: i,
          total_segments: segments.length,
        }),
      });
      const cData = await cRes.json().catch(() => ({}));
      if (!cRes.ok) {
        const d = typeof cData.detail === 'string' ? cData.detail : JSON.stringify(cData.detail || cData);
        throw new Error(d || 'optimization/candidates failed');
      }
      const cands = Array.isArray(cData.candidates)
        ? cData.candidates.map((x) => String(x || '').trim()).filter(Boolean)
        : [];
      if (!cands.length) throw new Error(`No candidates returned for segment ${i}.`);
      lattice.push(cands);
      offset += seg.length;
    }

    // ── Step 3: Thompson sampling loop ──────────────────────────────────────
    const S = lattice.length;
    const alpha = lattice.map((row) => row.map(() => 1));
    const beta  = lattice.map((row) => row.map(() => 1));
    let bestText = proposal;
    let bestRate = -1;
    let bestPicks = lattice.map(() => 0);
    const trialLog = [];
    const trials = Math.min(200, Math.max(4, Number(maxTrials) || 40));

    for (let t = 0; t < trials; t++) {
      throwIfAborted(signal);

      // Sample picks
      const picks = lattice.map((row, s) => {
        let pick = 0, bestDraw = -1;
        for (let k = 0; k < row.length; k++) {
          const draw = sampleBeta(alpha[s][k], beta[s][k]);
          if (draw > bestDraw) { bestDraw = draw; pick = k; }
        }
        return pick;
      });
      const composed = lattice.map((row, s) => row[picks[s]]).join('');

      if (typeof onProgress === 'function') {
        onProgress({ trial: t + 1, trials, bestRate: bestRate < 0 ? 0 : bestRate });
      }

      // Build test prompt with composed candidate
      const patched = allSuggestions.map((sg, i) => ({
        ...sg,
        applied: i === sugIdx,
        ...(i === sugIdx ? { new_sentence: composed } : {}),
      }));
      const testSections = rebuildWorkingFromApplied(originals, patched);
      if (!testSections || testSections.length !== originals.length) {
        for (let s = 0; s < S; s++) beta[s][picks[s]] += 1;
        trialLog.push({ round: t + 1, picks: picks.slice(), preview: composed.slice(0, 120), passRate: null, ok: false, note: 'rebuild failed' });
        continue;
      }

      const templateText = testSections.map((sec) => (sec.content || '').trim()).filter(Boolean).join('\n\n');

      let metrics;
      try {
        metrics = await runVerifyPassRate({
          credentialId,
          templateText,
          inputEntries,
          outputSchema,
          outputFields,
          scoreMapping,
          runWs,
          gtContent,
          signal,
        });
      } catch (err) {
        if (err?.name === 'AbortError') throw err;
        for (let s = 0; s < S; s++) beta[s][picks[s]] += 1;
        trialLog.push({ round: t + 1, picks: picks.slice(), preview: composed.slice(0, 120), passRate: null, ok: false, note: String(err?.message || err) });
        continue;
      }

      const r = typeof metrics.passRate === 'number' ? metrics.passRate : 0;
      for (let s = 0; s < S; s++) {
        alpha[s][picks[s]] += r;
        beta[s][picks[s]]  += 1 - r;
      }
      trialLog.push({ round: t + 1, picks: picks.slice(), preview: composed.slice(0, 120), passRate: r, ok: true });

      if (r > bestRate) { bestRate = r; bestText = composed; bestPicks = picks.slice(); }
      // Early exit on full pass
      if (r >= 1.0) break;
    }

    // Log final result to backend terminal
    try {
      await fetch(`${base}/api/review/optimization-compositional/log-result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          segments,
          lattice,
          best_picks: bestPicks,
          best_text: bestText,
          best_rate: bestRate < 0 ? 0 : bestRate,
          trials_run: trialLog.length,
          trials_total: trials,
        }),
      });
    } catch (_) {}

    return {
      bestText,
      bestObservedRate: bestRate < 0 ? 0 : bestRate,
      trialLog,
      segments,
      lattice,
    };
  } finally {
    if (ac) unregisterOptimizationSession(ac);
  }
}
