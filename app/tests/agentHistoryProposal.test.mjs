import test from 'node:test';
import assert from 'node:assert/strict';

import { previewProposal, applyProposal } from '../src/agent/operations/proposals.js';

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
