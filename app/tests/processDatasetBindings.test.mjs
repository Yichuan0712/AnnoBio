import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildProcessDatasetBindings,
  processDatasetInputs,
  referencedDatasetAliasNames,
  referencedDatasetAliases,
} from '../src/processDatasetBindings.js';

test('recognizes an alias derived from a Dataset name that starts with a number', () => {
  const bindings = buildProcessDatasetBindings([
    { nodeId: 'primary', name: '12 Extract sentiment words results' },
    { nodeId: 'secondary', name: '13 Explain sentiment results' },
  ], 'primary');

  const code = `def process(df):
    return df.merge(df_13_explain_sentiment_results, on="id")`;

  assert.deepEqual([...referencedDatasetAliasNames(code)], ['df_13_explain_sentiment_results']);
  assert.deepEqual([...referencedDatasetAliases(code, bindings)], ['secondary']);
});

test('reports numeric and alphabetic df aliases through the same scanner', () => {
  const aliases = referencedDatasetAliasNames('df_alpha.merge(df_13_results)');
  assert.deepEqual([...aliases], ['df_alpha', 'df_13_results']);
});

test('a saved alias selects its copied Dataset when another Dataset derives the same name', () => {
  const bindings = [
    { nodeId: 'original', alias: 'df_candidates' },
    { nodeId: 'copy', alias: 'df_candidates' },
  ];
  assert.deepEqual([...referencedDatasetAliases('return df_candidates', bindings, { copy: 'df_candidates' })], ['copy']);
});

test('a Process reads its primary, each chosen Dataset and each Dataset its code names', () => {
  const datasets = [
    { nodeId: 'ready', name: 'Pairs ready' },
    { nodeId: 'candidates', name: 'Candidates' },
    { nodeId: 'lookup', name: 'Lookup' },
    { nodeId: 'other', name: 'Other' },
  ];
  const inputs = processDatasetInputs({
    datasets, primaryDatasetId: 'ready', inputIds: ['ready', 'candidates'], code: 'return df.merge(df_lookup)',
  });
  assert.deepEqual(inputs.map(({ nodeId, alias, primary, input, referenced }) => [nodeId, alias, primary, input, referenced]), [
    ['ready', 'df', true, true, false],
    ['candidates', 'df_candidates', false, true, false],
    ['lookup', 'df_lookup', false, true, true],
    ['other', 'df_other', false, false, false],
  ]);
});

test('an input keeps its saved alias, and no other Dataset takes it', () => {
  const inputs = processDatasetInputs({
    datasets: [
      { nodeId: 'copy', name: 'Candidates (Copy 1)' },
      { nodeId: 'original', name: 'Candidates' },
      { nodeId: 'former-primary', name: 'Ready' },
      { nodeId: 'primary', name: 'Ready (Copy 1)' },
    ],
    primaryDatasetId: 'primary',
    inputIds: ['copy', 'former-primary', 'primary'],
    savedAliases: { copy: 'df_candidates', 'former-primary': 'df', primary: 'df_ready_copy_1' },
    code: 'return df.merge(df_candidates)',
  });
  assert.deepEqual(inputs.map(({ nodeId, alias, input, referenced }) => [nodeId, alias, input, referenced]), [
    ['copy', 'df_candidates', true, true],
    ['original', 'df_candidates_2', false, false],
    ['former-primary', 'df_ready', true, false],
    ['primary', 'df', true, false],
  ]);
});
