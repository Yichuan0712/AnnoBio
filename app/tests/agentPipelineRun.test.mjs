import assert from 'node:assert/strict';
import test from 'node:test';
import { executeRunRequest, previewRunRequest } from '../src/agent/execution/runJobs.js';

const state = {
  nodes: [
    { type: 'dataset', nodeId: 'raw', name: 'Raw', datasetContent: {
      headers: ['text'], columnTypes: ['text'], rowIds: [1, 2], rows: [['a'], ['b']],
    } },
    { type: 'prompt', nodeId: 'p', name: 'Extract', sections: [{ name: 'Task', content: 'Read {text}' }],
      outputFormat: { returnShape: 'single', fields: [{ key: 'answer', type: 'str' }] } },
    { type: 'run', nodeId: 'r', runName: 'Extract run', runWorkingSetId: 'raw',
      runInputToColumn: { text: 'text' }, runCredentialId: 'cred' },
  ],
  connections: [{ fromId: 'p', toId: 'r', type: 'prompt-to-run' }],
};

const spec = {
  inputs: ['dataset:raw'], outputs: ['output:llm:r:result'],
  artifacts: [
    { id: 'dataset:raw', name: 'Raw' },
    { id: 'output:llm:r:result', name: 'Extract run result' },
  ],
  jobs: [{
    id: 'llm:r', type: 'llm', inputs: { data: 'dataset:raw' },
    outputs: { result: ['output:llm:r:result'] },
    config: {
      model_binding: { run_node_id: 'r' },
      output_schema: { return_shape: 'single', fields: [{ key: 'answer', display: 'answer' }] },
    },
  }],
  source_map: { 'llm:r': { names: ['Extract'] } },
};

test('Agent whole-pipeline job uses the confirmation preview and unified runner', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url);
    requests.push({ path, options });
    let body = {};
    if (path.endsWith('/api/settings')) body = { default_run_credential_id: 'cred' };
    else if (path.includes('/api/credentials/openrouter/catalog')) body = { models: [] };
    else if (path.endsWith('/api/pipeline/compile')) body = { spec, diagnostics: [] };
    else if (path.endsWith('/api/pipeline/runs')) body = {
      run_id: 'pipeline-run', status: 'succeeded', revision: 1,
      jobs: [{ job_id: 'llm:r', status: 'succeeded' }],
      outputs: ['output:llm:r:result'],
      artifacts: [{ logical_id: 'dataset:raw', row_count: 2 },
        { logical_id: 'output:llm:r:result', row_count: 2 }],
    };
    return { ok: true, statusText: 'OK', json: async () => body };
  };
  const env = {
    getCanvasState: () => structuredClone(state),
    credentialsById: new Map([['cred', { id: 'cred', provider: 'mock', model: 'mock-model' }]]),
    getPipelineProjectId: async () => 'project-a',
    getAssetProjectId: () => 'project-a',
  };
  try {
    const request = { summary: 'Run it', jobs: [{ kind: 'pipeline', pipeline: 1 }] };
    const preview = await previewRunRequest(request, env);
    assert.equal(preview.ok, true, preview.error);
    assert.equal(preview.items[0].kind, 'pipeline');
    assert.match(preview.items[0].lines.join('\n'), /mock-model/);
    assert.match(preview.items[0].lines.join('\n'), /calls 2/);

    const result = await executeRunRequest(request, env);
    assert.equal(result.status, 'completed');
    assert.match(result.results[0], /2 final rows/);
  } finally {
    globalThis.fetch = originalFetch;
  }
  const start = requests.find((item) => item.path.endsWith('/api/pipeline/runs'));
  assert.ok(start, 'Agent must use the unified Pipeline start API');
  const payload = JSON.parse(start.options.body);
  assert.equal(payload.project_id, 'project-a');
  assert.deepEqual(payload.input_dataset_ids, ['raw']);
});
