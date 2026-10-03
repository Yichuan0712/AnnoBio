/**
 * Compact plain-text description of the canvas for the Agent's system prompt: pipelines as the
 * Current Pipeline panel sees them, then every node with the few facts needed to decide what to
 * inspect next. Details (prompt text, code, rows) are left to the read tools.
 */
import { detectPipelines } from '../../pipelineDetection.js';
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

function describePipelineStep(step, lookup) {
  if (step.kind === 'prompt') {
    const versions = step.versions.map((v) => {
      const runs = v.runs.map((r) => `${quote(r.runName)} [${r.runNodeId}]`).join(', ');
      return `${quote(v.promptName)} run by ${runs}`;
    });
    return versions.length > 1
      ? `Prompt versions (latest last): ${versions.join('; ')}`
      : `Prompt ${versions[0]}`;
  }
  if (step.kind === 'process') {
    const inputs = step.inputDatasets.map((d) => quote(d.datasetName)).join(' + ');
    return `Process ${quote(step.processName)}${inputs ? ` reading ${inputs}` : ''}`;
  }
  const names = step.datasets.map((d) => {
    const node = lookup.get(d.datasetNodeId);
    const branch = String(node?.processOutputName || '').trim();
    return `${quote(d.datasetName)} [${d.datasetNodeId}]${branch ? ` (branch ${branch})` : ''}`;
  });
  return names.length > 1 ? `Dataset, one of: ${names.join(', ')}` : `Dataset ${names[0]}`;
}

function pipelineLines(canvasState, lookup) {
  const pipelines = detectPipelines(canvasState);
  if (!pipelines.length) return ['No pipelines yet (a pipeline needs at least one Prompt with a Run, or a Process).'];
  const lines = [];
  pipelines.forEach((pipeline, index) => {
    lines.push(`Pipeline ${index + 1}:`);
    pipeline.steps.forEach((step, i) => lines.push(`  ${i + 1}. ${describePipelineStep(step, lookup)}`));
  });
  return lines;
}

function datasetLine(node, lookup, canvasState) {
  const content = datasetContentOf(node);
  const columns = content.headers
    .map((h, i) => (content.columnTypes[i] && content.columnTypes[i] !== 'text' ? `${h} (${content.columnTypes[i]})` : h))
    .join(', ');
  let source = '';
  const run = node.sourceRunNodeId ? lookup.get(node.sourceRunNodeId) : null;
  const processEdge = (canvasState.connections || []).find((c) => c.type === 'process-to-dataset' && c.toId === node.nodeId);
  const snapshotEdge = (canvasState.connections || []).find((c) =>
    (c.type === 'run-to-dataset-snapshot' || c.type === 'process-to-dataset-snapshot') && c.toId === node.nodeId);
  const sampler = node.samplerNodeId ? lookup.get(node.samplerNodeId) : null;
  if (run) source = `; results of run ${quote(nodeTitle(run))}`;
  else if (processEdge && lookup.get(processEdge.fromId)) {
    source = `; output ${quote(node.processOutputName || 'result')} of process ${quote(nodeTitle(lookup.get(processEdge.fromId)))}`;
  } else if (snapshotEdge && lookup.get(snapshotEdge.fromId)) {
    const kind = snapshotEdge.type === 'run-to-dataset-snapshot' ? 'run' : 'process';
    source = `; saved snapshot of ${kind} ${quote(nodeTitle(lookup.get(snapshotEdge.fromId)))}`;
  } else if (sampler) source = `; sampled by ${quote(nodeTitle(sampler))}`;
  return `- ${ref(node)}: ${content.rows.length} rows; columns: ${columns || '(none)'}${source}`;
}

