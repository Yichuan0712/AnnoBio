import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPipelineExportRequest } from '../src/pipelineExportDefinition.js';

test('export carries node settings, row count and explicit input boundary, never row values', () => {
  const state = { nodes: [
    { type: 'dataset', nodeId: 'raw', sourceRunNodeId: 'old-run', savedCopy: true, datasetContent: { headers: ['text'], rows: [['PRIVATE']] } },
    { type: 'prompt', nodeId: 'p', sections: [{ content: 'Read {text}' }] },
    { type: 'run', nodeId: 'r', runSettings: { run_concurrency: 2 }, runResults: 'PRIVATE_RESULTS' },
  ], connections: [{ fromId: 'p', toId: 'r', type: 'prompt-to-run' }, { type: 'data', fromId: 'raw', fromPort: 'result', toId: 'r' }] };
  const route = [{ type: 'dataset', dataset_node_id: 'raw' }, { type: 'prompt', prompt_node_id: 'p', run_node_id: 'r' }];
  const before = structuredClone(state);
  const req = buildPipelineExportRequest({ name: 'Example', canvasState: state, route });
  assert.deepEqual(req.input_dataset_ids, ['raw']);
  assert.deepEqual(req.canvas_state.nodes[2].runSettings, { run_concurrency: 2 });
  assert.equal(req.canvas_state.nodes[0].datasetContent.row_count, 1);
  assert.equal(req.canvas_state.nodes[0].savedCopy, true);
  assert.ok(!JSON.stringify(req).includes('PRIVATE'));
  assert.deepEqual(state, before);
});

test('other saved versions of a branch on the route are not sent as further Process outputs', () => {
  const edges = [
    { fromId: 'search', toId: 'pairs', type: 'process-to-dataset' },
    { fromId: 'search', toId: 'pairs-copy', type: 'process-to-dataset' },
    { fromId: 'search', toId: 'other', type: 'process-to-dataset' },
  ];
  const req = buildPipelineExportRequest({ name: 'Example', canvasState: {
    nodes: [{ type: 'process', nodeId: 'search' }, { type: 'dataset', nodeId: 'pairs' },
      { type: 'dataset', nodeId: 'pairs-copy', processOutputName: 'result', savedCopy: true },
      { type: 'dataset', nodeId: 'other', processOutputName: 'other' }],
    connections: edges,
  }, route: [{ type: 'process', process_node_id: 'search' }, { type: 'dataset', dataset_node_id: 'pairs' }] });
  assert.deepEqual(req.canvas_state.connections, [edges[0], edges[2]]);
});

test('omitted dependencies and conflicting producers remain visible to the compiler', () => {
  const edges = [
    { fromId: 'missing', fromPort: 'result', toId: 'proc', type: 'data', alias: 'df' },
    { fromId: 'outside', toId: 'out', type: 'process-to-dataset' },
    { fromId: 'proc', toId: 'other-branch', type: 'process-to-dataset' },
    { fromId: 'private-a', toId: 'private-b', type: 'prompt-to-run' },
  ];
  const req = buildPipelineExportRequest({ name: 'Example', canvasState: {
    nodes: [{ type: 'process', nodeId: 'proc' }, { type: 'dataset', nodeId: 'out' }], connections: edges,
  }, route: [{ type: 'process', process_node_id: 'proc' }, { type: 'dataset', dataset_node_id: 'out' }] });
  assert.deepEqual(req.canvas_state.connections, edges.slice(0, 3));
  assert.deepEqual(req.input_dataset_ids, []);
});

test('Python export rejects a missing result used as its starting Dataset', () => {
  const state = { nodes: [{ type: 'dataset', nodeId: 'derived', name: 'Derived', resultMissing: true,
    datasetContent: { headers: [], rows: [] } }], connections: [] };
  assert.throws(() => buildPipelineExportRequest({ name: 'Bad', canvasState: state,
    route: [{ type: 'dataset', dataset_node_id: 'derived' }] }), /no current result/);
});

test('Python export includes every external Dataset in a multi-input route', () => {
  const state = { nodes: [
    { type: 'dataset', nodeId: 'left', datasetContent: { headers: ['id'], rows: [] } },
    { type: 'dataset', nodeId: 'right', datasetContent: { headers: ['value'], rows: [] } },
    { type: 'process', nodeId: 'join' },
    { type: 'dataset', nodeId: 'out', processOutputName: 'result' },
  ], connections: [
    { type: 'data', fromId: 'left', fromPort: 'result', toId: 'join', alias: 'df' },
    { type: 'data', fromId: 'right', fromPort: 'result', toId: 'join', alias: 'df_right' },
    { type: 'process-to-dataset', fromId: 'join', toId: 'out' },
  ] };
  const route = [
    { type: 'dataset', dataset_node_id: 'left' },
    { type: 'dataset', dataset_node_id: 'right' },
    { type: 'process', process_node_id: 'join' },
    { type: 'dataset', dataset_node_id: 'out' },
  ];
  assert.deepEqual(buildPipelineExportRequest({ name: 'Join', canvasState: state, route }).input_dataset_ids, ['left', 'right']);
});
