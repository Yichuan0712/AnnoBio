import test from 'node:test';
import assert from 'node:assert/strict';
import { graph, recordGraph, content, indexOf } from './historyGraphFixture.mjs';
import { RunHistorySession } from '../src/runHistorySession.js';
import { runEvaluation, evaluationPayload, optimizationSourceIsEarlier } from '../src/evaluationHistory.js';
import { analysisInputKeys } from '../src/runAnalysisHistory.js';

async function fixture() {
  const initial = structuredClone(graph);
  initial.nodes.push({ type: 'dataset', nodeId: 'gt', name: 'Truth', datasetContent: content('world') },
    { type: 'score', nodeId: 'score', scoreName: 'Check', scoreGroundTruthId: 'gt', scoreMapping: [{ outputKey: 'answer', gtColumns: ['text'] }] });
  initial.connections.push({ type: 'run-to-score', fromId: 'run', toId: 'score' });
  const { state, records: saved } = await recordGraph(initial);
  const records = new Map(saved.map(record => [record.id, structuredClone(record)]));
  const writes = [];
  let next = 100;
  const session = new RunHistorySession({
    loadIndex: async () => indexOf([...records.values()]),
    loadRecord: async (_p, id) => structuredClone(records.get(id)),
    saveRecord: async (project, record) => { writes.push(project); records.set(record.id, structuredClone(record)); },
    saveCanvas: async () => {}, createId: () => String(next++).padStart(32, '0'),
  });
  await session.open('project', state);
  const calculate = async () => ({ metrics: { precision: 100, recall: 100, f1: 100 },
    comparisonRows: [{ row_index: 0, matched: true, row_input: { text: 'hello' }, ground_truth_output: { answer: 'world' } }] });
  const run = () => runEvaluation(session, state, 'score', calculate);
  return { state, records, session, calculate, run, writes };
}

test('each explicit Evaluate Run creates a separate immutable input/result snapshot', async () => {
  const f = await fixture();
  const first = await f.run(), original = structuredClone(first);
  const second = await f.run();
  assert.notEqual(first.id, second.id);
  assert.equal(first.signature, second.signature);
  assert.deepEqual(f.records.get(first.id), original);
  f.state.nodes.find(n => n.nodeId === 'gt').datasetContent.rows[0][0] = 'edited';
  const payload = evaluationPayload(first);
  assert.equal(payload.gtContent.rows[0][0], 'world');
  payload.gtContent.rows[0][0] = 'local edit';
  assert.equal(first.inputs.groundTruth.content.rows[0][0], 'world');
  assert.equal(payload.prompt, graph.nodes.find(n => n.type === 'prompt').text);
});

test('Evaluate History marks only records bound by Optimize, including multiple nodes on an older identical attempt', async () => {
  const f = await fixture(), first = await f.run(), second = await f.run();
  assert.equal(first.signature, second.signature);
  f.state.nodes.push(
    { type: 'promptReview', nodeId: 'opt-a', promptReviewName: 'Optimize A', evaluateRecordId: first.id },
    { type: 'promptReview', nodeId: 'opt-b', promptReviewName: 'Optimize B', evaluateRecordId: first.id },
    { type: 'promptReview', nodeId: 'legacy', promptReviewName: 'Legacy without a fixed source' },
  );
  const recordsBefore = structuredClone([...f.records.values()]);
  const entries = await f.session.displayEntriesForNode('score', f.state, { currentRecordIds: { score: second.id } });
  assert.deepEqual(entries.find(entry => entry.id === first.id).optimizations, [
    { nodeId: 'opt-a', name: 'Optimize A' }, { nodeId: 'opt-b', name: 'Optimize B' },
  ]);
  assert.deepEqual(entries.find(entry => entry.id === second.id).optimizations, []);
  assert((await f.session.displayEntriesForNode('run', f.state)).every(entry => !entry.optimizations.length));
  f.state.nodes.find(node => node.nodeId === 'opt-a').promptReviewName = 'Renamed Optimize';
  f.state.nodes = f.state.nodes.filter(node => node.nodeId !== 'opt-b');
  assert.deepEqual((await f.session.displayEntriesForNode('score', f.state)).find(entry => entry.id === first.id).optimizations,
    [{ nodeId: 'opt-a', name: 'Renamed Optimize' }]);
  f.state.nodes = f.state.nodes.filter(node => node.nodeId !== 'opt-a');
  assert((await f.session.displayEntriesForNode('score', f.state)).every(entry => !entry.optimizations.length));
  assert.deepEqual([...f.records.values()], recordsBefore);
});

