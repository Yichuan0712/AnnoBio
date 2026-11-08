/**
 * Score parity fixture: runs the app's real `evaluateScoreOutputGt` (scoreOutputGtMatcher.js and everything it
 * imports) on a large deterministic case set and records inputs + verdicts for the backend port
 * (backend/score_engine.py, checked by backend/test_score_engine.py).
 *
 *   node app/tests/scoreParityFixture.mjs     # rewrites backend/test_fixtures/score_parity_cases.json.gz
 *
 * The backend calls Verify makes are answered by a stub `fetch`: embedding cosines and terminology concepts come
 * from deterministic functions and are recorded per case (the backend side gets the same maps), and "Match by
 * code" runs a JavaScript equivalent of each case's Python `match` (the backend side runs the Python through
 * match_exec and must reach the same pairing). scoreParityFixture.test.mjs fails when the committed fixture no
 * longer matches what the JavaScript produces.
 */
import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { evaluateScoreOutputGt } from '../src/scoreOutputGtMatcher.js';

export const FIXTURE_PATH = fileURLToPath(new URL('../../backend/test_fixtures/score_parity_cases.json.gz', import.meta.url));

// ---------- deterministic randomness ----------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function makeRandom(seed) {
  const next = mulberry32(seed);
  const r = {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    chance: (p) => next() < p,
    pick: (list) => list[Math.floor(next() * list.length)],
    sample: (list, n) => {
      const copy = list.slice();
      const out = [];
      while (out.length < n && copy.length) out.push(copy.splice(Math.floor(next() * copy.length), 1)[0]);
      return out;
    },
  };
  return r;
}

// ---------- stubbed backend services ----------

/** Cosine the stub embedding endpoint returns for a pair (boundary values and nulls included). */
function stubCosine(a, b) {
  if (a.trim().toLowerCase() === b.trim().toLowerCase()) return 0.97;
  const h = fnv1a(`${a}\u0000${b}`);
  switch (h % 10) {
    case 0: return null;
    case 1: return 0.76;
    case 2: return 0.7599999999999999;
    default: return Math.round(((h >>> 4) % 1000) / 1000 * 0.6 * 10000 + 4000) / 10000;
  }
}

const CONCEPT_SYNONYMS = {
  aspirin: 'C:aspirin', 'acetylsalicylic acid': 'C:aspirin', asa: 'C:aspirin',
  tp53: 'G:TP53', p53: 'G:TP53', 'tumor protein p53': 'G:TP53',
  ibuprofen: 'C:ibuprofen', advil: 'C:ibuprofen',
  brca1: 'G:BRCA1', 'breast cancer 1': 'G:BRCA1',
};

/** Result the stub terminology endpoint returns for a term (ambiguous, null, {} and cross-source included). */
function stubConcept(source, term) {
  const norm = term.trim().toLowerCase();
  if (norm === 'ambiguous' || norm === 'cold') return { status: 'ambiguous', concept_id: 'X', source };
  if (CONCEPT_SYNONYMS[norm]) return { status: 'resolved', concept_id: CONCEPT_SYNONYMS[norm], source };
  const h = fnv1a(`${source}\u0000${term}`);
  switch (h % 6) {
    case 0: return null;
    case 1: return { status: 'ambiguous', concept_id: `H${h % 3}`, source };
    case 2: return { concept_id: `H${h % 3}`, source };
    case 3: return { concept_id: `H${h % 3}`, source: (h >>> 3) % 2 ? source : 'other' };
    case 4: return {};
    default: return { concept_id: `H${h % 3}` };
  }
}

function response(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => JSON.parse(JSON.stringify(data)),
    text: async () => JSON.stringify(data),
  };
}

/** First-fit greedy pairing exactly as match_exec.run_match_pairs does it, with a JavaScript predicate. */
function runJsMatch(fn, runRows, gtRows) {
  const claimed = gtRows.map(() => false);
  return runRows.map((runRow) => {
    for (let j = 0; j < gtRows.length; j++) {
      if (claimed[j]) continue;
      let result;
      try {
        result = fn(runRow.input_row || {}, runRow.output_row || {}, gtRows[j].gt_row || {});
      } catch (error) {
        return { ok: false, error: String(error.message || error) };
      }
      if (result) {
        claimed[j] = true;
        return { ok: true, matched_gt_index: j };
      }
    }
    return { ok: true, matched_gt_index: null };
  });
}

function makeStubFetch(state) {
  return async (url, init = {}) => {
    const path = String(url);
    const body = init.body ? JSON.parse(init.body) : null;
    if (path.endsWith('/api/embeddings/pair-similarities')) {
      const cosines = body.pairs.map(([a, b]) => {
        const c = stubCosine(a, b);
        state.embeddingCosines.push([a, b, c]);
        return c;
      });
      return response({ cosines, model: 'stub' });
    }
    if (path.endsWith('/api/terminology/normalize')) {
      const results = {};
      for (const term of body.terms) {
        results[term] = stubConcept(body.source, term);
        state.concepts.push([body.source, term, results[term]]);
      }
      return response({ results });
    }
    if (path.endsWith('/api/settings')) return response({ python_path: 'python' });
    if (path.endsWith('/api/score/match/run')) {
      const outcomes = runJsMatch(state.codeFn, body.run_rows, body.gt_rows);
      state.codeRuns.push({ runRows: body.run_rows, gtRows: body.gt_rows, outcomes });
      state.pendingOutcomes = outcomes;
      return response({ job_id: `job-${state.codeRuns.length}` }, 202);
    }
    if (path.includes('/api/score/match/run/result/')) return response({ status: 'done', results: state.pendingOutcomes });
    if (path.includes('/api/score/match/run/cancel/')) return response({ ok: true });
    throw new Error(`Unexpected fetch in parity fixture: ${path}`);
  };
}

// ---------- value pools ----------

