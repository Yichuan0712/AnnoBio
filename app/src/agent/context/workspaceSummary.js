/**
 * Compact plain-text description of the canvas for the Agent's system prompt: pipelines as the
 * Current Pipeline panel shows them (Generate and Process data steps, pickers, branches; the
 * panel's choices when mounted, otherwise the defaults), then every node with the few
 * facts needed to decide what to inspect next. Details (prompt text, code, rows) are left to the
 * read tools.
 */
import { nodeTypeLabel } from '../../nodeLabels.js';
import { detectPipelines } from '../../pipelineDetection.js';
import { buildSelectedRoute, getVisibleRoute } from '../../pipelineRouteSelection.js';
import { processInputSources, runInputSource, stepSourceLabel } from '../../stepInputs.js';
import { readSavedFrom } from '../../savedDatasets.js';
import { buildPromptFamilies } from '../../promptOptimization.js';
import { formatScoreMetrics } from '../canvas/scoreComparisonPrf.js';
import {
  buildNodeLookup,
  datasetContentOf,
  inspectWorkflowNode,
  nodeTitle,
  processOutputsOf,
} from '../canvas/workflowNodeInspector.js';

function quote(text) {
  return `"${String(text ?? '').replace(/"/g, "'")}"`;
}

function ref(node) {
  return `${quote(nodeTitle(node))} [${node.nodeId}]`;
}

/** A node the inspector returned as {nodeId, title}. */
function linkRef(linked, missing) {
  return linked ? `${quote(linked.title)} [${linked.nodeId}]` : missing;
}

/** An input the inspector returned (linkedSource): a Dataset, or a step's output and its branch. */
function sourceRef(linked, missing) {
  if (!linked) return missing;
  if (linked.type === 'dataset') return linkRef(linked);
  const branch = linked.branch && linked.branch !== 'result' ? ` branch ${quote(linked.branch)}` : '';
  return `the output of ${nodeTypeLabel(linked.type)} ${linkRef(linked)}${branch}`;
}

const STEP_LABELS = { prompt: 'Generate', process: 'Process data' };

/** An input as the summary names it: a Dataset by its name, another step's output by that step. */
function describeInput(source, lookup, canvasState) {
  if (source.kind === 'dataset') return quote(nodeTitle(lookup.get(source.nodeId)) || source.nodeId);
  return `the output of ${quote(stepSourceLabel(canvasState, source))}`;
}

function describeRouteOption(option, lookup, canvasState) {
  if (option.kind === 'prompt') {
    const input = runInputSource(canvasState, option.runNodeId);
    return `${quote(option.promptName)} [${option.promptNodeId}] by Generate ${quote(option.runName)} [${option.runNodeId}]`
      + ` on ${input ? describeInput(input, lookup, canvasState) : '(no input)'}`;
  }
  const inputs = processInputSources(canvasState, option.processNodeId).map((source) => describeInput(source, lookup, canvasState)).join(' + ');
  return `${quote(option.label)} [${option.processNodeId}]${inputs ? ` reading ${inputs}` : ''}`;
}

/** One step as the Current Pipeline panel shows it: the default choice first, then the alternatives. */
function describeRouteStep(step, lookup, selectionSource, canvasState) {
  const options = [step.selectedOption, ...step.options.filter((option) => option.value !== step.selectedValue)];
  const label = STEP_LABELS[step.kind];
  if (options.length === 1) return `${label}: ${describeRouteOption(options[0], lookup, canvasState)}`;
  return `${label}, a picker with ${options.length} choices: `
    + options.map((option, i) => `${describeRouteOption(option, lookup, canvasState)}${i === 0 ? ` (${selectionSource === 'panel' ? 'selected' : 'default'})` : ''}`).join('; ');
}

function routeLines(route, lookup, indent, selectionSource, canvasState) {
  const lines = [];
  route.forEach((step, i) => {
    if (step.kind === 'empty') {
      lines.push(`${indent}${i + 1}. (nothing)`);
    } else if (step.kind === 'branch') {
      lines.push(`${indent}${i + 1}. Branches:`);
      step.lanes.forEach((lane, laneIndex) => {
        lines.push(`${indent}   Branch ${laneIndex + 1}:`);
        lines.push(...routeLines(lane, lookup, `${indent}     `, selectionSource, canvasState));
      });
    } else {
      lines.push(`${indent}${i + 1}. ${describeRouteStep(step, lookup, selectionSource, canvasState)}`);
    }
  });
  return lines;
}

