import test from 'node:test';
import assert from 'node:assert/strict';
import { importPipelineRunHistory, pipelineRunImported, PIPELINE_RUN_BEFORE_DATA_FLOW } from '../src/pipelineHistoryImport.js';
import { resolveHistoryCanvasState } from '../src/runHistoryResolver.js';
import { stepOutputSignature } from '../src/runHistorySignature.js';

const RAW = { headers: ['text'], rows: [['x']], columnTypes: ['text'], rowIds: ['row-1'] };
const prompt = (nodeId, name, field) => ({ type: 'prompt', nodeId, name, text: '{text}',
  outputFormat: { returnShape: 'single', fields: [{ key: field, type: 'str' }] }, inputTypes: {} });
const data = (fromId, toId, alias) => ({ type: 'data', fromId, fromPort: 'result', toId, ...(alias ? { alias } : {}) });

// raw → Extract (r1) → Clean (Process) → Judge (r2), connected step to step.
const canvas = () => ({ version: 3, nodes: [
  { type: 'dataset', nodeId: 'raw', name: 'Raw' },
  prompt('p1', 'Extract', 'answer'), { type: 'run', nodeId: 'r1', runInputToColumn: { text: 'text' } },
  { type: 'process', nodeId: 'clean', name: 'Clean', dfCode: 'def process(df): return df' },
  prompt('p2', 'Judge', 'verdict'), { type: 'run', nodeId: 'r2', runInputToColumn: { text: 'answer' } },
], connections: [
  { type: 'prompt-to-run', fromId: 'p1', toId: 'r1' }, data('raw', 'r1'), data('r1', 'clean', 'df'),
  { type: 'prompt-to-run', fromId: 'p2', toId: 'r2' }, data('clean', 'r2'),
] });
const spec = { artifacts: [
  { id: 'dataset:raw', producer: null },
  { id: 'output:llm:r1:result', producer: { job_id: 'llm:r1', port: 'result' } },
  { id: 'output:process:clean:result', producer: { job_id: 'process:clean', port: 'result' } },
  { id: 'output:llm:r2:result', producer: { job_id: 'llm:r2', port: 'result' } },
], jobs: [
  { id: 'llm:r1', type: 'llm', inputs: { data: 'dataset:raw' }, outputs: { result: ['output:llm:r1:result'] },
    config: { output_schema: { fields: [{ key: 'answer' }] }, settings: {} } },
  { id: 'process:clean', type: 'process', inputs: { df: 'output:llm:r1:result' },
    outputs: { result: ['output:process:clean:result'] }, config: { code: 'def process(df): return df' } },
  { id: 'llm:r2', type: 'llm', inputs: { data: 'output:process:clean:result' }, outputs: { result: ['output:llm:r2:result'] },
    config: { output_schema: { fields: [{ key: 'verdict' }] }, settings: {} } },
], source_map: { 'llm:r1': { node_ids: ['p1', 'r1'] }, 'process:clean': { node_ids: ['clean'] },
  'llm:r2': { node_ids: ['p2', 'r2'] } } };
const tables = {
  'dataset:raw': { headers: ['text'], rows: [['x']], column_types: ['text'], row_ids: ['row-1'] },
  'output:llm:r1:result': { headers: ['Input: #', 'Input: text', 'Output: #', 'Output: answer'], rows: [[1, 'x', 1, 'y']] },
  'output:process:clean:result': { headers: ['answer'], rows: [['Y']], column_types: ['text'] },
  'output:llm:r2:result': { headers: ['Input: #', 'Input: answer', 'Output: #', 'Output: verdict'], rows: [[1, 'Y', 1, 'ok']] },
};
const JOBS = ['llm:r1', 'process:clean', 'llm:r2'];
const pipelineRun = (runId, statuses = {}) => ({ run_id: runId, status: 'succeeded', finished_at: '2026-10-08T00:00:00Z',
  jobs: JOBS.map((job_id) => ({ job_id, status: statuses[job_id] || 'succeeded' })),
  plan: { jobs: [{ job_id: 'llm:r1', model: { model: 'test', credential_id: 'cred' } }] } });
const historySession = () => {
  const records = [];
  return { records, session: { projectId: 'project', index: { records: [] },
    async putRecord(record) { records.push(record); this.index.records.push(record); } } };
};
const importArgs = (run, session, frozen = canvas()) => ({ run, session, definition: { spec, canvas_state: frozen },
  getArtifact: async (id) => ({ artifact: { valid: true }, table: tables[id] }) });

