import test from 'node:test';
import assert from 'node:assert/strict';
import { pickUnusedSampleIndices, requestedSampleRows, samplerQuota } from '../src/samplerQuota.js';
import { planChangeSet } from '../src/agent/operations/changeSet.js';

const source = {
  rowIds: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
  rows: [['same'], ['same'], ['c'], ['d'], ['e'], ['f'], ['g'], ['h']],
};

test('without replacement uses each source row once across four pulls', () => {
  const outputs = [];
  const pickedAcrossPulls = new Set();
  for (let pull = 0; pull < 4; pull += 1) {
    const quota = samplerQuota(source, outputs, 'rows', 2);
    assert.equal(quota.total, 4);
    assert.equal(quota.completed, pull);
    const picked = pickUnusedSampleIndices(quota.availableIndices, quota.count, () => 0);
    assert.equal(picked.length, 2);
    for (const index of picked) {
      assert.equal(pickedAcrossPulls.has(source.rowIds[index]), false);
      pickedAcrossPulls.add(source.rowIds[index]);
    }
    outputs.push({ sourceRowIds: picked.map((index) => source.rowIds[index]), rows: picked.map((index) => source.rows[index]) });
  }
  const full = samplerQuota(source, outputs, 'rows', 2);
  assert.equal(full.completed, 4);
  assert.deepEqual(full.availableIndices, []);
  assert.equal(pickUnusedSampleIndices(full.availableIndices, 2), null);

  outputs.pop();
  assert.equal(samplerQuota(source, outputs, 'rows', 2).availableIndices.length, 2);
});

test('old sampled outputs reserve distinct source rows even when values repeat', () => {
  const quota = samplerQuota(source, [{ rows: [['same'], ['same']] }], 'rows', 2);
  assert.equal(quota.completed, 1);
  assert.deepEqual(quota.availableIndices, [2, 3, 4, 5, 6, 7]);
});

test('an unmatched legacy row conservatively reserves one remaining source row', () => {
  const quota = samplerQuota(source, [{ rows: [['removed value']] }], 'rows', 2);
  assert.equal(quota.availableIndices.length, 7);
});

test('percentage size rounds down and only full pulls count', () => {
  assert.equal(requestedSampleRows(8, 'ratio', 25), 2);
  assert.equal(samplerQuota(source, [], 'rows', 3).total, 2);
  assert.equal(requestedSampleRows(8, 'ratio', 1), 0);
});

test('Agent-created samples retain the source row identities for later pulls', () => {
  const state = { nodes: [{ type: 'dataset', nodeId: 'source', name: 'Source',
    datasetContent: { headers: ['value'], ...source } }], connections: [] };
  const result = planChangeSet(state, [{ op: 'add_sampler', source: 'source', sampling: 'random', size_unit: 'rows', size: 2 }],
    { extractInputFields: () => [] });
  const output = result.state.nodes.find((node) => node.type === 'dataset' && node.samplerNodeId);
  assert.equal(output.sampledSourceRowIds.length, 2);
  assert.equal(new Set(output.sampledSourceRowIds).size, 2);
  output.sampledSourceRowIds.forEach((id, index) => {
    assert.deepEqual(output.datasetContent.rows[index], source.rows[source.rowIds.indexOf(id)]);
  });
});
