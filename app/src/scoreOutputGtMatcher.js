import { BACKEND_API_BASE } from './backendConfig.js';
import {
  SCORE_GT_ROW_INDEX_COLUMN,
  canonicalizeMatchFlags,
  numericPairMatches,
  stringsMatchContains,
  stringsMatchSemanticAlign,
  embeddingPairMatches,
  prefetchEmbeddingCosineMap,
  isValidRunOutputForScoreRow,
} from './scoreDetailModal.js';
import { computeGreedyRunToGtPairing, flattenScoreRules } from './scoreRunGtPairing.js';
import { emptyScoreRuleGroup, parseScoreMappingBundle } from './scoreMappingBundle.js';

function toCompareStr(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map((item) => toCompareStr(item)).join(', ').trim();
  return String(value).trim();
}

function normalizeForMatch(value, flags, isNumeric) {
  let text = value == null ? '' : String(value).trim();
  if (isNumeric) return text;
  if (flags.ignoreWhitespace) text = text.replace(/\s+/g, ' ').trim();
  if (flags.ignoreCase) text = text.toLowerCase();
  if (flags.ignoreSymbols) text = text.replace(/[^\w\s]/gu, '').replace(/\s+/g, ' ').trim();
  return text;
}

function getMatchFlags(rule) {
  return canonicalizeMatchFlags(rule && rule.matchFlags);
}

function uniqueGtIndicesFromInputEntries(inputEntries) {
  const ordered = [];
  const seen = new Set();
  for (const [, entry] of inputEntries || []) {
    for (const gtRow of entry?.gtRows || []) {
      const idx = Number(
        gtRow?.gtRowIndex ?? (Number.isFinite(Number(gtRow?.gtNum)) ? Number(gtRow.gtNum) - 1 : NaN),
      );
      if (!Number.isInteger(idx) || idx < 0 || seen.has(idx)) continue;
      seen.add(idx);
      ordered.push(idx);
    }
  }
  return ordered;
}

function buildGtSubset(gtContent, inputEntries) {
  const headers = Array.isArray(gtContent?.headers) ? gtContent.headers.slice() : [];
  const allRows = Array.isArray(gtContent?.rows) ? gtContent.rows : [];
  const sourceRowIndices = uniqueGtIndicesFromInputEntries(inputEntries);
  const rows = sourceRowIndices.map((idx) => (Array.isArray(allRows[idx]) ? allRows[idx] : []));
  const localIndexBySource = new Map(sourceRowIndices.map((idx, localIdx) => [idx, localIdx]));
  return {
    headers,
    rows,
    sourceRowIndices,
    localIndexBySource,
  };
}

function buildPromptIndexMaps(inputEntries) {
  const originalInputRowByPromptIndex = new Map();
  for (const [promptIndex, [originalInputIdx, entry]] of (inputEntries || []).entries()) {
    originalInputRowByPromptIndex.set(promptIndex, originalInputIdx);
  }
  return { originalInputRowByPromptIndex };
}

function getRunValue(runResult, outputKey, rowIndex, runWs, outputFields, originalInputRowByPromptIndex) {
  void outputFields;
  if (outputKey === '#' || outputKey === '[#]') return toCompareStr(rowIndex);
  const keyStr = String(outputKey || '').trim();
  if (!keyStr) return '';
  const isBracket = keyStr.startsWith('[') && keyStr.endsWith(']');
  if (isBracket) {
    const header = keyStr.slice(1, -1).trim();
    const rows = Array.isArray(runWs?.rows) ? runWs.rows : [];
    const headers = Array.isArray(runWs?.headers) ? runWs.headers : [];
    const colIdx = headers.findIndex((h) => String(h).trim() === header);
    const promptIdx = runResult?.input_row_index ?? rowIndex;
    const originalInputIdx = originalInputRowByPromptIndex.get(promptIdx);
    if (colIdx >= 0 && Number.isInteger(originalInputIdx) && rows[originalInputIdx]) {
      return toCompareStr(rows[originalInputIdx][colIdx]);
    }
    return '';
  }
  if (runResult?.output && typeof runResult.output === 'object' && keyStr in runResult.output) {
    return toCompareStr(runResult.output[keyStr]);
  }
  if (runResult?.error) return toCompareStr(runResult.error);
  return '';
}

function getGtValue(gtSubset, localGtIndex, columnName) {
  if (String(columnName).trim() === SCORE_GT_ROW_INDEX_COLUMN) {
    const sourceIdx = gtSubset?.sourceRowIndices?.[localGtIndex];
    return Number.isInteger(sourceIdx) && sourceIdx >= 0 ? toCompareStr(sourceIdx) : '';
  }
  const headers = Array.isArray(gtSubset?.headers) ? gtSubset.headers : [];
  const rows = Array.isArray(gtSubset?.rows) ? gtSubset.rows : [];
  const colIdx = headers.findIndex((h) => String(h).trim() === String(columnName).trim());
  if (colIdx < 0 || !Array.isArray(rows[localGtIndex])) return '';
  return toCompareStr(rows[localGtIndex][colIdx]);
}