const TEXT_VALUES = [
  '', ' ', 'abc', 'ABC', ' abc ', 'a b  c', 'a\tb', 'a b', 'abc﻿', '﻿abc', 'abc\u0085', 'abc\u001c',
  'a　b', 'a b', 'a-b-c', 'a_b', 'a.b,c!', 'abc!', '(abc)', 'Café', 'café', 'CAFÉ', 'caf', 'naïve', '基因', '基因!',
  '基因 TP53', 'ΟΔΟΣ', 'οδος', 'İstanbul', 'i̇stanbul', '\u{1F600}', '\u{1F600}x', 'x\u{1F600}', '\u{1F600}\u{1F601}',
  'aspirin', 'Aspirin', ' ASPIRIN ', 'acetylsalicylic acid', 'asa', 'TP53', 'p53', 'tumor protein p53', 'ibuprofen',
  'Advil', 'brca1', 'cold', 'ambiguous', 'hello world', 'Hello, World!', 'hello  world', 'hello world!!', 'helo world',
  'the quick brown fox', 'the quick brown fax', 'quick brown', 'yes', 'Yes', 'no', 'true', 'false', 'null',
];
const NUMBER_TEXT_VALUES = [
  '1', '1.0', '01', '1e0', ' 1 ', '1.004', '1.005', '1.006', '1.0049', '0.1', '0.30000000000000004', '0.3', '-0', '0',
  '+1', '.5', '0.5', '5.', '1e3', '1000', '1,000', '12abc', '12', 'abc12', 'Infinity', '-Infinity', 'NaN', '0x10', '16',
  '1_000', '٣', '3', '１２', '2.5', '3.5', '-2.5', '-3.5', '1e21', '1e-7', '0.0000001', '123456789012345678901234',
  '9007199254740993', '9007199254740992', '100', '99.5', '101', '1.0000000001', ' 12', '12 ', '﻿12', '1.e2',
  '-.5', '1e+2', '1E2', '2.675', '2.67', '2.68', '1.45', '1.55', '0.49999999999999994', '4503599627370497', '1e308', '1e309',
];
const JSON_VALUES = [
  1, 1.5, 0, -1, 2.5, 100, 1e21, 1e-7, 0.1, 0.30000000000000004, 123456789012345680000, 12, 1000, 3,
  true, false, null, [1, 'a', null], [], ['x', [' y ', 2]], { a: 1 }, ['abc'], [' abc '],
  { kind: 'images', assetIds: ['id1', 'id2'], names: ['img.png', ''] },
  { kind: 'images', assetIds: ['id1'], names: [] },
  { kind: 'pdf', assetIds: ['p1', null], names: null },
  { kind: 'other', assetIds: ['z'] },
];
const ALL_VALUES = [...TEXT_VALUES, ...NUMBER_TEXT_VALUES, ...JSON_VALUES];

const OUTPUT_FIELDS = ['answer', 'gene', 'value', 'label'];
const GT_HEADERS = ['answer', 'gene', 'value', 'label', 'alt'];
const INPUT_HEADERS = ['question', 'id'];
const MATCH_TYPES = ['exact', 'exact', 'exact', 'exact', 'exact', 'numeric', 'numeric', 'numeric', 'contains',
  'gt-contains-run', 'fuzzy', '', null, ' exact ', 'Exact', 5];
const BOOL_FLAGS = ['semanticAlign', 'embeddingSimilarity', 'rxnormMatch', 'meshMatch', 'hgncMatch', 'pubchemMatch',
  'ontologyMatch', 'contains', 'ignoreCase', 'ignoreSymbols', 'ignoreWhitespace'];
const TRUTHY_FLAG_VALUES = [true, true, true, true, 1, 'yes', 'false', [], {}];
const FALSY_FLAG_VALUES = [false, false, 0, '', null];
const EPSILONS = [0, 0.01, 0.005, 0.0049, 1, 0.5, -1, '', null, '0.5', ' 0.1 ', 'abc', '0x2', '1e-2', true, [], [0.5],
  [1, 2], 'Infinity', '1_0', '0b1', '0o7', '  ', '.5', '5.', 1e300, 'inf'];
const DECIMALS = [0, 1, 2, 3, 2.7, -1, 25, '', null, '3', 'abc', true, false, [1], [], 'Infinity', 1e300, '0x1', ' 2 ', 20, 21];
const NUMERIC_MODES = ['exact', 'abs', 'rel', 'decimals', 'abs', 'rel', 'decimals', 'bad', undefined, null, 'ABS'];
const OUTPUT_KEYS = [...OUTPUT_FIELDS, ...OUTPUT_FIELDS, '#', '[#]', '[question]', '[id]', ' answer ', 'constructor',
  'toString', 'missing', '', '[ question ]', '[]', '[nope]', ' # '];
const GT_COLUMNS = [...GT_HEADERS, ...GT_HEADERS, '__score_gt_row_index__', ' answer ', '', 'nope', ' __score_gt_row_index__ '];

// ---------- generators ----------

function randomFlags(r, { smart = 0.2 } = {}) {
  if (r.chance(0.03)) return r.pick([null, 'x', [true], 7]);
  const flags = {};
  for (const name of BOOL_FLAGS) {
    const isSmart = !['contains', 'ignoreCase', 'ignoreSymbols', 'ignoreWhitespace'].includes(name);
    const p = isSmart ? smart / 3 : 0.3;
    if (r.chance(p)) flags[name] = r.pick(TRUTHY_FLAG_VALUES);
    else if (r.chance(0.1)) flags[name] = r.pick(FALSY_FLAG_VALUES);
  }
  if (r.chance(0.3)) flags.ontologySource = r.pick(['go', 'chebi', 'mondo', 'xx', 'GO', null]);
  if (r.chance(0.6)) flags.numericMode = r.pick(NUMERIC_MODES);
  if (r.chance(0.5)) flags.numericAbsEpsilon = r.pick(EPSILONS);
  if (r.chance(0.5)) flags.numericRelEpsilon = r.pick(EPSILONS);
  if (r.chance(0.5)) flags.numericDecimalPlaces = r.pick(DECIMALS);
  return flags;
}

function randomRule(r, opts = {}) {
  const rule = { type: 'rule' };
  // Usually compare a field with its own column (so verdicts are often true), sometimes anything with anything.
  const field = r.pick(OUTPUT_FIELDS);
  const aligned = r.chance(0.65);
  rule.outputKey = opts.outputKey ?? (aligned ? field : r.pick(OUTPUT_KEYS));
  const key = String(rule.outputKey).trim();
  let cols;
  if (r.chance(0.03)) cols = r.pick([null, 'answer', {}]);
  else if (aligned && GT_HEADERS.includes(key)) cols = r.chance(0.75) ? [key] : r.sample(GT_COLUMNS, 2).concat([key]);
  else cols = r.sample(GT_COLUMNS, r.pick([1, 1, 1, 2, 2, 3]));
  rule.gtColumns = opts.gtColumns ?? cols;
  rule.matchType = opts.matchType ?? r.pick(MATCH_TYPES);
  rule.matchFlags = opts.matchFlags ?? randomFlags(r, opts);
  if (r.chance(0.02)) delete rule.type;
  return rule;
}

