import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeMatchFlags, medicalConceptSource, conceptPairMatches, prefetchConceptIdMap,
  prefetchEmbeddingCosineMap, collectConceptTerms } from '../src/scoreMatchPrimitives.js';
import { computeGreedyRunToGtPairing, computeGreedyRunToGtPairingAsync } from '../src/scoreRunGtPairing.js';
import { getScoreExportData } from '../src/scoreDetailModal.js';
import { parseScoreMappingBundle, serializeScoreMappingBundle } from '../src/scoreMappingBundle.js';
import { planChangeSet } from '../src/agent/operations/changeSet.js';
import { validateAgentScoreTree } from '../src/agent/operations/scoreRules.js';
import { extractInputFields } from '../src/promptText.js';
import { canonicalJson } from '../src/runHistorySignature.js';

const group = children => ({ type: 'group', children, ops: children.slice(1).map(() => 'AND') });
const rule = matchFlags => ({ type: 'rule', outputKey: 'gene', gtColumns: ['truth'], matchType: 'exact', matchFlags });
const lookupOptions = flags => ({ root: group([rule(flags)]), results: [{ row_index: 0, output: { gene: 'p53' } }],
  outputFields: [{ key: 'gene' }], runWs: { headers: [], rows: [[]] }, gtContent: { headers: ['truth'], rows: [['TP53']] },
  getRunValue: result => result.output.gene, getGtValue: (table, index) => table.rows[index][0] });

test('entity match choices survive save/reload with the same smart-mode exclusivity', () => {
  for (const [flags, source] of [[{ hgncMatch: true }, 'hgnc'], [{ pubchemMatch: true }, 'pubchem'],
    ...['go', 'chebi', 'mondo'].map(ontologySource => [{ ontologyMatch: true, ontologySource }, ontologySource])]) {
    const bundle = parseScoreMappingBundle({ v: 2, input: group([]), output: group([rule(flags)]) });
    const restored = parseScoreMappingBundle(serializeScoreMappingBundle(bundle.inputRoot, bundle.outputRoot));
    assert.equal(medicalConceptSource(restored.outputRoot.children[0].matchFlags), source);
    assert.equal(canonicalizeMatchFlags({ ...flags, contains: true }).contains, false);
  }
  assert.equal(canonicalizeMatchFlags({ hgncMatch: true, pubchemMatch: true }).pubchemMatch, false);
});

test('inactive new Match options preserve existing evaluation signatures on save/load', () => {
  const flags = { semanticAlign: false, embeddingSimilarity: false, rxnormMatch: false, meshMatch: true,
    contains: false, ignoreCase: false, ignoreSymbols: false, ignoreWhitespace: false,
    numericMode: 'exact', numericAbsEpsilon: 0, numericRelEpsilon: 0, numericDecimalPlaces: 2 };
  const saved = { v: 2, input: group([]), output: group([rule(flags)]) };
  const parsed = parseScoreMappingBundle(saved);
  const restored = JSON.parse(serializeScoreMappingBundle(parsed.inputRoot, parsed.outputRoot));
  assert.equal(canonicalJson(restored), canonicalJson(saved));
});

test('mixed vocabularies keep repeated names separate and reject ambiguous resolutions', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async (_url, request) => {
    const { terms, source } = JSON.parse(request.body);
    return Response.json({ results: Object.fromEntries(terms.map(term => [term,
      { source, concept_id: `${source}:${source === 'hgnc' || term === 'TP53' ? 1 : 2}` }])) });
  };
  try {
    const options = lookupOptions({ hgncMatch: true });
    options.root = group([rule({ hgncMatch: true }), rule({ pubchemMatch: true })]);
    const terms = collectConceptTerms(options);
    assert.deepEqual([...terms.get('hgnc')], ['p53', 'TP53']);
    const map = await prefetchConceptIdMap('', options);
    assert.equal(conceptPairMatches('p53', 'TP53', map, 'hgnc'), true);
    assert.equal(conceptPairMatches('p53', 'TP53', map, 'pubchem'), false);
    const ambiguous = new Map([['a', { status: 'ambiguous', concept_id: 'same' }], ['b', { concept_id: 'same' }]]);
    assert.equal(conceptPairMatches('a', 'b', ambiguous), false);
  } finally { globalThis.fetch = previous; }
});

