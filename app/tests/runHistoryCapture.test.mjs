import test from 'node:test';
import assert from 'node:assert/strict';

import { captureHistoryInput, runningHistoryRecord } from '../src/runHistoryCapture.js';
import { graph, recordGraph } from './historyGraphFixture.mjs';

test('new execution captures current upstream record IDs and a frozen input snapshot', async () => {
  const migrated = await recordGraph(graph);
  const records = Object.fromEntries(migrated.records.map((record) => [record.id, record]));
  const index = { records: migrated.records.map(({ id, nodeId, kind, signature }) => ({ id, nodeId, kind, signature })) };
  const capture = await captureHistoryInput(migrated.state, 'process', { index, loadRecord: async (id) => records[id] });
  const upstream = migrated.records.find((record) => record.nodeId === 'run');
  assert.deepEqual(capture.sourceRecordIds, [upstream.id]);
  assert.equal(capture.inputs.bindings[0].sourceRecordId, upstream.id);
  const item = runningHistoryRecord(capture, { createId: () => 'f'.repeat(32), now: () => '2026-10-01T00:00:00Z' });
  assert.equal(item.status, 'running');
  assert.equal(item.id, 'f'.repeat(32));
  migrated.state.nodes.find((node) => node.nodeId === 'run-dataset').datasetContent.rows[0][0] = 'changed';
  assert.notEqual(capture.inputs.bindings[0].content.rows[0][0], 'changed');
});

test('capture blocks a Process whose derived input has no current result', async () => {
  const migrated = await recordGraph(graph);
  const records = Object.fromEntries(migrated.records.map((record) => [record.id, record]));
  const index = { records: migrated.records.map(({ id, nodeId, kind, signature }) => ({ id, nodeId, kind, signature })) };
  const changed = structuredClone(migrated.state);
  changed.nodes.find((node) => node.nodeId === 'input').datasetContent.rows[0][0] = 'different';
  await assert.rejects(
    captureHistoryInput(changed, 'process', { index, loadRecord: async (id) => records[id] }),
    /Input Dataset has no current result/,
  );
});
