import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveHistoryCanvasState } from '../src/runHistoryResolver.js';
import { planHistorySelection } from '../src/runHistorySelection.js';
import { RunHistorySession } from '../src/runHistorySession.js';
import { graph, recordGraph } from './historyGraphFixture.mjs';

test('selecting a downstream record restores its ancestor inputs together', async () => {
  const migrated = await recordGraph(graph);
  const records = Object.fromEntries(migrated.records.map((record) => [record.id, record]));
  const processRecord = migrated.records.find((record) => record.nodeId === 'process');
  const changed = structuredClone(migrated.state);
  changed.nodes.find((node) => node.nodeId === 'input').datasetContent.rows[0][0] = 'new input';
  changed.nodes.find((node) => node.nodeId === 'prompt').sections[0].content = 'new prompt';
  changed.nodes.find((node) => node.nodeId === 'process').dfCode = 'return df.head()';
  const selected = await planHistorySelection(changed, processRecord.id, { loadRecord: async (id) => records[id] });
  assert.equal(selected.state.nodes.find((node) => node.nodeId === 'input').datasetContent.rows[0][0], 'hello');
  assert.equal(selected.state.nodes.find((node) => node.nodeId === 'prompt').sections[0].content, 'Say {{text}}');
  assert.equal(selected.state.nodes.find((node) => node.nodeId === 'process').dfCode, 'return df');
  assert.deepEqual(new Set(Object.keys(selected.selectedRecordIds)), new Set(['run', 'process']));
  assert.deepEqual(new Set(selected.affectedNodeIds).has('process-dataset'), true);
});

