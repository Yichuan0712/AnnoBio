import assert from 'node:assert/strict';
import test from 'node:test';
import { detectPipelines } from '../src/pipelineDetection.js';
import { buildSelectedRoute, exportRoutePayload } from '../src/pipelineRouteSelection.js';
import { buildRunResultsTable } from '../src/runResultsExport.js';

const node = (type, nodeId, extra = {}) => ({ type, nodeId, name: nodeId, ...extra });
const edge = (fromId, toId, type) => ({ fromId, toId, type });
// A step reading a Dataset or another step's output (`port`, a Process branch).
const data = (fromId, toId, alias, fromPort = 'result') => ({ type: 'data', fromId, fromPort, toId, ...(alias ? { alias } : {}) });
const payload = (state, choices = new Map()) => {
  const pipelines = detectPipelines(state);
  assert.equal(pipelines.length, 1);
  return exportRoutePayload(buildSelectedRoute(pipelines[0], choices));
};

test('version and Run choices continue with what their own Run feeds', () => {
  const state = {
    nodes: [node('dataset', 'raw'), node('prompt', 'p1'), node('prompt', 'p2'), node('run', 'r1'), node('run', 'r2'),
      node('process', 'clean1'), node('process', 'clean2')],
    connections: [edge('p1', 'p2', 'prompt-to-prompt'), edge('p1', 'r1', 'prompt-to-run'), edge('p2', 'r2', 'prompt-to-run'),
      data('raw', 'r1'), data('raw', 'r2'), data('r1', 'clean1', 'df'), data('r2', 'clean2', 'df')],
  };
  const before = structuredClone(state);
  const choices = new Map([['prompt:p1', 'r1']]);
  assert.deepEqual(payload(state, choices), [
    { type: 'dataset', dataset_node_id: 'raw' },
    { type: 'prompt', prompt_node_id: 'p1', run_node_id: 'r1' },
    { type: 'process', process_node_id: 'clean1' },
  ]);
  assert.deepEqual(payload(state).filter((s) => s.type !== 'dataset'), [
    { type: 'prompt', prompt_node_id: 'p2', run_node_id: 'r2' },
    { type: 'process', process_node_id: 'clean2' },
  ]);
  assert.deepEqual(state, before);
  assert.deepEqual([...choices], [['prompt:p1', 'r1']]);
});

test('a Run whose output nothing reads ends the route there', () => {
  const state = {
    nodes: [node('dataset', 'raw'), node('prompt', 'p1'), node('prompt', 'p2'), node('run', 'r1'), node('run', 'r2'), node('process', 'clean')],
    connections: [edge('p1', 'p2', 'prompt-to-prompt'), edge('p1', 'r1', 'prompt-to-run'), edge('p2', 'r2', 'prompt-to-run'),
      data('raw', 'r1'), data('raw', 'r2'), data('r1', 'clean', 'df')],
  };
  assert.deepEqual(payload(state, new Map([['prompt:p1', 'r2']])), [
    { type: 'dataset', dataset_node_id: 'raw' },
    { type: 'prompt', prompt_node_id: 'p2', run_node_id: 'r2' },
  ]);
});

test('shared source Prompts remain alternatives, not an inferred ensemble', () => {
  const state = {
    nodes: [node('dataset', 'raw'), node('prompt', 'p1'), node('prompt', 'p2'), node('run', 'r1'), node('run', 'r2')],
    connections: [edge('p1', 'r1', 'prompt-to-run'), edge('p2', 'r2', 'prompt-to-run'), data('raw', 'r1'), data('raw', 'r2')],
  };
  const route = payload(state, new Map([['step-choice:prompt:p1|prompt:p2', 'r2']]));
  assert.deepEqual(route.filter(s => s.type === 'prompt'), [{ type: 'prompt', prompt_node_id: 'p2', run_node_id: 'r2' }]);
});

