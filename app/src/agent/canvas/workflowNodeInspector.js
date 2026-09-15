import { buildFullScoreMetricsFromComparisonRows, mergeScoreMetricsWithPrf } from './scoreComparisonPrf.js';
import { displayCell } from '../../datasetContent.js';

function normalizeNodeId(value) {
  return String(value || '').trim();
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function parseJsonArray(raw) {
  if (Array.isArray(raw)) return raw;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function parseJsonObject(raw, fallback = {}) {
  if (!raw) return fallback;
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch (_) {
    return fallback;
  }
}

function parseReviewResult(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function deriveNodeTitle(node) {
  if (!node || typeof node !== 'object') return 'Node';
  switch (String(node.type || '')) {
    case 'prompt':
      return String(node.name || 'Prompt');
    case 'dataset':
      return String(node.name || 'Dataset');
    case 'sampler':
      return String(node.name || 'Sample');
    case 'run':
      return String(node.runName || 'Run');
    case 'score':
      return String(node.scoreName || 'Score');
    case 'promptReview':
      return String(node.promptReviewName || 'Review');
    default:
      return String(node.name || node.nodeId || 'Node');
  }
}

function buildNodeLookup(nodes) {
  return new Map(safeArray(nodes).map((node) => [normalizeNodeId(node?.nodeId), node]));
}

function summarizeLinkedNode(node) {
  return {
    nodeId: normalizeNodeId(node?.nodeId),
    nodeType: String(node?.type || 'unknown'),
    title: deriveNodeTitle(node),
  };
}

function summarizeEdgeNeighbor(connection, nodeLookup, direction) {
  const otherId = direction === 'upstream'
    ? normalizeNodeId(connection?.fromId)
    : normalizeNodeId(connection?.toId);
  const otherNode = nodeLookup.get(otherId);
  return {
    edgeType: String(connection?.type || ''),
    ...summarizeLinkedNode(otherNode),
  };
}

function findConnections(connections, nodeId, direction) {
  const id = normalizeNodeId(nodeId);
  return safeArray(connections).filter((connection) => {
    const fromId = normalizeNodeId(connection?.fromId);
    const toId = normalizeNodeId(connection?.toId);
    return direction === 'upstream' ? toId === id : fromId === id;
  });
}

function addDiagnostic(list, level, code, message) {
  list.push({ level, code, message });
}

function normalizePositiveInteger(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const normalized = Math.floor(n);
  return normalized >= 1 ? normalized : fallback;
}

function buildRowWindow(items, options = {}, defaultMaxRows = 3) {
  const totalCount = Array.isArray(items) ? items.length : 0;
  const startRow = normalizePositiveInteger(options?.startRow ?? options?.start_row, 1);
  const maxRows = normalizePositiveInteger(options?.maxRows ?? options?.max_rows, defaultMaxRows);
  const startIndex = Math.min(totalCount, Math.max(0, startRow - 1));
  const windowItems = safeArray(items).slice(startIndex, startIndex + maxRows);
  return {
    items: windowItems,
    window: {
      startRow: totalCount === 0 ? 1 : startIndex + 1,
      maxRows,
      returnedRowCount: windowItems.length,
      hasMoreBefore: startIndex > 0,
      hasMoreAfter: startIndex + windowItems.length < totalCount,
    },
  };
}

function buildBaseInspection(rawNode, canvasState) {
  const nodeId = normalizeNodeId(rawNode?.nodeId);
  const nodes = safeArray(canvasState?.nodes);
  const connections = safeArray(canvasState?.connections);
  const nodeLookup = buildNodeLookup(nodes);
  const upstreamEdges = findConnections(connections, nodeId, 'upstream');
  const downstreamEdges = findConnections(connections, nodeId, 'downstream');

  const nodeOriginRaw = String(rawNode?.nodeOrigin || '').trim();
  const nodeOrigin = nodeOriginRaw || 'user';

  return {
    found: true,
    nodeId,
    nodeType: String(rawNode?.type || 'unknown'),
    title: deriveNodeTitle(rawNode),
    nodeOrigin,
    agentMutable: nodeOrigin === 'agent',
    node: rawNode,
    upstream: upstreamEdges.map((edge) => summarizeEdgeNeighbor(edge, nodeLookup, 'upstream')),
    downstream: downstreamEdges.map((edge) => summarizeEdgeNeighbor(edge, nodeLookup, 'downstream')),
    diagnostics: [],
    details: {},
  };
}

function inspectPromptNode(rawNode, canvasState, options = {}) {
  const result = buildBaseInspection(rawNode, canvasState);
  const sections = safeArray(rawNode?.sections).map((section) => ({
    name: String(section?.name || ''),
    content: String(section?.content || ''),
  }));
  const outputFormat = rawNode?.outputFormat && typeof rawNode.outputFormat === 'object'
    ? rawNode.outputFormat
    : { returnShape: 'single', fields: [] };
  const inputFields = typeof options.extractInputFields === 'function'
    ? safeArray(options.extractInputFields(sections)).map((field) => String(field || '')).filter(Boolean)
    : [];

  result.details = {
    note: String(rawNode?.note || ''),
    sections,
    inputFields,
    outputFormat,
  };

  if (sections.length === 0) {
    addDiagnostic(result.diagnostics, 'warning', 'prompt.no_sections', 'This prompt has no sections.');
  }
  if (safeArray(outputFormat?.fields).length === 0) {
    addDiagnostic(result.diagnostics, 'info', 'prompt.no_output_schema', 'This prompt has no output schema fields.');
  }
  return result;
}

function inspectDatasetNode(rawNode, canvasState, options = {}) {
  const result = buildBaseInspection(rawNode, canvasState);
  const content = rawNode?.subsetContent || rawNode?.datasetContent || { headers: [], rows: [] };
  const headers = safeArray(content?.headers).map((header) => String(header ?? ''));
  const rows = safeArray(content?.rows).map((row) => safeArray(row).map(displayCell));
  const rowWindow = buildRowWindow(
    rows,
    {
      startRow: options?.startRow ?? options?.start_row,
      maxRows: options?.maxRows ?? options?.max_rows ?? options?.sampleRows,
    },
    3
  );

  result.details = {
    note: String(rawNode?.note || ''),
    samplerNodeId: normalizeNodeId(rawNode?.samplerNodeId),
    headers,
    rowCount: rows.length,
    columnCount: headers.length,
    columnTypes: safeArray(content?.columnTypes),
    rowWindow: rowWindow.window,
    sampleRows: rowWindow.items,
  };

  if (headers.length === 0) {
    addDiagnostic(result.diagnostics, 'warning', 'dataset.no_headers', 'This dataset has no headers.');
  }
  if (rows.length === 0) {
    addDiagnostic(result.diagnostics, 'info', 'dataset.no_rows', 'This dataset has no rows.');
  }
  return result;
}

function inspectSamplerNode(rawNode, canvasState) {
  const result = buildBaseInspection(rawNode, canvasState);
  result.details = {
    note: String(rawNode?.note || ''),
    sourceNodeId: normalizeNodeId(rawNode?.sourceNodeId),
    samplingType: String(rawNode?.samplingType || 'without-replacement'),
    sampleSizeType: String(rawNode?.sampleSizeType || ''),
    sampleSize: rawNode?.sampleSize ?? null,
    rowSpec: String(rawNode?.rowSpec || ''),
  };

  if (!result.details.sourceNodeId) {
    addDiagnostic(result.diagnostics, 'warning', 'sampler.no_source_dataset', 'This sampler is not linked to a source dataset.');
  }
  return result;
}

function inspectRunNode(rawNode, canvasState, options = {}) {
  const result = buildBaseInspection(rawNode, canvasState);
  const runInputToColumn = parseJsonObject(rawNode?.runInputToColumn, {});
  const runResults = parseJsonArray(rawNode?.runResults);
  const runInputContent = parseJsonObject(rawNode?.runInputContent, { headers: [], rows: [] });
  const promptUpstream = result.upstream.find((item) => item.nodeType === 'prompt');

  let promptInputFields = [];
  if (promptUpstream && typeof options.extractInputFields === 'function') {
    const promptNode = safeArray(canvasState?.nodes).find((node) => normalizeNodeId(node?.nodeId) === promptUpstream.nodeId);
    if (promptNode) {
      promptInputFields = safeArray(options.extractInputFields(safeArray(promptNode.sections)));
    }
  }

  const resultWindow = buildRowWindow(
    runResults,
    {
      startRow: options?.startRow ?? options?.start_row,
      maxRows: options?.maxRows ?? options?.max_rows ?? options?.sampleRunResults,
    },
    3
  );
  const resultPreview = resultWindow.items.map((row) => ({
    row_index: row?.row_index,
    input_row_index: row?.input_row_index,
    output: row?.output ?? null,
    error: row?.error ? String(row.error) : '',
  }));

  result.details = {
    runWorkingSetId: normalizeNodeId(rawNode?.runWorkingSetId),
    runCredentialId: normalizeNodeId(rawNode?.runCredentialId),
    runInputToColumn,
    promptInputFields,
    runPending: rawNode?.runPending === true,
    runCompleted: rawNode?.runCompleted === true || rawNode?.runCompleted === '1',
    runProgress: Number.isFinite(Number(rawNode?.runProgress)) ? Number(rawNode.runProgress) : 0,
    inputHeaders: safeArray(runInputContent?.headers).map((header) => String(header ?? '')),
    inputRowCount: safeArray(runInputContent?.rows).length,
    resultsCount: runResults.length,
    resultWindow: resultWindow.window,
    resultPreview,
  };

  if (!promptUpstream) {
    addDiagnostic(result.diagnostics, 'warning', 'run.no_prompt_upstream', 'This run node is not connected to an upstream prompt.');
  }
  if (!result.details.runWorkingSetId) {
    addDiagnostic(result.diagnostics, 'warning', 'run.no_input_dataset', 'This run node has no selected input dataset.');
  }
  if (!result.details.runCredentialId) {
    addDiagnostic(result.diagnostics, 'info', 'run.no_credential', 'This run node has no selected credential.');
  }
  if (promptInputFields.length > 0) {
    const missingMappings = promptInputFields.filter((field) => !String(runInputToColumn[field] || '').trim());
    if (missingMappings.length > 0) {
      addDiagnostic(
        result.diagnostics,
        'warning',
        'run.missing_input_mappings',
        `This run node is missing input mappings for: ${missingMappings.join(', ')}`,
      );
    }
  }
  if (runResults.length === 0) {
    addDiagnostic(result.diagnostics, 'info', 'run.no_results', 'This run node has no saved results.');
  }
  return result;
}

function countScoreRules(scoreMapping) {
  function walk(node) {
    if (!node) return 0;
    if (Array.isArray(node)) return node.reduce((sum, item) => sum + walk(item), 0);
    if (typeof node !== 'object') return 0;
    if (node.type === 'rule') return 1;
    if (Array.isArray(node.children)) return node.children.reduce((sum, item) => sum + walk(item), 0);
    if (node.inputRoot || node.outputRoot) return walk(node.inputRoot) + walk(node.outputRoot);
    if (Array.isArray(node.gtColumns) || Object.prototype.hasOwnProperty.call(node, 'outputKey')) return 1;
    return 0;
  }
  return walk(scoreMapping);
}

function summarizeComparisonRow(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    row_index: row.row_index ?? null,
    input_row_index: row.input_row_index ?? null,
    matched: row.matched === true,
    run_output: row.run_output ?? null,
    expected: row.expected ?? null,
    ground_truth_output: row.ground_truth_output ?? null,
    source_gt_row_index: row.source_gt_row_index ?? null,
    gt_only: row.gt_only === true,
  };
}

function buildScoreMetrics(comparisonRows) {
  const rows = safeArray(comparisonRows);
  const total = rows.length;
  if (total === 0) return null;
  let matched = 0;
  let unmatched = 0;
  let gtOnly = 0;
  for (const row of rows) {
    if (row?.gt_only === true) gtOnly += 1;
    if (row?.matched === true) matched += 1;
    else unmatched += 1;
  }
  const base = {
    totalRows: total,
    matchedRows: matched,
    unmatchedRows: unmatched,
    gtOnlyRows: gtOnly,
    passRate: total > 0 ? Number((matched / total).toFixed(4)) : 0,
  };
  return mergeScoreMetricsWithPrf(base, rows);
}

function summarizeVerifyRows(verifyRows, maxRows = 8) {
  const rows = safeArray(verifyRows);
  if (rows.length === 0) return [];
  return rows.slice(0, maxRows).map((row) => ({
    matched: row?.matched === true,
    error: row?.error ? String(row.error) : null,
    output: row?.output ?? null,
    gt: row?.gt ?? null,
    gtNum: Number.isFinite(Number(row?.gtNum)) ? Number(row.gtNum) : null,
  }));
}

function summarizeVerifyResult(verifyResult) {
  if (!verifyResult || typeof verifyResult !== 'object') return null;
  const status = String(verifyResult.status || '').trim();
  if (status === 'error') {
    return {
      status: 'error',
      message: String(verifyResult.message || '').trim() || 'Verification did not complete.',
      targetRowCount: Number.isFinite(Number(verifyResult.targetRowCount)) ? Number(verifyResult.targetRowCount) : null,
    };
  }
  if (status !== 'complete') {
    return {
      status: status || 'unknown',
      message: String(verifyResult.message || '').trim() || null,
    };
  }
  const verifyRows = safeArray(verifyResult.verifyRows);
  const matchedCount = Number.isFinite(Number(verifyResult.matchedCount))
    ? Number(verifyResult.matchedCount)
    : verifyRows.reduce((sum, row) => sum + (row?.matched === true && !row?.error ? 1 : 0), 0);
  const total = Number.isFinite(Number(verifyResult.total)) ? Number(verifyResult.total) : verifyRows.length;
  const errorRowCount = verifyRows.reduce((sum, row) => sum + (row?.error ? 1 : 0), 0);
  return {
    status: 'complete',
    matchedCount,
    total,
    passRate: total > 0 ? Number((matchedCount / total).toFixed(4)) : 0,
    errorRowCount,
    targetRowCount: Number.isFinite(Number(verifyResult.targetRowCount)) ? Number(verifyResult.targetRowCount) : null,
    verifyRowCount: verifyRows.length,
    verifyRowsPreview: summarizeVerifyRows(verifyRows, 8),
  };
}

function summarizeReviewSuggestion(rawSuggestion, reviewResult) {
  if (!rawSuggestion || typeof rawSuggestion !== 'object') return null;
  const suggestionId = String(rawSuggestion.suggestion_id ?? '').trim();
  const verifyState = suggestionId
    ? String(reviewResult?.verify_states?.[suggestionId] || '').trim()
    : '';
  const verifyResult = suggestionId
    ? (reviewResult?.verify_results?.[suggestionId] || null)
    : null;
  return {
    suggestion_id: suggestionId,
    name: String(rawSuggestion.name || '').trim(),
    source: String(rawSuggestion.source || '').trim(),
    target_section: String(rawSuggestion.target_section || '').trim(),
    old_sentence: String(rawSuggestion.old_sentence || ''),
    new_sentence: String(rawSuggestion.new_sentence || ''),
    reason: String(rawSuggestion.reason || ''),
    applied: rawSuggestion.applied === true,
    verify_state: verifyState || 'idle',
    verify_result: summarizeVerifyResult(verifyResult),
  };
}

function buildSuggestionStateCounts(reviewResult) {
  const counts = { idle: 0, verifying: 0, verified: 0, optimization: 0, optimized: 0, optimizedPass: 0, error: 0, other: 0 };
  const suggestions = safeArray(reviewResult?.suggestions);
  for (const suggestion of suggestions) {
    const id = String(suggestion?.suggestion_id ?? '').trim();
    const state = String(reviewResult?.verify_states?.[id] || 'idle').trim();
    switch (state) {
      case 'idle': counts.idle += 1; break;
      case 'verifying': counts.verifying += 1; break;
      case 'verified': counts.verified += 1; break;
      case 'optimization': counts.optimization += 1; break;
      case 'optimized': counts.optimized += 1; break;
      case 'optimized-pass': counts.optimizedPass += 1; break;
      case 'error': counts.error += 1; break;
      default: counts.other += 1; break;
    }
  }
  return counts;
}

function inspectScoreNode(rawNode, canvasState, options = {}) {
  const result = buildBaseInspection(rawNode, canvasState);
  const scoreMapping = rawNode?.scoreMapping ?? null;
  const reviewResult = parseReviewResult(rawNode?.reviewResult);
  const ruleCount = countScoreRules(scoreMapping);
  const runUpstream = result.upstream.find((item) => item.nodeType === 'run');
  const comparisonRows = safeArray(reviewResult?.comparison_rows);
  const metrics = buildScoreMetrics(comparisonRows);

  const comparisonWindow = buildRowWindow(
    comparisonRows,
    {
      startRow: options?.startRow ?? options?.start_row,
      maxRows: options?.maxRows ?? options?.max_rows,
    },
    5,
  );

  result.details = {
    scoreGroundTruthId: normalizeNodeId(rawNode?.scoreGroundTruthId),
    reviewCredentialId: normalizeNodeId(rawNode?.reviewCredentialId),
    scoreMapping,
    scoreRowExcludedFromScoring: rawNode?.scoreRowExcludedFromScoring ?? null,
    ruleCount,
    reviewSummary: reviewResult?.summary ? String(reviewResult.summary) : '',
    reviewSuggestionCount: safeArray(reviewResult?.suggestions).length,
    metrics,
    comparisonRowCount: comparisonRows.length,
    comparisonRowWindow: comparisonWindow.window,
    comparisonRows: comparisonWindow.items.map((row) => summarizeComparisonRow(row)).filter(Boolean),
  };

  if (!runUpstream) {
    addDiagnostic(result.diagnostics, 'warning', 'score.no_run_upstream', 'This score node is not connected to an upstream run.');
  }
  if (!result.details.scoreGroundTruthId) {
    addDiagnostic(result.diagnostics, 'warning', 'score.no_ground_truth', 'This score node has no selected ground-truth dataset.');
  }
  if (ruleCount === 0) {
    addDiagnostic(result.diagnostics, 'warning', 'score.no_rules', 'This score node has no scoring rules.');
  }
  if (comparisonRows.length === 0) {
    addDiagnostic(result.diagnostics, 'info', 'score.no_comparison_rows', 'This score node has no comparison rows yet (run a review to populate them).');
  }
  return result;
}

function inspectPromptReviewNode(rawNode, canvasState, options = {}) {
  const result = buildBaseInspection(rawNode, canvasState);
  const reviewResult = parseReviewResult(rawNode?.reviewResult);
  const scoreUpstream = result.upstream.find((item) => item.nodeType === 'score');
  const rawSuggestions = safeArray(reviewResult?.suggestions);
  const promptSections = safeArray(reviewResult?.promptSections).map((section) => ({
    name: String(section?.name || ''),
    content: String(section?.content || ''),
  }));
  const workingSections = safeArray(reviewResult?.workingSections).map((section) => ({
    name: String(section?.name || ''),
    content: String(section?.content || ''),
  }));
  const comparisonRows = safeArray(reviewResult?.comparison_rows);
  const metrics = buildScoreMetrics(comparisonRows);

  const suggestionWindow = buildRowWindow(
    rawSuggestions,
    {
      startRow: options?.startRow ?? options?.start_row,
      maxRows: options?.maxRows ?? options?.max_rows,
    },
    20,
  );

  const suggestions = suggestionWindow.items
    .map((suggestion) => summarizeReviewSuggestion(suggestion, reviewResult))
    .filter(Boolean);

  result.details = {
    reviewPending: rawNode?.reviewPending === true,
    reviewProgress: Number.isFinite(Number(rawNode?.reviewProgress)) ? Number(rawNode.reviewProgress) : 0,
    reviewSummary: reviewResult?.summary ? String(reviewResult.summary) : '',
    suggestionCount: rawSuggestions.length,
    suggestionStateCounts: buildSuggestionStateCounts(reviewResult),
    suggestionWindow: suggestionWindow.window,
    suggestions,
    promptSections,
    workingSections,
    metrics,
    comparisonRowCount: comparisonRows.length,
  };

  if (!scoreUpstream) {
    addDiagnostic(result.diagnostics, 'warning', 'review.no_score_upstream', 'This review node is not connected to an upstream score node.');
  }
  if (!result.details.reviewSummary && result.details.suggestionCount === 0) {
    addDiagnostic(result.diagnostics, 'info', 'review.no_result', 'This review node has no saved review result.');
  }
  return result;
}

/**
 * Merge live or precomputed comparison_rows into an existing score inspect result (same shape as inspectScoreNode).
 */
export function enrichInspectScoreResultWithComparisonRows(inspectResult, comparisonRows, options = {}) {
  if (!inspectResult || inspectResult.found === false || !inspectResult.details) return inspectResult;
  const rows = safeArray(comparisonRows);
  if (rows.length === 0) return inspectResult;
  const comparisonWindow = buildRowWindow(rows, {
    startRow: options?.startRow ?? options?.start_row,
    maxRows: options?.maxRows ?? options?.max_rows,
  }, 5);
  inspectResult.details.metrics = buildFullScoreMetricsFromComparisonRows(rows);
  inspectResult.details.comparisonRowCount = rows.length;
  inspectResult.details.comparisonRowWindow = comparisonWindow.window;
  inspectResult.details.comparisonRows = comparisonWindow.items.map((row) => summarizeComparisonRow(row)).filter(Boolean);
  inspectResult.details.comparisonRowsLive = true;
  const idx = inspectResult.diagnostics.findIndex((d) => d.code === 'score.no_comparison_rows');
  if (idx >= 0) inspectResult.diagnostics.splice(idx, 1);
  return inspectResult;
}

export function inspectWorkflowNode(canvasState, nodeId, options = {}) {
  const nodes = safeArray(canvasState?.nodes);
  const normalizedNodeId = normalizeNodeId(nodeId);
  const rawNode = nodes.find((node) => normalizeNodeId(node?.nodeId) === normalizedNodeId);

  if (!rawNode) {
    return {
      found: false,
      nodeId: normalizedNodeId,
      diagnostics: [
        {
          level: 'error',
          code: 'node.not_found',
          message: 'Node not found in current canvas state.',
        },
      ],
    };
  }

  switch (String(rawNode.type || '')) {
    case 'prompt':
      return inspectPromptNode(rawNode, canvasState, options);
    case 'dataset':
      return inspectDatasetNode(rawNode, canvasState, options);
    case 'sampler':
      return inspectSamplerNode(rawNode, canvasState, options);
    case 'run':
      return inspectRunNode(rawNode, canvasState, options);
    case 'score':
      return inspectScoreNode(rawNode, canvasState, options);
    case 'promptReview':
      return inspectPromptReviewNode(rawNode, canvasState, options);
    default:
      return buildBaseInspection(rawNode, canvasState);
  }
}