test('selecting Pipeline history switches its upstream, outputs, and downstream to one lineage', async () => {
  const table = (value) => ({ headers: ['value'], rows: [[value]], columnTypes: ['text'], rowIds: [`row-${value}`] });
  const promptSnapshot = { nodeId: 'prompt', name: 'Prompt', sections: [], outputFormat: { fields: [] }, inputTypes: {} };
  const records = [
    {
      id: 'run-old', nodeId: 'run', kind: 'run', signature: 'run-old-signature', inputs: {
        prompt: promptSnapshot, dataset: { nodeId: 'raw', name: 'Raw', content: table('raw'), signature: 'raw-signature' }, mapping: {},
      }, sourceRecordIds: [],
    },
    {
      id: 'run-current', nodeId: 'run', kind: 'run', signature: 'run-current-signature', inputs: {
        prompt: promptSnapshot, dataset: { nodeId: 'raw', name: 'Raw', content: table('raw'), signature: 'raw-signature' }, mapping: {},
      }, sourceRecordIds: [],
    },
    {
      id: 'tidy-old', nodeId: 'tidy', kind: 'process', signature: 'tidy-old-signature', inputs: {
        code: 'return df', primaryDatasetId: 'run-copy',
        bindings: [{ nodeId: 'run-copy', name: 'Run output (Copy)', content: table('old-run'), signature: 'copy', alias: 'df', upstreamPipelineRecordId: 'run-old' }],
      }, sourceRecordIds: ['run-old'],
    },
    {
      id: 'tidy-current', nodeId: 'tidy', kind: 'process', signature: 'tidy-current-signature', inputs: {
        code: 'return df', primaryDatasetId: 'run-live',
        bindings: [{ nodeId: 'run-live', name: 'Run output', content: table('current-run'), signature: 'live', alias: 'df', sourceRecordId: 'run-current', sourceNodeId: 'run', branch: 'result' }],
      }, sourceRecordIds: ['run-current'],
    },
    {
      id: 'check-old', nodeId: 'check', kind: 'process', signature: 'check-old-signature', inputs: {
        code: 'return df', primaryDatasetId: 'tidy-copy',
        bindings: [{ nodeId: 'tidy-copy', name: 'Tidy output (Copy)', content: table('old-tidy'), signature: 'copy', alias: 'df', upstreamPipelineRecordId: 'tidy-old' }],
      }, sourceRecordIds: ['tidy-old'],
    },
    {
      id: 'check-current', nodeId: 'check', kind: 'process', signature: 'check-current-signature', inputs: {
        code: 'return df', primaryDatasetId: 'tidy-live',
        bindings: [{ nodeId: 'tidy-live', name: 'Tidy output', content: table('current-tidy'), signature: 'live', alias: 'df', sourceRecordId: 'tidy-current', sourceNodeId: 'tidy', branch: 'result' }],
      }, sourceRecordIds: ['tidy-current'],
    },
  ];
  const state = {
    nodes: [
      { type: 'prompt', nodeId: 'prompt', sections: [], outputFormat: { fields: [] }, inputTypes: {} },
      { type: 'dataset', nodeId: 'raw', datasetContent: table('raw') },
      { type: 'run', nodeId: 'run', historyRecordId: 'run-current', runWorkingSetId: 'raw' },
      { type: 'dataset', nodeId: 'run-live', sourceRunNodeId: 'run', snapshotSourceRecordId: 'run-current', datasetContent: table('current-run') },
      { type: 'dataset', nodeId: 'run-copy', sourceRunNodeId: 'run', savedCopy: true, snapshotSourceRecordId: 'run-old', datasetContent: table('old-run') },
      { type: 'process', nodeId: 'tidy', historyRecordId: 'tidy-current', primaryDatasetId: 'run-live', dfCode: 'return df' },
      { type: 'dataset', nodeId: 'tidy-live', processOutputName: 'result', snapshotSourceRecordId: 'tidy-current', datasetContent: table('current-tidy') },
      { type: 'dataset', nodeId: 'tidy-current-copy', processOutputName: 'result', savedCopy: true,
        snapshotSourceRecordId: 'tidy-current', datasetContent: table('current-tidy') },
      { type: 'dataset', nodeId: 'tidy-copy', processOutputName: 'result', savedCopy: true, snapshotSourceRecordId: 'tidy-old', datasetContent: table('old-tidy') },
      { type: 'process', nodeId: 'check', historyRecordId: 'check-current', primaryDatasetId: 'tidy-live', dfCode: 'return df' },
    ],
    connections: [
      { type: 'prompt-to-run', fromId: 'prompt', toId: 'run' },
      { type: 'dataset-to-process', fromId: 'run-live', toId: 'tidy' },
      { type: 'process-to-dataset', fromId: 'tidy', toId: 'tidy-live' },
      { type: 'process-to-dataset', fromId: 'tidy', toId: 'tidy-current-copy' },
      { type: 'process-to-dataset', fromId: 'tidy', toId: 'tidy-copy' },
      { type: 'dataset-to-process', fromId: 'tidy-live', toId: 'check' },
    ],
  };
  const byId = Object.fromEntries(records.map((record) => [record.id, record]));
  const selected = await planHistorySelection(state, 'tidy-old', {
    loadRecord: async (id) => byId[id],
    recordEntries: records.map(({ id, nodeId, kind, signature }) => ({ id, nodeId, kind, signature })),
  });
  assert.deepEqual(selected.selectedRecordIds, { tidy: 'tidy-old', run: 'run-old', check: 'check-old' });
  assert.equal(selected.state.nodes.find((node) => node.nodeId === 'run').historyRecordId, 'run-old');
  assert.equal(selected.state.nodes.find((node) => node.nodeId === 'tidy').historyRecordId, 'tidy-old');
  assert.equal(selected.state.nodes.find((node) => node.nodeId === 'check').historyRecordId, 'check-old');
  assert.ok(selected.state.connections.some((edge) => edge.type === 'dataset-to-process' && edge.fromId === 'run-copy' && edge.toId === 'tidy'));
  assert.ok(selected.state.connections.some((edge) => edge.type === 'dataset-to-process' && edge.fromId === 'tidy-copy' && edge.toId === 'check'));
  assert.equal(selected.state.nodes.find((node) => node.nodeId === 'run-copy').savedCopy, true);
  assert.equal(selected.state.nodes.find((node) => node.nodeId === 'run-copy').sourceRunNodeId, 'run');
  assert.equal(selected.state.nodes.find((node) => node.nodeId === 'run-live').savedCopy, undefined);
  assert.ok(selected.state.connections.some((edge) => edge.type === 'run-to-dataset-snapshot' && edge.toId === 'run-live'));
  assert.equal(selected.state.nodes.find((node) => node.nodeId === 'tidy-copy').savedCopy, true);
  assert.ok(selected.state.connections.some((edge) => edge.type === 'process-to-dataset' && edge.fromId === 'tidy' && edge.toId === 'tidy-copy'));
  assert.equal(selected.state.nodes.find((node) => node.nodeId === 'tidy-live').savedCopy, undefined);
  assert.ok(selected.state.connections.some((edge) => edge.type === 'process-to-dataset-snapshot' && edge.fromId === 'tidy' && edge.toId === 'tidy-live'));

  const restored = await planHistorySelection(selected.state, 'tidy-current', {
    loadRecord: async (id) => byId[id],
    recordEntries: records.map(({ id, nodeId, kind, signature }) => ({ id, nodeId, kind, signature })),
  });
  assert.deepEqual(restored.selectedRecordIds, { tidy: 'tidy-current', run: 'run-current', check: 'check-current' });
  assert.ok(restored.state.connections.some((edge) => edge.type === 'dataset-to-process' && edge.fromId === 'run-live' && edge.toId === 'tidy'));
  assert.ok(restored.state.connections.some((edge) => edge.type === 'dataset-to-process' && edge.fromId === 'tidy-live' && edge.toId === 'check'));
  assert.equal(restored.state.nodes.find((node) => node.nodeId === 'run-live').sourceRunNodeId, 'run');
  assert.ok(restored.state.connections.some((edge) => edge.type === 'process-to-dataset' && edge.fromId === 'tidy' && edge.toId === 'tidy-live'));
  assert.deepEqual(restored.state.connections.filter((edge) => (
    edge.type === 'process-to-dataset' && edge.fromId === 'tidy'
  )).map((edge) => edge.toId), ['tidy-live']);
  assert.ok(restored.state.connections.some((edge) => (
    edge.type === 'process-to-dataset-snapshot' && edge.fromId === 'tidy' && edge.toId === 'tidy-current-copy'
  )));

  for (const rootId of ['run-old', 'check-old']) {
    const lineage = await planHistorySelection(state, rootId, {
      loadRecord: async (id) => byId[id],
      recordEntries: records.map(({ id, nodeId, kind, signature }) => ({ id, nodeId, kind, signature })),
    });
    assert.deepEqual(lineage.selectedRecordIds, { run: 'run-old', tidy: 'tidy-old', check: 'check-old' });
  }
});