const flattenRoute = (route) => route.flatMap((step) => (step.kind === 'branch' ? step.lanes.flatMap(flattenRoute) : [step]));
const routeKinds = (pipeline) => flattenRoute(buildSelectedRoute(pipeline, new Map()))
  .filter((step) => step.kind !== 'dataset')
  .map((step) => `${step.kind}:${step.options.map((o) => o.label).join('/')}`);

test('a Dataset read by both Runs and Processes starts one pipeline per step type', () => {
  const state = {
    nodes: [node('dataset', 'raw'), node('prompt', 'p'), node('process', 'clean'), node('process', 'trim'),
      node('run', 'r1', { runName: 'Run A' }), node('run', 'r2', { runName: 'Run B' })],
    connections: [edge('p', 'r1', 'prompt-to-run'), edge('p', 'r2', 'prompt-to-run'), data('raw', 'r1'), data('raw', 'r2'),
      data('raw', 'clean', 'df'), data('raw', 'trim', 'df')],
  };
  const pipelines = detectPipelines(state);
  assert.deepEqual(pipelines.map((p) => p.id), ['pipeline-1', 'pipeline-2']);
  assert.deepEqual(pipelines.map(routeKinds), [['prompt:p — Run A/p — Run B'], ['process:clean/trim']]);
});

test('an output read by both a Run and a merging Process splits, keeping the shared upstream in both', () => {
  const state = {
    nodes: [node('dataset', 'raw'), node('process', 'prep'), node('dataset', 'lookup'),
      node('prompt', 'p'), node('run', 'r'), node('process', 'join')],
    connections: [data('raw', 'prep', 'df'), edge('p', 'r', 'prompt-to-run'), data('prep', 'r'),
      data('prep', 'join', 'df'), data('lookup', 'join', 'df_lookup')],
  };
  const pipelines = detectPipelines(state);
  assert.deepEqual(pipelines.map(routeKinds), [['process:prep', 'prompt:p'], ['process:prep', 'process:join']]);
  assert.ok(!pipelines[0].steps.some((step) => step.datasets?.some((d) => d.datasetNodeId === 'lookup')));
});

test('named branches preserve both lanes and merge once', () => {
  const state = {
    nodes: [node('dataset', 'raw'), node('process', 'split'), node('process', 'join'), node('prompt', 'p'), node('run', 'r')],
    connections: [data('raw', 'split', 'df'), data('split', 'join', 'df', 'left'), data('split', 'join', 'df_right', 'right'),
      edge('p', 'r', 'prompt-to-run'), data('join', 'r')],
  };
  const pipelines = detectPipelines(state);
  assert.equal(pipelines.length, 1);
  const route = buildSelectedRoute(pipelines[0], new Map());
  const branch = route.find((step) => step.kind === 'branch');
  assert.deepEqual(branch.lanes.map((lane) => lane.map((step) => step.selectedOption.output.port)), [['left'], ['right']]);
  // Only the Dataset the pipeline starts from is listed; the compiler follows the outputs.
  assert.deepEqual(exportRoutePayload(route), [
    { type: 'dataset', dataset_node_id: 'raw' },
    { type: 'process', process_node_id: 'split' },
    { type: 'process', process_node_id: 'join' },
    { type: 'prompt', prompt_node_id: 'p', run_node_id: 'r' },
  ]);
});

test('a Dataset saved from a step starts a new pipeline instead of chaining to it', () => {
  const state = {
    nodes: [node('dataset', 'raw'), node('prompt', 'p'), node('run', 'r'),
      node('dataset', 'saved', { savedFrom: { kind: 'run', nodeId: 'r', port: 'result', recordId: 'rec' } }), node('process', 'clean')],
    connections: [edge('p', 'r', 'prompt-to-run'), data('raw', 'r'), data('saved', 'clean', 'df')],
  };
  assert.deepEqual(detectPipelines(state).map(routeKinds), [['prompt:p'], ['process:clean']]);
});

test('Process payload includes all explicit Dataset dependencies', () => {
  const route = exportRoutePayload([{ kind: 'process', selectedOption: {
    kind: 'process', processNodeId: 'join', inputDatasets: [{ datasetNodeId: 'primary' }, { datasetNodeId: 'lookup' }],
  } }]);
  assert.deepEqual(route, [
    { type: 'dataset', dataset_node_id: 'primary' },
    { type: 'dataset', dataset_node_id: 'lookup' },
    { type: 'process', process_node_id: 'join' },
  ]);
});

