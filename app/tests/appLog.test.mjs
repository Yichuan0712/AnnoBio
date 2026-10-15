import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { createBackendLog } from '../src/backendLog.js';

function temporaryLog(t, onLines = () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'annobio-log-test-'));
  const log = createBackendLog({ dir, onLines });
  t.after(async () => {
    await log.close();
    for (const name of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, name));
    fs.rmdirSync(dir);
  });
  return log;
}

test('frontend exceptions and backend output share ordered, persisted log entries', async (t) => {
  const log = temporaryLog(t);
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  log.attach({ stdout, stderr });
  stdout.write('Backend ready\n');
  log.rendererError({ context: 'Unhandled promise rejection', details: 'TypeError: failed\r\n    at run (canvas.js:42)' });
  stderr.write('ERROR: backend failed\n');
  stdout.end();
  stderr.end();

  const entries = log.lines();
  assert.deepEqual(entries.map((entry) => entry.stream), ['out', 'frontend', 'frontend', 'frontend', 'err']);
  assert.deepEqual(entries.map((entry) => entry.id), [1, 2, 3, 4, 5]);
  assert.equal(entries[3].text, '    at run (canvas.js:42)');
  await log.close();
  log.note('Late shutdown output');
  assert.equal(log.lines().length, entries.length);
  const saved = fs.readdirSync(log.dir).map((name) => fs.readFileSync(path.join(log.dir, name), 'utf8')).join('');
  assert.match(saved, /OUT Backend ready/);
  assert.match(saved, /FRONTEND TypeError: failed/);
  assert.match(saved, /FRONTEND     at run \(canvas.js:42\)/);
  assert.match(saved, /ERR ERROR: backend failed/);
});

test('frontend errors stream to the renderer in the same batch as backend notes', async (t) => {
  const batches = [];
  let received;
  const nextBatch = new Promise((resolve) => { received = resolve; });
  const log = temporaryLog(t, (batch) => { batches.push(batch); received(); });
  log.note('Backend ready');
  log.rendererError({ context: 'Uncaught error', details: 'Error: failed' });
  await nextBatch;
  assert.deepEqual(batches.flat().map((entry) => entry.text), ['Backend ready', 'Uncaught error', 'Error: failed']);
  assert.deepEqual(batches.flat(), log.lines());
});

test('renderer error payloads are validated without damaging the shared Log', async (t) => {
  const log = temporaryLog(t);
  log.rendererError({ context: 'Uncaught error', details: { message: 'invalid' } });
  assert.deepEqual(log.lines(), []);
  log.note('Still working');
  assert.equal(log.lines()[0].text, 'Still working');
});

test('the renderer forwards complete exceptions and groups repeated errors in the badge', async (t) => {
  const previousWindow = globalThis.window;
  const forwarded = [];
  globalThis.window = { electronAPI: { reportRendererError: async (entry) => forwarded.push(entry) } };
  t.after(() => { globalThis.window = previousWindow; });
  const source = fs.readFileSync(new URL('../src/appErrors.js', import.meta.url), 'utf8')
    .replace("import './appErrors.css';", '');
  const errors = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  errors.setLogPanelAvailable(true);
  let badge;
  const unsubscribe = errors.subscribeAppErrors((list) => { badge = list; });
  t.after(unsubscribe);
  const exception = new TypeError('Broken action');
  errors.reportAppError('Uncaught error', exception);
  errors.reportAppError('Uncaught error', exception);
  assert.equal(forwarded.length, 2);
  assert.deepEqual(forwarded[0], { context: 'Uncaught error', details: exception.stack });
  assert.equal(badge.length, 1);
  assert.equal(badge[0].count, 2);
});
