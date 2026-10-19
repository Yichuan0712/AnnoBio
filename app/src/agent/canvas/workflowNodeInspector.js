/**
 * Agent-facing views of canvas nodes, built from getCanvasState() output. Pure functions: no DOM.
 * inspectWorkflowNode gives one node's full configuration plus a short preview; readNodeRows pages
 * through a node's table (dataset rows, run results, process outputs, score comparisons).
 */
import { generateDisplayName, nodeTypeLabel } from '../../nodeLabels.js';
import { buildFullScoreMetricsFromComparisonRows, mergeScoreMetricsWithPrf } from './scoreComparisonPrf.js';
import { cloneCell, displayCell, isAssetCell, normalizeDatasetContent } from '../../datasetContent.js';
import { sampledOutputs, samplerQuota } from '../../samplerQuota.js';
import { contentLocks } from '../../contentLocks.js';
import { effectiveProcessOutputs } from '../../processOutputPorts.js';
import { nodePorts, unconnectedProcessInputs } from '../../nodePorts.js';
import {
  processInputBindings, processInputSources, processPrimarySource, processRequiredInputs, runInputSource, stepInputWaitingMessage,
} from '../../stepInputs.js';
import { stepOutputTable } from '../../stepOutputs.js';
import { readSavedFrom } from '../../savedDatasets.js';
import { parseScoreMappingBundle } from '../../scoreMappingBundle.js';
import { DEFAULT_MATCH_FLAGS } from '../../scoreMatchPrimitives.js';
import { suggestionTargetScoreRowIndices } from '../../reviewWorkingText.js';
import { hasNodeExecution } from '../../nodeExecutionControl.js';

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
    case 'run': return generateDisplayName(node.runName);
    case 'score': return String(node.scoreName || 'Evaluate');
    case 'promptReview': return String(node.promptReviewName || 'Optimize');
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

/** The Datasets saved from a Generate or Process, with the `savedFrom` each records. */
function savedFromNode(canvasState, nodeId) {
  return safeArray(canvasState?.nodes)
    .map((dataset) => ({ dataset, savedFrom: dataset?.type === 'dataset' ? readSavedFrom(dataset.savedFrom) : null }))
    .filter(({ savedFrom }) => savedFrom && normalizeNodeId(savedFrom.nodeId) === nodeId);
}

function linkedNode(node) {
  return node ? { nodeId: normalizeNodeId(node.nodeId), type: String(node.type || ''), title: nodeTitle(node) } : null;
}

/** A source a step reads (stepInputs.js): its node, plus the branch when it is a Process's. */
function linkedSource(nodeLookup, source) {
  const node = source?.nodeId ? nodeLookup.get(normalizeNodeId(source.nodeId)) : null;
  if (!node) return null;
  return { ...linkedNode(node), ...(node.type === 'process' ? { branch: String(source.port || 'result') } : {}) };
}

/** Why a step cannot run yet because of its inputs (as its window says), or null. */
function waitingFor(canvasState, sources) {
  for (const source of sources) {
    const { waiting } = stepOutputTable(canvasState, source);
    if (waiting && source.kind !== 'dataset') return stepInputWaitingMessage(canvasState, source, waiting);
  }
  return null;
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
    const value = safeArray(row)[i];
    out[header] = isAssetCell(value) ? cloneCell(value) : displayCell(value);
  });
  return out;
}

function columnsOf(content) {
  return content.headers.map((name, i) => ({ name, type: content.columnTypes?.[i] || 'text' }));
}

const SAVED_FROM_KINDS = { run: 'saved run results', process: 'saved process output', score: 'saved evaluation comparison', pipeline: 'pipeline run result' };

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
    ? `default Generate credential (${[fallback.provider, fallback.model].filter(Boolean).join(' / ')})`
    : 'default Generate credential (none set)';
}

