/**
 * Compositional finetune for Review suggestion cards.
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
 * (comparison_rows, {placeholder} substitution, compareRowToGt key-insensitive match).
 */

import { rebuildWorkingFromApplied } from './reviewWorkingSections.js';

const API_BASE = 'http://localhost:8000';

// ─── Session management (abort on app close) ─────────────────────────────────

/** @type {Set<AbortController>} */
const _finetuneACs = new Set();

export function registerFinetuneSession(ac) {
  if (ac && typeof ac.abort === 'function') _finetuneACs.add(ac);
}
export function unregisterFinetuneSession(ac) {
  _finetuneACs.delete(ac);
}
export function abortAllFinetuneJobs() {
  for (const c of _finetuneACs) { try { c.abort(); } catch (_) {} }
  _finetuneACs.clear();
}
export function hasActiveFinetuneSessions() {
  return _finetuneACs.size > 0;
}

// ─── Utility (mirrored from reviewDetailModal to avoid circular import) ───────

function isModelFacingKey(k) {
  const key = String(k || '').trim();
  if (!key || key === '#' || key === '[#]') return false;
  if (key.length >= 2 && key.startsWith('[') && key.endsWith(']')) return false;
  return true;
}

function normalizeForCompare(v) {
  if (v == null) return '';
  return String(v).trim().toLowerCase();
}

function compareRowToGt(output, gt) {
  if (!output || !gt) return false;
  const keys = Object.keys(gt);
  if (keys.length === 0) return true;
  const outLower = new Map(Object.entries(output).map(([k, v]) => [k.toLowerCase().trim(), v]));
  return keys.every((k) => {
    const outVal = outLower.get(k.toLowerCase().trim());
    return normalizeForCompare(outVal) === normalizeForCompare(gt[k]);
  });
}

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
 *   inputEntries: Array<[number, {row: object, gtRows: Array<{gtNum:number, gt:object}>}]>,
 *   outputSchema: object,
 *   signal?: AbortSignal,
 * }} opts
 * @returns {Promise<{passRate: number, ok: boolean, aborted: boolean}>}
 */
export async function runVerifyPassRate({ credentialId, templateText, inputEntries, outputSchema, signal }) {
  throwIfAborted(signal);

  // Fill prompts
  const prompts = inputEntries.map(([, { row }]) => {
    let text = templateText;
    for (const [key, val] of Object.entries(row.row_input || {})) {
      text = text.replace(new RegExp(`\\{${escapeRegex(key)}\\}`, 'g'), String(val ?? ''));
    }
    return text;
  });

  // Submit run
  const runRes = await fetch(`${API_BASE}/api/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credential_id: credentialId, prompts, output_schema: outputSchema }),
    signal,
  });
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

  // Group outputs by prompt index
  const outputsByIdx = new Map();
  for (const r of rawResults) {
    const idx = r?.input_row_index ?? 0;
    if (!outputsByIdx.has(idx)) outputsByIdx.set(idx, []);
    outputsByIdx.get(idx).push(r);
  }

  // Count matched vs total (greedy one-to-one, order-independent)
  let matched = 0;
  let total = 0;
  for (const [promptArrayIdx, [, { gtRows }]] of inputEntries.entries()) {
    const outputs = outputsByIdx.get(promptArrayIdx) || [];
    const usedGt = new Set();
    for (const out of outputs) {
      if (!out?.output) { total++; continue; }
      let found = false;
      for (let gi = 0; gi < gtRows.length; gi++) {
        if (usedGt.has(gi)) continue;
        if (compareRowToGt(out.output, gtRows[gi].gt)) {
          usedGt.add(gi);
          found = true;
          break;
        }
      }
      matched += found ? 1 : 0;
      total++;
    }
    // GT rows with no output count as failures
    for (let gi = 0; gi < gtRows.length; gi++) {
      if (!usedGt.has(gi)) { total++; }
    }
  }

  const passRate = total > 0 ? matched / total : 0;
  return { passRate, ok: true, aborted: false };
}

// ─── Main compositional finetune algorithm ────────────────────────────────────

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
 *   abortController?: AbortController,
 *   onProgress?: (info:{trial:number,trials:number,bestRate:number}) => void,
 * }} options
 */
export async function runSuggestionFinetuneCompositional(options) {
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
    abortController = null,
    onProgress,
  } = options;

  const ac = abortController;
  const signal = ac?.signal ?? null;
  const base = API_BASE;
  const proposal = String(newSentence || '').trim();
  if (!proposal) throw new Error('Empty new_sentence for finetune.');
  if (!inputEntries || inputEntries.length === 0) throw new Error('No input entries for finetune.');

  try {
    // ── Step 1: Get segments ────────────────────────────────────────────────
    throwIfAborted(signal);
    const segRes = await fetch(`${base}/api/review/finetune-compositional/segments`, {
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
      throw new Error(d || 'finetune/segments failed');
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
      const cRes = await fetch(`${base}/api/review/finetune-compositional/candidates`, {
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
        throw new Error(d || 'finetune/candidates failed');
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
        metrics = await runVerifyPassRate({ credentialId, templateText, inputEntries, outputSchema, signal });
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
      await fetch(`${base}/api/review/finetune-compositional/log-result`, {
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
    if (ac) unregisterFinetuneSession(ac);
  }
}
