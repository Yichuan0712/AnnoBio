import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveHistoryCanvasState } from '../src/runHistoryResolver.js';
import { planHistorySelection } from '../src/runHistorySelection.js';
import { RunHistorySession } from '../src/runHistorySession.js';
import { graph, recordGraph } from './historyGraphFixture.mjs';
import { processInputAliases, processPrimarySource } from '../src/stepInputs.js';

test('selecting a downstream record restores its ancestor inputs together', async () => {
  const migrated = await recordGraph(graph);
  const records = Object.fromEntries(migrated.records.map((record) => [record.id, record]));
  const processRecord = migrated.records.find((record) => record.nodeId === 'process');
  const changed = structuredClone(migrated.state);
  changed.nodes.find((node) => node.nodeId === 'input').datasetContent.rows[0][0] = 'new input';
  changed.nodes.find((node) => node.nodeId === 'prompt').text = 'new prompt';
  changed.nodes.find((node) => node.nodeId === 'process').dfCode = 'return df.head()';
  const selected = await planHistorySelection(changed, processRecord.id, { loadRecord: async (id) => records[id] });
  assert.equal(selected.state.nodes.find((node) => node.nodeId === 'input').datasetContent.rows[0][0], 'hello');
  assert.equal(selected.state.nodes.find((node) => node.nodeId === 'prompt').text, 'Say {{text}}');
  assert.equal(selected.state.nodes.find((node) => node.nodeId === 'process').dfCode, 'return df');
  assert.deepEqual(new Set(Object.keys(selected.selectedRecordIds)), new Set(['run', 'process']));
  assert.ok(['input', 'run', 'process'].every((id) => selected.affectedNodeIds.includes(id)));
});

const table = (value) => ({ headers: ['value'], rows: [[value]], columnTypes: ['text'], rowIds: [`row-${value}`] });
const data = (fromId, toId, alias, fromPort = 'result') => ({ type: 'data', fromId, fromPort, toId, ...(alias ? { alias } : {}) });
const step = (nodeId, recordId, alias) => ({ kind: 'step', nodeId, port: 'result', recordId, signature: `${recordId}-output`, ...(alias ? { alias } : {}) });
/** A completed Process record reading `bindings`, with one `result` output. */
const processRecord = (id, nodeId, bindings) => ({
  id, nodeId, kind: 'process', status: 'completed', signature: `${id}-signature`,
  sourceRecordIds: bindings.filter((binding) => binding.kind === 'step').map((binding) => binding.recordId),
  inputs: { code: 'return df', primaryDatasetId: bindings[0].kind === 'step' ? `${bindings[0].nodeId}:result` : bindings[0].nodeId, bindings },
  results: { dfResults: { outputs: { result: table(id) } } },
});
const entriesOf = (records) => records.map(({ id, nodeId, kind, signature }) => ({ id, nodeId, kind, signature }));

test('selecting any record of a chain switches its upstream and downstream to one lineage', async () => {
  const promptSnapshot = { nodeId: 'prompt', name: 'Prompt', text: '', outputFormat: { fields: [] } };
  const runRecord = (id) => ({
    id, nodeId: 'run', kind: 'run', status: 'completed', signature: `${id}-signature`, sourceRecordIds: [],
    inputs: { prompt: promptSnapshot, dataset: { kind: 'dataset', nodeId: 'raw', name: 'Raw', content: table('raw'), signature: 'raw' }, mapping: {} },
    results: { runResults: [], runInputContent: table('raw') },
  });
  const records = [
    runRecord('run-old'), runRecord('run-current'),
    processRecord('tidy-old', 'tidy', [step('run', 'run-old', 'df')]),
    processRecord('tidy-current', 'tidy', [step('run', 'run-current', 'df')]),
    processRecord('check-old', 'check', [step('tidy', 'tidy-old', 'df')]),
    processRecord('check-current', 'check', [step('tidy', 'tidy-current', 'df')]),
  ];
  const state = {
    version: 3,
    nodes: [
      { type: 'prompt', nodeId: 'prompt', text: '', outputFormat: { fields: [] } },
      { type: 'dataset', nodeId: 'raw', datasetContent: table('raw') },
      { type: 'run', nodeId: 'run', historyRecordId: 'run-current' },
      { type: 'process', nodeId: 'tidy', historyRecordId: 'tidy-current', dfCode: 'return df' },
      { type: 'process', nodeId: 'check', historyRecordId: 'check-current', dfCode: 'return df' },
    ],
    connections: [{ type: 'prompt-to-run', fromId: 'prompt', toId: 'run' }, data('raw', 'run'), data('run', 'tidy', 'df'), data('tidy', 'check', 'df')],
  };
  const byId = Object.fromEntries(records.map((record) => [record.id, record]));
  const plan = (current, recordId) => planHistorySelection(current, recordId, { loadRecord: async (id) => byId[id], recordEntries: entriesOf(records) });
  const selected = await plan(state, 'tidy-old');
  assert.deepEqual(selected.selectedRecordIds, { tidy: 'tidy-old', run: 'run-old', check: 'check-old' });
  for (const [nodeId, recordId] of [['run', 'run-old'], ['tidy', 'tidy-old'], ['check', 'check-old']]) {
    assert.equal(selected.state.nodes.find((node) => node.nodeId === nodeId).historyRecordId, recordId);
  }
  // Only the records change; the steps keep reading each other.
  assert.deepEqual(selected.state.connections.filter((edge) => edge.type === 'data'), state.connections.filter((edge) => edge.type === 'data'));

  const restored = await plan(selected.state, 'tidy-current');
  assert.deepEqual(restored.selectedRecordIds, { tidy: 'tidy-current', run: 'run-current', check: 'check-current' });
  for (const rootId of ['run-old', 'check-old']) {
    assert.deepEqual((await plan(state, rootId)).selectedRecordIds, { run: 'run-old', tidy: 'tidy-old', check: 'check-old' });
  }
});

