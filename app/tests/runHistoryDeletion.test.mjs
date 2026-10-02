import test from 'node:test';
import assert from 'node:assert/strict';
import { dependentHistoryIds } from '../src/runHistoryDeletion.js';
import { RunHistorySession } from '../src/runHistorySession.js';

const records = [
  { id: 'run-old', nodeId: 'run', kind: 'run', signature: 'a', status: 'completed', inputs: {} },
  { id: 'run-current', nodeId: 'run', kind: 'run', signature: 'b', status: 'completed', inputs: {} },
  { id: 'process', nodeId: 'process', kind: 'process', signature: 'c', status: 'completed', inputs: {}, sourceRecordIds: ['run-old'] },
  { id: 'score', nodeId: 'score', kind: 'score', signature: 'd', status: 'completed', inputs: { runRecordId: 'run-old' } },
  { id: 'review', nodeId: 'review', kind: 'review', signature: 'e', status: 'completed', inputs: { scoreSignature: 'd' } },
  { id: 'other', nodeId: 'other', kind: 'process', signature: 'f', status: 'completed', inputs: {}, sourceRecordIds: ['run-current'] },
];

test('deleting a historical Run cascades through Process, Score and Review only', () => {
  assert.deepEqual(new Set(dependentHistoryIds(records, 'run-old')), new Set(['run-old', 'process', 'score', 'review']));
  assert.deepEqual(dependentHistoryIds(records, 'review'), ['review']);
  assert.throws(() => dependentHistoryIds(records, 'missing'), /not found/);
});

test('deletion rejects a current or running dependent record', async () => {
  const session = new RunHistorySession({
    loadIndex: async () => ({ version: 1, records: records.map(({ id, nodeId, kind, signature, status }) => ({ id, nodeId, kind, signature, status })) }),
    loadRecord: async (_project, id) => records.find((record) => record.id === id),
    saveRecord: async () => {}, saveCanvas: async () => {},
  });
  session.projectId = 'project';
  session.index = await session.storage.loadIndex('project');
  session.resolve = async (state) => ({ state, currentRecordIds: { run: 'run-current' } });
  const state = { nodes: [], connections: [] };
  const plan = await session.planDelete('run-old', state);
  assert.equal(plan.records.length, 4);
  await assert.rejects(session.planDelete('run-current', state), /current result/);
  await assert.rejects(session.planDelete('run-old', state, { runningNodeIds: ['process'] }), /running/);
});
