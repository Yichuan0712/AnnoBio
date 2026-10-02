import test from 'node:test';
import assert from 'node:assert/strict';
import { describeHistoryRecord, historyStatusLabel } from '../src/runHistoryPresentation.js';

test('Run history describes its input, result and empty execution in plain words', () => {
  const display = describeHistoryRecord({
    kind: 'run', status: 'completed',
    inputs: { prompt: { name: 'Rewrite pair to UniProt names' }, dataset: { name: 'Pairs needing name rewrite', content: { rows: [] } } },
    results: { runResults: [] }, summary: { codeLine: 'def process(df):' },
  });
  assert.equal(display.title, 'Prompt: Rewrite pair to UniProt names');
  assert.equal(display.input, 'Input: Pairs needing name rewrite (0 rows)');
  assert.equal(display.output, 'Output: 0 rows (empty input)');
  assert.equal(historyStatusLabel('completed'), 'Completed');
});

test('Process history names inputs and counts rows in each output branch', () => {
  const display = describeHistoryRecord({
    kind: 'process',
    inputs: { bindings: [{ name: 'Extracted pairs', content: { rows: [['one'], ['two']] } }] },
    results: { dfResults: { outputs: {
      ready_for_uniprot_matching: { headers: ['pair'], rows: [['one'], ['two']] },
      needs_name_rewrite: { headers: ['pair'], rows: [] },
    } } },
    summary: { codeLine: 'import requests', branchCount: 2 },
  });
  assert.equal(display.title, 'Process result');
  assert.equal(display.input, 'Input: Extracted pairs (2 rows)');
  assert.equal(display.output, 'Output: ready for uniprot matching: 2 rows · needs name rewrite: 0 rows');
  assert.equal(display.output.includes('import requests'), false);
});

test('a single Process output is shown as a row count', () => {
  const display = describeHistoryRecord({
    kind: 'process', inputs: { bindings: [] },
    results: { dfResults: { outputs: { result: { headers: ['answer'], rows: [] } } } },
  });
  assert.equal(display.output, 'Output: 0 rows');
});