function randomOps(r, n) {
  const len = Math.max(0, n - 1);
  const roll = r.next();
  if (roll < 0.7) return { ops: Array.from({ length: len }, () => r.pick(['AND', 'OR'])) };
  if (roll < 0.8) return { ops: Array.from({ length: Math.max(0, len - 1) }, () => r.pick(['AND', 'OR'])), op: r.pick(['OR', 'AND', undefined]) };
  if (roll < 0.88) return { ops: Array.from({ length: len + 1 }, () => r.pick(['AND', 'OR', 'XOR', 'or', null])) };
  if (roll < 0.95) return { op: r.pick(['OR', 'AND', 'or']) };
  return {};
}

function randomTree(r, depth, opts = {}) {
  const n = r.int(1, depth > 0 ? 4 : 3);
  const children = [];
  for (let i = 0; i < n; i++) {
    if (depth > 0 && r.chance(0.35)) children.push(randomTree(r, depth - 1, opts));
    else if (r.chance(0.02)) children.push(r.pick([null, { type: 'weird', children: [randomRule(r, opts)] }, 0, 'x']));
    else children.push(randomRule(r, opts));
  }
  const group = { type: 'group', children, ...randomOps(r, n) };
  if (r.chance(0.2)) group.groupId = r.pick([1, 2, 7, 0, -1, 1.5, 'x']);
  return group;
}

function wrapBundle(r, outputTree) {
  const roll = r.next();
  const bundle = { v: 2, input: r.chance(0.2) ? { type: 'group', ops: [], children: [randomRule(r)] } : { type: 'group', ops: [], children: [] }, output: outputTree };
  if (roll < 0.6) return JSON.stringify(bundle);
  if (roll < 0.9) return bundle;
  if (roll < 0.95) return JSON.stringify(outputTree);
  return outputTree;
}

/** A value for an output field that is often related to `gtValue` (same, re-cased, padded, decorated, renumbered). */
function relatedValue(r, gtValue) {
  const roll = r.next();
  if (roll < 0.2) return r.pick(ALL_VALUES);
  if (typeof gtValue !== 'string') return roll < 0.6 ? gtValue : String(gtValue ?? '');
  if (roll < 0.4) return gtValue;
  if (roll < 0.5) return gtValue.toUpperCase();
  if (roll < 0.6) return `  ${gtValue}\t`;
  if (roll < 0.66) return `${gtValue}!`;
  if (roll < 0.72) return gtValue.replace(/ /g, '   ');
  if (roll < 0.78) return `${gtValue} extra`;
  if (roll < 0.84) return gtValue.slice(1);
  if (roll < 0.9) { const n = parseFloat(gtValue); return Number.isFinite(n) ? r.pick([n, n + 0.004, n * 1.01, String(n), `${n}0`]) : gtValue; }
  return r.pick(TEXT_VALUES);
}

function randomOutput(r, gtRowsForInput, gtHeaders) {
  const roll = r.next();
  if (roll < 0.03) return { error: r.pick(['Model error', ' boom ', 'abc']) };
  if (roll < 0.05) return { output: null, error: r.pick([null, 'abc', '']) };
  if (roll < 0.06) return { output: r.pick(['abc', ['abc', 'def'], 5]) };
  const source = gtRowsForInput.length ? r.pick(gtRowsForInput) : [];
  const output = {};
  for (const field of OUTPUT_FIELDS) {
    if (r.chance(0.1)) continue;
    const col = gtHeaders.findIndex((h) => String(h).trim() === field);
    output[field] = relatedValue(r, col >= 0 ? source[col] : r.pick(ALL_VALUES));
  }
  if (r.chance(0.05)) output.constructor = r.pick(['abc', 'x']);
  const out = { output };
  if (r.chance(0.08)) out.error = r.pick(['abc', 'late error', null]);
  return out;
}

function randomGtHeaders(r) {
  const roll = r.next();
  if (roll < 0.85) return GT_HEADERS.slice();
  if (roll < 0.9) return [' answer', 'gene ', 'value', 'label', 'alt'];
  if (roll < 0.95) return ['answer', 'answer', 'gene', 'value', 'label', 'alt'];
  return ['gene', 'answer', 'label', 'alt', 'value', 7];
}

function randomGtRow(r, headers, theme) {
  const row = headers.map(() => (r.chance(0.7) ? r.pick(theme) : r.pick(ALL_VALUES)));
  if (r.chance(0.05)) return row.slice(0, r.int(0, row.length - 1));
  if (r.chance(0.02)) return r.pick([null, 'abc', {}]);
  return row;
}

function gtReference(r, sourceIdx) {
  const roll = r.next();
  if (roll < 0.75) return { gtRowIndex: sourceIdx };
  if (roll < 0.85) return { gtNum: sourceIdx + 1 };
  if (roll < 0.9) return { gtNum: String(sourceIdx + 1) };
  if (roll < 0.93) return { gtRowIndex: String(sourceIdx) };
  if (roll < 0.95) return { gtRowIndex: null, gtNum: ` ${sourceIdx + 1} ` };
  return r.pick([{ gtRowIndex: -1 }, { gtRowIndex: 1.5 }, { gtNum: 'x' }, {}, null, { gtRowIndex: 99 }, { gtNum: 0 }, { gtRowIndex: true }]);
}

/**
 * A case with `inputCount` inputs, `maxOutputs` outputs and up to `maxGt` GT rows per input.
 * `opts.rowIndexQuirks` adds duplicate / negative / fractional row indices and missing input_row_index.
 */