test('selecting a multi-input Process history switches every upstream input lineage', async () => {
  const seeded = (id, nodeId, value) => processRecord(id, nodeId, [{ kind: 'dataset', nodeId: `${nodeId}-seed`, name: nodeId, content: table(value), signature: value, alias: 'df' }]);
  const merge = (id, suffix) => processRecord(id, 'merge', [step('left', `left-${suffix}`, 'df'), step('right', `right-${suffix}`, 'df_candidates')]);
  const records = [
    seeded('left-old', 'left', 'left-old'), seeded('left-current', 'left', 'left-current'),
    seeded('right-old', 'right', 'right-old'), seeded('right-current', 'right', 'right-current'),
    merge('merge-old', 'old'), merge('merge-current', 'current'),
  ];
  const state = {
    version: 3,
    nodes: [
      { type: 'dataset', nodeId: 'left-seed', datasetContent: table('left-current') },
      { type: 'dataset', nodeId: 'right-seed', datasetContent: table('right-current') },
      { type: 'process', nodeId: 'left', historyRecordId: 'left-current', dfCode: 'return df' },
      { type: 'process', nodeId: 'right', historyRecordId: 'right-current', dfCode: 'return df' },
      { type: 'process', nodeId: 'merge', historyRecordId: 'merge-current', dfCode: 'return df' },
    ],
    connections: [data('left-seed', 'left', 'df'), data('right-seed', 'right', 'df'), data('left', 'merge', 'df'), data('right', 'merge', 'df_candidates')],
  };
  const byId = Object.fromEntries(records.map((record) => [record.id, record]));
  const selected = await planHistorySelection(state, 'merge-old', { loadRecord: async (id) => byId[id], recordEntries: entriesOf(records) });
  assert.deepEqual(selected.selectedRecordIds, { merge: 'merge-old', left: 'left-old', right: 'right-old' });
  assert.deepEqual(selected.state.nodes.find((node) => node.nodeId === 'left-seed').datasetContent, table('left-old'));
  assert.equal(processPrimarySource(selected.state, 'merge').nodeId, 'left');
  assert.equal(processInputAliases(selected.state, 'merge')['right:result'], 'df_candidates');
  const resolved = await resolveHistoryCanvasState(selected.state, { index: { records: entriesOf(records) }, loadRecord: async (id) => byId[id] });
  assert.deepEqual(resolved.currentRecordIds, { left: 'left-old', right: 'right-old', merge: 'merge-old' });
  assert.equal(resolved.missingResultNodeIds.includes('merge'), false);
});

test('history selection rejects conflicting shared Dataset requirements atomically', async () => {
  const migrated = await recordGraph(graph);
  const processRecord = structuredClone(migrated.records.find((record) => record.nodeId === 'process'));
  const runRecord = migrated.records.find((record) => record.nodeId === 'run');
  const first = { ...structuredClone(runRecord.inputs.dataset), alias: 'df' };
  const second = { ...structuredClone(first), alias: 'df_input' };
  second.content.rows[0][0] = 'other input';
  processRecord.inputs = { ...processRecord.inputs, primaryDatasetId: 'input', bindings: [first, second] };
  const before = structuredClone(migrated.state);
  await assert.rejects(
    planHistorySelection(before, processRecord.id, { loadRecord: async () => processRecord }),
    /conflicts at dataset node input/,
  );
  assert.deepEqual(before, migrated.state);
});

