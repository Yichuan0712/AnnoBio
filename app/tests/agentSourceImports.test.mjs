import test from 'node:test';
import assert from 'node:assert/strict';
import { applyProposal, previewProposal } from '../src/agent/operations/proposals.js';
import { executeAgentTool } from '../src/agent/tools/agentTools.js';
import { sourceJob, sourceOptions } from '../src/agent/operations/sourceImports.js';

const filename = 'fixture.pkl';
const fields = { gene: 'Gene', score: 'Score' };
const sources = {
  lake_fixture: { label: 'Fixture snapshot', kind: 'snapshot', fields: {}, searchable: false, row_filters: true, datasets: [{ name: filename, bytes: 5000 }] },
  online_fixture: { label: 'Online fixture', id: 'record ID', fields, row_filters: true, option_fields: [{ key: 'assembly', type: 'select' }] },
};
const operation = { op: 'import_dataset', ref: '$data', source: 'lake_fixture', name: 'Filtered genes', note: 'My description.', fields: ['gene'], options: { dataset: filename, filters: [{ column: 'score', op: 'gte', value: 5 }] } };
const fixture = () => {
  let state = { nodes: [], connections: [] };
  let applied = 0;
  return { getCanvasState: () => state, extractInputFields: () => [], applyCanvasState(next) { state = next; applied++; }, get applied() { return applied; } };
};

async function withSources(options, fn) {
  const original = globalThis.fetch;
  const calls = [];
  let downloaded = options.downloaded !== false;
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path, body, method: init.method || 'GET' });
    if (path === '/api/agent/sources') return Response.json(options.hosted ? { online_fixture: sources.online_fixture } : sources);
    if (path.startsWith('/api/reference/import/downloads?')) return Response.json({ files: [{ name: filename, bytes: 5000, status: downloaded ? 'downloaded' : 'missing' }] });
    if (path.endsWith('/schema') && init.method === 'POST') return Response.json({ job_id: 'schema' }, { status: 202 });
    if (path.endsWith('/download') && init.method === 'POST') { downloaded = true; return Response.json({ job_id: 'download' }, { status: 202 }); }
    if (path.endsWith('/import')) return Response.json({ job_id: 'records' }, { status: 202 });
    if (path.endsWith('/result/schema') || path.endsWith('/result/download')) return Response.json({ status: 'done', schema: { fields, default_fields: ['gene'], fingerprint: 'fixture-v1' } });
    if (path.endsWith('/result/records')) return Response.json({ status: 'done', headers: ['Gene'], rows: [['BRCA1'], ['BRCA2']], truncated: true });
    throw new Error(`Unexpected fetch ${path}`);
  };
  try { await fn(calls); } finally { globalThis.fetch = original; }
}

test('Agent discovers enabled sources and missing snapshots without downloading or creating nodes', async () => {
  await withSources({ downloaded: false }, async (calls) => {
    const catalog = JSON.parse((await executeAgentTool('inspect_source', {}, {})).content);
    assert.equal(catalog.sources.length, 2);
    const inspect = JSON.parse((await executeAgentTool('inspect_source', { source: 'lake_fixture', dataset: filename }, {})).content);
    assert.equal(inspect.needs_download, true);
    assert.ok(!calls.some((call) => call.method === 'POST'));
    const plan = await previewProposal({ operations: [operation] }, fixture());
    assert.equal(plan.ok, false);
    assert.match(plan.error, /download_dataset first/);
  });
  await withSources({ hosted: true }, async () => {
    const catalog = JSON.parse((await executeAgentTool('inspect_source', {}, {})).content);
    assert.deepEqual(catalog.sources.map((source) => source.source), ['online_fixture']);
    const plan = await previewProposal({ operations: [{ op: 'download_dataset', source: 'lake_fixture', dataset: filename }] }, fixture());
    assert.equal(plan.ok, false);
  });
});

