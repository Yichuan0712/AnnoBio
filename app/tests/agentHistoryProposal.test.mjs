import test from 'node:test';
import assert from 'node:assert/strict';

import { previewProposal, applyProposal, createProposalRuntime } from '../src/agent/operations/proposals.js';

test('Agent select_history previews and applies one atomic ancestor switch', async () => {
  const calls = [];
  const workspace = {
    previewHistorySelection: async (id) => { calls.push(`preview:${id}`); return { changedNodeIds: ['prompt', 'run'], affectedNodeIds: ['prompt', 'run', 'process'] }; },
    applyHistorySelection: async (id) => { calls.push(`apply:${id}`); return { affectedNodeIds: ['prompt', 'run', 'process'] }; },
  };
  const proposal = { operations: [{ op: 'select_history', record_id: 'record-1' }] };
  const preview = await previewProposal(proposal, workspace);
  assert.equal(preview.ok, true);
  assert.deepEqual(preview.items[0].nodeIds, ['prompt', 'run']);
  const applied = await applyProposal(proposal, workspace);
  assert.equal(applied.status, 'applied');
  assert.deepEqual(calls, ['preview:record-1', 'apply:record-1']);
});

test('Agent select_history cannot be mixed with another proposal operation', async () => {
  const proposal = { operations: [{ op: 'select_history', record_id: 'record-1' }, { op: 'remove', node: 'run' }] };
  const preview = await previewProposal(proposal, {});
  assert.equal(preview.ok, false);
  assert.match(preview.error, /must be the only operation/);
});

test('Agent delete_history previews the cascade and applies only after approval', async () => {
  const calls = [];
  const workspace = {
    previewHistoryDeletion: async (id) => { calls.push(`preview:${id}`); return { records: [{ nodeId: 'run' }, { nodeId: 'process' }] }; },
    applyHistoryDeletion: async (id) => { calls.push(`apply:${id}`); return { records: [{ nodeId: 'run' }, { nodeId: 'process' }] }; },
  };
  const proposal = { operations: [{ op: 'delete_history', record_id: 'old-run' }] };
  const preview = await previewProposal(proposal, workspace);
  assert.equal(preview.ok, true);
  assert.match(preview.items[0].lines[0], /2 history records/);
  const applied = await applyProposal(proposal, workspace);
  assert.equal(applied.status, 'applied');
  assert.deepEqual(calls, ['preview:old-run', 'apply:old-run']);
});

test('the chat proposal runtime retains both History preview and apply capabilities', async () => {
  const calls = [];
  const runtime = createProposalRuntime({
    previewHistorySelection: async (id) => { calls.push(`preview select ${id}`); return { changedNodeIds: ['run'], affectedNodeIds: ['run'] }; },
    applyHistorySelection: async (id) => { calls.push(`apply select ${id}`); return { affectedNodeIds: ['run'] }; },
    previewHistoryDeletion: async (id) => { calls.push(`preview delete ${id}`); return { records: [{ nodeId: 'run' }] }; },
    applyHistoryDeletion: async (id) => { calls.push(`apply delete ${id}`); return { records: [{ nodeId: 'run' }] }; },
  });
  for (const op of ['select_history', 'delete_history']) {
    const request = { operations: [{ op, record_id: 'record' }] };
    assert.equal((await runtime.previewProposal(request)).ok, true);
    assert.equal((await runtime.applyProposal(request)).status, 'applied');
  }
  assert.deepEqual(calls, ['preview select record', 'apply select record', 'preview delete record', 'apply delete record']);
});
