import test from 'node:test';
import assert from 'node:assert/strict';
import { importPipelineRunHistory, withCompatibleLegacyCanvas } from '../src/pipelineHistoryImport.js';
import { resolveHistoryCanvasState } from '../src/runHistoryResolver.js';

test('imports a Pipeline chain into node History exactly once with upstream record references', async () => {
  const canvas = { nodes: [
    { type: 'dataset', nodeId: 'raw', name: 'Raw' },
    { type: 'prompt', nodeId: 'prompt', name: 'Extract', sections: [{ name: 'Task', content: '{text}' }],
      outputFormat: { returnShape: 'single', fields: [{ key: 'answer', type: 'str' }] }, inputTypes: {} },
    { type: 'run', nodeId: 'run', runWorkingSetId: 'raw', runInputToColumn: { text: 'text' } },
    { type: 'dataset', nodeId: 'mid', name: 'Pairs', sourceRunNodeId: 'run' },
    { type: 'process', nodeId: 'process', name: 'Clean', primaryDatasetId: 'mid', dfCode: 'def process(df): pass' },
    { type: 'dataset', nodeId: 'out', name: 'Clean pairs', processOutputName: 'result' },
  ], connections: [] };
  const spec = { artifacts: [
    { id: 'dataset:raw', producer: null },
    { id: 'dataset:mid', producer: { job_id: 'llm:run', port: 'result' } },
    { id: 'dataset:out', producer: { job_id: 'process:process', port: 'result' } },
  ], jobs: [
    { id: 'llm:run', type: 'llm', inputs: { data: 'dataset:raw' }, outputs: { result: ['dataset:mid'] },
      config: { input_mapping: { text: 'text' }, output_schema: { fields: [{ key: 'answer' }] }, settings: {} } },
    { id: 'process:process', type: 'process', inputs: { df: 'dataset:mid' },
      outputs: { result: ['dataset:out'] }, config: { code: 'def process(df): pass' } },
  ], source_map: { 'llm:run': { node_ids: ['prompt', 'run'] },
    'process:process': { node_ids: ['process'] } } };
  const tables = {
    'dataset:raw': { headers: ['text'], rows: [['x']], column_types: ['text'], row_ids: ['row-1'] },
    'dataset:mid': { headers: ['Input: #', 'Input: text', 'Output: #', 'Output: answer'],
      rows: [[1, 'x', 1, 'y']], column_types: ['text', 'text', 'text', 'text'], row_ids: [1] },
    'dataset:out': { headers: ['answer'], rows: [['Y']], column_types: ['text'], row_ids: [1] },
  };
  const records = [];
  const session = { projectId: 'project', index: { records: [] },
    async putRecord(record) { records.push(record); this.index.records.push(record); } };
  const run = { run_id: 'a'.repeat(32), status: 'succeeded', finished_at: '2026-10-05T00:00:00Z',
    jobs: [{ job_id: 'llm:run', status: 'succeeded' }, { job_id: 'process:process', status: 'succeeded' }],
    plan: { jobs: [{ job_id: 'llm:run', model: { model: 'test', credential_id: 'cred' } }] } };
  const args = { run, definition: { spec, canvas_state: canvas }, session,
    getArtifact: async (id) => ({ artifact: { valid: true }, table: tables[id] }) };
  const first = await importPipelineRunHistory(args);
  assert.equal(first.imported, 2);
  assert.equal(records[0].results.runResults[0].output.answer, 'y');
  assert.equal(records[1].inputs.bindings[0].sourceRecordId, records[0].id);
  assert.deepEqual(records[1].sourceRecordIds, [records[0].id]);
  const liveCanvas = structuredClone(canvas);
  liveCanvas.nodes.find((node) => node.nodeId === 'raw').datasetContent = {
    headers: ['text'], rows: [['x']], columnTypes: ['text'], rowIds: ['row-1'],
  };
  liveCanvas.nodes.find((node) => node.nodeId === 'mid').datasetContent = { headers: [], rows: [] };
  liveCanvas.nodes.find((node) => node.nodeId === 'out').datasetContent = { headers: [], rows: [] };
  liveCanvas.connections = [{ type: 'prompt-to-run', fromId: 'prompt', toId: 'run' },
    { type: 'dataset-to-process', fromId: 'mid', toId: 'process' },
    { type: 'process-to-dataset', fromId: 'process', toId: 'out' }];
  const resolved = await resolveHistoryCanvasState(liveCanvas, {
    index: session.index, loadRecord: async (id) => records.find((record) => record.id === id),
  });
  assert.equal(resolved.currentRecordIds.run, records[0].id);
  assert.equal(resolved.currentRecordIds.process, records[1].id);
  assert.deepEqual(resolved.state.nodes.find((node) => node.nodeId === 'out').datasetContent.rows, [['Y']]);
  assert.equal((await importPipelineRunHistory(args)).imported, 0);
  assert.equal(records.length, 2);

  const savedCopyCanvas = structuredClone(canvas);
  savedCopyCanvas.nodes.find((node) => node.nodeId === 'mid').savedCopy = true;
  const savedCopyRecords = [];
  const savedCopySession = { projectId: 'project', index: { records: [] },
    async putRecord(record) { savedCopyRecords.push(record); this.index.records.push(record); } };
  await importPipelineRunHistory({ ...args, run: { ...run, run_id: 'b'.repeat(32) },
    definition: { spec, canvas_state: savedCopyCanvas }, session: savedCopySession });
  assert.equal(savedCopyRecords[1].inputs.bindings[0].sourceRecordId, undefined);
  assert.deepEqual(savedCopyRecords[1].sourceRecordIds, [savedCopyRecords[0].id]);
});

test('does not attribute an old Pipeline run to changed live Prompt code', () => {
  const definition = { spec: { jobs: [{ id: 'llm:run', type: 'llm', inputs: { data: 'dataset:raw' },
    config: { sections: [{ name: 'Task', content: '{text}' }], input_mapping: { text: 'text' },
      output_schema: { return_shape: 'single', fields: [{ key: 'answer' }] } } }],
  artifacts: [{ id: 'dataset:raw' }], source_map: { 'llm:run': { node_ids: ['prompt', 'run'] } } } };
  const canvas = { nodes: [
    { type: 'dataset', nodeId: 'raw' },
    { type: 'prompt', nodeId: 'prompt', sections: [{ name: 'Task', content: 'changed {text}' }],
      outputFormat: { returnShape: 'single', fields: [{ key: 'answer' }] } },
    { type: 'run', nodeId: 'run', runWorkingSetId: 'raw', runInputToColumn: { text: 'text' } },
  ] };
  assert.equal(withCompatibleLegacyCanvas(definition, canvas).canvas_state, undefined);
});