test('Evaluate becomes stale after configuration, GT, exclusion or upstream edits and restores the full lineage', async () => {
  const f = await fixture(), record = await f.run();
  const score = f.state.nodes.find(n => n.nodeId === 'score');
  score.historyRecordId = record.id;
  for (const edit of [
    s => { s.nodes.find(n => n.nodeId === 'gt').datasetContent = content('changed'); },
    s => { s.nodes.find(n => n.nodeId === 'score').scoreRowExcludedFromScoring = { 0: true }; },
    s => { s.nodes.find(n => n.nodeId === 'score').scoreMatchCode = 'new code'; },
    s => { s.nodes.find(n => n.nodeId === 'score').scoreActiveMatchMode = 'code'; },
    s => { s.nodes.find(n => n.nodeId === 'prompt').text = 'changed prompt'; },
  ]) {
    const edited = structuredClone(f.state); edit(edited);
    const resolved = await f.session.resolve(edited), stale = resolved.state.nodes.find(n => n.nodeId === 'score');
    assert.equal(stale.historyRecordId, undefined);
    assert.equal(stale.historyStaleRecordId, record.id);
    const selected = await f.session.select(record.id, edited);
    assert.equal(selected.currentRecordIds.score, record.id);
    assert.deepEqual(selected.state.nodes.find(n => n.nodeId === 'gt').datasetContent, record.inputs.groundTruth.content);
    assert.equal(selected.state.nodes.find(n => n.nodeId === 'prompt').text, record.inputs.prompt.text);
  }
});

test('fixed Optimize identity and evidence survive new Evaluate attempts, missing live inputs, and method metadata', async () => {
  const f = await fixture(), first = await f.run();
  f.state.nodes.push({ type: 'promptReview', nodeId: 'opt', evaluateRecordId: first.id, evaluateNodeId: 'score' });
  f.state.connections.push({ type: 'score-to-prompt-review', fromId: 'score', toId: 'opt' });
  const before = (await analysisInputKeys(f.state, {})).review.get('opt');
  const second = await f.run();
  const opt = f.state.nodes.find(n => n.nodeId === 'opt');
  opt.reviewMethodId = 'actual-backend-method';
  f.state.nodes = f.state.nodes.filter(n => ['promptReview'].includes(n.type));
  f.state.connections = [];
  assert.deepEqual((await analysisInputKeys(f.state, {})).review.get('opt'), before);
  assert.equal(optimizationSourceIsEarlier(opt, { historyRecordId: second.id }), true);
  assert.equal(optimizationSourceIsEarlier(opt, { historyRecordId: first.id }), false);
  assert.deepEqual(evaluationPayload(f.records.get(opt.evaluateRecordId)).comparison_rows, first.results.comparisonRows);
});

test('rerunning Generate invalidates Evaluate without changing the Optimize evaluation version', async () => {
  const f = await fixture(), first = await f.run();
  const score = f.state.nodes.find(node => node.nodeId === 'score');
  score.historyRecordId = first.id;
  const opt = { type: 'promptReview', nodeId: 'opt', evaluateRecordId: first.id, evaluateNodeId: 'score' };
  f.state.nodes.push(opt);
  f.state.connections.push({ type: 'score-to-prompt-review', fromId: 'score', toId: 'opt' });
  const oldGenerate = f.records.get(first.inputs.runRecordId);
  const rerun = { ...structuredClone(oldGenerate), id: 'new-generate-attempt' };
  await f.session.putRecord(rerun); // Same setup and same output, but a distinct Generate execution.
  f.state.nodes.find(node => node.nodeId === 'run').historyRecordId = rerun.id;
  const resolved = await f.session.resolve(f.state);
  const stale = resolved.state.nodes.find(node => node.nodeId === 'score');
  assert.equal(stale.historyRecordId, undefined);
  assert.equal(stale.historyStaleRecordId, first.id);
  assert.equal(optimizationSourceIsEarlier(opt, stale), false);

  const second = await runEvaluation(f.session, resolved.state, 'score', f.calculate);
  assert.equal(second.inputs.runRecordId, rerun.id);
  stale.historyRecordId = second.id;
  delete stale.historyStaleRecordId;
  assert.equal(optimizationSourceIsEarlier(opt, stale), true);
  const restored = await f.session.select(first.id, resolved.state);
  assert.equal(restored.currentRecordIds.run, oldGenerate.id);
  assert.equal(optimizationSourceIsEarlier(opt, restored.state.nodes.find(node => node.nodeId === 'score')), false);
});