function randomData(r, { inputCount = 1, maxOutputs = 1, maxGt = 1, minGt = 1, rowIndexQuirks = false, theme } = {}) {
  theme = theme || r.sample(ALL_VALUES, r.int(3, 6));
  const gtHeaders = randomGtHeaders(r);
  const totalGt = r.int(minGt * inputCount, Math.max(minGt * inputCount, maxGt * inputCount + 1));
  const gtRows = Array.from({ length: totalGt }, () => randomGtRow(r, gtHeaders, theme));
  const runRows = Array.from({ length: inputCount + r.int(0, 2) }, (_, i) => [r.pick(['q', 'abc', 'Q1', ...theme.filter((v) => typeof v === 'string')]), r.pick([i, String(i), `id-${i}`, null])]);
  const originalIndices = r.sample(runRows.map((_, i) => i), inputCount);
  if (r.chance(0.03)) originalIndices[0] = r.pick(['1', null, 99, -1]);
  const inputEntries = [];
  const results = [];
  let rowIndex = r.int(0, 3);
  originalIndices.forEach((original, promptIdx) => {
    const nGt = r.int(minGt, maxGt);
    const sources = Array.from({ length: nGt }, () => r.int(0, Math.max(0, totalGt - 1)));
    if (totalGt === 0) sources.length = 0;
    const refs = sources.map((s) => gtReference(r, s));
    if (r.chance(0.05) && refs.length) refs.push({ ...refs[0] });
    inputEntries.push([original, { gtRows: refs }]);
    const rowsForInput = sources.map((s) => gtRows[s]).filter(Array.isArray);
    const nOut = r.int(0, maxOutputs);
    for (let k = 0; k < nOut; k++) {
      const res = { row_index: rowIndex++, input_row_index: promptIdx, ...randomOutput(r, rowsForInput, gtHeaders) };
      if (rowIndexQuirks) {
        const q = r.next();
        if (q < 0.08) res.row_index = Math.max(0, res.row_index - r.int(1, 2));
        else if (q < 0.12) res.row_index = -1;
        else if (q < 0.15) res.row_index = res.row_index + 0.5;
        else if (q < 0.2) delete res.input_row_index;
        else if (q < 0.23) res.input_row_index = null;
        else if (q < 0.25) res.input_row_index = r.pick([99, '0', 0.5]);
        else if (q < 0.27) res.row_index = r.pick(['3', null]);
        else if (q < 0.3) res.row_index = rowIndex + 10;
      }
      results.push(res);
    }
  });
  if (r.chance(0.2)) results.reverse();
  return {
    results,
    inputEntries,
    outputFields: [],
    runWs: { headers: r.chance(0.95) ? INPUT_HEADERS.slice() : ['question ', 'id', 'question'], rows: runRows },
    gtContent: { headers: gtHeaders, rows: gtRows },
  };
}

// ---------- case builders ----------

function primitiveCases(r, count) {
  const cases = [];
  for (let n = 0; n < count; n++) {
    const smart = r.pick([0, 0, 0.2, 0.6, 1.5]);
    const rule = randomRule(r, { smart });
    const tree = { type: 'group', ops: [], children: [rule] };
    const data = randomData(r, { inputCount: r.int(4, 10), maxOutputs: 1, maxGt: 1, minGt: 1 });
    cases.push({ category: 'primitives', scoreMapping: wrapBundle(r, tree), ...data });
  }
  return cases;
}

function numericCases(r, count) {
  const cases = [];
  for (let n = 0; n < count; n++) {
    const flags = { numericMode: r.pick(['exact', 'abs', 'rel', 'decimals']), numericAbsEpsilon: r.pick(EPSILONS),
      numericRelEpsilon: r.pick(EPSILONS), numericDecimalPlaces: r.pick(DECIMALS) };
    if (r.chance(0.2)) flags.ignoreCase = true;
    const tree = { type: 'group', ops: [], children: [{ type: 'rule', outputKey: 'value', gtColumns: ['value'], matchType: 'numeric', matchFlags: flags }] };
    const theme = r.sample([...NUMBER_TEXT_VALUES, 1, 1.5, 2.5, 1e21, 0.1, 12, 100, 3], r.int(3, 6));
    const data = randomData(r, { inputCount: r.int(5, 10), maxOutputs: 1, maxGt: 1, theme });
    for (const res of data.results) {
      if (res.output && typeof res.output === 'object' && !Array.isArray(res.output)) res.output.value = r.chance(0.5) ? r.pick(theme) : r.pick(NUMBER_TEXT_VALUES);
    }
    cases.push({ category: 'numeric', scoreMapping: wrapBundle(r, tree), ...data });
  }
  return cases;
}

function numberFormatCases(r, count) {
  const cases = [];
  for (let n = 0; n < count; n++) {
    const values = Array.from({ length: 8 }, () => {
      const kind = r.int(0, 5);
      const mant = r.next() * 10;
      if (kind === 0) return mant * 10 ** r.int(-12, 25);
      if (kind === 1) return -mant * 10 ** r.int(-8, 22);
      if (kind === 2) return r.int(0, 2 ** 31) / 10 ** r.int(0, 8);
      if (kind === 3) return Number.MAX_SAFE_INTEGER + r.int(-3, 3) * 2;
      if (kind === 4) return r.pick([5e-324, 1.7976931348623157e308, 1e21, 999999999999999900000, 1e-6, 1e-7, 0.000001234, 123e-20]);
      return r.next();
    });
    const gtRows = values.map((v) => [String(v), r.chance(0.5) ? v : String(v), 'x', 'y', 'z']);
    const inputEntries = values.map((_, i) => [i, { gtRows: [{ gtRowIndex: i }] }]);
    const results = values.map((v, i) => ({ row_index: i, input_row_index: i, output: { answer: v, gene: String(v), value: v } }));
    const tree = { type: 'group', ops: ['AND', 'AND'], children: [
      { type: 'rule', outputKey: 'answer', gtColumns: ['answer'], matchType: 'exact', matchFlags: {} },
      { type: 'rule', outputKey: 'gene', gtColumns: ['gene'], matchType: 'exact', matchFlags: {} },
      { type: 'rule', outputKey: 'value', gtColumns: ['gene'], matchType: 'numeric', matchFlags: {} },
    ] };
    cases.push({ category: 'number-format', scoreMapping: { v: 2, input: { type: 'group', ops: [], children: [] }, output: tree },
      results, inputEntries, outputFields: [], runWs: { headers: [], rows: values.map(() => []) },
      gtContent: { headers: GT_HEADERS, rows: gtRows } });
  }
  return cases;
}