test('rules report lookup progress while retaining results until the complete attempt finishes', async () => {
  const previous = globalThis.fetch;
  const encoder = new TextEncoder();
  let streamController;
  let firstProgress;
  const progressed = new Promise(resolve => { firstProgress = resolve; });
  const updates = [];
  globalThis.fetch = async (_url, request) => {
    const payload = JSON.parse(request.body);
    assert.equal(payload.stream, true);
    return new Response(new ReadableStream({ start(controller) {
      streamController = controller;
      const event = { type: 'result', term: 'p53', result: { source: 'hgnc', concept_id: 'HGNC:11998' } };
      // Split a UTF-8 NDJSON event over chunks, as a real network response may do.
      const encoded = encoder.encode(JSON.stringify(event) + '\n');
      controller.enqueue(encoded.slice(0, 17));
      controller.enqueue(encoded.slice(17));
    } }), { headers: { 'Content-Type': 'application/x-ndjson' } });
  };
  let displayed;
  try {
    const tablePromise = getScoreExportData({
      node: { dataset: { scoreGroundTruthId: 'gt', scoreMapping: JSON.stringify({ v: 2,
        input: group([]), output: group([rule({ hgncMatch: true })]) }) } },
      getRunResults: () => ({ results: [{ row_index: 0, input_row_index: 0, input_row: ['article'], output: { gene: 'p53' } }],
        outputFields: [{ key: 'gene' }] }),
      getRunWorkingSetContent: () => ({ headers: ['text'], rows: [['article']] }),
      getGroundTruthContent: () => ({ headers: ['truth'], rows: [['TP53']] }), getGroundTruthHeaders: () => ['truth'],
      captureEvaluationState: true,
      onProgress: (completed, total, stage) => { updates.push({ completed, total, stage }); if (completed === 1) firstProgress(); },
    }).then(table => { displayed = table; return table; });
    await progressed;
    assert.equal(displayed, undefined);
    assert.ok(updates.some(update => update.completed > 0 && update.completed < update.total));
    streamController.enqueue(encoder.encode(JSON.stringify({ type: 'result', term: 'TP53',
      result: { source: 'hgnc', concept_id: 'HGNC:11998' } }) + '\n{"type":"done"}\n'));
    streamController.close();
    const table = await tablePromise;
    assert.equal(table.evaluationState.metrics.f1, 100);
    assert.ok(updates.every((value, index) => !index || value.completed >= updates[index - 1].completed));
    assert.ok(updates.at(-1).completed < updates.at(-1).total, '100% is reserved for history persistence');
    assert.ok(updates.some(update => update.stage === 'Matching rows'));
  } finally { globalThis.fetch = previous; }
});

test('truncated or failed lookup streams fail evaluation instead of producing a zero score', async () => {
  const previous = globalThis.fetch;
  try {
    for (const body of ['{"type":"done"}\n', '{"type":"error","error":"HGNC unavailable"}\n']) {
      globalThis.fetch = async () => new Response(body, { headers: { 'Content-Type': 'application/x-ndjson' } });
      await assert.rejects(prefetchConceptIdMap('', { ...lookupOptions({ hgncMatch: true }), onProgress() {} }),
        /before all terms|HGNC unavailable/);
    }
  } finally { globalThis.fetch = previous; }
});

test('semantic work reports actual completed chunks and forwards cancellation', async () => {
  const previous = globalThis.fetch, controller = new AbortController(), updates = [];
  const pairs = Array.from({ length: 321 }, (_, index) => [`a${index}`, 'b']);
  globalThis.fetch = async (_url, request) => {
    assert.equal(request.signal, controller.signal);
    return Response.json({ cosines: JSON.parse(request.body).pairs.map(() => 0.9) });
  };
  try {
    const map = await prefetchEmbeddingCosineMap('', { pairs, signal: controller.signal,
      onProgress: (completed, total) => updates.push([completed, total]) });
    assert.equal(map.size, 321);
    assert.deepEqual(updates, [[0, 321], [320, 321], [321, 321]]);
  } finally { globalThis.fetch = previous; }
});

test('cooperative rules pairing retains exact decisions and supports cancellation mid-run', async () => {
  const results = Array.from({ length: 30 }, (_, row_index) => ({ row_index, input_row_index: row_index % 3 }));
  const ctx = { results, runWs: { rows: results }, gtContent: { rows: results }, outputFields: [],
    inputRoot: group([]), outputRoot: group([rule({})]),
    ruleMatchesRow: (_rule, i, j) => i % 7 === j % 7, getRunValue: result => String(result.input_row_index) };
  const updates = [];
  assert.deepEqual(await computeGreedyRunToGtPairingAsync(ctx, { onProgress: (done, total) => updates.push([done, total]) }),
    computeGreedyRunToGtPairing(ctx));
  assert.ok(updates.some(([done, total]) => done > 0 && done < total));
  const controller = new AbortController();
  await assert.rejects(computeGreedyRunToGtPairingAsync(ctx, { signal: controller.signal,
    onProgress: done => { if (done > 0) controller.abort(); } }), { name: 'AbortError' });
});

test('Agent flat proposals and nested rules configure all three new Match options', () => {
  const state = { nodes: [
    { type: 'dataset', nodeId: 'raw', name: 'Raw', datasetContent: { headers: ['text'], rows: [['article']] } },
    { type: 'dataset', nodeId: 'gt', name: 'Truth', datasetContent: { headers: ['truth'], rows: [['TP53']] } },
    { type: 'prompt', nodeId: 'p', name: 'Extract', text: '{text}', outputFormat: { fields: [{ key: 'gene', type: 'str' }] } },
    { type: 'run', nodeId: 'r', runName: 'Generate' }],
    connections: [{ type: 'data', fromId: 'raw', fromPort: 'result', toId: 'r' }, { type: 'prompt-to-run', fromId: 'p', toId: 'r' }] };
  for (const [match, source] of [[{ hgnc: true }, 'hgnc'], [{ pubchem: true }, 'pubchem'], [{ ontology: 'mondo' }, 'mondo']]) {
    const proposed = planChangeSet(state, [{ op: 'add_score', ref: '$s', run: 'r', ground_truth: 'gt',
      comparison: [{ field: 'gene', ground_truth_columns: ['truth'], match }] }], { extractInputFields });
    const node = proposed.state.nodes.find(node => node.nodeId === proposed.refs.$s);
    assert.equal(medicalConceptSource(parseScoreMappingBundle(node.scoreMapping).outputRoot.children[0].matchFlags), source);
  }
  assert.throws(() => validateAgentScoreTree({ v: 2, input: group([]), output: group([rule({ ontologyMatch: true, ontologySource: 'bad' })]) },
    { inputColumns: ['text'], outputKeys: ['gene'], gtColumns: ['truth'] }), /ontologySource/);
});
