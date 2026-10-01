import assert from 'node:assert/strict';
import test from 'node:test';
import { getPipelineProjectId, setCurrentProjectId } from '../src/currentProject.js';

test('web keeps its opaque project id and desktop derives a stable Save-As-aware owner', async () => {
  const originalWindow = globalThis.window;
  try {
    delete globalThis.window;
    setCurrentProjectId('web-project-42');
    assert.equal(await getPipelineProjectId(), 'web-project-42');

    globalThis.window = { electronAPI: {} };
    setCurrentProjectId('C:\\Work\\Example.yc');
    const first = await getPipelineProjectId();
    setCurrentProjectId('c:/work/example.yc');
    assert.equal(await getPipelineProjectId(), first);
    assert.match(first, /^desktop:[0-9a-f]{64}$/);

    setCurrentProjectId('C:\\Work\\Example copy.yc');
    assert.notEqual(await getPipelineProjectId(), first);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    setCurrentProjectId(null);
  }
});