function treeCases(r, count) {
  const cases = [];
  for (let n = 0; n < count; n++) {
    const tree = randomTree(r, r.int(1, 3), { smart: 0.1 });
    const data = randomData(r, { inputCount: r.int(2, 5), maxOutputs: r.pick([1, 1, 2]), maxGt: r.pick([1, 2]) });
    cases.push({ category: 'trees', scoreMapping: wrapBundle(r, tree), ...data });
  }
  return cases;
}

function tableCases(r, count) {
  const cases = [];
  for (let n = 0; n < count; n++) {
    const rules = Array.from({ length: r.int(1, 3) }, () => randomRule(r, { smart: 0.05,
      matchType: r.pick(['exact', 'exact', 'numeric', 'contains']) }));
    const tree = r.chance(0.7)
      ? { type: 'group', ops: rules.slice(1).map(() => r.pick(['AND', 'OR'])), children: rules }
      : randomTree(r, 2, { smart: 0.05 });
    const theme = r.sample(ALL_VALUES, r.int(2, 4));
    const data = randomData(r, { inputCount: r.int(1, 3), maxOutputs: r.int(2, 5), maxGt: r.int(1, 5), minGt: 0,
      rowIndexQuirks: r.chance(0.5), theme });
    cases.push({ category: 'tables', scoreMapping: wrapBundle(r, tree), ...data });
  }
  return cases;
}

function smartCases(r, count) {
  const cases = [];
  const smartFlags = [{ embeddingSimilarity: true }, { semanticAlign: true }, { rxnormMatch: true }, { meshMatch: true },
    { hgncMatch: true }, { pubchemMatch: true }, { ontologyMatch: true, ontologySource: 'go' },
    { ontologyMatch: true, ontologySource: 'chebi' }, { ontologyMatch: true, ontologySource: 'mondo' },
    { ontologyMatch: true, ontologySource: 'bad' }, { embeddingSimilarity: true, rxnormMatch: true, ignoreCase: true },
    { meshMatch: true, hgncMatch: true, contains: true }, { semanticAlign: true, embeddingSimilarity: 1 }];
  const theme = ['aspirin', 'Aspirin', 'acetylsalicylic acid', 'asa', 'TP53', 'p53', 'tumor protein p53', 'ibuprofen',
    'Advil', 'brca1', 'cold', 'ambiguous', 'hello world', 'hello  world', 'Hello, World!', 'helo world', '', ' ',
    'the quick brown fox', 'the quick brown fax', '\u{1F600}x', 'x\u{1F600}', 'abc', 'abd', 'ab'];
  for (let n = 0; n < count; n++) {
    const rules = Array.from({ length: r.int(1, 2) }, () => ({ type: 'rule', outputKey: r.pick(['answer', 'gene', 'label', '[question]', '#']),
      gtColumns: r.sample(['answer', 'gene', 'label', '__score_gt_row_index__'], r.pick([1, 1, 2])),
      matchType: r.pick(['exact', 'exact', 'exact', 'contains', ' exact ', 'numeric']), matchFlags: { ...r.pick(smartFlags) } }));
    const tree = { type: 'group', ops: rules.slice(1).map(() => r.pick(['AND', 'OR'])), children: rules };
    const data = randomData(r, { inputCount: r.int(1, 4), maxOutputs: r.int(1, 3), maxGt: r.int(1, 3), theme,
      rowIndexQuirks: r.chance(0.3) });
    cases.push({ category: 'smart', scoreMapping: wrapBundle(r, tree), ...data });
  }
  return cases;
}

function legacyBundleCases(r) {
  const data = () => randomData(r, { inputCount: 4, maxOutputs: 2, maxGt: 2 });
  const legacy = [
    [{ outputKey: 'answer', gtColumns: ['answer', '', null], matchType: 'contains' }, { outputKey: 'gene', gtColumns: ['gene'], matchType: 'gt-contains-run', matchFlags: { ignoreCase: true } }],
    [{ outputKey: 'answer', gtColumns: ['answer'], matchType: 'numeric', matchFlags: [true] }, { outputKey: '', gtColumns: [] }, { outputKey: 'label', gtColumns: 'label' }],
    [{ outputKey: 'answer', gtColumn: 'answer', matchType: 'exact' }, { outputKey: 'answer', gtColumn: 'alt', matchType: 'contains' }, { outputKey: 'gene', gtColumn: 'gene' }],
    [{ outputKey: '2', gtColumn: 'answer' }, { outputKey: 'b', gtColumn: 'gene' }, { outputKey: '1', gtColumn: 'value' }, { outputKey: 2, gtColumn: 'label' }],
    [{ rules: [{ outputKey: 'answer', gtColumn: 'answer', matchType: 'gt-contains-run' }] }, { rules: [{ outputKey: 'gene', gtColumn: 'gene' }] }, {}],
    [{ outputKey: null, gtColumn: 'answer' }],
    { type: 'group', op: 'OR', children: [{ type: 'rule', outputKey: 'answer', gtColumns: ['answer'] }, { type: 'rule', outputKey: 'gene', gtColumns: ['gene'] }] },
    '{"v":2,"input":{"type":"group","children":[]},"output":{"type":"group","op":"OR","children":[{"type":"rule","outputKey":"answer","gtColumns":["answer"],"matchType":"contains"},{"outputKey":"gene","gtColumns":["gene"]}]}}',
    '{"v":2.0,"input":{"type":"group","children":[]},"output":{"type":"group","children":[{"type":"rule","outputKey":"answer","gtColumns":["answer"]}]}}',
    '{"v":"2","input":{"type":"group","children":[]},"output":{"type":"group","children":[{"type":"rule","outputKey":"answer","gtColumns":["answer"]}]}}',
    '{"v":2,"input":{"type":"rule"},"output":{"type":"group","children":[{"type":"rule","outputKey":"answer","gtColumns":["answer"]}]}}',
    '[{"outputKey":"answer","gtColumns":["answer"],"matchFlags":{"ignoreCase":true,"numericDecimalPlaces":"x"}}]',
  ];
  return legacy.map((scoreMapping) => ({ category: 'legacy-bundle', scoreMapping, ...data() }));
}

