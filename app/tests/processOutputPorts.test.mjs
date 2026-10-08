import test from 'node:test';
import assert from 'node:assert/strict';

import { codeHashOf, effectiveProcessOutputs, parseProcessOutputPorts, showsProcessOutputs } from '../src/processOutputPorts.js';

const detected = (ports, extra = {}) => JSON.stringify({ ports, dynamic: false, error: '', codeHash: 'sha256:x', ...extra });
const result = (outputs) => JSON.stringify({ outputs: Object.fromEntries(outputs.map((name) => [name, { headers: ['a'], rows: [] }])) });

test('parsing tolerates missing, malformed and partial detections', () => {
  assert.equal(parseProcessOutputPorts(undefined), null);
  assert.equal(parseProcessOutputPorts('not json'), null);
  assert.equal(parseProcessOutputPorts('[]'), null);
  assert.deepEqual(parseProcessOutputPorts({ ports: ['a', '', 3], dynamic: 'yes' }), { ports: ['a'], dynamic: false, error: '', codeHash: '' });
  assert.deepEqual(parseProcessOutputPorts(detected(['a'])), { ports: ['a'], dynamic: false, error: '', codeHash: 'sha256:x' });
});

test('without a result the detected branches are offered', () => {
  assert.deepEqual(effectiveProcessOutputs({ detected: detected(['ready', 'rewrite']) }),
    { ports: ['ready', 'rewrite'], dynamic: false, mismatch: false, source: 'code' });
  assert.deepEqual(effectiveProcessOutputs({ detected: detected([], { dynamic: true }) }),
    { ports: [], dynamic: true, mismatch: false, source: 'code' });
});

test('a failed or missing detection offers nothing until the Process runs', () => {
  const none = { ports: [], dynamic: false, mismatch: false, source: 'none' };
  assert.deepEqual(effectiveProcessOutputs({ detected: detected([], { error: 'SyntaxError: x (line 2)' }) }), none);
  assert.deepEqual(effectiveProcessOutputs({}), none);
  assert.deepEqual(effectiveProcessOutputs({ detected: detected([], { error: 'bad' }), dfResults: result(['a']) }),
    { ports: ['a'], dynamic: false, mismatch: false, source: 'run' });
});

test('a result inside the detected branches keeps every detected branch offered', () => {
  assert.deepEqual(effectiveProcessOutputs({ detected: detected(['empty', 'kept']), dfResults: result(['empty']) }),
    { ports: ['empty', 'kept'], dynamic: false, mismatch: false, source: 'run' });
});

test('a result with a branch the detection missed wins and is flagged', () => {
  assert.deepEqual(effectiveProcessOutputs({ detected: detected(['result']), dfResults: result(['a', 'b']) }),
    { ports: ['a', 'b'], dynamic: false, mismatch: true, source: 'run' });
});

test('a dynamic detection takes its branches from the result', () => {
  assert.deepEqual(effectiveProcessOutputs({ detected: detected([], { dynamic: true }), dfResults: result(['x', 'y']) }),
    { ports: ['x', 'y'], dynamic: false, mismatch: false, source: 'run' });
});

test('an older single-table result is the result branch, and an empty result is no result', () => {
  assert.deepEqual(effectiveProcessOutputs({ dfResults: JSON.stringify({ headers: ['a'], rows: [] }) }).ports, ['result']);
  assert.equal(effectiveProcessOutputs({ dfResults: JSON.stringify({ outputs: {} }) }).source, 'none');
  assert.equal(effectiveProcessOutputs({ dfResults: 'not json' }).source, 'none');
});

test('only named or unknown branches are shown on the node', () => {
  assert.equal(showsProcessOutputs({ ports: ['result'], dynamic: false }), false);
  assert.equal(showsProcessOutputs({ ports: [], dynamic: false }), false);
  assert.equal(showsProcessOutputs({ ports: ['kept'], dynamic: false }), true);
  assert.equal(showsProcessOutputs({ ports: ['a', 'b'], dynamic: false }), true);
  assert.equal(showsProcessOutputs({ ports: [], dynamic: true }), true);
});

test('the code hash changes with the code only', async () => {
  assert.equal(await codeHashOf('def process(df):\n    return df\n'), await codeHashOf('def process(df):\n    return df\n'));
  assert.notEqual(await codeHashOf('a'), await codeHashOf('b'));
  assert.equal(await codeHashOf(undefined), await codeHashOf(''));
});
