import assert from 'node:assert/strict';
import test from 'node:test';
import { executePipelineAction, previewPipelineAction, readPipelineRuns } from '../src/agent/pipeline/pipelineActions.js';
import { findPendingInteraction, resolvePipelineAction } from '../src/agent/agentLoop.js';

const canvas = { nodes: [
  { type: 'dataset', nodeId: 'raw', name: 'Raw', datasetContent: { headers: ['text'], rows: [['one']] } },
  { type: 'prompt', nodeId: 'p', name: 'Extract', sections: [{ content: 'Read {text}' }] },
  { type: 'run', nodeId: 'r', runWorkingSetId: 'raw', runInputToColumn: { text: 'text' } },
], connections: [{ fromId: 'p', toId: 'r', type: 'prompt-to-run' }] };

function selected(runNodeId = 'r') {
  return { id: 'pipeline-1', index: 0, source: 'panel', route: [{
    kind: 'prompt', selectedOption: { kind: 'prompt', promptNodeId: 'p', runNodeId,
      inputDatasetNodeId: 'raw', promptName: 'Extract', runName: 'Run' },
  }] };
}

test('Agent Pipeline action is previewed before it can start, and route changes invalidate it', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return { ok: true, statusText: 'OK', json: async () => String(url).endsWith('/compile')
      ? { spec: { jobs: [] }, diagnostics: [] }
      : { run_id: 'run-1', project_id: 'project-1', status: 'pending', jobs: [{ job_id: 'llm:r' }] } };
  };
  let choice = selected();
  const attached = [];
  const runtime = {
    getCanvasState: () => canvas,
    getPipelineSelections: () => [choice],
    getPipelineProjectId: async () => 'project-1',
    getAssetProjectId: () => null,
    registerPipelineRun: async (...args) => { attached.push(args); },
  };
  const args = { action: 'run', pipeline_id: 'pipeline-1', summary: 'Run Extract' };
  try {
    const preview = await previewPipelineAction(args, runtime);
    assert.equal(preview.ok, true);
    assert.equal(calls.length, 1);
    assert.match(preview.items[0].lines.join(' '), /Current Pipeline panel/);
    choice = selected('another-run');
    await assert.rejects(executePipelineAction(args, preview, runtime), /selected route changed/);
    assert.equal(calls.length, 1);
    choice = selected();
    const result = await executePipelineAction(args, preview, runtime);
    assert.equal(result.status, 'started');
    assert.equal(result.run.run_id, 'run-1');
    assert.deepEqual(attached[0].slice(0, 2), ['pipeline-1', { run_id: 'run-1', project_id: 'project-1', status: 'pending', jobs: [{ job_id: 'llm:r' }] }]);
    assert.match(calls.at(-1).url, /\/api\/pipeline\/runs$/);
  } finally { globalThis.fetch = originalFetch; }
});

test('whole-Pipeline history is filtered by its jobs and stays separate from node history', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => [
    { run_id: 'mine', job_ids: ['llm:r'], status: 'succeeded' },
    { run_id: 'other', job_ids: ['process:x'], status: 'failed' },
  ] });
  try {
    const result = await readPipelineRuns({ pipeline_id: 'pipeline-1' }, {
      getPipelineProjectId: async () => 'project-1', getPipelineSelections: () => [selected()],
    });
    assert.equal(result.total, 1);
    assert.equal(result.runs[0].run_id, 'mine');
  } finally { globalThis.fetch = originalFetch; }
});

test('stop checks the run belongs to the Pipeline and uses the existing cancel API', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return { ok: true, json: async () => ({ run_id: 'run-1', project_id: 'project-1',
      status: options.method === 'POST' ? 'cancelling' : 'running', jobs: [{ job_id: 'llm:r' }] }) };
  };
  const attached = [];
  const runtime = { getCanvasState: () => canvas, getPipelineSelections: () => [selected()],
    getPipelineProjectId: async () => 'project-1', registerPipelineRun: async (...args) => attached.push(args) };
  try {
    const args = { action: 'stop', pipeline_id: 'pipeline-1', run_id: 'run-1' };
    const preview = await previewPipelineAction(args, runtime);
    assert.equal(preview.ok, true);
    const outcome = await executePipelineAction(args, preview, runtime);
    assert.equal(outcome.status, 'stopping');
    assert.equal(attached[0][0], 'pipeline-1');
    assert.match(calls.at(-1).url, /\/api\/pipeline\/runs\/run-1\/cancel/);
  } finally { globalThis.fetch = originalFetch; }
});

test('resume reuses the prior asset requirement', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return { ok: true, json: async () => ({ run_id: 'run-1', project_id: 'project-1',
      status: options.method === 'POST' ? 'pending' : 'interrupted', jobs: [{ job_id: 'llm:r' }] }) };
  };
  const attached = [];
  const runtime = { getCanvasState: () => canvas, getPipelineSelections: () => [selected()],
    getPipelineProjectId: async () => 'project-1', getAssetProjectId: () => null,
    getPipelineRunNeedsAssets: () => false, registerPipelineRun: async (...args) => attached.push(args) };
  try {
    const args = { action: 'resume', pipeline_id: 'pipeline-1', run_id: 'run-1' };
    const preview = await previewPipelineAction(args, runtime);
    assert.equal(preview.ok, true);
    assert.equal((await executePipelineAction(args, preview, runtime)).status, 'resumed');
    assert.equal(attached[0][2], false);
    assert.match(calls.at(-1).url, /\/api\/pipeline\/runs\/run-1\/resume$/);
  } finally { globalThis.fetch = originalFetch; }
});

test('export requests the chosen route and downloads only after confirmation', async () => {
  const originalFetch = globalThis.fetch;
  const originalDocument = globalThis.document;
  const calls = [];
  let clicked = false;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return String(url).endsWith('/compile')
      ? { ok: true, json: async () => ({ spec: { jobs: [] }, diagnostics: [] }) }
      : { ok: true, headers: { get: () => 'attachment; filename="Extract pipeline.zip"' }, blob: async () => new Blob(['zip']) };
  };
  globalThis.document = { createElement: () => ({ click() { clicked = true; }, remove() {} }),
    body: { appendChild() {} } };
  const runtime = { getCanvasState: () => canvas, getPipelineSelections: () => [selected()] };
  try {
    const args = { action: 'export', pipeline_id: 'pipeline-1' };
    const preview = await previewPipelineAction(args, runtime);
    assert.equal(preview.ok, true);
    assert.equal(clicked, false);
    assert.equal((await executePipelineAction(args, preview, runtime)).status, 'exported');
    assert.equal(clicked, true);
    assert.match(calls.at(-1).url, /\/api\/pipeline\/export$/);
  } finally { globalThis.fetch = originalFetch; globalThis.document = originalDocument; }
});

test('Pipeline action keeps an explicit pending confirmation in conversation history', () => {
  const messages = [{ role: 'user', content: 'Run this Pipeline' }, { role: 'assistant', content: '', toolCalls: [{
    id: 'call-1', name: 'pipeline_action', arguments: JSON.stringify({ action: 'run', pipeline_id: 'pipeline-1', summary: 'Run it' }),
    preview: { items: [], routeKey: 'route' },
  }] }];
  const pending = findPendingInteraction(messages);
  assert.equal(pending.kind, 'pipeline');
  resolvePipelineAction(messages, pending, { status: 'cancelled' });
  assert.equal(findPendingInteraction(messages), null);
});
