import { BACKEND_API_BASE } from './backendConfig.js';
import { evaluateScoreOutputGt } from './scoreOutputGtMatcher.js';
import {
  rebuildWorkingFromApplied,
  suggestionTargetScoreRowIndices,
} from './reviewWorkingSections.js';
import { compileReviewInputs } from './runInputBuilder.js';
import { postRun } from './runClient.js';
import { getCurrentProjectId } from './currentProject.js';

function normalizeSections(sections) {
  return Array.isArray(sections)
    ? sections.map((section) => ({
      name: String(section?.name || ''),
      content: String(section?.content || ''),
    }))
    : [];
}

function sectionsSignature(sections) {
  return JSON.stringify(normalizeSections(sections));
}

export function isVerifyFullPass(result) {
  if (!result || result.status !== 'complete') return false;
  const rows = Array.isArray(result.verifyRows) ? result.verifyRows : [];
  if (rows.length === 0) return false;
  return rows.every((row) => row?.matched === true && !row?.error);
}

export function reviewVerifyStateFromResult(result) {
  if (isVerifyFullPass(result)) return 'verified';
  if (result?.status === 'complete') return 'optimization';
  return 'idle';
}

function buildInputEntriesForSuggestion(suggestion, comparisonRows) {
  const rowIndices = suggestionTargetScoreRowIndices(suggestion);
  const targetRows = rowIndices
    .map((rowIndex) => (Array.isArray(comparisonRows)
      ? comparisonRows.find((row) => Number(row?.row_index) === rowIndex)
      : null))
    .filter(Boolean);

  const inputMap = new Map();
  for (const row of targetRows) {
    const inputIdx = row?.input_row_index;
    if (inputIdx == null) continue;
    if (!inputMap.has(inputIdx)) inputMap.set(inputIdx, { row, gtRows: [] });
    if (row?.ground_truth_output && row?.source_gt_row_index != null) {
      const gtNum = Number(row.source_gt_row_index) + 1;
      const entry = inputMap.get(inputIdx);
      if (!entry.gtRows.find((gtRow) => gtRow.gtNum === gtNum)) {
        entry.gtRows.push({ gtNum, gtRowIndex: Number(row.source_gt_row_index) });
      }
    }
  }
  return [...inputMap.entries()].sort(([a], [b]) => a - b);
}

async function runPromptsAndWaitForResults({
  apiBase = BACKEND_API_BASE,
  credentialId,
  samples,
  outputSchema,
}) {
  const runResponse = await postRun({
    credential_id: credentialId,
    samples,
    output_schema: outputSchema,
  }, undefined, apiBase, getCurrentProjectId());
  if (!runResponse.ok) {
    const errorText = await runResponse.text().catch(() => String(runResponse.status));
    throw new Error(`Run API error ${runResponse.status}: ${errorText}`);
  }
  const { run_id: runId } = await runResponse.json();
  if (!runId) {
    throw new Error('Run API did not return a run id.');
  }

  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const pollResponse = await fetch(`${apiBase}/api/run/result/${runId}`);
    const pollData = await pollResponse.json();
    if (pollData.status === 'done' || pollData.status === 'cancelled') {
      return pollData;
    }
  }
}

function countMatchedVerifyRows(verifyRows) {
  return Array.isArray(verifyRows)
    ? verifyRows.reduce((sum, row) => sum + (row?.matched === true && !row?.error ? 1 : 0), 0)
    : 0;
}

function suggestionWouldChangePrompt(originals, suggestion) {
  const nextSections = rebuildWorkingFromApplied(originals, [{ ...suggestion, applied: true }]);
  if (!nextSections || nextSections.length !== originals.length) return false;
  return sectionsSignature(nextSections) !== sectionsSignature(originals);
}

