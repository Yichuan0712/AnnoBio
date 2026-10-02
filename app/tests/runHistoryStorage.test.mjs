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
    const state = { nodes: [{ nodeId: 'run-1', type: 'run' }], connections: [] };
    await assets.save(original, state);
    const first = record('run-1', 'signature-1');
    await assets.saveHistoryRecord(original, first);
    await assets.save(original, state);
    assert.deepEqual(await assets.loadHistoryRecord(original, first.id), first);
    await assets.save(copy, state, { copySessionFromCurrent: true });
    assert.deepEqual(await assets.loadHistoryRecord(copy, first.id), first);

    const sourceAssets = newAssets();
    await sourceAssets.save(source, { nodes: [{ nodeId: 'run-2', type: 'run' }], connections: [] });
    const second = record('run-2', 'signature-2');
    await sourceAssets.saveHistoryRecord(source, second);
    await assets.merge(copy, source);
    assert.deepEqual(new Set((await assets.loadHistoryIndex(copy)).records.map((entry) => entry.id)), new Set([first.id, second.id]));
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
