import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPipelineCompileRequest,
  buildPipelineStartRequest,
  pipelineInputHasAssets,
  pipelineRouteKey,
} from '../src/pipelineRunDefinition.js';

function fixture() {
  const state = { nodes: [
    { type: 'dataset', nodeId: 'raw', name: 'Raw', datasetContent: {
      headers: ['text', 'image'], columnTypes: ['text', 'image'], rowIds: ['row-a'],
      rows: [['PRIVATE_INPUT', { kind: 'images', assetIds: ['sha256:a'], names: ['a.png'] }]],
    } },
    { type: 'prompt', nodeId: 'p', sections: [{ name: 'Task', content: 'Read {text}' }] },
    { type: 'run', nodeId: 'r', runInputToColumn: { text: 'text' }, runResults: 'PRIVATE_CACHE' },
    { type: 'dataset', nodeId: 'out', sourceRunNodeId: 'r', datasetContent: {
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

test('start freezes rows only for explicit inputs and never sends stale intermediate rows', () => {
  const { state, route } = fixture();
  const before = structuredClone(state);
  const request = buildPipelineStartRequest({ projectId: 'project-a', canvasState: state, route });
  const raw = request.canvas_state.nodes.find((node) => node.nodeId === 'raw');
  const out = request.canvas_state.nodes.find((node) => node.nodeId === 'out');
  assert.equal(request.project_id, 'project-a');
  assert.deepEqual(request.input_dataset_ids, ['raw']);
  assert.equal(raw.datasetContent.rows[0][0], 'PRIVATE_INPUT');
  assert.deepEqual(raw.datasetContent.rowIds, ['row-a']);
  assert.equal(out.datasetContent.row_count, 1);
  assert.equal('rows' in out.datasetContent, false);
  assert.ok(!JSON.stringify(request).includes('PRIVATE_CACHE'));
  assert.ok(!JSON.stringify(request).includes('STALE_OUTPUT'));
  assert.deepEqual(state, before);
});

test('compile rejects a derived Dataset with no current result when a step starts from it', () => {
  const { state, route } = fixture();
  const out = state.nodes.find((node) => node.nodeId === 'out');
  out.resultMissing = true;
  out.datasetContent = { headers: [], rows: [] };
  // Nothing in this route reads it.
  assert.doesNotThrow(() => buildPipelineCompileRequest({ canvasState: state, route }));
  state.nodes.push({ type: 'process', nodeId: 'clean' });
  state.connections.push({ type: 'data', fromId: 'out', fromPort: 'result', toId: 'clean', alias: 'df' });
  const readingRoute = [{ type: 'dataset', dataset_node_id: 'out' }, { type: 'process', process_node_id: 'clean' }];
  assert.throws(() => buildPipelineCompileRequest({ canvasState: state, route: readingRoute }), /no current result/);
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

test('compile and start share the same selected graph and asset detection', () => {
  const { state, route } = fixture();
  const compiled = buildPipelineCompileRequest({ canvasState: state, route });
  const started = buildPipelineStartRequest({ projectId: 'p', projectSessionId: 'assets', canvasState: state, route });
  assert.deepEqual(started.canvas_state, compiled.canvas_state);
  assert.deepEqual(started.route, compiled.route);
  assert.equal(started.project_session_id, 'assets');
  assert.equal(pipelineInputHasAssets(state, route), true);
  assert.equal(pipelineRouteKey(route), pipelineRouteKey(structuredClone(route)));
});

test('all selected source datasets are frozen for a multi-input Process', () => {
  const state = { nodes: [
    { type: 'dataset', nodeId: 'left', datasetContent: { headers: ['id'], rows: [['1']] } },
    { type: 'dataset', nodeId: 'right', datasetContent: { headers: ['id'], rows: [['2']] } },
    { type: 'process', nodeId: 'join' },
    { type: 'dataset', nodeId: 'out', processOutputName: 'result', datasetContent: { headers: ['old'], rows: [['stale']] } },
  ], connections: [
    { type: 'data', fromId: 'left', fromPort: 'result', toId: 'join', alias: 'df' },
    { type: 'data', fromId: 'right', fromPort: 'result', toId: 'join', alias: 'df_right' },
    { fromId: 'join', toId: 'out', type: 'process-to-dataset' },
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