/** Hand-picked value pairs at the edges of each primitive (rounding, parsing, UTF-16, whitespace sets). */
const EDGE_PAIRS = [
  ['numeric', { numericMode: 'decimals', numericDecimalPlaces: 0 }, [
    ['0.49999999999999994', '0'], ['4503599627370497', '4503599627370497'], ['4503599627370497', '4503599627370498'],
    ['-0.5', '0'], ['-0.5', '-1'], ['2.5', '3'], ['-2.5', '-2'], ['-2.5', '-3'], ['0.5', '1'], ['1e308', '1e308'],
    ['1e309', '1e309'], ['1e309', 'Infinity'], ['-1e308', '-1e308'], ['9007199254740993', '9007199254740992']]],
  ['numeric', { numericMode: 'decimals', numericDecimalPlaces: 2 }, [
    ['1.005', '1.01'], ['1.005', '1'], ['2.675', '2.68'], ['2.675', '2.67'], ['1.255', '1.26'], ['1e300', '1e300'], ['0.125', '0.13']]],
  ['numeric', { numericMode: 'decimals', numericDecimalPlaces: 20 }, [['1e290', '1e290'], ['0.1', '0.1'], ['1e289', '1.0000000000000001e289']]],
  ['numeric', { numericMode: 'abs', numericAbsEpsilon: 0.1 }, [['1.1', '1'], ['1.09', '1'], ['-1.1', '-1'], ['1e309', '1e309']]],
  ['numeric', { numericMode: 'rel', numericRelEpsilon: 0.1 }, [['0', '0'], ['1e-16', '0'], ['110', '100'], ['111', '100']]],
  ['numeric', {}, [['٣', '3'], ['３', '3'], [' 3', '3'], ['\u001c3', '3'], ['\u00853', '3'], ['﻿3', '3'],
    ['3\u001c', '3'], ['0x10', '16'], ['1_000', '1'], ['.5', '0.5'], ['5.', '5'], ['-.5e1', '-5'], ['1e', '1'], ['+-1', '-1'], ['Infinityx', 'Infinity']]],
  ['exact', { semanticAlign: true }, [['ab\u{1F600}', 'ab\u{1F601}'], ['\u{1F600}\u{1F601}', '\u{1F600}\u{1F602}'], ['\u{1F600}', '\u{1F601}'],
    ['\u{1F600}', '\u{1F600}\u0085'], ['a', 'a\u001c'], ['abc', 'abc\u0085'], ['night', 'nacht'], ['context', 'contact']]],
  ['exact', {}, [['abc', 'abc\u001c'], ['abc', 'abc\u0085'], ['abc', 'abc﻿'], ['abc', '　abc'], ['abc', 'abc​']]],
  ['exact', { ignoreWhitespace: true }, [['a b', 'a\u001cb'], ['a b', 'a\u0085b'], ['a b', 'a﻿b'], ['a b', 'a b'], ['a b', 'a​b']]],
  ['exact', { ignoreSymbols: true }, [['ab', 'a\u001cb'], ['ab', 'a\u0085b'], ['a b', 'a b'], ['ab', 'a\u{1F600}b'], ['Caf', 'Café'], ['٣', '']]],
  ['exact', { ignoreCase: true }, [['σας', 'ΣΑΣ'], ['i̇', 'İ'], ['\u{10428}', '\u{10400}'], ['ẞ', 'ß'], ['ⱥ', 'Ⱥ']]],
  ['exact', { contains: true }, [['', ''], ['', 'a'], ['\u{1F600}', 'x\u{1F600}y'], ['abc', 'b']]],
  ...['', null, false, [], ' ', '0x1', [3], true, 'abc', 2.9, -3, 99, 'Infinity'].map((places) =>
    ['numeric', { numericMode: 'decimals', numericDecimalPlaces: places }, [['1.4', '1'], ['1.44', '1.4'], ['1.444', '1.44'], ['1.04', '1']]]),
  ...['0x2', '0b10', '0o2', ' 2 ', '2e0', '', null, true, [2], [1, 2], 'Infinity', '-2', '2_0', 'inf'].map((eps) =>
    ['numeric', { numericMode: 'abs', numericAbsEpsilon: eps, numericRelEpsilon: eps }, [['3', '1'], ['1.5', '1'], ['2', '1']]]),
  ...[0.5, '0.5', 'Infinity', true, [0.5]].map((eps) =>
    ['numeric', { numericMode: 'rel', numericRelEpsilon: eps }, [['3', '2'], ['1.5', '1'], ['100', '1']]]),
];

function edgeCases() {
  return EDGE_PAIRS.map(([matchType, matchFlags, pairs]) => ({
    category: 'edges',
    scoreMapping: { v: 2, input: { type: 'group', ops: [], children: [] }, output: { type: 'group', ops: [], children: [
      { type: 'rule', outputKey: 'answer', gtColumns: ['answer'], matchType, matchFlags }] } },
    results: pairs.map(([run], i) => ({ row_index: i, input_row_index: i, output: { answer: run } })),
    inputEntries: pairs.map((_, i) => [i, { gtRows: [{ gtRowIndex: i }] }]),
    outputFields: [],
    runWs: { headers: [], rows: pairs.map(() => []) },
    gtContent: { headers: ['answer'], rows: pairs.map(([, gt]) => [gt]) },
  }));
}

function errorCases(r) {
  const base = () => randomData(r, { inputCount: 2, maxOutputs: 1, maxGt: 1 });
  return [
    { category: 'errors', scoreMapping: '{}', ...base() },
    { category: 'errors', scoreMapping: 'not json', ...base() },
    { category: 'errors', scoreMapping: null, ...base() },
    { category: 'errors', scoreMapping: '{"v":2,"input":{"type":"group","children":[]},"output":{"type":"group","children":[]}}', ...base() },
    { category: 'errors', scoreMapping: '[null, {"outputKey":"a","gtColumns":["answer"]}]', ...base() },
    { category: 'errors', scoreMapping: '[{"outputKey":"a","gtColumns":["answer"]}, null]', ...base() },
    { category: 'errors', scoreMapping: 'NaN', ...base() },
  ];
}

