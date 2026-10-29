import test from 'node:test';
import assert from 'node:assert/strict';

function restoreWindow(t) {
  const previous = globalThis.window;
  t.after(() => {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  });
}
async function config(desktop) {
  globalThis.window = desktop ? { electronAPI: {} } : {};
  return import(`../src/backendConfig.js?startup-test=${desktop}`);
}

test('desktop readiness accepts a healthy service and web readiness sends no health request', async (t) => {
  restoreWindow(t);
  const desktop = await config(true);
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests += 1;
    assert.equal(url, 'http://127.0.0.1:8000/health');
    assert.ok(options.signal);
    return { ok: true };
  });
  assert.equal(await desktop.waitForBackend(), true);
  const web = await config(false);
  assert.equal(await web.waitForBackend(), true);
  assert.equal(requests, 1);
});

test('a listening service whose health response hangs cannot block desktop startup forever', async (t) => {
  restoreWindow(t);
  const desktop = await config(true);
  t.mock.method(globalThis, 'fetch', (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  // AbortSignal.timeout is unref'ed in Node; keep the test alive until it expires.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    assert.equal(await desktop.waitForBackend(25), false);
  } finally { clearTimeout(keepAlive); }
});
