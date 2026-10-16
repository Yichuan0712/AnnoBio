import assert from 'node:assert/strict';
import test from 'node:test';
import { executePipelineAction, previewPipelineAction } from '../src/agent/pipeline/pipelineActions.js';
import { findPendingInteraction, resolvePipelineAction } from '../src/agent/agentLoop.js';

const canvas = { nodes: [
  { type: 'dataset', nodeId: 'raw', name: 'Raw', datasetContent: { headers: ['text'], rows: [['one']] } },
  { type: 'prompt', nodeId: 'p', name: 'Extract', text: 'Read {text}' },
  { type: 'run', nodeId: 'r', runWorkingSetId: 'raw', runInputToColumn: { text: 'text' } },
], connections: [{ fromId: 'p', toId: 'r', type: 'prompt-to-run' }] };

function selected(runNodeId = 'r') {
  return { id: 'pipeline-1', index: 0, source: 'panel', route: [{
    kind: 'prompt', selectedOption: { kind: 'prompt', promptNodeId: 'p', runNodeId,
      inputDatasetNodeId: 'raw', promptName: 'Extract', runName: 'Run' },
  }] };
}

test('run, stop and resume are not Pipeline actions any more', async () => {
  const runtime = { getCanvasState: () => canvas, getPipelineSelections: () => [selected()] };
  for (const action of ['run', 'stop', 'resume']) {
    const preview = await previewPipelineAction({ action, pipeline_id: 'pipeline-1' }, runtime);
    assert.equal(preview.ok, false);
    assert.match(preview.error, /run_to/);
  }
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
  const messages = [{ role: 'user', content: 'Export this Pipeline' }, { role: 'assistant', content: '', toolCalls: [{
    id: 'call-1', name: 'pipeline_action', arguments: JSON.stringify({ action: 'export', pipeline_id: 'pipeline-1', summary: 'Export it' }),
    preview: { items: [], routeKey: 'route' },
  }] }];
  const pending = findPendingInteraction(messages);
  assert.equal(pending.kind, 'pipeline');
  resolvePipelineAction(messages, pending, { status: 'cancelled' });
  assert.equal(findPendingInteraction(messages), null);
});
