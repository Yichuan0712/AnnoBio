import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPipelineExportRequest } from '../src/pipelineExportDefinition.js';

const data = (fromId, toId, alias, fromPort = 'result') => ({ type: 'data', fromId, fromPort, toId, ...(alias ? { alias } : {}) });

test('export carries node settings, row count and explicit input boundary, never row values', () => {
  const state = { nodes: [
    { type: 'dataset', nodeId: 'raw', sourceRunNodeId: 'old-run', savedCopy: true, datasetContent: { headers: ['text'], rows: [['PRIVATE']] } },
    { type: 'prompt', nodeId: 'p', sections: [{ content: 'Read {text}' }] },
    { type: 'run', nodeId: 'r', runSettings: { run_concurrency: 2 }, runResults: 'PRIVATE_RESULTS' },
  ], connections: [{ fromId: 'p', toId: 'r', type: 'prompt-to-run' }, data('raw', 'r')] };
  const route = [{ type: 'dataset', dataset_node_id: 'raw' }, { type: 'prompt', prompt_node_id: 'p', run_node_id: 'r' }];
  const before = structuredClone(state);
  const req = buildPipelineExportRequest({ name: 'Example', canvasState: state, route });
  assert.deepEqual(req.input_dataset_ids, ['raw']);
  assert.deepEqual(req.canvas_state.nodes[2].runSettings, { run_concurrency: 2 });
  assert.equal(req.canvas_state.nodes[0].datasetContent.row_count, 1);
  // Where a Dataset was saved from does not matter to a pipeline: it is an input.
  assert.deepEqual(['sourceRunNodeId', 'savedCopy'].filter((field) => field in req.canvas_state.nodes[0]), []);
  assert.ok(!JSON.stringify(req).includes('PRIVATE'));
  assert.deepEqual(state, before);
});

test('only what the selected steps read, and their Prompts, is sent', () => {
  const edges = [
    data('raw', 'split', 'df'),
    data('split', 'join', 'df', 'left'),
    { type: 'process-to-dataset', fromId: 'split', toId: 'saved' },
    { type: 'run-to-dataset-snapshot', fromId: 'r', toId: 'saved' },
    { type: 'prompt-to-run', fromId: 'p', toId: 'r' },
    data('join', 'r'),
    data('join', 'elsewhere', 'df'),
  ];
  const req = buildPipelineExportRequest({ name: 'Example', canvasState: {
    nodes: [{ type: 'dataset', nodeId: 'raw', datasetContent: { headers: ['text'], rows: [] } }, { type: 'process', nodeId: 'split' },
      { type: 'process', nodeId: 'join' }, { type: 'dataset', nodeId: 'saved' }, { type: 'prompt', nodeId: 'p' }, { type: 'run', nodeId: 'r' },
      { type: 'process', nodeId: 'elsewhere' }],
    connections: edges,
  }, route: [{ type: 'dataset', dataset_node_id: 'raw' }, { type: 'process', process_node_id: 'split' },
    { type: 'process', process_node_id: 'join' }, { type: 'prompt', prompt_node_id: 'p', run_node_id: 'r' }] });
  assert.deepEqual(req.canvas_state.connections, [edges[0], edges[1], edges[4], edges[5]]);
  assert.deepEqual(req.canvas_state.nodes.map((item) => item.nodeId), ['raw', 'split', 'join', 'p', 'r']);
});

test('an upstream step outside the route goes by name only, so the compiler can name it', () => {
  const edges = [data('missing', 'proc', 'df'), data('outside', 'proc', 'df_outside'), { fromId: 'private-a', toId: 'private-b', type: 'prompt-to-run' }];
  const req = buildPipelineExportRequest({ name: 'Example', canvasState: {
    nodes: [{ type: 'process', nodeId: 'proc' }, { type: 'process', nodeId: 'outside', name: 'Clean', dfCode: 'PRIVATE_CODE' }],
    connections: edges,
  }, route: [{ type: 'process', process_node_id: 'proc' }] });
  assert.deepEqual(req.canvas_state.connections, edges.slice(0, 2));
  assert.deepEqual(req.canvas_state.nodes.at(-1), { type: 'process', nodeId: 'outside', name: 'Clean' });
  assert.deepEqual(req.input_dataset_ids, []);
});

test('Python export rejects a missing result a step starts from', () => {
  const state = { nodes: [
    { type: 'dataset', nodeId: 'derived', name: 'Derived', resultMissing: true, datasetContent: { headers: [], rows: [] } },
    { type: 'process', nodeId: 'clean' },
  ], connections: [data('derived', 'clean', 'df')] };
  assert.throws(() => buildPipelineExportRequest({ name: 'Bad', canvasState: state,
    route: [{ type: 'dataset', dataset_node_id: 'derived' }, { type: 'process', process_node_id: 'clean' }] }), /no current result/);
});

test('Python export includes every Dataset a multi-input route starts from', () => {
  const state = { nodes: [
    { type: 'dataset', nodeId: 'left', datasetContent: { headers: ['id'], rows: [] } },
    { type: 'dataset', nodeId: 'right', datasetContent: { headers: ['value'], rows: [] } },
    { type: 'process', nodeId: 'join' },
  ], connections: [data('left', 'join', 'df'), data('right', 'join', 'df_right')] };
  const route = [
    { type: 'dataset', dataset_node_id: 'left' },
    { type: 'dataset', dataset_node_id: 'right' },
    { type: 'process', process_node_id: 'join' },
  ];
  assert.deepEqual(buildPipelineExportRequest({ name: 'Join', canvasState: state, route }).input_dataset_ids, ['left', 'right']);
});
