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

  return {
    found: true,
    nodeId,
    nodeType: String(rawNode?.type || 'unknown'),
    title: deriveNodeTitle(rawNode),
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
  const rows = safeArray(content?.rows).map((row) => safeArray(row).map((cell) => String(cell ?? '')));
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

function inspectScoreNode(rawNode, canvasState) {
  const result = buildBaseInspection(rawNode, canvasState);
  const scoreMapping = rawNode?.scoreMapping ?? null;
  const reviewResult = parseReviewResult(rawNode?.reviewResult);
  const ruleCount = countScoreRules(scoreMapping);
  const runUpstream = result.upstream.find((item) => item.nodeType === 'run');

  result.details = {
    scoreGroundTruthId: normalizeNodeId(rawNode?.scoreGroundTruthId),
    reviewCredentialId: normalizeNodeId(rawNode?.reviewCredentialId),
    scoreMapping,
    scoreRowExcludedFromScoring: rawNode?.scoreRowExcludedFromScoring ?? null,
    ruleCount,
    reviewSummary: reviewResult?.summary ? String(reviewResult.summary) : '',
    reviewSuggestionCount: safeArray(reviewResult?.suggestions).length,
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
  return result;
}

function inspectPromptReviewNode(rawNode, canvasState) {
  const result = buildBaseInspection(rawNode, canvasState);
  const reviewResult = parseReviewResult(rawNode?.reviewResult);
  const scoreUpstream = result.upstream.find((item) => item.nodeType === 'score');

  result.details = {
    reviewProgress: Number.isFinite(Number(rawNode?.reviewProgress)) ? Number(rawNode.reviewProgress) : 0,
    reviewSummary: reviewResult?.summary ? String(reviewResult.summary) : '',
    suggestionCount: safeArray(reviewResult?.suggestions).length,
    suggestionNames: safeArray(reviewResult?.suggestions)
      .slice(0, 5)
      .map((item) => String(item?.name || '').trim())
      .filter(Boolean),
  };

  if (!scoreUpstream) {
    addDiagnostic(result.diagnostics, 'warning', 'review.no_score_upstream', 'This review node is not connected to an upstream score node.');
  }
  if (!result.details.reviewSummary && result.details.suggestionCount === 0) {
    addDiagnostic(result.diagnostics, 'info', 'review.no_result', 'This review node has no saved review result.');
  }
  return result;
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