function promptLine(node, lookup, canvasState, extractInputFields) {
  const inputTypes = node.inputTypes && typeof node.inputTypes === 'object' ? node.inputTypes : {};
  const inputs = typeof extractInputFields === 'function'
    ? extractInputFields(node.sections || []).map((name) => (inputTypes[name] && inputTypes[name] !== 'text' ? `${name} (${inputTypes[name]})` : name))
    : [];
  const fields = (node.outputFormat?.fields || []).map((f) => f.key).filter(Boolean);
  const shape = node.outputFormat?.returnShape === 'table' ? 'table' : 'single';
  const previous = (canvasState.connections || [])
    .filter((c) => c.type === 'prompt-to-prompt' && c.toId === node.nodeId)
    .map((c) => lookup.get(c.fromId))
    .filter(Boolean);
  const version = previous.length ? `; new version of ${previous.map((p) => quote(nodeTitle(p))).join(', ')}` : '';
  return `- ${ref(node)}: inputs ${inputs.join(', ') || '(none)'}; outputs (${shape}) ${fields.join(', ') || '(none)'}${version}`;
}

function runLine(node, inspection) {
  const d = inspection.details;
  const prompt = linkRef(d.prompt, '(no prompt)');
  const dataset = linkRef(d.inputDataset, '(no input dataset)');
  const errors = d.errorRows ? `, ${d.errorRows} errors` : '';
  return `- ${ref(node)}: prompt ${prompt} on ${dataset}; model ${d.model}; ${d.status}, ${d.inputRowsDone}/${d.inputRows} input rows${errors}`;
}

function processLine(node, inspection) {
  const d = inspection.details;
  const inputs = d.inputs.map((i) => `${linkRef(i)}${i.alias ? ` as ${i.alias}` : ''}`).join(', ');
  const outputs = Object.entries(processOutputsOf(node))
    .map(([name, branch]) => `${name} (${branch.rows.length} rows)`)
    .join(', ');
  return `- ${ref(node)}: reads ${inputs || '(no inputs)'}; last output ${outputs || '(not run)'}`;
}

function samplerLine(node, lookup) {
  const source = lookup.get(node.sourceNodeId);
  const size = node.samplingType === 'specify-rows'
    ? `rows ${node.rowSpec || '(none)'}`
    : `${node.sampleSize ?? ''}${node.sampleSizeType === 'ratio' ? '%' : ' rows'}`;
  return `- ${ref(node)}: samples ${source ? quote(nodeTitle(source)) : '(no source)'}; ${size}`;
}

function scoreLine(node, inspection) {
  const d = inspection.details;
  const metrics = d.metrics
    ? `; ${d.metrics.matchedRows}/${d.metrics.totalRows} rows matched (${Math.round(d.metrics.passRate * 1000) / 10}%)`
    : '; not computed yet';
  return `- ${ref(node)}: run ${linkRef(d.run, '(none)')} vs ground truth ${linkRef(d.groundTruth, '(none)')}; ${d.matching}${metrics}`;
}

function reviewLine(node, inspection) {
  const d = inspection.details;
  const verified = d.suggestions.filter((s) => s.verifyState === 'verified').length;
  const counts = d.suggestions.length ? `; ${d.suggestions.length} suggestions (${verified} verified)` : '';
  return `- ${ref(node)}: reviews score ${linkRef(d.score, '(none)')}; ${d.status}${counts}`;
}

const SECTION_ORDER = [
  ['dataset', 'Datasets'],
  ['sampler', 'Samplers'],
  ['process', 'Processes'],
  ['prompt', 'Prompts'],
  ['run', 'Runs'],
  ['score', 'Scores'],
  ['promptReview', 'Reviews'],
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

  const lines = ['Pipelines:', ...pipelineLines(canvasState, lookup), ''];
  for (const [type, heading] of SECTION_ORDER) {
    const group = nodes.filter((n) => n.type === type);
    if (!group.length) continue;
    lines.push(`${heading}:`);
    for (const node of group) {
      if (type === 'dataset') lines.push(datasetLine(node, lookup, canvasState));
      else if (type === 'prompt') lines.push(promptLine(node, lookup, canvasState, options.extractInputFields));
      else if (type === 'sampler') lines.push(samplerLine(node, lookup));
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

