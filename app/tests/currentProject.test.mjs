import assert from 'node:assert/strict';
import test from 'node:test';
import { getPipelineProjectId, pipelineOwnerFor, setCurrentProjectId, setPipelineOwnerId } from '../src/currentProject.js';

test('web keeps its opaque project id and desktop uses the run owner kept in the file', async () => {
  const originalWindow = globalThis.window;
  try {
    delete globalThis.window;
    setCurrentProjectId('web-project-42');
    assert.equal(await getPipelineProjectId(), 'web-project-42');

    globalThis.window = { electronAPI: {} };
    setCurrentProjectId('C:\\Work\\Example.yc');
    await assert.rejects(getPipelineProjectId(), /still opening/);
    const owner = await pipelineOwnerFor('C:\\Work\\Example.yc', undefined);
    setPipelineOwnerId(owner.id);
    assert.equal(await getPipelineProjectId(), `desktop:${owner.id}`);

    // The same file, however its path is spelled, keeps its owner (and an older version of it, too).
    assert.equal(await pipelineOwnerFor('c:/work/example.yc', owner), owner);
    // A copy, a moved file or Save As starts a new owner, even at the path a deleted file used.
    assert.notEqual((await pipelineOwnerFor('C:\\Work\\Example copy.yc', owner)).id, owner.id);
    const fresh = await pipelineOwnerFor('C:\\Work\\Example.yc', undefined);
    assert.notEqual(fresh.id, owner.id);

    setCurrentProjectId('C:\\Work\\Other.yc');
    await assert.rejects(getPipelineProjectId(), /still opening/);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    setCurrentProjectId(null);
  }
});