function pipelineLines(canvasState, lookup, selections = []) {
  const pipelines = detectPipelines(canvasState);
  if (!pipelines.length) return ['No pipelines yet (a pipeline needs at least one Prompt with a Generate, or a Process).'];
  const lines = [];
  pipelines.forEach((pipeline, index) => {
    const selection = selections.find((item) => item.id === String(pipeline?.id || `pipeline-index-${index}`));
    const source = selection?.source === 'panel' ? 'panel' : 'default';
    lines.push(`Pipeline ${index + 1} [${String(pipeline?.id || `pipeline-index-${index}`)}] (${source === 'panel' ? 'current panel selection' : 'default route; Current Pipeline panel is not mounted'}):`);
    lines.push(...routeLines(getVisibleRoute(selection?.route || buildSelectedRoute(pipeline, new Map())), lookup, '  ', source, canvasState));
  });
  return lines;
}

function datasetLine(node, lookup) {
  const content = datasetContentOf(node);
  const columns = content.headers
    .map((h, i) => (content.columnTypes[i] && content.columnTypes[i] !== 'text' ? `${h} (${content.columnTypes[i]})` : h))
    .join(', ');
  // A saved Dataset is a plain table; savedFrom only says where it came from (savedDatasets.js).
  let source = '';
  const savedFrom = readSavedFrom(node.savedFrom);
  const from = savedFrom ? lookup.get(savedFrom.nodeId) : null;
  const sampler = node.samplerNodeId ? lookup.get(node.samplerNodeId) : null;
  if (savedFrom?.kind === 'pipeline') source = `; saved from Pipeline run ${savedFrom.pipelineRunId}`;
  else if (savedFrom && from) {
    source = savedFrom.kind === 'run' ? `; saved results of Generate ${quote(nodeTitle(from))}`
      : savedFrom.kind === 'process' ? `; saved output ${quote(savedFrom.port)} of process ${quote(nodeTitle(from))}`
        : `; saved comparison of Evaluate ${quote(nodeTitle(from))}`;
  } else if (savedFrom) source = `; saved from a ${nodeTypeLabel(savedFrom.kind)} no longer on the canvas`;
  else if (sampler) source = `; sampled by ${quote(nodeTitle(sampler))}`;
  return `- ${ref(node)}: ${content.rows.length} rows; columns: ${columns || '(none)'}${source}`;
}

function promptLine(node, lookup, versionsById, extractInputFields) {
  const inputTypes = node.inputTypes && typeof node.inputTypes === 'object' ? node.inputTypes : {};
  const inputs = typeof extractInputFields === 'function'
    ? extractInputFields(node.text || '').map((name) => (inputTypes[name] && inputTypes[name] !== 'text' ? `${name} (${inputTypes[name]})` : name))
    : [];
  const fields = (node.outputFormat?.fields || []).map((f) => f.key).filter(Boolean);
  const shape = node.outputFormat?.returnShape === 'table' ? 'table' : 'single';
  const link = versionsById.get(node.nodeId);
  const parent = link?.parentId ? lookup.get(link.parentId) : null;
  let version = '';
  if (parent && link.via === 'review') version = `; made by applying Optimize ${quote(link.reviewName)} of ${quote(nodeTitle(parent))}`;
  else if (parent) version = `; new version of ${quote(nodeTitle(parent))}`;
  return `- ${ref(node)}: inputs ${inputs.join(', ') || '(none)'}; outputs (${shape}) ${fields.join(', ') || '(none)'}${version}`;
}

function runLine(node, inspection) {
  const d = inspection.details;
  const prompt = linkRef(d.prompt, '(no prompt)');
  const input = sourceRef(d.input, '(no input)');
  const errors = d.errorRows ? `, ${d.errorRows} errors` : '';
  const waiting = d.waitingFor ? `; waiting: ${d.waitingFor}` : '';
  return `- ${ref(node)}: prompt ${prompt} on ${input}; model ${d.model}; ${d.status}, ${d.inputRowsDone}/${d.inputRows} input rows${errors}${waiting}`;
}

function processLine(node, inspection) {
  const d = inspection.details;
  const inputs = d.inputs.map((i) => `${sourceRef(i)}${i.alias ? ` as ${i.alias}` : ''}`).join(', ');
  const outputs = Object.entries(processOutputsOf(node))
    .map(([name, branch]) => `${name} (${branch.rows.length} rows)`)
    .join(', ');
  const branches = d.branches.dynamic ? '; branches are built at run time'
    : d.branches.names.length > 1 || (d.branches.names[0] && d.branches.names[0] !== 'result') ? `; branches ${d.branches.names.join(', ')}` : '';
  const waiting = d.waitingFor ? `; waiting: ${d.waitingFor}` : '';
  return `- ${ref(node)}: reads ${inputs || '(no inputs)'}${branches}; last output ${outputs || '(not run)'}${waiting}`;
}

