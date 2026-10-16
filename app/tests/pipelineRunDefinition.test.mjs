import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPipelineCompileRequest, pipelineRouteKey } from '../src/pipelineRunDefinition.js';

function fixture() {
  const state = { nodes: [
    { type: 'dataset', nodeId: 'raw', name: 'Raw', datasetContent: {
      headers: ['text', 'image'], columnTypes: ['text', 'image'], rowIds: ['row-a'],
      rows: [['PRIVATE_INPUT', { kind: 'images', assetIds: ['sha256:a'], names: ['a.png'] }]],
    } },
    { type: 'prompt', nodeId: 'p', text: 'Read {text}' },
    { type: 'run', nodeId: 'r', runInputToColumn: { text: 'text' }, runResults: 'PRIVATE_CACHE' },
    { type: 'dataset', nodeId: 'out', savedFrom: { kind: 'run', nodeId: 'r', port: 'result', recordId: 'rec' }, datasetContent: {
      headers: ['Output: answer'], rows: [['STALE_OUTPUT']],
    } },
  ], connections: [{ fromId: 'p', toId: 'r', type: 'prompt-to-run' }, { type: 'data', fromId: 'raw', fromPort: 'result', toId: 'r' }] };
  const route = [
    { type: 'dataset', dataset_node_id: 'raw' },
    { type: 'prompt', prompt_node_id: 'p', run_node_id: 'r' },
    { type: 'dataset', dataset_node_id: 'out' },
  ];
  return { state, route };
}

test('compile sends rows only for explicit inputs and never stale intermediate rows', () => {
  const { state, route } = fixture();
  const before = structuredClone(state);
  const request = buildPipelineCompileRequest({ canvasState: state, route });
  const raw = request.canvas_state.nodes.find((node) => node.nodeId === 'raw');
  const out = request.canvas_state.nodes.find((node) => node.nodeId === 'out');
  assert.deepEqual(request.input_dataset_ids, ['raw']);
  assert.equal(raw.datasetContent.rows[0][0], 'PRIVATE_INPUT');
  assert.deepEqual(raw.datasetContent.rowIds, ['row-a']);
  assert.equal(out.datasetContent.row_count, 1);
  assert.equal('rows' in out.datasetContent, false);
  assert.ok(!JSON.stringify(request).includes('PRIVATE_CACHE'));
  assert.ok(!JSON.stringify(request).includes('STALE_OUTPUT'));
  assert.deepEqual(state, before);
});

test('an ordinary empty Dataset remains a valid input', () => {
  const state = { nodes: [{ type: 'dataset', nodeId: 'empty', name: 'Empty',
    datasetContent: { headers: ['text'], rows: [] } }, { type: 'process', nodeId: 'clean' }],
  connections: [{ type: 'data', fromId: 'empty', fromPort: 'result', toId: 'clean', alias: 'df' }] };
  const route = [{ type: 'dataset', dataset_node_id: 'empty' }, { type: 'process', process_node_id: 'clean' }];
  const request = buildPipelineCompileRequest({ canvasState: state, route });
  assert.deepEqual(request.input_dataset_ids, ['empty']);
  assert.deepEqual(request.canvas_state.nodes[0].datasetContent.rows, []);
});

test('the route key is stable for the same route', () => {
  const { route } = fixture();
  assert.equal(pipelineRouteKey(route), pipelineRouteKey(structuredClone(route)));
  assert.notEqual(pipelineRouteKey(route), pipelineRouteKey(route.slice(1)));
});

test('all selected source datasets are frozen for a multi-input Process', () => {
  const state = { nodes: [
    { type: 'dataset', nodeId: 'left', datasetContent: { headers: ['id'], rows: [['1']] } },
    { type: 'dataset', nodeId: 'right', datasetContent: { headers: ['id'], rows: [['2']] } },
    { type: 'process', nodeId: 'join' },
    { type: 'dataset', nodeId: 'out', savedFrom: { kind: 'process', nodeId: 'join', port: 'result', recordId: 'rec' }, datasetContent: { headers: ['old'], rows: [['stale']] } },
  ], connections: [
    { type: 'data', fromId: 'left', fromPort: 'result', toId: 'join', alias: 'df' },
    { type: 'data', fromId: 'right', fromPort: 'result', toId: 'join', alias: 'df_right' },
  ] };
  const route = [
    { type: 'dataset', dataset_node_id: 'left' }, { type: 'dataset', dataset_node_id: 'right' },
    { type: 'process', process_node_id: 'join' }, { type: 'dataset', dataset_node_id: 'out' },
  ];
  const request = buildPipelineCompileRequest({ canvasState: state, route });
  assert.deepEqual(request.input_dataset_ids, ['left', 'right']);
  assert.deepEqual(request.canvas_state.nodes.find((node) => node.nodeId === 'left').datasetContent.rows, [['1']]);
  assert.deepEqual(request.canvas_state.nodes.find((node) => node.nodeId === 'right').datasetContent.rows, [['2']]);
  assert.equal('rows' in request.canvas_state.nodes.find((node) => node.nodeId === 'out').datasetContent, false);
});