/** Object-prototype keys and own "__proto__" need JSON text: object literals would set the prototype. */
function prototypeKeyCases() {
  const results = JSON.parse('[{"row_index":0,"input_row_index":0,"output":{"__proto__":"own","answer":"x"}},'
    + '{"row_index":1,"input_row_index":1,"output":{"answer":"x"}},{"row_index":2,"input_row_index":2,"output":{"constructor":"own"}},'
    + '{"row_index":3,"input_row_index":3,"output":["first","second"]}]');
  const gtRows = [['own', 'function Object() { [native code] }', '[object Object]', 'function toString() { [native code] }', 'first'],
    ['own', 'function Object() { [native code] }', '[object Object]', 'function toString() { [native code] }', '2'],
    ['own', 'function Object() { [native code] }', '[object Object]', 'function hasOwnProperty() { [native code] }', 'second'],
    ['first', 'function Object() { [native code] }', '[object Object]', '2', 'second']];
  const keys = [['__proto__', 'answer'], ['constructor', 'gene'], ['__proto__', 'value'], ['toString', 'label'], ['hasOwnProperty', 'label'],
    ['0', 'answer'], ['length', 'alt'], ['1', 'alt'], ['valueOf', 'label']];
  return keys.map(([outputKey, col]) => ({
    category: 'prototype-keys',
    scoreMapping: { v: 2, input: { type: 'group', children: [] }, output: { type: 'group', children: [{ type: 'rule', outputKey, gtColumns: [col], matchType: 'exact', matchFlags: {} }] } },
    results, inputEntries: gtRows.map((_, i) => [i, { gtRows: [{ gtRowIndex: i }] }]), outputFields: [],
    runWs: { headers: [], rows: [[], [], [], []] }, gtContent: { headers: GT_HEADERS, rows: gtRows },
  }));
}

// ---------- code mode ----------

const CODE_CASES = [
  {
    name: 'answer-equal',
    python: 'def match(input_row, output_row, gt_row):\n    return output_row.get("answer", "") == gt_row.get("answer", "")\n',
    js: (i, o, g) => (o.answer ?? '') === (g.answer ?? ''),
  },
  {
    name: 'answer-lower-contains',
    python: 'def match(input_row, output_row, gt_row):\n    a = output_row.get("answer", "").lower()\n    b = gt_row.get("answer", "").lower()\n    return bool(a) and (a in b or b in a)\n',
    js: (i, o, g) => { const a = (o.answer ?? '').toLowerCase(); const b = (g.answer ?? '').toLowerCase(); return !!a && (b.includes(a) || a.includes(b)); },
  },
  {
    name: 'uses-input-row',
    python: 'def match(input_row, output_row, gt_row):\n    return input_row.get("question", "") == gt_row.get("label", "") or output_row.get("gene", "") == gt_row.get("gene", "")\n',
    js: (i, o, g) => (i.question ?? '') === (g.label ?? '') || (o.gene ?? '') === (g.gene ?? ''),
  },
  {
    name: 'always-true',
    python: 'def match(input_row, output_row, gt_row):\n    return 1\n',
    js: () => true,
  },
  {
    name: 'always-false',
    python: 'def match(input_row, output_row, gt_row):\n    return []\n',
    js: () => false,
  },
  {
    name: 'raises-on-alt',
    python: 'def match(input_row, output_row, gt_row):\n    if gt_row.get("alt") == "boom":\n        raise ValueError("boom")\n    return output_row.get("value", "") == gt_row.get("value", "")\n',
    js: (i, o, g) => { if (g.alt === 'boom') throw new Error('boom'); return (o.value ?? '') === (g.value ?? ''); },
  },
  {
    name: 'missing-key-error',
    python: 'def match(input_row, output_row, gt_row):\n    return output_row["label"] == gt_row["label"]\n',
    js: (i, o, g) => { if (!('label' in o)) throw new Error("'label'"); return o.label === g.label; },
  },
  {
    name: 'syntax-error',
    python: 'def match(input_row, output_row, gt_row)\n    return True\n',
    js: () => { throw new Error('SyntaxError'); },
  },
];

function codeCases(r) {
  const cases = [];
  for (const spec of CODE_CASES) {
    const rounds = spec.name === 'syntax-error' ? 1 : 2;
    for (let k = 0; k < rounds; k++) {
      const theme = ['abc', 'ABC', 'boom', 'x', 'q', 'TP53', 'p53', '1', '1.0', ''];
      const data = randomData(r, { inputCount: r.int(1, 2), maxOutputs: r.int(1, 3), maxGt: r.int(1, 3), minGt: 0, theme });
      // Code-mode cells must stay plain text (asset cells would need a project session).
      data.gtContent.rows = data.gtContent.rows.map((row) => (Array.isArray(row) ? row.map((c) => (c && typeof c === 'object' ? 'obj' : c)) : row));
      data.runWs.rows = data.runWs.rows.map((row) => row.map((c) => (c && typeof c === 'object' ? 'obj' : c)));
      for (const res of data.results) {
        if (res.output && typeof res.output === 'object' && !Array.isArray(res.output)) {
          for (const key of Object.keys(res.output)) if (res.output[key] && typeof res.output[key] === 'object' && !Array.isArray(res.output[key])) res.output[key] = 'obj';
        }
      }
      cases.push({ category: 'code', codeName: spec.name, scoreMatchCode: spec.python,
        scoreMapping: r.chance(0.5) ? '{}' : wrapBundle(r, randomTree(r, 1)), ...data });
    }
  }
  return cases;
}

// ---------- hand-written golden cases (expected verdicts written by hand) ----------

const rule = (outputKey, gtColumns, matchType = 'exact', matchFlags = {}) => ({ type: 'rule', outputKey, gtColumns, matchType, matchFlags });
const bundle = (children, ops) => ({ v: 2, input: { type: 'group', ops: [], children: [] }, output: { type: 'group', ops: ops || children.slice(1).map(() => 'AND'), children } });
const one = (output, gtRow, headers = ['answer']) => ({
  results: [{ row_index: 0, input_row_index: 0, output }], inputEntries: [[0, { gtRows: [{ gtRowIndex: 0 }] }]],
  outputFields: [], runWs: { headers: ['question'], rows: [['q']] }, gtContent: { headers, rows: [gtRow] },
});