function buildDisplayGtObject(gtSubset, localGtIndex, outputLeaves) {
  const out = {};
  const seen = new Set();
  for (const rule of outputLeaves || []) {
    for (const col of rule?.gtColumns || []) {
      const rawKey = String(col || '').trim();
      if (!rawKey || seen.has(rawKey)) continue;
      seen.add(rawKey);
      const displayKey = rawKey === SCORE_GT_ROW_INDEX_COLUMN ? 'Ground truth: #' : rawKey;
      out[displayKey] = rawKey === SCORE_GT_ROW_INDEX_COLUMN
        ? String((gtSubset?.sourceRowIndices?.[localGtIndex] ?? -1) + 1).replace(/^0$/, '')
        : getGtValue(gtSubset, localGtIndex, rawKey);
    }
  }
  return out;
}

async function buildEmbeddingCosineMap({
  apiBase,
  outputRoot,
  results,
  outputFields,
  runWs,
  gtSubset,
  originalInputRowByPromptIndex,
}) {
  const outputLeaves = flattenScoreRules(outputRoot || emptyScoreRuleGroup());
  if (!outputLeaves.some((rule) => getMatchFlags(rule).embeddingSimilarity)) {
    return new Map();
  }
  return prefetchEmbeddingCosineMap(apiBase || BACKEND_API_BASE, {
    root: outputRoot,
    results,
    outputFields,
    runWs,
    gtContent: gtSubset,
    getRunValue: (runResult, outputKey, rowIndex, ws, fields) =>
      getRunValue(runResult, outputKey, rowIndex, ws, fields, originalInputRowByPromptIndex),
    getGtValue,
  });
}

function makeRuleMatchesRow({ embeddingCosineMap, originalInputRowByPromptIndex }) {
  return function ruleMatchesRow(rule, runRowIndex, gtRowIndex, resultsByIndex, runWs, outputFields, gtSubset) {
    const runResult = resultsByIndex.get(runRowIndex) || null;
    const runValRaw = getRunValue(runResult, rule.outputKey, runRowIndex, runWs, outputFields, originalInputRowByPromptIndex);
    const gtValsRaw = (rule.gtColumns || []).map((col) => getGtValue(gtSubset, gtRowIndex, col));
    const matchType = String(rule?.matchType || 'exact').trim() || 'exact';
    const flags = getMatchFlags(rule);

    if (matchType === 'numeric') {
      const runNorm = normalizeForMatch(runValRaw, flags, true);
      return gtValsRaw.some((gtValue) => {
        const gtNorm = normalizeForMatch(gtValue, flags, true);
        return numericPairMatches(runNorm, gtNorm, flags);
      });
    }

    if (matchType === 'exact' && flags.embeddingSimilarity) {
      return gtValsRaw.some((gtValue) => embeddingPairMatches(runValRaw, gtValue, embeddingCosineMap));
    }
    if (matchType === 'exact' && flags.semanticAlign) {
      return gtValsRaw.some((gtValue) => stringsMatchSemanticAlign(runValRaw, gtValue));
    }

    const runVal = normalizeForMatch(runValRaw, flags, false);
    return gtValsRaw.some((gtValue) => {
      const normalizedGt = normalizeForMatch(gtValue, flags, false);
      if (matchType === 'exact') {
        if (flags.contains) return stringsMatchContains(runVal, normalizedGt);
        return runVal === normalizedGt;
      }
      return runVal === normalizedGt;
    });
  };
}

