import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dependentHistoryIds,
  directHistoryDownstreamIds,
  directHistoryUpstreamIds,
} from '../src/runHistoryDeletion.js';
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

test('single-node records leave out Pipeline imports and analysis records, loading each record once', async () => {
  const stored = [
    { id: 'manual', nodeId: 'run', kind: 'run', signature: 'a', status: 'completed', inputs: {} },
    { id: 'piped', nodeId: 'run', kind: 'run', signature: 'a', status: 'completed', inputs: {}, pipelineRunId: 'p'.repeat(32) },
    { id: 'tidy', nodeId: 'process', kind: 'process', signature: 'c', status: 'failed', inputs: {} },
    { id: 'score', nodeId: 'score', kind: 'score', signature: 'd', status: 'completed', inputs: {} },
  ];
  let loads = 0;
  const session = new RunHistorySession({
    loadIndex: async () => ({ version: 1, records: stored.map(({ id, nodeId, kind, signature, status }) => ({ id, nodeId, kind, signature, status })) }),
    loadRecord: async (_project, id) => { loads += 1; return stored.find((record) => record.id === id); },
    saveRecord: async () => {}, saveCanvas: async () => {},
  });
  session.projectId = 'project';
  session.index = await session.storage.loadIndex('project');
  assert.deepEqual((await session.singleNodeRecords()).map((entry) => entry.id), ['manual', 'tidy']);
  await session.contentLocks({ nodes: [], connections: [] });
  assert.equal(loads, stored.length);
});

test('direct history relationships exclude more distant ancestors and descendants', () => {
  const chain = [
    ...records,
    { id: 'process-child', nodeId: 'process-child', kind: 'process', signature: 'g', status: 'completed', inputs: {}, sourceRecordIds: ['process'] },
  ];
  assert.deepEqual(new Set(directHistoryDownstreamIds(chain, 'run-old')), new Set(['process', 'score']));
  assert.deepEqual(directHistoryDownstreamIds(chain, 'process'), ['process-child']);
  assert.deepEqual(directHistoryDownstreamIds(chain, 'score'), ['review']);
  assert.deepEqual(directHistoryUpstreamIds(chain, 'review'), ['score']);
  assert.deepEqual(new Set(dependentHistoryIds(chain, 'run-old')), new Set(['run-old', 'process', 'process-child', 'score', 'review']));
});

test('a legacy Review links to one matching Score attempt instead of every identical attempt', () => {
  const repeated = [
    { id: 'score-first', nodeId: 'score', kind: 'score', signature: 'same', status: 'completed', inputs: {}, createdAt: '2026-10-06T12:00:00.000Z' },
    { id: 'score-second', nodeId: 'score', kind: 'score', signature: 'same', status: 'completed', inputs: {}, createdAt: '2026-10-06T12:01:00.000Z' },
    { id: 'review', nodeId: 'review', kind: 'review', signature: 'review', status: 'completed', inputs: { scoreNodeId: 'score', scoreSignature: 'same' }, createdAt: '2026-10-06T12:02:00.000Z' },
  ];
  assert.deepEqual(directHistoryUpstreamIds(repeated, 'review'), ['score-second']);
  assert.deepEqual(directHistoryDownstreamIds(repeated, 'score-first'), []);
  assert.deepEqual(directHistoryDownstreamIds(repeated, 'score-second'), ['review']);
});

test('new Review history saves the exact Score record it reads', async () => {
  const scoreEntry = { id: 'score-exact', nodeId: 'score', kind: 'score', signature: 'score-signature', status: 'completed' };
  let saved;
  const session = new RunHistorySession({
    loadIndex: async () => ({ version: 1, records: [scoreEntry] }),
    loadRecord: async () => null,
    saveRecord: async (_project, record) => { saved = record; },
    saveCanvas: async () => {}, createId: () => 'review-exact', now: () => '2026-10-06T12:00:00.000Z',
  });
  session.projectId = 'project';
  session.index = await session.storage.loadIndex('project');
  await session.saveAnalysis('review', 'review', {
    signature: 'review-signature',
    inputs: { scoreNodeId: 'score', scoreSignature: 'score-signature' },
  }, { reviewResult: { summary: 'done' } });
  assert.equal(saved.inputs.scoreRecordId, 'score-exact');
  assert.deepEqual(saved.sourceRecordIds, ['score-exact']);
});

test('history display includes only direct upstream and downstream records', async () => {
  const chain = [
    ...records.map((record, index) => ({ ...record, createdAt: `2026-10-06T12:0${index}:00.000Z` })),
    {
      id: 'process-current', nodeId: 'process', kind: 'process', signature: 'current', status: 'completed',
      inputs: {}, sourceRecordIds: ['run-old'], createdAt: '2026-10-06T12:05:30.000Z',
    },
    {
      id: 'process-child', nodeId: 'process-child', kind: 'process', signature: 'g', status: 'completed',
      inputs: {}, sourceRecordIds: ['process'], createdAt: '2026-10-06T12:06:00.000Z',
    },
  ];
  const session = new RunHistorySession({
    loadIndex: async () => ({ version: 1, records: chain.map(({ id, nodeId, kind, signature, status, createdAt }) => ({ id, nodeId, kind, signature, status, createdAt })) }),
    loadRecord: async (_project, id) => chain.find((record) => record.id === id),
    saveRecord: async () => {}, saveCanvas: async () => {},
  });
  session.projectId = 'project';
  session.index = await session.storage.loadIndex('project');
  const entries = await session.displayEntriesForNode('run', {
    nodes: [
      { nodeId: 'run', type: 'run', runName: 'Run source' },
      { nodeId: 'process', type: 'process', name: 'First Process' },
      { nodeId: 'process-child', type: 'process', name: 'Second Process' },
      { nodeId: 'score', type: 'score', scoreName: 'Score output' },
    ],
    connections: [],
  }, { currentRecordIds: { run: 'run-old', process: 'process-current' } });
  const entry = entries.find((item) => item.id === 'run-old');
  assert.deepEqual(entry.relationships.upstream, []);
  assert.deepEqual(new Set(entry.relationships.downstream.map((item) => item.id)), new Set(['process', 'process-current', 'score']));
  assert.equal(entry.relationships.downstream.some((item) => item.id === 'process-child'), false);
  assert.equal(entry.relationships.downstream[0].id, 'process-current');
  assert.equal(entry.relationships.downstream[0].current, true);
  assert.equal(entry.relationships.downstream.find((item) => item.id === 'process').current, false);
});
