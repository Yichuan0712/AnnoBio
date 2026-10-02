import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { ProjectAssets } from '../src/projectAssets.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'annobio-history-benchmark-'));
try {
  const file = path.join(root, 'long-history.yc');
  const records = {};
  const entries = [];
  const payload = 'x'.repeat(100_000);
  for (let index = 0; index < 300; index += 1) {
    const id = index.toString(16).padStart(32, '0');
    records[id] = {
      id, nodeId: `run-${index}`, kind: 'run', signature: `sig-${index}`,
      status: 'completed', inputs: {}, results: { runResults: [{ output: payload }] },
    };
    entries.push({ id, nodeId: `run-${index}`, kind: 'run', signature: `sig-${index}`, status: 'completed' });
  }
  const state = { schemaVersion: 2, nodes: [{ type: 'run', nodeId: 'run-0' }], connections: [] };
  await fs.writeFile(file, JSON.stringify({ bundleVersion: 1, project: state, assetBlobs: {}, history: { index: { version: 1, records: entries }, records } }));
  const assets = new ProjectAssets({ decodeImage: () => {}, registerSession: () => {} });
  const sizeMb = (await fs.stat(file)).size / 1e6;
  const startLoad = performance.now();
  await assets.load(file);
  const loadMs = performance.now() - startLoad;
  const times = [];
  for (let index = 0; index < 3; index += 1) {
    const start = performance.now();
    await assets.save(file, state);
    times.push(Math.round(performance.now() - start));
  }
  process.stdout.write(JSON.stringify({ sizeMb: Math.round(sizeMb), loadMs: Math.round(loadMs), saveMs: times }) + '\n');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
