import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ProjectAssets } from '../src/projectAssets.js';
import { datasetSignature, processInputSignature, runInputSignature } from '../src/runHistorySignature.js';
import { collectHistoryAssetIds } from '../src/runHistoryAssets.js';

const newAssets = () => new ProjectAssets({ decodeImage: () => {}, registerSession: () => {} });
const record = (nodeId, signature) => ({
  id: crypto.randomUUID().replaceAll('-', ''), nodeId, kind: 'run', signature,
  inputs: { prompt: 'hello' }, status: 'completed', results: [{ output: 'world' }],
});

test('history signatures distinguish Dataset identity and normalize object key order', async () => {
  const content = { headers: ['text'], rows: [['hello']], columnTypes: ['text'], rowIds: ['row-1'] };
  const first = await datasetSignature({ nodeId: 'dataset-1', content });
  const same = await datasetSignature({ nodeId: 'dataset-1', content: { rows: [['hello']], rowIds: ['row-1'], columnTypes: ['text'], headers: ['text'] } });
  const second = await datasetSignature({ nodeId: 'dataset-2', content });
  assert.equal(first, same);
  assert.notEqual(first, second);

  const run = await runInputSignature({ promptNodeId: 'prompt-1', prompt: { sections: [{ content: 'Hi' }] }, datasetNodeId: 'dataset-1', datasetSignature: first, mapping: { name: 'text' } });
  const changed = await runInputSignature({ promptNodeId: 'prompt-1', prompt: { sections: [{ content: 'Hello' }] }, datasetNodeId: 'dataset-1', datasetSignature: first, mapping: { name: 'text' } });
  assert.notEqual(run, changed);

  const bindings = [{ nodeId: 'dataset-1', alias: 'df', signature: first }, { nodeId: 'dataset-2', alias: 'df_other', signature: second }];
  assert.equal(
    await processInputSignature({ code: 'return df', primaryDatasetId: 'dataset-1', bindings }),
    await processInputSignature({ code: 'return df', primaryDatasetId: 'dataset-1', bindings: bindings.slice().reverse() }),
  );
});

test('desktop .yc canvas save, Save As and merge retain history', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'annobio-history-test-'));
  try {
    const original = path.join(root, 'original.yc');
    const copy = path.join(root, 'copy.yc');
    const source = path.join(root, 'source.yc');
    const assets = newAssets();
    const state = { historyVersion: 1, zoomLevel: 1.35, nodes: [{ nodeId: 'run-1', type: 'run' },
      { nodeId: 'dataset-1', type: 'dataset' }],
    connections: [{ fromId: 'dataset-1', fromPort: 'result', toId: 'run-1', type: 'data' }] };
    await assets.save(original, state);
    const first = record('run-1', 'signature-1');
    await assets.saveHistoryRecord(original, first);
    const agentSession = { format_version: 2, activeConversationId: 'chat-1', conversations: [{ id: 'chat-1', messages: [] }] };
    await assets.saveAgentSession(original, agentSession);
    await assets.save(original, state);
    assert.deepEqual(await assets.loadHistoryRecord(original, first.id), first);
    await assets.save(copy, state, { copySessionFromCurrent: true });
    assert.deepEqual(await assets.loadHistoryRecord(copy, first.id), first);
    assert.deepEqual(await assets.loadAgentSession(copy), agentSession);
    assert.deepEqual((await assets.load(copy)).connections, state.connections);
    assert.equal((await assets.load(copy)).historyVersion, 1);
    assert.equal((await assets.load(copy)).zoomLevel, 1.35);

    const sourceAssets = newAssets();
    await sourceAssets.save(source, { nodes: [{ nodeId: 'run-2', type: 'run' }], connections: [] });
    const second = record('run-2', 'signature-2');
    await sourceAssets.saveHistoryRecord(source, second);
    await assets.merge(copy, source);
    assert.equal((await assets.load(copy)).zoomLevel, 1.35);
    assert.deepEqual(new Set((await assets.loadHistoryIndex(copy)).records.map((entry) => entry.id)), new Set([first.id, second.id]));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('desktop history keeps repeated Run attempts with the same input signature', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'annobio-history-rerun-test-'));
  try {
    const file = path.join(root, 'rerun.yc');
    const assets = newAssets();
    await assets.save(file, { historyVersion: 1, nodes: [{ nodeId: 'run-1', type: 'run' }], connections: [] });
    const first = record('run-1', 'same-signature');
    const second = record('run-1', 'same-signature');
    await assets.saveHistoryRecord(file, first);
    await assets.saveHistoryRecord(file, second);
    assert.deepEqual((await assets.loadHistoryIndex(file)).records.map((entry) => entry.id), [first.id, second.id]);
    assert.deepEqual(await assets.loadHistoryRecord(file, first.id), first);
    assert.deepEqual(await assets.loadHistoryRecord(file, second.id), second);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('desktop asset pruning retains cells referenced only by history', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'annobio-history-assets-test-'));
  try {
    const file = path.join(root, 'assets.yc');
    const referenced = 'sha256:referenced';
    const orphan = 'sha256:orphan';
    const item = record('run-1', 'signature-1');
    item.inputs = { dataset: { content: { rows: [[{ kind: 'images', assetIds: [referenced] }]] } } };
    const payload = {
      bundleVersion: 1, project: { schemaVersion: 2, nodes: [], assets: {} }, assetBlobs: {},
      history: { index: { version: 1, records: [{ id: item.id }] }, records: { [item.id]: item } },
    };
    await fs.writeFile(file, JSON.stringify(payload));
    const assets = newAssets();
    assets.file = file;
    assets.assets = {
      [referenced]: { name: 'old.png', bytes: 10 }, [orphan]: { name: 'orphan.png', bytes: 20 },
    };
    assert.deepEqual(collectHistoryAssetIds(item), [referenced]);
    const preview = await assets.pruneUnusedAssets([], { dryRun: true });
    assert.deepEqual(preview.removed.map((entry) => entry.id), [orphan]);
    await assets.pruneUnusedAssets([]);
    assert.ok(assets.assets[referenced]);
    assert.equal(assets.assets[orphan], undefined);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('desktop history deletion removes exactly the confirmed dependency closure', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'annobio-history-delete-'));
  try {
    const file = path.join(root, 'project.yc');
    const assets = newAssets();
    await assets.save(file, { nodes: [], connections: [] });
    const upstream = record('run-1', 'a');
    const child = { ...record('process-1', 'b'), kind: 'process', sourceRecordIds: [upstream.id] };
    await assets.saveHistoryRecord(file, upstream);
    await assets.saveHistoryRecord(file, child);
    await assert.rejects(assets.deleteHistoryRecords(file, upstream.id, [upstream.id]), /changed/);
    await assets.deleteHistoryRecords(file, upstream.id, [upstream.id, child.id]);
    assert.equal((await assets.loadHistoryIndex(file)).records.length, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
