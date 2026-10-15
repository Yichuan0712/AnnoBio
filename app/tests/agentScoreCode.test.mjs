import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCodeMatchInputs, runScoreCode } from '../src/scoreCodeRunClient.js';
import { imageCell, pdfCell } from '../src/datasetContent.js';
import { previewRunRequest, executeRunRequest } from '../src/agent/execution/runJobs.js';
import { planChangeSet } from '../src/agent/operations/changeSet.js';

const input = { headers: ['text'], rows: [['alpha'], ['beta']] };
const groundTruth = { headers: ['answer'], rows: [['A'], ['B']] };
const results = [{ row_index: 0, input_row_index: 0, output: { answer: 'A' } },
  { row_index: 2, input_row_index: 1, output: { answer: 'B' } }];
const code = 'def match(input_row, output_row, gt_row):\n    return output_row["answer"] == gt_row["answer"]';
const state = () => ({ nodes: [
  { nodeId: 'data', type: 'dataset', name: 'Data', datasetContent: input },
  { nodeId: 'gt', type: 'dataset', name: 'GT', datasetContent: groundTruth },
  { nodeId: 'run', type: 'run', runName: 'Run', runResults: JSON.stringify(results) },
  { nodeId: 'score', type: 'score', scoreName: 'Score', scoreGroundTruthId: 'gt', scoreActiveMatchMode: 'code', scoreMatchCode: code },
], connections: [{ type: 'data', fromId: 'data', fromPort: 'result', toId: 'run' },
  { type: 'run-to-score', fromId: 'run', toId: 'score' }] });
const response = (body) => ({ ok: true, status: 200, json: async () => body });

test('code scoring shares the Score window dictionaries, retains asset cells and sparse Run row indices', () => {
  const payload = buildCodeMatchInputs({ results, outputFields: [],
    input: { headers: ['image'], rows: [[imageCell(['img'], ['a.png'])], [imageCell()]] },
    groundTruth: { headers: ['PDF'], rows: [[pdfCell(['pdf'], ['a.pdf'])]] },
  });
  assert.deepEqual(payload.runRowIndices, [0, 2]);
  assert.deepEqual(payload.runRows[0], { input_row: { image: imageCell(['img'], ['a.png']) }, output_row: { answer: 'A' } });
  assert.deepEqual(payload.gtRows[0], { gt_row: { PDF: pdfCell(['pdf'], ['a.pdf']) } });
  assert.throws(() => buildCodeMatchInputs({ results: [], groundTruth }), /No run results/);
});

test('Agent runs custom-code Score jobs and reports progress without model calls', async () => {
  const previousFetch = globalThis.fetch;
  const requests = [];
  const progress = [];
  let polls = 0;
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).endsWith('/api/settings')) return response({ python_path: 'python' });
    if (String(url).endsWith('/api/score/match/run')) return response({ job_id: 'job' });
    return response(++polls === 1 ? { status: 'running', completed: 1, total: 2 }
      : { status: 'completed', total: 2, results: [{ ok: true, matched_gt_index: 0 }, { ok: true, matched_gt_index: 1 }] });
  };
  try {
    const result = await runScoreCode({ code, results, input, groundTruth, pollMs: 0,
      onProgress: (completed, total) => progress.push([completed, total]) });
    assert.equal(result.wasCancelled, false);
    assert.equal(result.outcomes.length, 2);
    assert.deepEqual(progress, [[1, 2], [2, 2]]);
    const body = JSON.parse(requests.find((request) => request.url.endsWith('/api/score/match/run')).options.body);
    assert.equal(body.code, code);
    assert.deepEqual(body.run_rows[1].input_row, { text: 'beta' });
  } finally { globalThis.fetch = previousFetch; }
});

test('cancelling code scoring keeps the API partial results', async () => {
  const previousFetch = globalThis.fetch;
  const controller = new AbortController();
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith('/api/settings')) return response({ python_path: 'python' });
    if (String(url).endsWith('/api/score/match/run')) return response({ job_id: 'job' });
    return response({ status: 'cancelled', results: [{ ok: true, matched_gt_index: 0 }] });
  };
  try {
    const result = await runScoreCode({ code, results, input, groundTruth, signal: controller.signal,
      onStarted: () => controller.abort() });
    assert.equal(result.wasCancelled, true);
    assert.equal(result.outcomes.length, 1);
    assert.ok(calls.some((url) => url.endsWith('/cancel/job')));
  } finally { globalThis.fetch = previousFetch; }
});

test('run_nodes previews and executes a custom-code Score through the canvas API', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url) => response(String(url).endsWith('/api/settings') ? { python_path: 'python' } : { models: [] });
  try {
    const canvas = state();
    const calls = [];
    const env = { getCanvasState: () => canvas, credentialsById: new Map(),
      runScoreNode: async (nodeId, options) => {
        calls.push(nodeId);
        options.onProgress(2, 2);
        return { outcomes: [{ ok: true, matched_gt_index: 0 }, { ok: true, matched_gt_index: 1 }], wasCancelled: false };
      } };
    const request = { jobs: [{ kind: 'score', node: 'score' }] };
    const preview = await previewRunRequest(request, env);
    assert.equal(preview.ok, true);
    assert.match(preview.total, /No model calls/);
    const result = await executeRunRequest(request, env);
    assert.equal(result.status, 'completed');
    assert.deepEqual(calls, ['score']);
    assert.match(result.results[0], /2\/2 Run rows matched/);
    canvas.nodes.find((node) => node.nodeId === 'score').scoreActiveMatchMode = 'rules';
    assert.match((await previewRunRequest(request, env)).error, /compute automatically/);
  } finally { globalThis.fetch = previousFetch; }
});

test('editing a matcher clears stale results and refuses configuration edits while it is running', () => {
  const canvas = state();
  const score = canvas.nodes.find((node) => node.nodeId === 'score');
  score.scoreMatchResult = JSON.stringify({ outcomes: [{ ok: true, matched_gt_index: 0 }] });
  const operations = [{ op: 'update', node: 'score', set: { match_code: `${code}\n` } }];
  const result = planChangeSet(canvas, operations, { extractInputFields: () => [] });
  assert.equal(result.state.nodes.find((node) => node.nodeId === 'score').scoreMatchResult, undefined);
  assert.ok(score.scoreMatchResult);
  score.scoreMatchPending = true;
  assert.throws(() => planChangeSet(canvas, operations, { extractInputFields: () => [] }), /is matching/);
});
