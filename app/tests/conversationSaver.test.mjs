import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationSaver } from '../src/agent/conversationSaver.js';

test('typing a burst of edits writes one latest snapshot', async () => {
  let draft = '';
  const snapshots = [];
  const saver = createConversationSaver(async () => { snapshots.push(draft); });
  for (let i = 0; i < 100; i += 1) {
    draft = `draft ${i}`;
    saver.schedule();
  }
  await saver.flush();
  assert.deepEqual(snapshots, ['draft 99']);
});

test('a slow save coalesces edits without overlapping writes or losing the final edit', async () => {
  let draft = 'first';
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const snapshots = [];
  const saver = createConversationSaver(async () => {
    snapshots.push(draft);
    if (snapshots.length === 1) await blocked;
  });
  saver.schedule();
  const finished = saver.flush();
  for (let i = 0; i < 100; i += 1) {
    draft = `edit ${i}`;
    saver.schedule();
  }
  assert.equal(saver.flush(), finished);
  assert.deepEqual(snapshots, ['first']);
  release();
  await finished;
  assert.deepEqual(snapshots, ['first', 'edit 99']);
  // A project transition can await flush before changing the target storage.
  await saver.flush();
  assert.equal(snapshots.length, 2);
});