export async function verifyReviewSuggestion({
  suggestion,
  originals,
  comparisonRows,
  reviewPayload,
  apiBase = BACKEND_API_BASE,
}) {
  try {
    const credentialId = String(reviewPayload?.run_credential_id || '').trim();
    const outputSchema = reviewPayload?.output_schema;
    const scoreMapping = reviewPayload?.score_mapping;
    const outputFields = Array.isArray(reviewPayload?.output_fields) ? reviewPayload.output_fields : [];
    const runWs = reviewPayload?.runWs || { headers: [], rows: [] };
    const gtContent = reviewPayload?.gtContent || { headers: [], rows: [] };

    if (!credentialId) throw new Error('No run credential configured on the upstream Run node.');
    if (!outputSchema) throw new Error('No output schema configured on the upstream Prompt node.');
    if (!scoreMapping) throw new Error('No Score mapping configured on the upstream Score node.');

    const normalizedOriginals = normalizeSections(originals);
    if (!suggestionWouldChangePrompt(normalizedOriginals, suggestion)) {
      throw new Error('Suggestion could not be applied to the original prompt sections.');
    }

    const modifiedSections = rebuildWorkingFromApplied(normalizedOriginals, [{ ...suggestion, applied: true }]) || normalizedOriginals;
    const templateText = modifiedSections
      .map((section) => String(section?.content || '').trim())
      .filter(Boolean)
      .join('\n\n');
    if (!templateText.trim()) {
      throw new Error('Modified prompt is empty after applying this suggestion.');
    }

    const inputEntries = buildInputEntriesForSuggestion(suggestion, comparisonRows);
    if (inputEntries.length === 0) {
      throw new Error('No inputs found for this suggestion.');
    }

    const samples = compileReviewInputs(templateText, inputEntries);
    const finalData = await runPromptsAndWaitForResults({
      apiBase,
      credentialId,
      samples,
      outputSchema,
    });
    if (finalData?.error) {
      throw new Error(String(finalData.error));
    }

    const rawResults = Array.isArray(finalData?.results) ? finalData.results : [];
    const { verifyRows, matchedCount, total } = await evaluateScoreOutputGt({
      apiBase,
      scoreMapping,
      results: rawResults,
      inputEntries,
      outputFields: Array.isArray(finalData?.output_fields) ? finalData.output_fields : outputFields,
      runWs,
      gtContent,
    });

    return {
      status: 'complete',
      verifyRows,
      matchedCount,
      total,
      targetRowCount: suggestionTargetScoreRowIndices(suggestion).length,
      targetInputCount: inputEntries.length,
    };
  } catch (error) {
    return {
      status: 'error',
      message: error instanceof Error ? error.message : String(error || 'Unknown verification error'),
      targetRowCount: suggestionTargetScoreRowIndices(suggestion).length,
    };
  }
}

export function decideSuggestionAcceptance({
  suggestion,
  verifyResult,
  originals,
}) {
  const suggestionId = String(suggestion?.suggestion_id ?? '').trim();
  const targetRowCount = suggestionTargetScoreRowIndices(suggestion).length;

  if (isVerifyFullPass(verifyResult)) {
    const verifyRowsForFullPass = Array.isArray(verifyResult?.verifyRows) ? verifyResult.verifyRows : [];
    const matchedCountForFullPass = Number.isFinite(Number(verifyResult?.matchedCount))
      ? Number(verifyResult.matchedCount)
      : countMatchedVerifyRows(verifyRowsForFullPass);
    const totalForFullPass = Number.isFinite(Number(verifyResult?.total))
      ? Number(verifyResult.total)
      : verifyRowsForFullPass.length;
    return {
      suggestionId,
      accept: true,
      reason: `Accepted (verified): all ${matchedCountForFullPass}/${totalForFullPass} verification rows matched ground truth.`,
      targetRowCount,
      matchedCount: matchedCountForFullPass,
      total: totalForFullPass,
    };
  }

  if (!suggestionWouldChangePrompt(normalizeSections(originals), suggestion)) {
    return {
      suggestionId,
      accept: false,
      reason: 'Suggestion could not be applied to the original prompt text.',
      targetRowCount,
    };
  }

  if (!verifyResult) {
    return {
      suggestionId,
      accept: false,
      reason: 'Suggestion has not been verified yet.',
      targetRowCount,
    };
  }

  if (verifyResult.status !== 'complete') {
    return {
      suggestionId,
      accept: false,
      reason: String(verifyResult.message || 'Suggestion verification did not complete successfully.'),
      targetRowCount,
    };
  }

  const verifyRows = Array.isArray(verifyResult.verifyRows) ? verifyResult.verifyRows : [];
  if (verifyRows.length === 0) {
    return {
      suggestionId,
      accept: false,
      reason: 'Suggestion verification returned no comparable rows.',
      targetRowCount,
    };
  }

  const matchedCount = Number.isFinite(Number(verifyResult.matchedCount))
    ? Number(verifyResult.matchedCount)
    : countMatchedVerifyRows(verifyRows);
  const total = Number.isFinite(Number(verifyResult.total)) ? Number(verifyResult.total) : verifyRows.length;

  const errorRowCount = verifyRows.reduce((sum, row) => sum + (row?.error ? 1 : 0), 0);
  if (errorRowCount > 0) {
    return {
      suggestionId,
      accept: false,
      reason: `Rejected because verification produced ${errorRowCount} error row${errorRowCount === 1 ? '' : 's'}.`,
      targetRowCount,
      matchedCount,
      total,
    };
  }

  return {
    suggestionId,
    accept: false,
    reason: `Rejected because only ${matchedCount}/${total} verification rows matched ground truth.`,
    targetRowCount,
    matchedCount,
    total,
  };
}
