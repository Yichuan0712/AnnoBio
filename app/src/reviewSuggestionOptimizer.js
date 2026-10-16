import { paragraphAround, suggestionTargetScoreRowIndices } from './reviewWorkingText.js';
import { allocNextReviewSuggestionId } from './reviewSuggestionIds.js';
import { runSuggestionOptimizationCompositional, registerOptimizationSession, unregisterOptimizationSession } from './reviewSuggestionOptimization.js';
import { registerNodeStop } from './nodeExecutionControl.js';
import { getCurrentProjectId } from './currentProject.js';

/** Shared by the suggestion card and Agent: target inputs plus up to two regression inputs. */
export function suggestionOptimizationInputs(suggestion, comparisonRows) {
  const targetRows = new Set(suggestionTargetScoreRowIndices(suggestion));
  const grouped = new Map();
  const targetInputs = new Set();
  for (const row of comparisonRows || []) {
    const index = row?.input_row_index;
    if (!Number.isInteger(index) || index < 0) continue;
    if (targetRows.has(Number(row.row_index))) targetInputs.add(index);
    if (!grouped.has(index)) grouped.set(index, { row, allMatched: true, gtRows: [] });
    const entry = grouped.get(index);
    if (![true, 'true', 1, '1'].includes(row.matched)) entry.allMatched = false;
    if (row.ground_truth_output && Number.isInteger(row.source_gt_row_index) && row.source_gt_row_index >= 0
      && !entry.gtRows.some((gt) => gt.gtRowIndex === row.source_gt_row_index)) {
      entry.gtRows.push({ gtNum: row.source_gt_row_index + 1, gtRowIndex: row.source_gt_row_index });
    }
  }
  const targets = [...grouped].filter(([index]) => targetInputs.has(index));
  if (!targets.length) throw new Error('No inputs found for this suggestion.');
  const extra = [...grouped].filter(([index]) => !targetInputs.has(index))
    .sort(([ai, a], [bi, b]) => Number(b.allMatched) - Number(a.allMatched) || ai - bi).slice(0, 2);
  const entries = [...targets, ...extra].sort(([a], [b]) => a - b)
    .map(([index, { row, gtRows }]) => [index, { row, gtRows }]);
  return { entries, extraIndices: extra.map(([index]) => index) };
}

export async function optimizeReviewSuggestion({ suggestion, suggestions, originalText, comparisonRows, payload,
  signal, onProgress, maxTrials, nodeId, runOptimization = runSuggestionOptimizationCompositional }) {
  if (!payload?.run_credential_id) throw new Error('No Run model configured. Choose a Run model in Settings → Run.');
  if (!payload.output_schema) throw new Error('No output schema configured.');
  if (!payload.score_mapping) throw new Error('No Evaluate mapping configured.');
  const { entries, extraIndices } = suggestionOptimizationInputs(suggestion, comparisonRows);
  const controller = new AbortController();
  const projectId = getCurrentProjectId();
  const abort = () => controller.abort();
  const onProjectChanged = () => { if (getCurrentProjectId() !== projectId) abort(); };
  const release = nodeId ? registerNodeStop(nodeId, abort) : () => {};
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });
  globalThis.document?.addEventListener?.('workflow:project-changed', onProjectChanged);
  registerOptimizationSession(controller);
  try {
    if (controller.signal.aborted || getCurrentProjectId() !== projectId) throw new DOMException('Aborted', 'AbortError');
    const result = await runOptimization({
      credentialId: payload.run_credential_id, oldSentence: suggestion.old_sentence || '',
      newSentence: suggestion.new_sentence || '', improvementRationale: suggestion.reason || '',
      promptContext: paragraphAround(originalText, suggestion.old_sentence || ''),
      maxSegments: 5, candidatesPerSegment: 4, maxTrials,
      allSuggestions: suggestions, sugIdx: suggestions.indexOf(suggestion), originalText,
      inputEntries: entries, outputSchema: payload.output_schema, outputFields: payload.output_fields || [],
      scoreMapping: payload.score_mapping,
      runWs: payload.runWs || payload.getRunWorkingSetContent?.() || { headers: [], rows: [] },
      gtContent: payload.gtContent || payload.getGroundTruthContent?.() || { headers: [], rows: [] },
      abortController: controller, onProgress,
    });
    if (controller.signal.aborted || getCurrentProjectId() !== projectId) throw new DOMException('Aborted', 'AbortError');
    return { ...result, optimizationInputNums: entries.map(([index]) => `#${index + 1}`).join(', '),
      optimizationExtraInputNums: extraIndices.length ? extraIndices.map((index) => `#${index + 1}`).join(', ') : null,
      optimizationGtNums: [...new Set(entries.flatMap(([, entry]) => entry.gtRows.map((gt) => gt.gtNum)))].sort((a, b) => a - b).map((n) => `#${n}`).join(', ') };
  } finally {
    signal?.removeEventListener('abort', abort);
    globalThis.document?.removeEventListener?.('workflow:project-changed', onProjectChanged);
    release();
    unregisterOptimizationSession(controller);
  }
}

/** Append a separate, unapplied candidate; its source suggestion and verification stay intact. */
export function optimizedReviewSuggestion(source, result, reviewResult) {
  if (!String(result?.bestText || '').trim() || !Array.isArray(result.trialLog)
    || !result.trialLog.some((trial) => trial.ok)) throw new Error('Optimization produced no successful candidate trials.');
  return { ...source, suggestion_id: allocNextReviewSuggestionId(reviewResult), new_sentence: result.bestText,
    review_optimization_completed: true, review_optimization_meta: {
      bestRate: result.bestObservedRate, trials: result.trialLog.length,
      optimizationInputNums: result.optimizationInputNums, optimizationExtraInputNums: result.optimizationExtraInputNums,
      optimizationGtNums: result.optimizationGtNums,
    }, applied: false, optimized_from_suggestion_id: source.suggestion_id };
}
