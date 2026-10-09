/**
 * Agent-facing views of canvas nodes, built from getCanvasState() output. Pure functions: no DOM.
 * inspectWorkflowNode gives one node's full configuration plus a short preview; readNodeRows pages
 * through a node's table (dataset rows, run results, process outputs, score comparisons).
 */
import { buildFullScoreMetricsFromComparisonRows, mergeScoreMetricsWithPrf } from './scoreComparisonPrf.js';
import { displayCell, normalizeDatasetContent } from '../../datasetContent.js';
import { processInputAliases, processInputEdges, processPrimarySource, runInputSource } from '../../stepInputs.js';
import { readSavedFrom } from '../../savedDatasets.js';

export const MAX_ROWS_PER_READ = 50;

function normalizeNodeId(value) {
  return String(value || '').trim();
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function parseJson(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch (_) {
    return fallback;
  }
}

function parseJsonObject(raw, fallback = {}) {
  const parsed = parseJson(raw, fallback);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
}

export function nodeTitle(node) {
  if (!node || typeof node !== 'object') return 'Node';
  switch (String(node.type || '')) {
    case 'prompt': return String(node.name || 'Prompt');
    case 'dataset': return String(node.name || 'Dataset');
    case 'sampler': return String(node.name || 'Sample');
    case 'process': return String(node.name || 'Process');
    case 'run': return String(node.runName || 'Run');
    case 'score': return String(node.scoreName || 'Score');
    case 'promptReview': return String(node.promptReviewName || 'Review');
    default: return String(node.name || node.nodeId || 'Node');
  }
}

export function buildNodeLookup(canvasState) {
  return new Map(safeArray(canvasState?.nodes).map((node) => [normalizeNodeId(node?.nodeId), node]));
}

export function datasetContentOf(node) {
  return normalizeDatasetContent(node?.subsetContent || node?.datasetContent || { headers: [], rows: [] });
}

/** Process output branches as {name: {headers, rows}} from a node's saved dfResults. */
export function processOutputsOf(node) {
  const parsed = parseJsonObject(node?.dfResults, {});
  if (parsed.outputs && typeof parsed.outputs === 'object') {
    return Object.fromEntries(Object.entries(parsed.outputs)
      .filter(([, branch]) => branch && Array.isArray(branch.headers) && Array.isArray(branch.rows)));
  }
  if (Array.isArray(parsed.headers) && Array.isArray(parsed.rows)) return { result: parsed };
  return {};
}

export function runResultsOf(node) {
  const parsed = parseJson(node?.runResults, []);
  return Array.isArray(parsed) ? parsed : [];
}

export function runInputContentOf(node) {
  return parseJsonObject(node?.runInputContent, { headers: [], rows: [] });
}

/** The Datasets saved from a Run or Process, with the `savedFrom` each records. */
function savedFromNode(canvasState, nodeId) {
  return safeArray(canvasState?.nodes)
    .map((dataset) => ({ dataset, savedFrom: dataset?.type === 'dataset' ? readSavedFrom(dataset.savedFrom) : null }))
    .filter(({ savedFrom }) => savedFrom && normalizeNodeId(savedFrom.nodeId) === nodeId);
}

function linkedNode(node) {
  return node ? { nodeId: normalizeNodeId(node.nodeId), type: String(node.type || ''), title: nodeTitle(node) } : null;
}

function neighbors(canvasState, nodeLookup, nodeId, direction) {
  return safeArray(canvasState?.connections)
    .filter((c) => normalizeNodeId(direction === 'upstream' ? c?.toId : c?.fromId) === nodeId)
    .map((c) => {
      const other = nodeLookup.get(normalizeNodeId(direction === 'upstream' ? c?.fromId : c?.toId));
      return other ? { connection: String(c.type || ''), ...linkedNode(other) } : null;
    })
    .filter(Boolean);
}

function upstreamOfType(canvasState, nodeLookup, nodeId, type) {
  return neighbors(canvasState, nodeLookup, nodeId, 'upstream').find((n) => n.type === type) || null;
}

function normalizePositiveInteger(value, fallback) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

/** 1-based row window over `items`; `maxRows` is capped at MAX_ROWS_PER_READ. */
export function rowWindow(items, options = {}, defaultMaxRows = 5) {
  const list = safeArray(items);
  const startRow = normalizePositiveInteger(options.startRow ?? options.start_row, 1);
  const maxRows = Math.min(MAX_ROWS_PER_READ, normalizePositiveInteger(options.maxRows ?? options.max_rows, defaultMaxRows));
  const startIndex = Math.min(list.length, startRow - 1);
  const slice = list.slice(startIndex, startIndex + maxRows);
  return {
    items: slice,
    startIndex,
    window: {
      totalRows: list.length,
      firstRow: slice.length ? startIndex + 1 : null,
      lastRow: slice.length ? startIndex + slice.length : null,
      hasMore: startIndex + slice.length < list.length,
    },
  };
}

function rowObject(headers, row, columns = null) {
  const out = {};
  headers.forEach((header, i) => {
    if (columns && !columns.includes(header)) return;
    out[header] = displayCell(safeArray(row)[i]);
  });
  return out;
}

function columnsOf(content) {
  return content.headers.map((name, i) => ({ name, type: content.columnTypes?.[i] || 'text' }));
}

const SAVED_FROM_KINDS = { run: 'saved run results', process: 'saved process output', score: 'saved score comparison', pipeline: 'pipeline run result' };

/** Where a Dataset came from: a saved Dataset's `savedFrom` (savedDatasets.js), or its Sampler. */
function datasetProducer(node, canvasState, nodeLookup) {
  const savedFrom = readSavedFrom(node?.savedFrom);
  if (savedFrom) {
    const source = nodeLookup.get(normalizeNodeId(savedFrom.nodeId));
    return {
      kind: SAVED_FROM_KINDS[savedFrom.kind],
      ...(savedFrom.pipelineRunId ? { pipelineRunId: savedFrom.pipelineRunId } : {}),
      ...(source?.type === 'process' ? { branch: savedFrom.port } : {}),
      ...(source ? linkedNode(source) : savedFrom.nodeId ? { sourceRemoved: true } : {}),
    };
  }
  if (node?.samplerNodeId) {
    const sampler = nodeLookup.get(normalizeNodeId(node.samplerNodeId));
    if (sampler) return { kind: 'sample', ...linkedNode(sampler) };
  }
  return { kind: 'imported or created directly' };
}

function credentialLabel(credentialId, options) {
  const id = normalizeNodeId(credentialId);
  const credential = id ? options.credentialsById?.get(id) : null;
  if (credential) return [credential.provider, credential.model].filter(Boolean).join(' / ');
  if (id) return 'a credential that no longer exists';
  const fallback = options.defaultRunCredential;
  return fallback
    ? `default Run credential (${[fallback.provider, fallback.model].filter(Boolean).join(' / ')})`
    : 'default Run credential (none set)';
}

function inspectPrompt(node, ctx, options) {
  const sections = safeArray(node.sections).map((s) => ({ name: String(s?.name || ''), content: String(s?.content || '') }));
  const inputTypes = parseJsonObject(node.inputTypes, {});
  const inputFields = typeof options.extractInputFields === 'function'
    ? safeArray(options.extractInputFields(sections)).map(String)
    : [];
  const outputFormat = node.outputFormat && typeof node.outputFormat === 'object'
    ? node.outputFormat
    : { returnShape: 'single', fields: [] };
  const diagnostics = [];
  if (!sections.some((s) => s.content.trim())) diagnostics.push('The prompt has no content.');
  if (!safeArray(outputFormat.fields).length) diagnostics.push('The prompt has no output fields, so it cannot be exported.');
  return {
    details: {
      note: String(node.note || ''),
      sections,
      inputs: inputFields.map((name) => ({ name, type: inputTypes[name] || 'text' })),
      output: {
        returnShape: outputFormat.returnShape || 'single',
        fields: safeArray(outputFormat.fields).map((f) => ({
          key: f.key, type: f.type || 'str', description: f.description || '', examples: safeArray(f.examples),
        })),
      },
    },
    diagnostics,
  };
}

function inspectDataset(node, ctx, options) {
  const content = datasetContentOf(node);
  const preview = rowWindow(content.rows, options, 3);
  return {
    details: {
      note: String(node.note || ''),
      producedBy: datasetProducer(node, ctx.canvasState, ctx.nodeLookup),
      rowCount: content.rows.length,
      columns: columnsOf(content),
      preview: preview.items.map((row, i) => ({ row: preview.startIndex + i + 1, ...rowObject(content.headers, row) })),
      previewWindow: preview.window,
    },
    diagnostics: content.headers.length ? [] : ['The dataset has no columns.'],
  };
}

function inspectSampler(node, ctx) {
  const source = ctx.nodeLookup.get(normalizeNodeId(node.sourceNodeId));
  return {
    details: {
      note: String(node.note || ''),
      source: linkedNode(source),
      samplingType: String(node.samplingType || 'without-replacement'),
      sampleSizeType: node.sampleSizeType ?? null,
      sampleSize: node.sampleSize ?? null,
      rowSpec: node.rowSpec ?? null,
    },
    diagnostics: source ? [] : ['The sampler has no source dataset.'],
  };
}

function inspectProcess(node, ctx) {
  const aliases = processInputAliases(ctx.canvasState, ctx.nodeId);
  const code = String(node.dfCode || '');
  const connectedInputs = processInputEdges(ctx.canvasState)
    .filter((edge) => normalizeNodeId(edge.toId) === ctx.nodeId)
    .map((edge) => ctx.nodeLookup.get(normalizeNodeId(edge.fromId)))
    .filter(Boolean)
    .map((dataset) => ({ connection: 'data', ...linkedNode(dataset) }));
  const primaryId = processPrimarySource(ctx.canvasState, ctx.nodeId)?.nodeId || '';
  const primary = ctx.nodeLookup.get(primaryId);
  const outputs = processOutputsOf(node);
  const savedDatasets = savedFromNode(ctx.canvasState, ctx.nodeId)
    .map(({ dataset, savedFrom }) => ({ ...linkedNode(dataset), branch: savedFrom.port }));
  const diagnostics = [];
  if (!/^\s*def\s+process\s*\(\s*df\b/m.test(code)) diagnostics.push('The code does not define process(df).');
  if (!Object.keys(outputs).length) diagnostics.push('The process has not been run yet, or its last run returned nothing.');
  return {
    details: {
      code,
      primaryInput: linkedNode(primary),
      inputs: connectedInputs.map((n) => ({
        ...n,
        alias: n.nodeId === primaryId ? 'df' : (aliases[n.nodeId] || null),
      })),
      availableAliases: Object.entries(aliases)
        .map(([datasetId, alias]) => ({ alias, dataset: linkedNode(ctx.nodeLookup.get(normalizeNodeId(datasetId))) }))
        .filter((a) => a.dataset),
      outputs: Object.entries(outputs).map(([name, branch]) => ({
        branch: name,
        rowCount: branch.rows.length,
        columns: branch.headers.map(String),
      })),
      status: node.processPending === true ? 'running'
        : node.processResumable === true ? 'interrupted; ready to resume'
          : Object.keys(outputs).length ? 'completed' : 'not run yet',
      savedAsDatasets: savedDatasets,
    },
    diagnostics,
  };
}

function runStatus(node, results, inputRowCount) {
  if (node.runPending === true) return 'running';
  const completed = node.runCompleted === true || node.runCompleted === '1';
  if (completed) return 'completed';
  if (node.runResumable === true) return 'interrupted; ready to resume';
  return results.length ? 'stopped before finishing' : 'not run yet';
}

function inspectRun(node, ctx, options) {
  const results = runResultsOf(node);
  const input = runInputContentOf(node);
  const prompt = upstreamOfType(ctx.canvasState, ctx.nodeLookup, ctx.nodeId, 'prompt');
  const dataset = ctx.nodeLookup.get(normalizeNodeId(runInputSource(ctx.canvasState, ctx.nodeId)?.nodeId));
  const mapping = parseJsonObject(node.runInputToColumn, {});
  const promptNode = prompt ? ctx.nodeLookup.get(prompt.nodeId) : null;
  const promptInputs = promptNode && typeof options.extractInputFields === 'function'
    ? safeArray(options.extractInputFields(safeArray(promptNode.sections))).map(String)
    : [];
  const inputRowCount = safeArray(input.rows).length || datasetContentOf(dataset).rows.length;
  const errorCount = results.filter((r) => r?.error).length;
  const doneInputRows = new Set(results.map((r) => r?.input_row_index).filter((i) => typeof i === 'number')).size;
  const preview = rowWindow(results, options, 3);
  const diagnostics = [];
  if (!prompt) diagnostics.push('The run is not connected to a prompt.');
  if (!dataset) diagnostics.push('The run has no input dataset.');
  const unmapped = promptInputs.filter((name) => !String(mapping[name] || '').trim());
  if (unmapped.length) diagnostics.push(`Prompt inputs without a column: ${unmapped.join(', ')}.`);
  return {
    details: {
      prompt,
      inputDataset: linkedNode(dataset),
      inputMapping: mapping,
      model: credentialLabel(node.runCredentialId, options),
      status: runStatus(node, results, inputRowCount),
      progressPercent: Number(node.runProgress) || (node.runCompleted ? 100 : 0),
      inputRows: inputRowCount,
      inputRowsDone: doneInputRows,
      resultRows: results.length,
      errorRows: errorCount,
      savedAsDatasets: savedFromNode(ctx.canvasState, ctx.nodeId).map(({ dataset }) => linkedNode(dataset)),
      preview: preview.items.map((r) => ({
        inputRow: typeof r?.input_row_index === 'number' ? r.input_row_index + 1 : null,
        output: r?.output ?? null,
        error: r?.error ? String(r.error) : undefined,
      })),
    },
    diagnostics,
  };
}

const DEFAULT_MATCH_FLAGS = {
  semanticAlign: false,
  embeddingSimilarity: false,
  rxnormMatch: false,
  meshMatch: false,
  contains: false,
  ignoreCase: false,
  ignoreSymbols: false,
  ignoreWhitespace: false,
  numericMode: 'exact',
};

function flattenRules(group) {
  if (!group || typeof group !== 'object') return [];
  if (group.type === 'rule') return [group];
  return safeArray(group.children).flatMap(flattenRules);
}

function describeMatch(rule) {
  const flags = { ...DEFAULT_MATCH_FLAGS, ...(rule?.matchFlags || {}) };
  const parts = Object.entries(DEFAULT_MATCH_FLAGS)
    .filter(([key, value]) => key !== 'numericMode' && flags[key] !== value)
    .map(([key]) => key);
  if (flags.numericMode === 'abs') parts.push(`numeric within ${flags.numericAbsEpsilon}`);
  else if (flags.numericMode === 'rel') parts.push(`numeric within ${flags.numericRelEpsilon} relative`);
  else if (flags.numericMode === 'decimals') parts.push(`numeric to ${flags.numericDecimalPlaces} decimals`);
  return parts.length ? parts.join(', ') : 'exact';
}

/** Score rules as {pairing, comparison} lists: pairing rules match Run rows to ground-truth rows,
 * comparison rules judge the outputs. Accepts the v2 {input, output} bundle getCanvasState saves. */
function describeScoreRules(scoreMapping) {
  const bundle = parseJsonObject(scoreMapping, {});
  const side = (group) => ({
    combinedWith: safeArray(group?.ops).length ? [...new Set(group.ops)].join('/') : undefined,
    rules: flattenRules(group).map((rule) => ({
      field: String(rule.outputKey || ''),
      groundTruthColumns: safeArray(rule.gtColumns).map(String),
      match: describeMatch(rule),
    })),
  });
  const pairing = side(bundle.input || bundle.inputRoot);
  const comparison = side(bundle.output || bundle.outputRoot);
  return { pairing, comparison, count: pairing.rules.length + comparison.rules.length };
}

function summarizeComparisonRow(row, index) {
  return {
    row: index + 1,
    inputRow: typeof row?.input_row_index === 'number' ? row.input_row_index + 1 : null,
    matched: row?.matched === true,
    gtOnly: row?.gt_only === true || undefined,
    output: row?.run_output ?? null,
    expected: row?.expected ?? row?.ground_truth_output ?? null,
    gtRow: typeof row?.source_gt_row_index === 'number' ? row.source_gt_row_index + 1 : null,
  };
}

function basicScoreMetrics(rows) {
  if (!rows.length) return null;
  const matched = rows.filter((r) => r?.matched === true).length;
  return mergeScoreMetricsWithPrf({
    totalRows: rows.length,
    matchedRows: matched,
    unmatchedRows: rows.length - matched,
    gtOnlyRows: rows.filter((r) => r?.gt_only === true).length,
    passRate: Number((matched / rows.length).toFixed(4)),
  }, rows);
}

function inspectScore(node, ctx) {
  const reviewResult = parseJsonObject(node.reviewResult, {});
  const comparisonRows = safeArray(reviewResult.comparison_rows);
  const run = upstreamOfType(ctx.canvasState, ctx.nodeLookup, ctx.nodeId, 'run');
  const groundTruth = ctx.nodeLookup.get(normalizeNodeId(node.scoreGroundTruthId));
  const rules = describeScoreRules(node.scoreMapping);
  const ruleCount = rules.count;
  const usesCode = node.scoreActiveMatchMode === 'code';
  const diagnostics = [];
  if (!run) diagnostics.push('The score is not connected to a run.');
  if (!groundTruth) diagnostics.push('The score has no ground-truth dataset.');
  if (!usesCode && ruleCount === 0) diagnostics.push('The score has no mapping rules.');
  return {
    details: {
      run,
      groundTruth: linkedNode(groundTruth),
      matching: usesCode ? 'custom match code' : `${ruleCount} mapping rule${ruleCount === 1 ? '' : 's'}`,
      rules: usesCode ? undefined : { pairing: rules.pairing, comparison: rules.comparison },
      matchCode: usesCode ? String(node.scoreMatchCode || '') : undefined,
      executionStatus: usesCode && node.scoreMatchInterrupted === true ? 'interrupted; ready to resume' : undefined,
      reviewMethod: node.reviewMethod || 'default',
      excludedRows: node.scoreRowExcludedFromScoring ?? undefined,
      metrics: basicScoreMetrics(comparisonRows),
      comparisonRows: comparisonRows.length,
    },
    diagnostics,
  };
}

function summarizeSuggestion(raw, reviewResult) {
  const id = String(raw?.suggestion_id ?? '').trim();
  const verify = id ? reviewResult?.verify_results?.[id] : null;
  const out = {
    id,
    name: String(raw?.name || ''),
    targetSection: String(raw?.target_section || ''),
    oldSentence: String(raw?.old_sentence || ''),
    newSentence: String(raw?.new_sentence || ''),
    reason: String(raw?.reason || ''),
    applied: raw?.applied === true,
    verifyState: String(reviewResult?.verify_states?.[id] || 'not verified'),
  };
  if (verify && typeof verify === 'object' && verify.status === 'complete') {
    const rows = safeArray(verify.verifyRows);
    const matched = Number.isFinite(Number(verify.matchedCount))
      ? Number(verify.matchedCount)
      : rows.filter((r) => r?.matched === true && !r?.error).length;
    out.verification = { matched, total: Number(verify.total) || rows.length };
  }
  return out;
}

function inspectReview(node, ctx) {
  const reviewResult = parseJsonObject(node.reviewResult, {});
  const score = upstreamOfType(ctx.canvasState, ctx.nodeLookup, ctx.nodeId, 'score');
  const suggestions = safeArray(reviewResult.suggestions);
  const diagnostics = [];
  if (!score) diagnostics.push('The review is not connected to a score.');
  if (!suggestions.length && !reviewResult.summary && node.reviewPending !== true) diagnostics.push('The review has no result yet.');
  return {
    details: {
      score,
      status: node.reviewPending === true ? `running (${Number(node.reviewProgress) || 0}%)`
        : node.reviewInterrupted === true || reviewResult.streamComplete === false ? 'interrupted; ready to resume'
          : (suggestions.length || reviewResult.summary ? 'finished' : 'not run yet'),
      summary: String(reviewResult.summary || ''),
      suggestions: suggestions.map((s) => summarizeSuggestion(s, reviewResult)),
      createdPromptVersions: neighbors(ctx.canvasState, ctx.nodeLookup, ctx.nodeId, 'downstream')
        .filter((n) => n.type === 'prompt'),
    },
    diagnostics,
  };
}

const INSPECTORS = {
  prompt: inspectPrompt,
  dataset: inspectDataset,
  sampler: inspectSampler,
  process: inspectProcess,
  run: inspectRun,
  score: inspectScore,
  promptReview: inspectReview,
};

/**
 * @param {object} canvasState getCanvasState() output
 * @param {string} nodeId
 * @param {{extractInputFields?: Function, credentialsById?: Map, defaultRunCredential?: object,
 *   startRow?: number, maxRows?: number}} options
 */
export function inspectWorkflowNode(canvasState, nodeId, options = {}) {
  const id = normalizeNodeId(nodeId);
  const nodeLookup = buildNodeLookup(canvasState);
  const node = nodeLookup.get(id);
  if (!node) return { found: false, nodeId: id, error: 'No node with this id is on the canvas.' };
  const ctx = { canvasState, nodeLookup, nodeId: id };
  const inspector = INSPECTORS[node.type];
  const { details, diagnostics } = inspector ? inspector(node, ctx, options) : { details: {}, diagnostics: [] };
  return {
    found: true,
    nodeId: id,
    type: String(node.type || ''),
    title: nodeTitle(node),
    createdByAgent: node.nodeOrigin === 'agent' || undefined,
    upstream: neighbors(canvasState, nodeLookup, id, 'upstream'),
    downstream: neighbors(canvasState, nodeLookup, id, 'downstream'),
    details,
    diagnostics,
  };
}

/** Replace a score inspection's metrics with those from live comparison rows (see workflowCanvas). */
export function enrichInspectScoreResultWithComparisonRows(inspectResult, comparisonRows) {
  const rows = safeArray(comparisonRows);
  if (!inspectResult?.found || !inspectResult.details || rows.length === 0) return inspectResult;
  inspectResult.details.metrics = buildFullScoreMetricsFromComparisonRows(rows);
  inspectResult.details.comparisonRows = rows.length;
  inspectResult.diagnostics = safeArray(inspectResult.diagnostics);
  return inspectResult;
}

/**
 * Page through one node's rows.
 * @param {{startRow?: number, maxRows?: number, columns?: string[], branch?: string,
 *   onlyUnmatched?: boolean, comparisonRows?: object[]}} options comparisonRows supplies live score
 *   rows when the saved ones are missing.
 */
export function readNodeRows(canvasState, nodeId, options = {}) {
  const id = normalizeNodeId(nodeId);
  const node = buildNodeLookup(canvasState).get(id);
  if (!node) return { error: 'No node with this id is on the canvas.' };
  const columns = safeArray(options.columns).map(String).filter(Boolean);
  const pick = columns.length ? columns : null;

  if (node.type === 'dataset') {
    const content = datasetContentOf(node);
    const w = rowWindow(content.rows, options);
    return {
      title: nodeTitle(node),
      columns: columnsOf(content).filter((c) => !pick || pick.includes(c.name)),
      rows: w.items.map((row, i) => ({ row: w.startIndex + i + 1, ...rowObject(content.headers, row, pick) })),
      ...w.window,
    };
  }

  if (node.type === 'run') {
    const results = runResultsOf(node);
    const input = runInputContentOf(node);
    const headers = safeArray(input.headers).map(String);
    const w = rowWindow(results, options);
    return {
      title: nodeTitle(node),
      rows: w.items.map((r, i) => {
        const inputRowIndex = typeof r?.input_row_index === 'number' ? r.input_row_index : null;
        const inputRow = safeArray(r?.input_row).length ? r.input_row : safeArray(input.rows)[inputRowIndex];
        return {
          result: w.startIndex + i + 1,
          inputRow: inputRowIndex == null ? null : inputRowIndex + 1,
          input: headers.length && inputRow ? rowObject(headers, inputRow, pick) : undefined,
          output: r?.output ?? null,
          error: r?.error ? String(r.error) : undefined,
        };
      }),
      ...w.window,
    };
  }

  if (node.type === 'process') {
    const outputs = processOutputsOf(node);
    const names = Object.keys(outputs);
    if (!names.length) return { title: nodeTitle(node), error: 'The process has no saved output. It has to be run from its detail view first.' };
    const branch = options.branch && outputs[options.branch] ? options.branch : names[0];
    const content = normalizeDatasetContent(outputs[branch]);
    const w = rowWindow(content.rows, options);
    return {
      title: nodeTitle(node),
      branch,
      branches: names,
      columns: content.headers.filter((h) => !pick || pick.includes(h)),
      rows: w.items.map((row, i) => ({ row: w.startIndex + i + 1, ...rowObject(content.headers, row, pick) })),
      ...w.window,
    };
  }

  if (node.type === 'score') {
    const saved = safeArray(parseJsonObject(node.reviewResult, {}).comparison_rows);
    const all = (saved.length ? saved : safeArray(options.comparisonRows)).map(summarizeComparisonRow);
    const rows = options.onlyUnmatched ? all.filter((r) => !r.matched) : all;
    const w = rowWindow(rows, options);
    return {
      title: nodeTitle(node),
      filter: options.onlyUnmatched ? 'unmatched only' : 'all rows',
      rows: w.items,
      ...w.window,
    };
  }

  return { title: nodeTitle(node), error: `A ${node.type} node has no rows to read. Use inspect_node instead.` };
}

/**
 * Follow one input row of a Run: its input values, every result produced for it, and how each
 * downstream Score judged it.
 * @param {Map<string, object[]>} comparisonRowsByScoreId live comparison rows per score id
 */
export function traceRunRow(canvasState, runNodeId, inputRow, comparisonRowsByScoreId = new Map()) {
  const id = normalizeNodeId(runNodeId);
  const lookup = buildNodeLookup(canvasState);
  const node = lookup.get(id);
  if (!node || node.type !== 'run') return { error: 'trace_row needs the id of a Run node.' };
  const index = normalizePositiveInteger(inputRow, 0) - 1;
  if (index < 0) return { error: 'input_row must be a 1-based row number.' };
  const input = runInputContentOf(node);
  const headers = safeArray(input.headers).map(String);
  const inputValues = safeArray(input.rows)[index];
  const results = runResultsOf(node).filter((r) => r?.input_row_index === index);
  const scores = safeArray(canvasState?.connections)
    .filter((c) => c?.type === 'run-to-score' && normalizeNodeId(c.fromId) === id)
    .map((c) => lookup.get(normalizeNodeId(c.toId)))
    .filter(Boolean)
    .map((score) => {
      const saved = safeArray(parseJsonObject(score.reviewResult, {}).comparison_rows);
      const rows = saved.length ? saved : safeArray(comparisonRowsByScoreId.get(normalizeNodeId(score.nodeId)));
      return {
        score: linkedNode(score),
        comparisons: rows
          .map(summarizeComparisonRow)
          .filter((r) => r.inputRow === index + 1),
      };
    });
  return {
    run: linkedNode(node),
    inputRow: index + 1,
    input: inputValues ? rowObject(headers, inputValues) : null,
    results: results.map((r) => ({ output: r?.output ?? null, error: r?.error ? String(r.error) : undefined })),
    scores,
    note: inputValues ? undefined : 'This input row does not exist in the run input.',
  };
}