test('selecting a multi-input Process history switches every upstream input lineage', async () => {
  const table = (value) => ({ headers: ['value'], rows: [[value]], columnTypes: ['text'], rowIds: [`row-${value}`] });
  const processRecord = (id, nodeId, inputId, value) => ({
    id, nodeId, kind: 'process', signature: `${id}-signature`, sourceRecordIds: [],
    inputs: { code: 'return df', primaryDatasetId: inputId,
      bindings: [{ nodeId: inputId, name: inputId, content: table(value), signature: `${id}-input`, alias: 'df' }] },
  });
  const leftOld = processRecord('left-old', 'left', 'left-seed', 'left-old');
  const leftCurrent = processRecord('left-current', 'left', 'left-seed', 'left-current');
  const rightOld = processRecord('right-old', 'right', 'right-seed', 'right-old');
  const rightCurrent = processRecord('right-current', 'right', 'right-seed', 'right-current');
  const merge = (id, leftId, leftRecordId, rightId, rightRecordId, suffix) => ({
    id, nodeId: 'merge', kind: 'process', signature: `${id}-signature`,
    sourceRecordIds: [leftRecordId, rightRecordId],
    inputs: {
      code: 'return df_candidates', primaryDatasetId: leftId,
      bindings: [
        { nodeId: leftId, name: leftId, content: table(`left-${suffix}`), signature: `left-${suffix}`,
          alias: 'df', upstreamPipelineRecordId: leftRecordId },
        { nodeId: rightId, name: rightId, content: table(`right-${suffix}`), signature: `right-${suffix}`,
          alias: 'df_candidates', upstreamPipelineRecordId: rightRecordId },
      ],
    },
  });
  // Legacy Pipeline History recorded the original Dataset IDs even though published copies exist.
  const mergeOld = merge('merge-old', 'left-live', 'left-old', 'right-live', 'right-old', 'old');
  const mergeCurrent = merge('merge-current', 'left-live', 'left-current', 'right-live', 'right-current', 'current');
  const records = [leftOld, leftCurrent, rightOld, rightCurrent, mergeOld, mergeCurrent];
  const state = {
    nodes: [
      { type: 'dataset', nodeId: 'left-seed', datasetContent: table('left-seed') },
      { type: 'dataset', nodeId: 'right-seed', datasetContent: table('right-seed') },
      { type: 'process', nodeId: 'left', historyRecordId: 'left-current', primaryDatasetId: 'left-seed', dfCode: 'return df' },
      { type: 'process', nodeId: 'right', historyRecordId: 'right-current', primaryDatasetId: 'right-seed', dfCode: 'return df' },
      { type: 'dataset', nodeId: 'left-live', name: 'Left', processOutputName: 'result', snapshotSourceRecordId: 'left-current', datasetContent: table('left-current') },
      { type: 'dataset', nodeId: 'left-copy', name: 'Left', processOutputName: 'result', savedCopy: true, snapshotSourceRecordId: 'left-old', datasetContent: table('left-old') },
      { type: 'dataset', nodeId: 'right-live', name: 'Candidates', processOutputName: 'result', snapshotSourceRecordId: 'right-current', datasetContent: table('right-current') },
      { type: 'dataset', nodeId: 'right-copy', name: 'Candidates', processOutputName: 'result', savedCopy: true, snapshotSourceRecordId: 'right-old', datasetContent: table('right-old') },
      { type: 'process', nodeId: 'merge', historyRecordId: 'merge-current', primaryDatasetId: 'left-live', dfCode: 'return df_candidates' },
    ],
    connections: [
      { type: 'dataset-to-process', fromId: 'left-seed', toId: 'left' },
      { type: 'dataset-to-process', fromId: 'right-seed', toId: 'right' },
      { type: 'process-to-dataset', fromId: 'left', toId: 'left-live' },
      { type: 'process-to-dataset-snapshot', fromId: 'left', toId: 'left-copy' },
      { type: 'process-to-dataset', fromId: 'right', toId: 'right-live' },
      { type: 'process-to-dataset-snapshot', fromId: 'right', toId: 'right-copy' },
      { type: 'dataset-to-process', fromId: 'left-live', toId: 'merge' },
      { type: 'dataset-to-process', fromId: 'right-live', toId: 'merge' },
    ],
  };
  const byId = Object.fromEntries(records.map((record) => [record.id, record]));
  const selected = await planHistorySelection(state, 'merge-old', {
    loadRecord: async (id) => byId[id],
    recordEntries: records.map(({ id, nodeId, kind, signature }) => ({ id, nodeId, kind, signature })),
  });
  assert.deepEqual(selected.selectedRecordIds, { merge: 'merge-old', left: 'left-old', right: 'right-old' });
  assert.equal(selected.state.nodes.find((node) => node.nodeId === 'merge').primaryDatasetId, 'left-copy');
  assert.equal(JSON.parse(selected.state.nodes.find((node) => node.nodeId === 'merge').datasetAliases)['right-copy'], 'df_candidates');
  assert.deepEqual(selected.state.connections.filter((edge) => (
    edge.type === 'dataset-to-process' && edge.toId === 'merge'
  )).map((edge) => edge.fromId).sort(), ['left-copy', 'right-copy']);
  assert.deepEqual(selected.state.connections.filter((edge) => edge.type === 'process-to-dataset').map((edge) => edge.toId).sort(),
    ['left-copy', 'right-copy']);
  const resolved = await resolveHistoryCanvasState(selected.state, {
    index: { records: records.map(({ id, nodeId, kind, signature }) => ({ id, nodeId, kind, signature })) },
    loadRecord: async (id) => byId[id],
  });
  assert.equal(resolved.currentRecordIds.merge, 'merge-old');
  assert.equal(resolved.state.nodes.find((node) => node.nodeId === 'merge').historyRecordId, 'merge-old');
  assert.equal(resolved.missingResultNodeIds.includes('merge'), false);
});

test('history selection rejects conflicting shared Dataset requirements atomically', async () => {
  const migrated = await recordGraph(graph);
  const processRecord = structuredClone(migrated.records.find((record) => record.nodeId === 'process'));
  const first = structuredClone(processRecord.inputs.bindings[0]);
  delete first.sourceRecordId;
  delete first.sourceNodeId;
  delete first.branch;
  const second = structuredClone(first);
  second.content.rows[0][0] = 'other input';
  processRecord.inputs.bindings = [first, second];
  const before = structuredClone(migrated.state);
  await assert.rejects(
    planHistorySelection(before, processRecord.id, { loadRecord: async () => processRecord }),
    /conflicts at dataset node run-dataset/,
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