test('a chain is imported as single-node records: Dataset content first, then references to the step before', async () => {
  const { records, session } = historySession();
  const first = await importPipelineRunHistory(importArgs(pipelineRun('a'.repeat(32)), session));
  assert.equal(first.imported, 3);
  const [extract, clean, judge] = records;
  assert.deepEqual(records.map((record) => [record.nodeId, record.kind, record.pipelineRunId]),
    [['r1', 'run', 'a'.repeat(32)], ['clean', 'process', 'a'.repeat(32)], ['r2', 'run', 'a'.repeat(32)]]);
  assert.deepEqual([...first.recordIdsByJob], [['llm:r1', extract.id], ['process:clean', clean.id], ['llm:r2', judge.id]]);

  assert.equal(extract.inputs.dataset.kind, 'dataset');
  assert.equal(extract.inputs.dataset.name, 'Raw');
  assert.deepEqual(extract.sourceRecordIds, []);
  assert.equal(extract.results.runResults[0].output.answer, 'y');
  assert.equal(extract.inputs.credentialId, 'cred');

  const [binding] = clean.inputs.bindings;
  assert.deepEqual({ ...binding, signature: undefined },
    { kind: 'step', nodeId: 'r1', port: 'result', recordId: extract.id, alias: 'df', signature: undefined });
  assert.equal(binding.signature, await stepOutputSignature({ nodeId: 'r1', recordId: extract.id, port: 'result' }));
  assert.equal(clean.inputs.primaryDatasetId, 'r1:result');
  assert.deepEqual(clean.sourceRecordIds, [extract.id]);
  assert.deepEqual(clean.summary.datasetNames, ['Extract']);
  assert.deepEqual(clean.results.dfResults.outputs.result.rows, [['Y']]);

  // A step's output is only referenced; the table the Run read is kept as its runInputContent.
  assert.deepEqual(judge.inputs.dataset, { kind: 'step', nodeId: 'clean', port: 'result', recordId: clean.id,
    signature: await stepOutputSignature({ nodeId: 'clean', recordId: clean.id, port: 'result' }) });
  assert.deepEqual(judge.sourceRecordIds, [clean.id]);
  assert.deepEqual(judge.results.runInputContent.rows, [['Y']]);
  assert.equal(judge.results.runResults[0].output.verdict, 'ok');
  assert.deepEqual(judge.summary.datasetNames, ['Clean']);

  // The live canvas signs its inputs as these records do, so every step shows this run.
  const live = canvas();
  live.nodes[0].datasetContent = structuredClone(RAW);
  const resolved = await resolveHistoryCanvasState(live, {
    index: session.index, loadRecord: async (id) => records.find((record) => record.id === id),
  });
  assert.deepEqual(resolved.currentRecordIds, { r1: extract.id, clean: clean.id, r2: judge.id });

  assert.equal((await importPipelineRunHistory(importArgs(pipelineRun('a'.repeat(32)), session))).imported, 0);
  assert.equal(records.length, 3);
});

test('an entry Dataset is recorded as the run read it, not as the canvas holds it now', async () => {
  const { records, session } = historySession();
  const frozen = canvas();
  frozen.nodes[0].datasetContent = { headers: ['text'], rows: [['edited since']], columnTypes: ['text'], rowIds: ['row-1'] };
  await importPipelineRunHistory(importArgs(pipelineRun('b'.repeat(32)), session, frozen));
  assert.deepEqual(records[0].inputs.dataset.content, RAW);
  assert.deepEqual(records[0].results.runInputContent, RAW);
});

test('a stopped run imports only the jobs that succeeded, and the rest once it is resumed', async () => {
  const { records, session } = historySession();
  const stopped = pipelineRun('c'.repeat(32), { 'process:clean': 'cancelled', 'llm:r2': 'pending' });
  assert.equal(await pipelineRunImported(stopped, session.index), false);
  assert.equal((await importPipelineRunHistory(importArgs(stopped, session))).imported, 1);
  assert.deepEqual(records.map((record) => record.nodeId), ['r1']);
  assert.equal(await pipelineRunImported(stopped, session.index), true);

  const resumed = pipelineRun('c'.repeat(32));
  assert.equal(await pipelineRunImported(resumed, session.index), false);
  assert.equal((await importPipelineRunHistory(importArgs(resumed, session))).imported, 2);
  assert.equal(records[1].inputs.bindings[0].recordId, records[0].id);
  assert.equal(await pipelineRunImported(resumed, session.index), true);
  assert.equal(await pipelineRunImported(pipelineRun('d'.repeat(32)), session.index), false);
});

test('a run made before steps connected directly is not imported', async () => {
  const session = { projectId: 'project', index: { records: [] }, putRecord: async () => { throw new Error('nothing should be saved'); } };
  const old = { ...spec, artifacts: [
    { id: 'dataset:raw', producer: null },
    { id: 'dataset:pairs', producer: { job_id: 'llm:r1', port: 'result' } },
  ] };
  await assert.rejects(
    importPipelineRunHistory({ ...importArgs(pipelineRun('e'.repeat(32)), session), definition: { spec: old, canvas_state: canvas() } }),
    { message: PIPELINE_RUN_BEFORE_DATA_FLOW },
  );
});

test('a Pipeline run without a frozen node definition is not imported', async () => {
  const definition = { spec: { jobs: [], artifacts: [], source_map: {} } };
  const session = { projectId: 'project', index: { records: [] }, putRecord: async () => { throw new Error('nothing should be saved'); } };
  await assert.rejects(
    importPipelineRunHistory({ run: { run_id: 'old-run', jobs: [] }, definition, getArtifact: async () => null, session }),
    /This Pipeline run has no frozen node definition for History import\./,
  );
});