function inspectPrompt(node, ctx, options) {
  const text = String(node.text || '');
  const inputFields = typeof options.extractInputFields === 'function'
    ? safeArray(options.extractInputFields(text)).map(String)
    : [];
  const outputFormat = node.outputFormat && typeof node.outputFormat === 'object'
    ? node.outputFormat
    : { returnShape: 'single', fields: [] };
  const diagnostics = [];
  if (!text.trim()) diagnostics.push('The prompt has no text.');
  if (!safeArray(outputFormat.fields).length) diagnostics.push('The prompt has no output fields, so it cannot be exported.');
  return {
    details: {
      note: String(node.note || ''),
      text,
      // An input has no type: it sends what its mapped column holds (an image or PDF column sends its files).
      inputs: inputFields,
      output: {
        returnShape: outputFormat.returnShape || 'single',
        fields: safeArray(outputFormat.fields).map((f) => ({
          key: f.key, type: f.type || 'str', description: f.description || '', examples: safeArray(f.examples),
          allowNone: f.allowNone === true,
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
  const outputs = sampledOutputs(ctx.canvasState, node.nodeId);
  const finite = (node.samplingType || 'without-replacement') === 'without-replacement';
  const quota = finite ? samplerQuota(datasetContentOf(source), outputs, node.sampleSizeType || 'ratio', node.sampleSize ?? 100) : null;
  const remaining = quota ? Math.max(0, Math.min(quota.total - quota.completed, quota.count ? Math.floor(quota.availableIndices.length / quota.count) : 0)) : null;
  const diagnostics = source ? [] : ['The Sample has no source Dataset.'];
  if (source && quota && !quota.count) diagnostics.push('Sample size selects no rows from this Dataset.');
  else if (source && quota && remaining === 0) diagnostics.push('Not enough remaining data to create a new dataset when sampling without replacement.');
  return {
    details: {
      note: String(node.note || ''),
      source: linkedNode(source),
      samplingType: String(node.samplingType || 'without-replacement'),
      sampleSizeType: node.sampleSizeType ?? null,
      sampleSize: node.sampleSize ?? null,
      rowSpec: node.rowSpec ?? null,
      settingsLocked: outputs.length > 0,
      outputs: outputs.map((output) => linkedNode(ctx.nodeLookup.get(output.nodeId))),
      progress: quota ? { completed: quota.completed, total: quota.total, remaining, rowsPerSample: quota.count, remainingRows: quota.availableIndices.length } : null,
      canCreateSample: Boolean(source && datasetContentOf(source).headers.length && (!quota || remaining > 0)),
    },
    diagnostics,
  };
}

function inspectProcess(node, ctx) {
  const code = String(node.dfCode || '');
  const inputs = processInputSources(ctx.canvasState, ctx.nodeId)
    .map((source) => ({ ...linkedSource(ctx.nodeLookup, source), alias: source.alias || null }))
    .filter((input) => input.nodeId);
  const primary = linkedSource(ctx.nodeLookup, processPrimarySource(ctx.canvasState, ctx.nodeId));
  const outputs = processOutputsOf(node);
  const ports = effectiveProcessOutputs({ detected: node.processOutputPorts, dfResults: node.dfResults });
  const savedDatasets = savedFromNode(ctx.canvasState, ctx.nodeId)
    .map(({ dataset, savedFrom }) => ({ ...linkedNode(dataset), branch: savedFrom.port }));
  const diagnostics = [];
  if (!/^\s*def\s+process\s*\(\s*df\b/m.test(code)) diagnostics.push('The code does not define process(df).');
  if (!primary) diagnostics.push('The process has no df input.');
  // Parameters of the code with nothing connected: empty ports on the canvas; it cannot run until they are.
  const unconnected = unconnectedProcessInputs(ctx.canvasState, ctx.nodeId, code);
  if (unconnected.length) diagnostics.push(`Not connected: ${unconnected.join(', ')}. The process cannot run until an input is connected to each.`);
  if (!Object.keys(outputs).length) diagnostics.push('The process has not been run yet, or its last run returned nothing.');
  if (ports.mismatch) diagnostics.push('Its last run returned branches its code was not detected to return.');
  const waiting = primary ? waitingFor(ctx.canvasState, processRequiredInputs(ctx.canvasState, ctx.nodeId, { code }).bindings) : null;
  return {
    details: {
      code,
      primaryInput: primary,
      inputs,
      unconnectedInputs: unconnected,
      // Every Dataset and step output the code could read, under the alias it has in process(df, ...).
      availableInputs: processInputBindings(ctx.canvasState, ctx.nodeId, { code })
        .map((binding) => ({ ...linkedSource(ctx.nodeLookup, binding), alias: binding.alias, isInput: binding.input })),
      branches: {
        names: ports.ports,
        known: ports.source !== 'none',
        dynamic: ports.dynamic,
        from: ports.source === 'run' ? 'last run' : ports.source === 'code' ? 'code' : 'not known yet',
      },
      readBy: readersOf(ctx),
      outputs: Object.entries(outputs).map(([name, branch]) => ({
        branch: name,
        rowCount: branch.rows.length,
        columns: branch.headers.map(String),
      })),
      status: node.processPending === true ? 'running'
        : node.processResumable === true ? 'interrupted; ready to resume'
          : Object.keys(outputs).length ? 'completed' : 'not run yet',
      waitingFor: waiting,
      needsUpdate: node.historyStaleRecordId ? 'Its inputs changed since its last run; that result is in its History. Run it (or run_to a later step) to update.' : null,
      savedAsDatasets: savedDatasets,
    },
    diagnostics,
  };
}

/** The steps reading a Generate or Process, with the branch and alias each reads under. */
function readersOf(ctx) {
  return safeArray(ctx.canvasState?.connections)
    .filter((edge) => edge?.type === 'data' && normalizeNodeId(edge.fromId) === ctx.nodeId)
    .map((edge) => ({ ...linkedNode(ctx.nodeLookup.get(normalizeNodeId(edge.toId))), branch: String(edge.fromPort || 'result'), alias: edge.alias || null }))
    .filter((reader) => reader.nodeId);
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
  const source = runInputSource(ctx.canvasState, ctx.nodeId);
  const inputSource = linkedSource(ctx.nodeLookup, source);
  const mapping = parseJsonObject(node.runInputToColumn, {});
  const promptNode = prompt ? ctx.nodeLookup.get(prompt.nodeId) : null;
  const promptInputs = promptNode && typeof options.extractInputFields === 'function'
    ? safeArray(options.extractInputFields(String(promptNode.text || ''))).map(String)
    : [];
  const inputRowCount = safeArray(input.rows).length || safeArray(stepOutputTable(ctx.canvasState, source).table?.rows).length;
  const errorCount = results.filter((r) => r?.error).length;
  const doneInputRows = new Set(results.map((r) => r?.input_row_index).filter((i) => typeof i === 'number')).size;
  const preview = rowWindow(results, options, 3);
  const diagnostics = [];
  if (!prompt) diagnostics.push('The run is not connected to a prompt.');
  if (!inputSource) diagnostics.push('The run has no input.');
  const unmapped = promptInputs.filter((name) => !String(mapping[name] || '').trim());
  if (unmapped.length) diagnostics.push(`Prompt inputs without a column: ${unmapped.join(', ')}.`);
  return {
    details: {
      prompt,
      input: inputSource,
      inputMapping: mapping,
      model: credentialLabel(node.runCredentialId, options),
      status: runStatus(node, results, inputRowCount),
      progressPercent: Number(node.runProgress) || (node.runCompleted ? 100 : 0),
      inputRows: inputRowCount,
      inputRowsDone: doneInputRows,
      resultRows: results.length,
      errorRows: errorCount,
      waitingFor: source ? waitingFor(ctx.canvasState, [source]) : null,
      needsUpdate: node.historyStaleRecordId ? 'Its inputs changed since its last run; that result is in its History. Run it (or run_to a later step) to update.' : null,
      readBy: readersOf(ctx),
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

/** Score rules as {pairing, comparison} lists: pairing rules match model output rows to ground-truth rows,
 * comparison rules judge the outputs. Accepts the v2 {input, output} bundle getCanvasState saves. */
function describeScoreRules(scoreMapping) {
  const { inputRoot, outputRoot } = parseScoreMappingBundle(scoreMapping);
  const bundle = { input: inputRoot, output: outputRoot };
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
  return { pairing, comparison, count: pairing.rules.length + comparison.rules.length,
    ruleTree: { v: 2, input: inputRoot, output: outputRoot } };
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
    rowKey: Number.isInteger(row?.source_gt_row_index) && row.source_gt_row_index >= 0 ? String(row.source_gt_row_index)
      : Number.isInteger(row?.row_index) && !row.gt_only ? `run:${row.row_index}` : null,
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
  if (!run) diagnostics.push('The Evaluate node is not connected to a Generate.');
  if (!groundTruth) diagnostics.push('The Evaluate node has no ground-truth dataset.');
  if (!usesCode && ruleCount === 0) diagnostics.push('The Evaluate node has no mapping rules.');
  return {
    details: {
      run,
      groundTruth: linkedNode(groundTruth),
      matching: usesCode ? 'custom match code' : `${ruleCount} mapping rule${ruleCount === 1 ? '' : 's'}`,
      resultsFromEarlierSetup: !!node.historyStaleRecordId,
      evaluationRecordId: node.historyRecordId || null,
      rules: usesCode ? undefined : { pairing: rules.pairing, comparison: rules.comparison, ruleTree: rules.ruleTree },
      matchCode: usesCode ? String(node.scoreMatchCode || '') : undefined,
      executionStatus: node.scoreMatchPending === true ? 'running'
        : usesCode && node.scoreMatchInterrupted === true ? 'interrupted; ready to resume' : undefined,
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
    oldSentence: String(raw?.old_sentence || ''),
    newSentence: String(raw?.new_sentence || ''),
    reason: String(raw?.reason || ''),
    applied: raw?.applied === true,
    verifyState: String(reviewResult?.verify_states?.[id] || 'not verified'),
    targetRows: suggestionTargetScoreRowIndices(raw),
    optimization: raw.review_optimization_meta || undefined,
    optimizedFromSuggestionId: raw.optimized_from_suggestion_id ?? undefined,
  };
  if (verify && typeof verify === 'object' && verify.status === 'complete') {
    const rows = safeArray(verify.verifyRows);
    const matched = Number.isFinite(Number(verify.matchedCount))
      ? Number(verify.matchedCount)
      : rows.filter((r) => r?.matched === true && !r?.error).length;
    out.verification = { matched, total: Number(verify.total) || rows.length };
  }
  if (verify?.status === 'error') out.verificationError = String(verify.message || 'Verification failed.');
  return out;
}

function inspectReview(node, ctx, options = {}) {
  const reviewResult = parseJsonObject(node.reviewResult, {});
  const score = upstreamOfType(ctx.canvasState, ctx.nodeLookup, ctx.nodeId, 'score');
  const suggestions = safeArray(reviewResult.suggestions);
  const diagnostics = [];
  const page = (items) => { const window = rowWindow(items, options, 5); return { rows: window.items, ...window.window }; };
  const suggestionPage = rowWindow(suggestions, options, 10);
  const verification = options.section === 'verification' ? reviewResult.verify_results?.[options.suggestionId] : null;
  if (options.section === 'verification' && !verification) diagnostics.push('No verification result for that suggestion_id.');
  if (!score) diagnostics.push('The Optimize is not connected to an Evaluate node.');
  if (ctx.canvasState.historyVersion === 1 && !node.evaluateRecordId) diagnostics.push('This legacy Optimize has no fixed evaluation snapshot. Run Evaluate and create a new Optimize before Verify or Resume.');
  if (!suggestions.length && !reviewResult.summary && node.reviewPending !== true) diagnostics.push('The review has no result yet.');
  return {
    details: {
      score,
      evaluationRecordId: node.evaluateRecordId || null,
      sourceIsEarlierEvaluation: node.reviewSourceEarlier === true,
      status: node.reviewPending === true ? `running (${Number(node.reviewProgress) || 0}%)`
        : node.reviewInterrupted === true || reviewResult.streamComplete === false ? 'interrupted; ready to resume'
          : (reviewResult.streamComplete === true || suggestions.length || reviewResult.summary ? 'finished' : 'not run yet'),
      summary: String(reviewResult.summary || ''),
      method: node.reviewMethodId || reviewResult.review_method_id || 'default',
      streamComplete: reviewResult.streamComplete === true,
      supportsSuggestionOptimization: reviewResult.supports_segment_optimization !== false,
      suggestionOptimizationRunning: hasNodeExecution(node.nodeId),
      rowDiagnostics: page(safeArray(reviewResult.row_diagnostics)),
      dataRefinement: page(safeArray(reviewResult.data_refinement)),
      stages: page(safeArray(reviewResult.stage_log)),
      ...(verification ? { verification: { ...verification, verifyRows: page(safeArray(verification.verifyRows)) } } : {}),
      suggestions: suggestionPage.items.map((s) => summarizeSuggestion(s, reviewResult)),
      suggestionCount: suggestions.length,
      verifiedSuggestionCount: suggestions.filter((s) => reviewResult.verify_states?.[s.suggestion_id] === 'verified').length,
      suggestionsWindow: suggestionPage.window,
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
  if (node.type === 'promptReview' && options.section && options.section !== 'overview') {
    const sectionKey = { diagnostics: 'rowDiagnostics', data_refinement: 'dataRefinement', stages: 'stages',
      suggestions: 'suggestions', verification: 'verification' }[options.section];
    if (!sectionKey) diagnostics.push('Unknown Optimize section.');
    else for (const key of ['rowDiagnostics', 'dataRefinement', 'stages', 'suggestions', 'verification']) {
      if (key !== sectionKey) delete details[key];
    }
  }
  // The dots on the node's edges, as the user sees and drags them (nodePorts.js); connect and disconnect use these ids.
  const ports = nodePorts(canvasState, id);
  const lockedBy = (options.contentLocks || contentLocks([], canvasState)).get(id) || [];
  return {
    found: true,
    nodeId: id,
    type: String(node.type || ''),
    title: nodeTitle(node),
    createdByAgent: node.nodeOrigin === 'agent' || undefined,
    ...(['prompt', 'dataset'].includes(node.type) ? { contentLock: {
      locked: lockedBy.length > 0,
      usedBy: lockedBy.map((otherId) => linkedNode(nodeLookup.get(otherId))).filter(Boolean),
      editableFields: lockedBy.length ? ['name', 'note'] : null,
    } } : {}),
    upstream: neighbors(canvasState, nodeLookup, id, 'upstream'),
    downstream: neighbors(canvasState, nodeLookup, id, 'downstream'),
    ports: ports && {
      inputs: ports.inputs.map((input) => ({
        id: input.id, source: input.source ? linkedSource(nodeLookup, input.source) : null, ...(input.fixed ? { fixed: input.fixed } : {}),
      })),
      outputs: ports.outputs.map((output) => ({
        id: output.id, readBy: output.readers, ...(output.unavailable ? { unavailable: output.unavailable } : {}),
      })),
    },
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
      rowIds: content.rowIds.slice(w.startIndex, w.startIndex + w.items.length),
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
    if (!names.length) return { title: nodeTitle(node), error: 'The Process has no saved output. Run it with run_nodes (kind: process) or from its detail view first.' };
    if (options.branch && !outputs[options.branch]) return { title: nodeTitle(node), error: `Unknown Process output "${options.branch}". Branches: ${names.join(', ')}.` };
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
    const all = (Array.isArray(options.comparisonRows) ? options.comparisonRows : saved).map(summarizeComparisonRow);
    const rows = options.onlyUnmatched ? all.filter((r) => !r.matched) : all;
    const w = rowWindow(rows, options);
    return {
      title: nodeTitle(node),
      filter: options.onlyUnmatched ? 'unmatched only' : 'all rows',
      resultsFromEarlierSetup: !!node.historyStaleRecordId,
      rows: w.items,
      ...w.window,
    };
  }

  return { title: nodeTitle(node), error: `A ${nodeTypeLabel(node.type)} node has no rows to read. Use inspect_node instead.` };
}

/**
 * Follow one input row of a Generate: its input values, every result produced for it, and how each
 * downstream Score judged it.
 * @param {Map<string, object[]>} comparisonRowsByScoreId live comparison rows per score id
 */
export function traceRunRow(canvasState, runNodeId, inputRow, comparisonRowsByScoreId = new Map()) {
  const id = normalizeNodeId(runNodeId);
  const lookup = buildNodeLookup(canvasState);
  const node = lookup.get(id);
  if (!node || node.type !== 'run') return { error: 'trace_row needs the id of a Generate node.' };
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
      const rows = comparisonRowsByScoreId.has(normalizeNodeId(score.nodeId)) ? safeArray(comparisonRowsByScoreId.get(normalizeNodeId(score.nodeId))) : saved;
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