function samplerLine(node, lookup, canvasState) {
  const source = lookup.get(node.sourceNodeId);
  const size = node.samplingType === 'specify-rows'
    ? `rows ${node.rowSpec || '(none)'}`
    : `${node.sampleSize ?? ''}${node.sampleSizeType === 'ratio' ? '%' : ' rows'}`;
  const { details } = inspectWorkflowNode(canvasState, node.nodeId);
  const mode = node.samplingType === 'specify-rows' ? 'specified rows'
    : node.samplingType === 'with-replacement' ? 'with replacement' : 'without replacement';
  const progress = details.progress
    ? `; ${details.progress.completed}/${details.progress.total} samples created, ${details.progress.remaining} remaining`
    : `; ${details.outputs.length} samples created, repeatable`;
  return `- ${ref(node)}: samples ${source ? quote(nodeTitle(source)) : '(no source)'}; ${mode}, ${size}${progress}${details.settingsLocked ? '; settings locked' : '; settings editable'}`;
}

function scoreLine(node, inspection) {
  const d = inspection.details;
  const metrics = d.metrics ? `; ${formatScoreMetrics(d.metrics)}` : '; not computed yet';
  return `- ${ref(node)}: Generate ${linkRef(d.run, '(none)')} vs ground truth ${linkRef(d.groundTruth, '(none)')}; ${d.matching}${metrics}`;
}

function reviewLine(node, inspection) {
  const d = inspection.details;
  const verified = d.verifiedSuggestionCount ?? d.suggestions.filter((s) => s.verifyState === 'verified').length;
  const count = d.suggestionCount ?? d.suggestions.length;
  const counts = count ? `; ${count} suggestions (${verified} verified)` : '';
  return `- ${ref(node)}: reviews Evaluate ${linkRef(d.score, '(none)')}; ${d.status}${counts}`;
}

const SECTION_ORDER = [
  ['dataset', 'Datasets'],
  ['sampler', 'Samplers'],
  ['process', 'Processes'],
  ['prompt', 'Prompts'],
  ['run', 'Generate nodes'],
  ['score', 'Evaluate nodes'],
  ['promptReview', 'Optimize nodes'],
];

/**
 * @param {object} canvasState getCanvasState() output
 * @param {{extractInputFields: Function, inspectNode: (id: string) => Promise<object>,
 *   credentialsById: Map, defaultRunCredential: object|null, selectedNodeIds?: string[]}} options
 *   inspectNode is the canvas's own (it adds live score metrics).
 */
export async function buildWorkspaceSummary(canvasState, options = {}) {
  const nodes = Array.isArray(canvasState?.nodes) ? canvasState.nodes : [];
  if (!nodes.length) return 'The canvas is empty.';
  const lookup = buildNodeLookup(canvasState);
  const inspectOptions = {
    extractInputFields: options.extractInputFields,
    credentialsById: options.credentialsById,
    defaultRunCredential: options.defaultRunCredential,
  };
  const inspect = async (node) => (node.type === 'score' && typeof options.inspectNode === 'function'
    ? options.inspectNode(node.nodeId)
    : inspectWorkflowNode(canvasState, node.nodeId, inspectOptions));

  const versionsById = new Map(buildPromptFamilies(canvasState)
    .flatMap((family) => family.versions.map((version) => [version.promptId, version])));
  const lines = ['Pipelines:', ...pipelineLines(canvasState, lookup, options.pipelineSelections), ''];
  for (const [type, heading] of SECTION_ORDER) {
    const group = nodes.filter((n) => n.type === type);
    if (!group.length) continue;
    lines.push(`${heading}:`);
    for (const node of group) {
      if (type === 'dataset') lines.push(datasetLine(node, lookup));
      else if (type === 'prompt') lines.push(promptLine(node, lookup, versionsById, options.extractInputFields));
      else if (type === 'sampler') lines.push(samplerLine(node, lookup, canvasState));
      else {
        const inspection = await inspect(node);
        if (type === 'run') lines.push(runLine(node, inspection));
        else if (type === 'process') lines.push(processLine(node, inspection));
        else if (type === 'score') lines.push(scoreLine(node, inspection));
        else lines.push(reviewLine(node, inspection));
      }
    }
    lines.push('');
  }

  const selected = (options.selectedNodeIds || []).map((id) => lookup.get(id)).filter(Boolean);
  lines.push(selected.length
    ? `Selected on the canvas: ${selected.map(ref).join(', ')}`
    : 'Nothing is selected on the canvas.');
  return lines.join('\n');
}