export async function evaluateScoreOutputGt({
  apiBase = BACKEND_API_BASE,
  scoreMapping,
  results,
  inputEntries,
  outputFields = [],
  runWs = { headers: [], rows: [] },
  gtContent = { headers: [], rows: [] },
}) {
  const { outputRoot } = parseScoreMappingBundle(scoreMapping || '{}');
  const outputLeaves = flattenScoreRules(outputRoot || emptyScoreRuleGroup());
  if (outputLeaves.length === 0) {
    throw new Error('No Score output->gt rules configured.');
  }

  const gtSubset = buildGtSubset(gtContent, inputEntries);
  const enrichedInputEntries = (inputEntries || []).map(([inputIdx, entry]) => {
    const gtRows = (entry?.gtRows || []).map((gtRow) => {
      const sourceIdx = Number(
        gtRow?.gtRowIndex ?? (Number.isFinite(Number(gtRow?.gtNum)) ? Number(gtRow.gtNum) - 1 : NaN),
      );
      const localIdx = gtSubset.localIndexBySource.get(sourceIdx);
      return { ...gtRow, gtRowIndex: sourceIdx, localGtIndex: localIdx };
    }).filter((gtRow) => Number.isInteger(gtRow.localGtIndex));
    return [
      inputIdx,
      {
        ...(entry || {}),
        gtRows,
      },
    ];
  });
  const { originalInputRowByPromptIndex } = buildPromptIndexMaps(enrichedInputEntries);
  const validResults = (results || []).filter((row) => isValidRunOutputForScoreRow(row, outputFields));
  const embeddingCosineMap = await buildEmbeddingCosineMap({
    apiBase,
    outputRoot,
    results: validResults,
    outputFields,
    runWs,
    gtSubset,
    originalInputRowByPromptIndex,
  });
  const ruleMatchesRow = makeRuleMatchesRow({ embeddingCosineMap, originalInputRowByPromptIndex });

  const outputsByPromptIdx = new Map();
  for (const result of validResults) {
    const promptIdx = result?.input_row_index ?? 0;
    if (!outputsByPromptIdx.has(promptIdx)) outputsByPromptIdx.set(promptIdx, []);
    outputsByPromptIdx.get(promptIdx).push(result);
  }

  const verifyRows = [];
  let matchedCount = 0;
  let total = 0;

  for (const [promptIdx, [, entry]] of enrichedInputEntries.entries()) {
    const outputs = outputsByPromptIdx.get(promptIdx) || [];
    const allowedLocalGtIndices = (entry?.gtRows || [])
      .map((gtRow) => gtRow.localGtIndex)
      .filter((idx) => Number.isInteger(idx));
    const localGtSubset = {
      headers: gtSubset.headers,
      rows: allowedLocalGtIndices.map((idx) => gtSubset.rows[idx]),
      sourceRowIndices: allowedLocalGtIndices.map((idx) => gtSubset.sourceRowIndices[idx]),
    };
    const { runToGt } = computeGreedyRunToGtPairing({
      inputRoot: emptyScoreRuleGroup(),
      outputRoot,
      results: outputs,
      runWs,
      gtContent: localGtSubset,
      outputFields,
      ruleMatchesRow,
      getRunValue: (runResult, outputKey, rowIndex, ws, fields) =>
        getRunValue(runResult, outputKey, rowIndex, ws, fields, originalInputRowByPromptIndex),
    });
    const remainingLocalGtIndices = allowedLocalGtIndices.slice();
    const assignments = outputs.map((outputRow) => {
      const pairedLocalGt = outputRow?.row_index >= 0 ? runToGt[outputRow.row_index] : -1;
      const matched = Number.isInteger(pairedLocalGt) && pairedLocalGt >= 0;
      const globalLocalGtIndex = matched ? allowedLocalGtIndices[pairedLocalGt] : null;
      if (matched) {
        const remainingIdx = remainingLocalGtIndices.indexOf(globalLocalGtIndex);
        if (remainingIdx >= 0) remainingLocalGtIndices.splice(remainingIdx, 1);
      }
      return {
        out: outputRow,
        localGtIndex: matched ? globalLocalGtIndex : null,
        matched,
      };
    });

    let unmatchedCursor = 0;
    for (const assignment of assignments) {
      if (!assignment.matched && assignment.localGtIndex == null && unmatchedCursor < remainingLocalGtIndices.length) {
        assignment.localGtIndex = remainingLocalGtIndices[unmatchedCursor++];
      }
    }

    for (const assignment of assignments) {
      const localGtIndex = assignment.localGtIndex;
      const gtNum = Number.isInteger(localGtIndex)
        ? (gtSubset.sourceRowIndices[localGtIndex] + 1)
        : null;
      verifyRows.push({
        output: assignment.out?.output ?? null,
        error: assignment.out?.error ?? null,
        gt: Number.isInteger(localGtIndex) ? buildDisplayGtObject(gtSubset, localGtIndex, outputLeaves) : null,
        gtNum,
        matched: assignment.matched,
      });
      total += 1;
      if (assignment.matched) matchedCount += 1;
    }

    for (let i = unmatchedCursor; i < remainingLocalGtIndices.length; i++) {
      const localGtIndex = remainingLocalGtIndices[i];
      verifyRows.push({
        output: null,
        error: null,
        gt: buildDisplayGtObject(gtSubset, localGtIndex, outputLeaves),
        gtNum: gtSubset.sourceRowIndices[localGtIndex] + 1,
        matched: false,
      });
      total += 1;
    }
  }

  return {
    verifyRows,
    matchedCount,
    total,
  };
}
