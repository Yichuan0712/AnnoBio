import assert from 'node:assert/strict';
import test from 'node:test';
import { compileCurrentPipeline } from '../src/pipelineRunClient.js';

const state = { nodes: [
  { type: 'dataset', nodeId: 'raw', datasetContent: { headers: ['text'], rows: [['one']] } },
  { type: 'prompt', nodeId: 'p', text: 'Read {text}' },
  { type: 'run', nodeId: 'r', runInputToColumn: { text: 'text' } },
], connections: [{ fromId: 'p', toId: 'r', type: 'prompt-to-run' }, { type: 'data', fromId: 'raw', fromPort: 'result', toId: 'r' }] };
const route = [{ type: 'dataset', dataset_node_id: 'raw' }, { type: 'prompt', prompt_node_id: 'p', run_node_id: 'r' }];

test('compiling the selected route posts it with its explicit inputs', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return { ok: true, statusText: 'OK', json: async () => ({ spec: { jobs: [] }, diagnostics: [] }) };
  };
  try {
    await compileCurrentPipeline({ canvasState: state, route });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.match(calls[0].url, /\/api\/pipeline\/compile$/);
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body.input_dataset_ids, ['raw']);
  assert.deepEqual(body.route, route);
});

test('a compile error reports the diagnostics', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, statusText: 'Bad Request', json: async () => ({ detail: {
    message: 'Cannot compile.', diagnostics: [{ severity: 'error', message: 'Run "r" has no input.' }],
  } }) });
  try {
    await assert.rejects(compileCurrentPipeline({ canvasState: state, route }), /Run "r" has no input\./);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
