import test from 'node:test';
import assert from 'node:assert/strict';
import { appInfoRows, formatAppInfo } from '../src/aboutInfo.js';

const info = {
  version: '1.2.3-beta.4', commit: 'a'.repeat(40), modified: true,
  buildDate: '2026-11-02T15:00:00.000Z', electron: '40.1.0', chromium: '144.0.0.0',
  node: '24.0.0', v8: '14.4', os: 'Windows_NT x64 10.0.26200',
};

test('copied diagnostics match every displayed runtime and build field', () => {
  const rows = appInfoRows(info);
  const report = formatAppInfo(info);
  assert.equal(rows.length, 8);
  assert.equal(rows[0][1], info.version);
  assert.equal(rows[1][1], info.commit + ' (modified)');
  for (const [label, value] of rows) assert.ok(report.includes(`${label}: ${value}`));
  assert.match(report, /AnnoBio Non-Commercial License/);
  assert.match(report, /© 2026 AnnoBio/);
  assert.doesNotMatch(report, /Yichuan Zhang|Contact \/ commercial|Website:|Source code:/);
  assert.match(report, /Paper coming soon\./);
});

test('missing metadata stays unavailable rather than claiming a guessed version or build', () => {
  for (const value of [null, undefined, {}, { version: '', commit: ' ', buildDate: null }]) {
    assert.ok(appInfoRows(value).every(([, text]) => text === 'Unavailable'));
  }
});

test('a release build does not carry the development modified marker', () => {
  assert.equal(appInfoRows({ ...info, modified: false })[1][1], info.commit);
});