export const GOLDEN_CASES = [
  { name: 'ignoreCase+ignoreSymbols', scoreMapping: bundle([rule('answer', ['answer'], 'exact', { ignoreCase: true, ignoreSymbols: true })]),
    ...one({ answer: 'Hello, World!' }, ['hello world']), expectMatched: [true] },
  { name: 'ignoreSymbols strips non-ASCII letters', scoreMapping: bundle([rule('answer', ['answer'], 'exact', { ignoreSymbols: true })]),
    ...one({ answer: 'Café' }, ['Caf']), expectMatched: [true] },
  { name: 'numeric decimals rounds half up', scoreMapping: bundle([rule('answer', ['answer'], 'numeric', { numericMode: 'decimals', numericDecimalPlaces: 0 })]),
    ...one({ answer: '-2.5' }, ['-2']), expectMatched: [true] },
  { name: 'numeric parseFloat prefix', scoreMapping: bundle([rule('answer', ['answer'], 'numeric')]),
    ...one({ answer: '12abc' }, ['12.0']), expectMatched: [true] },
  { name: 'fuzzy below threshold', scoreMapping: bundle([rule('answer', ['answer'], 'exact', { semanticAlign: true })]),
    ...one({ answer: 'abc' }, ['abd']), expectMatched: [false] },
  { name: 'any GT column matches', scoreMapping: bundle([rule('answer', ['answer', 'alt'])]),
    ...one({ answer: 'B' }, ['A', 'B'], ['answer', 'alt']), expectMatched: [true] },
  { name: 'OR tree', scoreMapping: bundle([rule('answer', ['answer']), rule('gene', ['gene'])], ['OR']),
    ...one({ answer: 'x', gene: 'TP53' }, ['y', 'TP53'], ['answer', 'gene']), expectMatched: [true] },
  { name: 'AND tree: paired but not matched', scoreMapping: bundle([rule('answer', ['answer']), rule('gene', ['gene'])]),
    ...one({ answer: 'x', gene: 'TP53' }, ['y', 'TP53'], ['answer', 'gene']), expectMatched: [false] },
  { name: 'table output: greedy prefers the higher score', scoreMapping: bundle([rule('answer', ['answer']), rule('gene', ['gene'])], ['OR']),
    results: [{ row_index: 0, input_row_index: 0, output: { answer: 'a', gene: 'g2' } }, { row_index: 1, input_row_index: 0, output: { answer: 'a', gene: 'g1' } }],
    inputEntries: [[0, { gtRows: [{ gtRowIndex: 0 }, { gtRowIndex: 1 }, { gtRowIndex: 2 }] }]], outputFields: [],
    runWs: { headers: [], rows: [[]] }, gtContent: { headers: ['answer', 'gene'], rows: [['a', 'g1'], ['b', 'g2'], ['c', 'g3']] },
    expectMatched: [true, true, false], expectGtNums: [2, 1, 3] },
  { name: 'gt-only rows are unmatched', scoreMapping: bundle([rule('answer', ['answer'])]),
    results: [], inputEntries: [[0, { gtRows: [{ gtNum: 1 }, { gtNum: '2' }] }]], outputFields: [],
    runWs: { headers: [], rows: [[]] }, gtContent: { headers: ['answer'], rows: [['a'], ['b']] },
    expectMatched: [false, false], expectGtNums: [1, 2] },
];

function checkGolden(golden, result) {
  assert.deepEqual(result.verifyRows.map((row) => row.matched), golden.expectMatched, golden.name);
  if (golden.expectGtNums) assert.deepEqual(result.verifyRows.map((row) => row.gtNum), golden.expectGtNums, golden.name);
}

// ---------- driver ----------
// (gzip keeps the multi-megabyte JSON small in git; the freshness test compares the decompressed text)

const ARG_KEYS = ['scoreMapping', 'scoreMatchCode', 'results', 'inputEntries', 'outputFields', 'runWs', 'gtContent'];

async function runCase(spec, state) {
  const args = JSON.parse(JSON.stringify(Object.fromEntries(ARG_KEYS.filter((k) => spec[k] !== undefined).map((k) => [k, spec[k]]))));
  state.embeddingCosines = [];
  state.concepts = [];
  state.codeRuns = [];
  state.codeFn = spec.codeName ? CODE_CASES.find((c) => c.name === spec.codeName).js : null;
  let expected;
  try {
    const { verifyRows, matchedCount, total } = await evaluateScoreOutputGt({ ...args });
    expected = { verifyRows, matchedCount, total };
  } catch (error) {
    expected = { error: String(error?.message || error) };
  }
  return JSON.parse(JSON.stringify({
    category: spec.category,
    ...(spec.codeName ? { codeName: spec.codeName } : {}),
    ...(spec.name ? { name: spec.name } : {}),
    args,
    embeddingCosines: state.embeddingCosines,
    concepts: state.concepts,
    ...(state.codeRuns.length ? { codeRuns: state.codeRuns } : {}),
    expected,
  }));
}

export async function buildScoreParityFixture() {
  const r = makeRandom(20261107);
  const specs = [
    ...GOLDEN_CASES.map((g) => ({ ...g, category: 'golden' })),
    ...primitiveCases(r, 600),
    ...numericCases(r, 150),
    ...numberFormatCases(r, 40),
    ...treeCases(r, 300),
    ...tableCases(r, 350),
    ...smartCases(r, 250),
    ...legacyBundleCases(r),
    ...prototypeKeyCases(),
    ...edgeCases(),
    ...errorCases(r),
    ...codeCases(r),
  ];
  const state = {};
  const savedFetch = globalThis.fetch;
  globalThis.fetch = makeStubFetch(state);
  const cases = [];
  try {
    for (const [index, spec] of specs.entries()) {
      const recorded = await runCase(spec, state);
      if (spec.category === 'golden') {
        assert.ok(!recorded.expected.error, `${spec.name}: ${recorded.expected.error}`);
        checkGolden(spec, recorded.expected);
      }
      cases.push({ id: index, ...recorded });
    }
  } finally {
    globalThis.fetch = savedFetch;
  }
  const codeSources = Object.fromEntries(CODE_CASES.map((c) => [c.name, c.python]));
  return { version: 1, generator: 'app/tests/scoreParityFixture.mjs', codeCases: codeSources, cases };
}

export function serializeFixture(fixture) {
  return `${JSON.stringify(fixture)}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fixture = await buildScoreParityFixture();
  writeFileSync(FIXTURE_PATH, gzipSync(serializeFixture(fixture), { level: 9 }));
  const counts = {};
  for (const c of fixture.cases) counts[c.category] = (counts[c.category] || 0) + 1;
  console.log(`Wrote ${fixture.cases.length} cases to ${FIXTURE_PATH}`, counts);
}
