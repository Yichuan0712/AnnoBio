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
