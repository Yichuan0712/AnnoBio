import test from 'node:test';
import assert from 'node:assert/strict';

import { RunHistorySession } from '../src/runHistorySession.js';
import { graph, recordGraph } from './historyGraphFixture.mjs';

function memorySession(initialRecords = []) {
  const records = new Map(initialRecords.map((record) => [record.id, record]));
  const savedCanvases = [];
  let nextId = 100;
  const session = new RunHistorySession({
    loadIndex: async () => ({ version: 1, records: [...records.values()].map(({ id, nodeId, kind, signature, status }) => ({ id, nodeId, kind, signature, status })) }),
    loadRecord: async (_project, id) => records.get(id),
    saveRecord: async (_project, record) => { records.set(record.id, record); },
    saveCanvas: async (_project, state) => { savedCanvases.push(state); },
    createId: () => String(++nextId).padStart(32, '0'), now: () => '2026-10-02T00:00:00Z',
  });
  return { session, records, savedCanvases };
}

test('opening a canvas saved before History marks it as using History without turning cached results into records', async () => {
  const { session, records, savedCanvases } = memorySession();
  const opened = await session.open('project', graph);
  assert.equal(savedCanvases.length, 1);
  assert.equal(savedCanvases[0].historyVersion, 1);
  assert.equal(graph.historyVersion, undefined);
  assert.equal(records.size, 0);
  assert.deepEqual(new Set(opened.missingResultNodeIds), new Set(['run', 'process']));
  assert.equal(opened.state.nodes.find((node) => node.nodeId === 'run').runResults, undefined);
  assert.equal(opened.state.nodes.find((node) => node.nodeId === 'process').dfResults, undefined);
});

test('opening a new empty project marks it as using History', async () => {
  const { session, savedCanvases } = memorySession();
  const opened = await session.open('project', { nodes: [], connections: [] });
  assert.equal(savedCanvases.length, 1);
  assert.equal(savedCanvases[0].historyVersion, 1);
  assert.deepEqual(opened.state.nodes, []);
});

test('opening a canvas that already uses History does not save it again', async () => {
  const recorded = await recordGraph(graph);
  const { session, savedCanvases } = memorySession(recorded.records);
  const opened = await session.open('project', recorded.state);
  assert.equal(savedCanvases.length, 0);
  assert.deepEqual(Object.keys(opened.currentRecordIds).sort(), ['process', 'run']);
});

test('nodes merged in with cached results but no records show no result', async () => {
  const recorded = await recordGraph(graph);
  const incoming = structuredClone(graph);
  incoming.nodes.forEach((node) => {
    node.nodeId = `new-${node.nodeId}`;
  });
  incoming.connections.forEach((edge) => { edge.fromId = `new-${edge.fromId}`; edge.toId = `new-${edge.toId}`; });
  const merged = { historyVersion: 1, nodes: [...recorded.state.nodes, ...incoming.nodes], connections: [...recorded.state.connections, ...incoming.connections] };
  const { session, records } = memorySession(recorded.records);
  const opened = await session.open('project', merged);
  assert.equal(records.size, 2);
  assert.deepEqual(Object.keys(opened.currentRecordIds).sort(), ['process', 'run']);
  assert.deepEqual(new Set(opened.missingResultNodeIds), new Set(['new-run', 'new-process']));
  assert.equal(opened.state.nodes.find((node) => node.nodeId === 'new-run').runResults, undefined);
});