test('history selection blocks a running affected descendant', async () => {
  const migrated = await recordGraph(graph);
  const records = Object.fromEntries(migrated.records.map((record) => [record.id, record]));
  const processRecord = migrated.records.find((record) => record.nodeId === 'process');
  const changed = structuredClone(migrated.state);
  changed.nodes.find((node) => node.nodeId === 'input').datasetContent.rows[0][0] = 'new input';
  await assert.rejects(
    planHistorySelection(changed, processRecord.id, { loadRecord: async (id) => records[id], runningNodeIds: ['process'] }),
    /while node process is running/,
  );
  await assert.rejects(
    planHistorySelection(migrated.state, processRecord.id, { loadRecord: async (id) => records[id], runningNodeIds: ['process'] }),
    /while node process is running/,
  );
});

test('completed inputs create a new attempt and History can select either identical-input result', async () => {
  const migrated = await recordGraph(graph);
  const records = new Map(migrated.records.map((record) => [record.id, record]));
  let nextId = 900;
  const storage = {
    loadIndex: async () => ({ version: 1, records: [...records.values()].map(({ id, nodeId, kind, signature, status }) => ({ id, nodeId, kind, signature, status })) }),
    loadRecord: async (_project, id) => records.get(id),
    saveRecord: async (_project, record) => { records.set(record.id, record); },
    saveCanvas: async () => {},
  };
  const session = new RunHistorySession({ ...storage, createId: () => String(++nextId).padStart(32, '0'), now: () => '2026-10-02T00:00:00Z' });
  await session.open('project', migrated.state);
  const previous = migrated.records.find((record) => record.nodeId === 'run');
  const rerun = await session.reserve(migrated.state, 'run');
  assert.equal(rerun.mode, 'rerun');
  assert.notEqual(rerun.record.id, previous.id);
  assert.equal(rerun.record.signature, previous.signature);
  assert.equal(records.size, 3);
  await session.putRecord({ ...rerun.record, status: 'completed', results: previous.results });
  const latest = await session.resolve(migrated.state);
  assert.equal(latest.currentRecordIds.run, rerun.record.id);
  const selected = await session.select(previous.id, migrated.state);
  assert.equal(selected.currentRecordIds.run, previous.id);
  assert.equal(selected.state.nodes.find((node) => node.nodeId === 'run').historyRecordId, previous.id);

  const changed = structuredClone(migrated.state);
  changed.nodes.find((node) => node.nodeId === 'input').datasetContent.rows[0][0] = 'another input';
  const reserved = await session.reserve(changed, 'run');
  assert.equal(reserved.mode, 'new');
  assert.equal(reserved.record.status, 'running');
  assert.equal(records.size, 4);
  await assert.rejects(session.reserve(changed, 'run'), /already have a running job/);
});

test('fresh execution preserves stopped Generate and Process attempts instead of resuming or rewriting them', async () => {
  for (const nodeId of ['run', 'process']) {
    const migrated = await recordGraph(graph);
    const records = new Map(migrated.records.map(record => [record.id, structuredClone(record)]));
    const original = [...records.values()].find(record => record.nodeId === nodeId);
    original.status = 'stopped';
    const before = structuredClone(original);
    const state = structuredClone(migrated.state);
    state.nodes.find(node => node.nodeId === nodeId).historyRecordId = original.id;
    const session = new RunHistorySession({
      loadIndex: async () => ({ version: 1, records: [...records.values()].map(({ id, nodeId, kind, signature, status }) => ({ id, nodeId, kind, signature, status })) }),
      loadRecord: async (_project, id) => records.get(id),
      saveRecord: async (_project, record) => records.set(record.id, record),
      saveCanvas: async () => {},
      createId: () => '99999999999999999999999999999999',
    });
    const resolved = await session.open('project', state);
    const fresh = await session.reserve(resolved.state, nodeId, { fresh: true });
    assert.notEqual(fresh.record.id, original.id);
    assert.equal(fresh.record.signature, original.signature);
    assert.deepEqual(records.get(original.id), before);
    if (nodeId === 'run') assert.deepEqual(fresh.record.results.runResults, []);
    else assert.equal(fresh.record.results.dfResults, null);
    await assert.rejects(session.reserve(resolved.state, nodeId, { fresh: true }), /already have a running job/);
  }
});