test('materialization contract includes row indices and preserves input asset types', () => {
  const table = buildRunResultsTable({ results: [],
    runContent: { headers: ['text', 'image'], columnTypes: ['text', 'image'], rows: [] },
    schemaFields: [{ key: 'answer', type: 'str' }],
  });
  assert.deepEqual(table.headers, ['Input: #', 'Input: text', 'Input: image', 'Output: #', 'Output: answer']);
  assert.deepEqual(table.columnTypes, ['text', 'text', 'image', 'text', 'text']);
});

test('Prompts whose results one Process merges are branches it needs, not alternatives', () => {
  const state = {
    nodes: [node('dataset', 'raw'), node('prompt', 'words'), node('prompt', 'explain'),
      node('run', 'r-words'), node('run', 'r-explain'), node('process', 'merge')],
    connections: [edge('words', 'r-words', 'prompt-to-run'), edge('explain', 'r-explain', 'prompt-to-run'),
      data('raw', 'r-words'), data('raw', 'r-explain'), data('r-words', 'merge', 'df'), data('r-explain', 'merge', 'df_explain')],
  };
  const pipelines = detectPipelines(state);
  const route = buildSelectedRoute(pipelines[0], new Map());
  const branch = route.find((step) => step.kind === 'branch');
  assert.deepEqual(branch.lanes.map((lane) => lane.filter((step) => step.kind === 'prompt').map((step) => step.selectedValue)),
    [['r-words'], ['r-explain']]);
  assert.deepEqual(payload(state).filter((s) => s.type !== 'dataset'), [
    { type: 'prompt', prompt_node_id: 'words', run_node_id: 'r-words' },
    { type: 'prompt', prompt_node_id: 'explain', run_node_id: 'r-explain' },
    { type: 'process', process_node_id: 'merge' },
  ]);
});

test('Prompts whose paths first meet at another Prompt stay alternatives', () => {
  const state = {
    nodes: [node('dataset', 'raw'), node('prompt', 'p1'), node('prompt', 'p2'), node('prompt', 'next'),
      node('run', 'r1'), node('run', 'r2'), node('run', 'next-1'), node('run', 'next-2'), node('process', 'finish')],
    connections: [edge('p1', 'r1', 'prompt-to-run'), edge('p2', 'r2', 'prompt-to-run'),
      edge('next', 'next-1', 'prompt-to-run'), edge('next', 'next-2', 'prompt-to-run'),
      data('raw', 'r1'), data('raw', 'r2'), data('r1', 'next-1'), data('r2', 'next-2'), data('next-1', 'finish', 'df')],
  };
  const route = buildSelectedRoute(detectPipelines(state)[0], new Map());
  assert.equal(route.some((step) => step.kind === 'branch'), false);
  assert.deepEqual(route.find((step) => step.kind === 'prompt').options.map((option) => option.value), ['r1', 'r2']);
});

test('every branch of a Process is a lane in its order, one nothing reads shown empty', async () => {
  const { getVisibleRoute } = await import('../src/pipelineRouteSelection.js');
  const ports = JSON.stringify({ ports: ['ready', 'rewrite', 'rest'], dynamic: false, error: '', codeHash: 'h' });
  const state = {
    nodes: [node('dataset', 'raw'), node('process', 'check', { processOutputPorts: ports }), node('prompt', 'p'), node('run', 'r')],
    connections: [data('raw', 'check', 'df'), edge('p', 'r', 'prompt-to-run'), data('check', 'r', undefined, 'rewrite')],
  };
  const route = getVisibleRoute(buildSelectedRoute(detectPipelines(state)[0], new Map()));
  const branch = route.find((step) => step.kind === 'branch');
  assert.deepEqual(branch.lanes.map((lane) => lane.map((step) => step.kind)), [['empty'], ['prompt'], ['empty']]);
});