test('Optimize notices compare displayed History IDs independently of input freshness', () => {
  const opt = { evaluateRecordId: 'e1' };
  assert.equal(optimizationSourceIsEarlier(opt, { historyStaleRecordId: 'e1' }), false);
  assert.equal(optimizationSourceIsEarlier(opt, { historyStaleRecordId: 'e2' }), true);
  assert.equal(optimizationSourceIsEarlier(opt, null), false);
  assert.equal(optimizationSourceIsEarlier({}, { historyRecordId: 'e1' }), false);
});

test('history permits deleting an unselected identical attempt, and protects bound Optimize evidence', async () => {
  const f = await fixture(), first = await f.run(), second = await f.run();
  f.state.nodes.find(n => n.nodeId === 'score').historyRecordId = second.id;
  assert.deepEqual((await f.session.planDelete(first.id, f.state)).ids, [first.id]);
  f.state.nodes.push({ type: 'promptReview', nodeId: 'opt', evaluateRecordId: first.id });
  await assert.rejects(f.session.planDelete(first.id, f.state), /bound to this evaluation/);
});

test('failure and cancellation leave attempts in History without replacing a completed result', async () => {
  const f = await fixture(), completed = await f.run();
  f.state.nodes.find(n => n.nodeId === 'score').historyRecordId = completed.id;
  await assert.rejects(runEvaluation(f.session, f.state, 'score', async () => { throw Error('matcher error'); }), /matcher error/);
  const controller = new AbortController();
  const stopped = await runEvaluation(f.session, f.state, 'score', async () => { controller.abort(); return { wasCancelled: true, partial: ['kept'] }; }, { signal: controller.signal });
  assert.equal(stopped.status, 'stopped');
  assert.deepEqual(stopped.results.partial, ['kept']);
  assert.equal((await f.session.resolve(f.state)).currentRecordIds.score, completed.id);
  const entries = await f.session.displayEntriesForNode('score', f.state);
  assert.equal(entries.find(entry => entry.id === stopped.id).restorable, false);
});

test('Evaluate saves to the original project when a project switch occurs during calculation', async () => {
  const f = await fixture();
  await runEvaluation(f.session, f.state, 'score', async () => { f.session.projectId = 'other'; return f.calculate(); });
  assert(f.writes.every(project => project === 'project'));
});

test('opening a project stops abandoned Evaluate attempts; legacy snapshots cannot seed Optimize', async () => {
  const f = await fixture(), completed = await f.run();
  const abandoned = { ...completed, id: 'abandoned', status: 'running', results: {} };
  f.records.set(abandoned.id, abandoned);
  await f.session.open('project', f.state);
  assert.equal(f.records.get(abandoned.id).status, 'stopped');
  assert.throws(() => evaluationPayload({ ...completed, evaluationVersion: undefined }), /no complete evaluation snapshot/);
});

test('a failed index refresh after completion never downgrades the saved Evaluate', async () => {
  const f = await fixture(), loadIndex = f.session.storage.loadIndex;
  f.session.storage.loadIndex = async () => {
    if ([...f.records.values()].some(record => record.kind === 'score' && record.status === 'completed')) throw Error('index unavailable');
    return loadIndex();
  };
  await assert.rejects(f.run(), /index unavailable/);
  assert.equal([...f.records.values()].find(record => record.kind === 'score').status, 'completed');
  assert.equal(f.writes.length, 2);
});
