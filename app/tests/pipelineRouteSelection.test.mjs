import assert from 'node:assert/strict';
import test from 'node:test';
import { detectPipelines } from '../src/pipelineDetection.js';
import { buildSelectedRoute, exportRoutePayload } from '../src/pipelineRouteSelection.js';
import { buildRunResultsTable } from '../src/runResultsExport.js';

const node = (type, nodeId, extra = {}) => ({ type, nodeId, name: nodeId, ...extra });
const edge = (fromId, toId, type) => ({ fromId, toId, type });
const payload = (state, choices = new Map()) => {
  const pipelines = detectPipelines(state);
  assert.equal(pipelines.length, 1);
  return exportRoutePayload(buildSelectedRoute(pipelines[0], choices));
};

test('version and Run choices select only their own materialized Dataset', () => {
  const state = {
    nodes: [node('dataset', 'raw'), node('prompt', 'p1'), node('prompt', 'p2'),
      node('run', 'r1', { runWorkingSetId: 'raw' }), node('run', 'r2', { runWorkingSetId: 'raw' }),
      node('dataset', 'out1', { sourceRunNodeId: 'r1' }), node('dataset', 'out2', { sourceRunNodeId: 'r2' })],
    connections: [edge('p1', 'p2', 'prompt-to-prompt'), edge('p1', 'r1', 'prompt-to-run'), edge('p2', 'r2', 'prompt-to-run')],
  };
  const before = structuredClone(state);
  const choices = new Map([['prompt:p1', 'r1']]);
  assert.deepEqual(payload(state, choices), [
    { type: 'dataset', dataset_node_id: 'raw' },
    { type: 'prompt', prompt_node_id: 'p1', run_node_id: 'r1' },
    { type: 'dataset', dataset_node_id: 'out1' },
  ]);
  assert.equal(payload(state).find(s => s.type === 'prompt').run_node_id, 'r2');
  assert.deepEqual(state, before);
  assert.deepEqual([...choices], [['prompt:p1', 'r1']]);
});

test('shared source Prompts remain alternatives, not an inferred ensemble', () => {
  const state = {
    nodes: [node('dataset', 'raw'), node('prompt', 'p1'), node('prompt', 'p2'),
      node('run', 'r1', { runWorkingSetId: 'raw' }), node('run', 'r2', { runWorkingSetId: 'raw' })],
    connections: [edge('p1', 'r1', 'prompt-to-run'), edge('p2', 'r2', 'prompt-to-run')],
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
      node('run', 'r1', { runWorkingSetId: 'raw', runName: 'Run A' }), node('run', 'r2', { runWorkingSetId: 'raw', runName: 'Run B' })],
    connections: [edge('p', 'r1', 'prompt-to-run'), edge('p', 'r2', 'prompt-to-run'),
      edge('raw', 'clean', 'dataset-to-process'), edge('raw', 'trim', 'dataset-to-process')],
  };
  const pipelines = detectPipelines(state);
  assert.deepEqual(pipelines.map((p) => p.id), ['pipeline-1', 'pipeline-2']);
  assert.deepEqual(pipelines.map(routeKinds), [['prompt:p — Run A/p — Run B'], ['process:clean/trim']]);
});

test('splitting drops a merging Process from the Prompt pipeline and keeps shared upstream in both', () => {
  const state = {
    nodes: [node('dataset', 'raw'), node('process', 'prep'), node('dataset', 'clean'), node('dataset', 'lookup'),
      node('prompt', 'p'), node('run', 'r', { runWorkingSetId: 'clean' }), node('process', 'join')],
    connections: [edge('raw', 'prep', 'dataset-to-process'), edge('prep', 'clean', 'process-to-dataset'),
      edge('p', 'r', 'prompt-to-run'), edge('clean', 'join', 'dataset-to-process'), edge('lookup', 'join', 'dataset-to-process')],
  };
  const pipelines = detectPipelines(state);
  assert.deepEqual(pipelines.map(routeKinds), [['process:prep', 'prompt:p'], ['process:prep', 'process:join']]);
  assert.ok(!pipelines[0].steps.some((step) => step.datasets?.some((d) => d.datasetNodeId === 'lookup')));
});

test('named branches preserve both lanes and merge once', () => {
  const state = {
    nodes: [node('dataset', 'raw'), node('process', 'split'),
      node('dataset', 'left', { processOutputName: 'left' }), node('dataset', 'right', { processOutputName: 'right' }),
      node('process', 'join'), node('dataset', 'merged'), node('prompt', 'p'), node('run', 'r', { runWorkingSetId: 'merged' })],
    connections: [edge('raw', 'split', 'dataset-to-process'), edge('split', 'left', 'process-to-dataset'),
      edge('split', 'right', 'process-to-dataset'), edge('left', 'join', 'dataset-to-process'),
      edge('right', 'join', 'dataset-to-process'), edge('join', 'merged', 'process-to-dataset'), edge('p', 'r', 'prompt-to-run')],
  };
  const route = payload(state);
  assert.deepEqual(route.filter(s => s.type === 'process').map(s => s.process_node_id), ['split', 'join']);
  assert.deepEqual(route.filter(s => s.type === 'dataset').map(s => s.dataset_node_id), ['raw', 'left', 'right', 'merged']);
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
