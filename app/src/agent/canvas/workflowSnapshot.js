import { DATASET_BORDER_COLORS } from '../../workflowNodeColors.js';
import { mergeScoreMetricsWithPrf } from './scoreComparisonPrf.js';

function normalizeNodeId(value) {
  return String(value || '').trim();
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function countRules(node) {
  if (!node) return 0;
  if (Array.isArray(node)) return node.reduce((sum, item) => sum + countRules(item), 0);
  if (typeof node !== 'object') return 0;
  if (node.type === 'rule') return 1;
  if (Array.isArray(node.children)) return node.children.reduce((sum, item) => sum + countRules(item), 0);
  if (Array.isArray(node.rules)) return node.rules.reduce((sum, item) => sum + countRules(item), 0);
  if (node.inputRoot || node.outputRoot) {
    return countRules(node.inputRoot) + countRules(node.outputRoot);
  }
  if (Array.isArray(node.gtColumns) || Object.prototype.hasOwnProperty.call(node, 'outputKey')) return 1;
  return 0;
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

function parseJsonArray(raw) {
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function getDatasetContent(node) {
  return node?.subsetContent || node?.datasetContent || null;
}

function getDatasetPreview(node, previewRows) {
  const content = getDatasetContent(node);
  const headers = safeArray(content?.headers).map((header) => String(header ?? ''));
  const rows = safeArray(content?.rows).map((row) => safeArray(row).map((cell) => String(cell ?? '')));
  return {
    headers,
    rowCount: rows.length,
    columnCount: headers.length,
    sampleRows: rows.slice(0, Math.max(0, previewRows)),
  };
}

function normalizeColorIndex(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

function resolveDatasetColor(colorIndex) {
  const idx = normalizeColorIndex(colorIndex);
  if (idx == null || DATASET_BORDER_COLORS.length === 0) return null;
  const normalizedIndex = idx % DATASET_BORDER_COLORS.length;
  return {
    index: normalizedIndex,
    value: DATASET_BORDER_COLORS[normalizedIndex],
  };
}

function resolveLinkedDatasetColor(rawNodeById, datasetNodeId) {
  const targetId = normalizeNodeId(datasetNodeId);
  if (!targetId) return null;
  const datasetNode = rawNodeById.get(targetId);
  if (!datasetNode || String(datasetNode.type || '') !== 'dataset') return null;
  return resolveDatasetColor(datasetNode.colorIndex);
}

function getPromptPreview(node, extractInputFields) {
  const sections = safeArray(node?.sections).map((section) => ({
    name: String(section?.name || ''),
    content: String(section?.content || ''),
  }));
  const outputFormat = node?.outputFormat && typeof node.outputFormat === 'object'
    ? node.outputFormat
    : { returnShape: 'single', fields: [] };
  const fields = safeArray(outputFormat.fields).map((field) => ({
    key: String(field?.key || ''),
    type: String(field?.type || 'str'),
    description: String(field?.description || ''),
    allowNone: field?.allowNone === true,
  }));
  const inputFields = typeof extractInputFields === 'function'
    ? safeArray(extractInputFields(sections)).map((field) => String(field || '')).filter(Boolean)
    : [];
  return {
    sections,
    outputFormat: {
      returnShape: String(outputFormat.returnShape || 'single'),
      fields,
    },
    inputFields,
    outputKeys: fields.map((field) => field.key).filter(Boolean),
  };
}

function getRunPreview(node) {
  const runInputToColumn = parseJsonObject(node?.runInputToColumn, {});
  const results = parseJsonArray(node?.runResults);
  const firstOutput = results.find((item) => item && typeof item.output === 'object' && item.output !== null);
  const outputKeys = firstOutput ? Object.keys(firstOutput.output) : [];
  return {
    runWorkingSetId: normalizeNodeId(node?.runWorkingSetId),
    runCredentialId: normalizeNodeId(node?.runCredentialId),
    runInputToColumn,
    runPending: node?.runPending === true,
    runCompleted: node?.runCompleted === true || node?.runCompleted === '1',
    runProgress: Number.isFinite(Number(node?.runProgress)) ? Number(node.runProgress) : 0,
    resultsCount: results.length,
    outputKeys,
  };
}

function buildScoreMetricsFromComparisonRows(comparisonRows) {
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

function getScorePreview(node) {
  const scoreMapping = typeof node?.scoreMapping === 'string'
    ? parseReviewResult(node.scoreMapping)
    : (node?.scoreMapping ?? null);
  const reviewResult = parseReviewResult(node?.reviewResult);
  const ruleCount = countRules(scoreMapping);
  const comparisonRows = safeArray(reviewResult?.comparison_rows);
  return {
    scoreGroundTruthId: normalizeNodeId(node?.scoreGroundTruthId),
    reviewCredentialId: normalizeNodeId(node?.reviewCredentialId),
    scoreMapping,
    ruleCount,
    reviewSuggestionCount: safeArray(reviewResult?.suggestions).length,
    metrics: buildScoreMetricsFromComparisonRows(comparisonRows),
    comparisonRowCount: comparisonRows.length,
  };
}

function getReviewPreview(node) {
  const reviewResult = parseReviewResult(node?.reviewResult);
  return {
    reviewPending: node?.reviewPending === true,
    reviewProgress: Number.isFinite(Number(node?.reviewProgress)) ? Number(node.reviewProgress) : 0,
    reviewSuggestionCount: safeArray(reviewResult?.suggestions).length,
    reviewSummary: reviewResult?.summary ? String(reviewResult.summary) : '',
  };
}

export function buildAdjacency(connections) {
  const upstreamByNodeId = {};
  const downstreamByNodeId = {};
  for (const connection of safeArray(connections)) {
    const fromId = normalizeNodeId(connection?.fromId);
    const toId = normalizeNodeId(connection?.toId);
    if (!fromId || !toId) continue;
    if (!downstreamByNodeId[fromId]) downstreamByNodeId[fromId] = [];
    if (!upstreamByNodeId[toId]) upstreamByNodeId[toId] = [];
    downstreamByNodeId[fromId].push(toId);
    upstreamByNodeId[toId].push(fromId);
  }
  return { upstreamByNodeId, downstreamByNodeId };
}

function indexConnectionsByType(connections) {
  const byType = new Map();
  for (const connection of safeArray(connections)) {
    const type = String(connection?.type || '').trim();
    if (!type) continue;
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type).push(connection);
  }
  return byType;
}

export function buildChains(nodes, connections) {
  const nodeById = new Map(safeArray(nodes).map((node) => [normalizeNodeId(node?.id), node]));
  const byType = indexConnectionsByType(connections);
  const promptToRun = byType.get('prompt-to-run') || [];
  const runToScore = byType.get('run-to-score') || [];
  const scoreToReview = byType.get('score-to-prompt-review') || [];

  return safeArray(nodes)
    .filter((node) => node?.type === 'run')
    .map((runNode) => {
      const runId = normalizeNodeId(runNode.id);
      const promptEdge = promptToRun.find((edge) => normalizeNodeId(edge?.toId) === runId);
      const scoreEdge = runToScore.find((edge) => normalizeNodeId(edge?.fromId) === runId);
      const scoreId = scoreEdge ? normalizeNodeId(scoreEdge.toId) : '';
      const reviewEdge = scoreId
        ? scoreToReview.find((edge) => normalizeNodeId(edge?.fromId) === scoreId)
        : null;
      const datasetId = normalizeNodeId(runNode?.config?.runWorkingSetId);
      return {
        promptId: promptEdge ? normalizeNodeId(promptEdge.fromId) : '',
        datasetId,
        runId,
        scoreId,
        reviewId: reviewEdge ? normalizeNodeId(reviewEdge.toId) : '',
      };
    })
    .filter((chain) => chain.promptId || chain.datasetId || chain.runId || chain.scoreId || chain.reviewId)
    .map((chain) => ({
      ...chain,
      promptTitle: chain.promptId ? nodeById.get(chain.promptId)?.title || '' : '',
      datasetTitle: chain.datasetId ? nodeById.get(chain.datasetId)?.title || '' : '',
      runTitle: chain.runId ? nodeById.get(chain.runId)?.title || '' : '',
      scoreTitle: chain.scoreId ? nodeById.get(chain.scoreId)?.title || '' : '',
      reviewTitle: chain.reviewId ? nodeById.get(chain.reviewId)?.title || '' : '',
    }));
}

function buildNodeSnapshot(rawNode, adjacency, options, rawNodeById) {
  const id = normalizeNodeId(rawNode?.nodeId);
  const type = String(rawNode?.type || '').trim() || 'unknown';
  const position = {
    left: Number.isFinite(Number(rawNode?.left)) ? Number(rawNode.left) : 0,
    top: Number.isFinite(Number(rawNode?.top)) ? Number(rawNode.top) : 0,
  };
  const upstream = safeArray(adjacency.upstreamByNodeId[id]);
  const downstream = safeArray(adjacency.downstreamByNodeId[id]);

  if (type === 'prompt') {
    const preview = getPromptPreview(rawNode, options.extractInputFields);
    const nodeOrigin = String(rawNode?.nodeOrigin || '').trim() || 'user';
    return {
      id,
      type,
      title: String(rawNode?.name || 'Prompt'),
      position,
      upstream,
      downstream,
      nodeOrigin,
      config: {
        note: String(rawNode?.note || ''),
        sections: preview.sections,
        outputFormat: preview.outputFormat,
      },
      status: {
        hasSections: preview.sections.length > 0,
        hasOutputSchema: preview.outputKeys.length > 0,
      },
      preview: {
        inputFields: preview.inputFields,
        outputKeys: preview.outputKeys,
        sectionCount: preview.sections.length,
      },
    };
  }

  if (type === 'dataset') {
    const preview = getDatasetPreview(rawNode, options.datasetPreviewRows);
    const color = resolveDatasetColor(rawNode?.colorIndex);
    return {
      id,
      type,
      title: String(rawNode?.name || 'Dataset'),
      position,
      color,
      upstream,
      downstream,
      config: {
        note: String(rawNode?.note || ''),
        samplerNodeId: normalizeNodeId(rawNode?.samplerNodeId),
      },
      status: {
        rowCount: preview.rowCount,
        columnCount: preview.columnCount,
        hasData: preview.rowCount > 0 || preview.columnCount > 0,
      },
      preview,
    };
  }

  if (type === 'sampler') {
    return {
      id,
      type,
      title: String(rawNode?.name || 'Sample'),
      position,
      upstream,
      downstream,
      config: {
        note: String(rawNode?.note || ''),
        sourceNodeId: normalizeNodeId(rawNode?.sourceNodeId),
        samplingType: String(rawNode?.samplingType || 'without-replacement'),
        sampleSizeType: String(rawNode?.sampleSizeType || ''),
        sampleSize: rawNode?.sampleSize ?? null,
        rowSpec: String(rawNode?.rowSpec || ''),
      },
      status: {
        hasSourceDataset: Boolean(normalizeNodeId(rawNode?.sourceNodeId)),
      },
      preview: {
        modeLabel: String(rawNode?.samplingType || 'without-replacement'),
      },
    };
  }

  if (type === 'run') {
    const preview = getRunPreview(rawNode);
    const color = resolveLinkedDatasetColor(rawNodeById, preview.runWorkingSetId);
    return {
      id,
      type,
      title: String(rawNode?.runName || 'Run'),
      position,
      color,
      upstream,
      downstream,
      config: {
        runWorkingSetId: preview.runWorkingSetId,
        runCredentialId: preview.runCredentialId,
        runInputToColumn: preview.runInputToColumn,
      },
      status: {
        pending: preview.runPending,
        completed: preview.runCompleted,
        progress: preview.runProgress,
        hasResults: preview.resultsCount > 0,
        resultsCount: preview.resultsCount,
      },
      preview: {
        mappedInputs: Object.keys(preview.runInputToColumn),
        outputKeys: preview.outputKeys,
      },
    };
  }

  if (type === 'score') {
    const preview = getScorePreview(rawNode);
    const color = resolveLinkedDatasetColor(rawNodeById, preview.scoreGroundTruthId);
    const nodeOrigin = String(rawNode?.nodeOrigin || '').trim() || 'user';
    return {
      id,
      type,
      title: String(rawNode?.scoreName || 'Score'),
      position,
      color,
      upstream,
      downstream,
      nodeOrigin,
      config: {
        scoreGroundTruthId: preview.scoreGroundTruthId,
        reviewCredentialId: preview.reviewCredentialId,
        scoreMapping: preview.scoreMapping,
        scoreRowExcludedFromScoring:
          rawNode?.scoreRowExcludedFromScoring && typeof rawNode.scoreRowExcludedFromScoring === 'object'
            ? rawNode.scoreRowExcludedFromScoring
            : undefined,
      },
      status: {
        hasGroundTruth: Boolean(preview.scoreGroundTruthId),
        hasScoreMapping: preview.ruleCount > 0,
        hasReviewResult: preview.reviewSuggestionCount > 0,
        hasMetrics: preview.metrics !== null,
      },
      preview: {
        ruleCount: preview.ruleCount,
        reviewSuggestionCount: preview.reviewSuggestionCount,
        metrics: preview.metrics,
        comparisonRowCount: preview.comparisonRowCount,
      },
    };
  }

  if (type === 'promptReview') {
    const preview = getReviewPreview(rawNode);
    return {
      id,
      type,
      title: String(rawNode?.promptReviewName || 'Review'),
      position,
      upstream,
      downstream,
      config: {},
      status: {
        pending: preview.reviewPending,
        progress: preview.reviewProgress,
        hasReviewResult: preview.reviewSuggestionCount > 0 || Boolean(preview.reviewSummary),
      },
      preview: {
        reviewSuggestionCount: preview.reviewSuggestionCount,
        reviewSummary: preview.reviewSummary,
      },
    };
  }

  return {
    id,
    type,
    title: String(rawNode?.name || rawNode?.nodeId || 'Node'),
    position,
    color: null,
    upstream,
    downstream,
    config: { ...rawNode },
    status: {},
    preview: {},
  };
}

function buildSummary(nodes, connections) {
  const countsByType = {};
  for (const node of safeArray(nodes)) {
    const type = String(node?.type || 'unknown');
    countsByType[type] = (countsByType[type] || 0) + 1;
  }

  const runnableRunNodeIds = safeArray(nodes)
    .filter((node) => node?.type === 'run')
    .filter((node) => safeArray(node.upstream).length > 0 && Boolean(normalizeNodeId(node?.config?.runWorkingSetId)))
    .map((node) => node.id);

  const reviewableScoreNodeIds = safeArray(nodes)
    .filter((node) => node?.type === 'score')
    .filter((node) => Boolean(normalizeNodeId(node?.config?.scoreGroundTruthId)) && node?.preview?.ruleCount > 0)
    .map((node) => node.id);

  return {
    countsByType,
    totalNodes: safeArray(nodes).length,
    totalConnections: safeArray(connections).length,
    runnableRunNodeIds,
    reviewableScoreNodeIds,
    chains: buildChains(nodes, connections),
  };
}

export function buildWorkflowSnapshot(canvasState, options = {}) {
  const nodesRaw = safeArray(canvasState?.nodes);
  const rawNodeById = new Map(nodesRaw.map((node) => [normalizeNodeId(node?.nodeId), node]));
  const connections = safeArray(canvasState?.connections)
    .map((connection) => ({
      fromId: normalizeNodeId(connection?.fromId),
      toId: normalizeNodeId(connection?.toId),
      type: String(connection?.type || '').trim(),
    }))
    .filter((connection) => connection.fromId && connection.toId);

  const normalizedOptions = {
    extractInputFields: typeof options.extractInputFields === 'function' ? options.extractInputFields : null,
    datasetPreviewRows: Number.isFinite(Number(options.datasetPreviewRows)) ? Math.max(0, Number(options.datasetPreviewRows)) : 3,
  };

  const adjacency = buildAdjacency(connections);
  const nodes = nodesRaw.map((node) => buildNodeSnapshot(node, adjacency, normalizedOptions, rawNodeById));

  return {
    version: 1,
    generatedAt: Date.now(),
    sourceVersion: Number.isFinite(Number(canvasState?.version)) ? Number(canvasState.version) : null,
    nodes,
    connections,
    adjacency,
    summary: buildSummary(nodes, connections),
  };
}
