import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.document = {
  documentElement: { dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } } },
  body: { appendChild() {}, removeChild() {} },
  addEventListener() {},
  removeEventListener() {},
  createElement() {
    const el = {
      _text: '',
      set textContent(value) { this._text = String(value ?? ''); },
      get innerHTML() {
        return this._text.replace(/[&<>"']/g, (ch) => ({
          '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        }[ch]));
      },
    };
    return el;
  },
};

const {
  renderPipelineRunActionButtons, renderPipelineStepRows, renderRunDetail, renderStatusNodeRow, renderStatusNodeTable,
} = await import('../src/pipelineOverviewModal.js');

const headers = '<thead><tr><th>Status</th><th>Started</th><th>Run info</th></tr></thead>';

test('an expanded pipeline run lists its steps in the single-node table', () => {
  const canvasNodes = [
    { nodeId: 'run-1', runName: 'Sample run' },
    { nodeId: 'proc-1', name: 'Join rows' },
  ];
  const run = {
    jobs: [
      { job_id: 'llm:run-1', status: 'running', started_at: '2026-10-06T12:00:00Z', completed: 2, total: 5 },
      { job_id: 'process:proc-1', status: 'failed', finished_at: '2026-10-06T12:04:00Z', error: 'bad column' },
      { job_id: 'process:gone', status: 'succeeded', finished_at: '2026-10-06T12:05:00Z' },
    ],
    plan: {
      jobs: [
        { job_id: 'llm:run-1', type: 'llm', name: 'Extract' },
        { job_id: 'process:proc-1', type: 'process', name: 'Join rows' },
        { job_id: 'process:gone', type: 'process', name: 'Old step' },
      ],
    },
  };
  const history = [{
    pipelineRunId: run.run_id, nodeId: 'run-1', datasetNames: ['Examples'], rowCount: 2, model: 'gpt-test',
  }];
  run.run_id = 'run-abc';
  history[0].pipelineRunId = 'run-abc';
  const steps = renderStatusNodeTable(renderPipelineStepRows(run, canvasNodes, history), 'pipeline-runs-steps');
  const single = renderStatusNodeTable(renderStatusNodeRow({
    status: 'succeeded', tone: 'succeeded', time: '10/6/2026', nodeLabel: 'Extract · Sample run',
    historyLabel: 'Input: Examples · 2 rows', nodeId: 'run-1',
  }));
  assert.equal(steps.includes(headers), true);
  assert.equal(single.includes(headers), true);
  assert.match(steps, /pipeline-runs-table pipeline-runs-steps/);
  assert.match(single, /pipeline-runs-table/);
  assert.match(steps, /Extract · Sample run/);
  assert.match(steps, /Input: Examples · 2 rows · Model: gpt-test/);
  assert.match(steps, /Join rows/);
  assert.match(steps, />Not saved</);
  assert.match(steps, />2\/5</);
  assert.match(steps, /bad column/);
  assert.match(steps, /title="Highlight on canvas"/);
  assert.equal(steps.includes('Open on canvas'), false);
  assert.match(steps, /data-node-id="run-1"/);
  assert.match(steps, /data-node-id="proc-1"/);
  assert.equal(steps.includes('data-node-id="gone"'), false);
  assert.match(steps, /pipeline-runs-step-row/);
  assert.match(steps, /Old step/);
  assert.equal(steps.includes('pipeline-job-list'), false);
});

test('Delete sits on the pipeline run, and the inputs line has no button', () => {
  const run = {
    run_id: 'abc123', status: 'succeeded', revision: 1,
    plan: { inputs: [{ name: 'Examples', row_count: 2 }], jobs: [] },
    jobs: [], artifacts: [],
  };
  const actions = renderPipelineRunActionButtons(run);
  const detail = renderRunDetail(run, { publicationError: '', canvasNodes: [] });
  assert.match(actions, /data-action="delete"/);
  assert.match(actions, />Delete</);
  assert.equal(detail.includes('Delete'), false);
  assert.equal(detail.includes('pipeline-runs-action'), false);
  assert.match(detail, /Inputs: Examples: 2 rows · Revision 1/);
});
