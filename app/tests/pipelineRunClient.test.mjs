import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cancelPipelineRun,
  compileCurrentPipeline,
  getPipelineResults,
  getPipelineRun,
  reviseCurrentPipeline,
  resumePipelineRun,
  startCurrentPipeline,
} from '../src/pipelineRunClient.js';

const state = { nodes: [
  { type: 'dataset', nodeId: 'raw', datasetContent: { headers: ['text'], rows: [['one']] } },
  { type: 'prompt', nodeId: 'p', sections: [{ content: 'Read {text}' }] },
  { type: 'run', nodeId: 'r', runWorkingSetId: 'raw', runInputToColumn: { text: 'text' } },
], connections: [{ fromId: 'p', toId: 'r', type: 'prompt-to-run' }] };
const route = [{ type: 'dataset', dataset_node_id: 'raw' }, { type: 'prompt', prompt_node_id: 'p', run_node_id: 'r' }];

test('pipeline client uses compile/start/status/cancel/resume/results contracts', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return { ok: true, statusText: 'OK', json: async () => ({ run_id: 'run-a', status: 'running', outputs: [] }) };
  };
  try {
    await compileCurrentPipeline({ canvasState: state, route });
    await startCurrentPipeline({ projectId: 'project-a', assetProjectId: null, canvasState: state, route, requestId: 'request-a' });
    await reviseCurrentPipeline('run-a', {
      projectId: 'project-a', assetProjectId: null, canvasState: state, route, requestId: 'request-b',
    });
    await getPipelineRun('project-a', 'run-a');
    await cancelPipelineRun('project-a', 'run-a');
    await resumePipelineRun('project-a', 'run-a');
    await getPipelineResults('project-a', 'run-a', 'dataset:out');
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.match(calls[0].url, /\/api\/pipeline\/compile$/);
  const startBody = JSON.parse(calls[1].options.body);
  assert.equal(startBody.project_id, 'project-a');
  assert.equal(startBody.request_id, 'request-a');
  assert.deepEqual(startBody.input_dataset_ids, ['raw']);
  assert.match(calls[2].url, /\/api\/pipeline\/runs\/run-a\/revisions$/);
  assert.equal(JSON.parse(calls[2].options.body).request_id, 'request-b');
  assert.match(calls[3].url, /\/api\/pipeline\/runs\/run-a\?project_id=project-a$/);
  assert.equal(calls[4].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[5].options.body), { project_id: 'project-a' });
  assert.match(calls[6].url, /logical_id=dataset%3Aout/);
});