test('Agent downloads only after approval and download-only proposals never alter the canvas', async () => {
  await withSources({ downloaded: false }, async (calls) => {
    const runtime = fixture();
    const proposal = { operations: [{ op: 'download_dataset', source: 'lake_fixture', dataset: filename }] };
    assert.equal((await previewProposal(proposal, runtime)).ok, true);
    assert.ok(!calls.some((call) => call.path.endsWith('/download')));
    assert.equal((await applyProposal(proposal, runtime)).status, 'applied');
    assert.equal(calls.filter((call) => call.path.endsWith('/download') && call.method === 'POST').length, 1);
    assert.equal(runtime.applied, 0);
  });
});

test('Agent reads real schema, forwards filters and records them and truncation in a created Dataset', async () => {
  await withSources({}, async (calls) => {
    const inspect = await executeAgentTool('inspect_source', { source: 'lake_fixture', dataset: filename, column_query: 'score', sample_rows: 0 }, {});
    assert.equal(inspect.ok, true);
    assert.deepEqual(JSON.parse(inspect.content).importable_fields, { score: 'Score' });
    const runtime = fixture();
    const proposal = { operations: [operation] };
    const preview = await previewProposal(proposal, runtime);
    assert.equal(preview.ok, true);
    assert.match(preview.items[0].lines.join('\n'), /Filters.*score/);
    assert.equal(runtime.applied, 0);
    assert.ok(!calls.some((call) => call.path.endsWith('/import')));
    const result = await applyProposal(proposal, runtime);
    assert.equal(result.status, 'applied');
    const sent = calls.find((call) => call.path.endsWith('/import')).body;
    assert.deepEqual(sent.ids, []);
    assert.deepEqual(sent.options, { ...operation.options, limit: 5000 });
    const node = runtime.getCanvasState().nodes[0];
    assert.equal(node.type, 'dataset');
    assert.deepEqual(node.datasetContent.rows, [['BRCA1'], ['BRCA2']]);
    assert.match(node.note, /^My description\./);
    assert.match(node.note, /Source file: fixture.pkl/);
    assert.match(node.note, /score gte 5/);
    assert.match(node.note, /first 2 matching rows/);
    assert.ok(result.created.$data.id);
  });
});

test('Agent imports forward online connection options, and reject bad filters before applying', async () => {
  await withSources({}, async (calls) => {
    const runtime = fixture();
    await applyProposal({ operations: [{ ...operation, source: 'online_fixture', ids: ['1'], options: { assembly: 'GRCh38', filters: [{ column: 'score', op: 'gt', value: 2 }] } }] }, runtime);
    assert.equal(calls.find((call) => call.path.endsWith('/import')).body.options.assembly, 'GRCh38');
    assert.throws(() => sourceOptions(sources.online_fixture, { filters: [{ column: 'bad', value: 1 }] }), /Filter columns/);
    assert.throws(() => sourceOptions(sources.online_fixture, { filters: [{ column: 'score', op: 'gt', value: 'NaN' }] }), /finite/);
    assert.throws(() => sourceOptions({ ...sources.online_fixture, row_filters: false }, { filters: [{ column: 'score', value: 1 }] }), /native search/);
    assert.throws(() => sourceOptions(sources.lake_fixture, { dataset: '../private.csv' }), /exact dataset/);
  });
});

test('an abort during source job startup cancels the late job', async () => {
  const controller = new AbortController();
  const original = globalThis.fetch;
  const cancelled = [];
  let finish;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/import')) return new Promise((resolve) => { finish = resolve; });
    if (String(url).includes('/cancel/')) { cancelled.push(String(url)); return Response.json({ ok: true }); }
    throw new Error('Polling must not start after abort');
  };
  try {
    const job = sourceJob('online_fixture', '/api/online_fixture/import', {}, { signal: controller.signal });
    controller.abort();
    finish(Response.json({ job_id: 'late-job' }));
    await assert.rejects(job);
    assert.equal(cancelled.length, 1);
    assert.match(cancelled[0], /cancel\/late-job$/);
  } finally { globalThis.fetch = original; }
});
