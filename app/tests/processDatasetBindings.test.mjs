import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildProcessDatasetBindings,
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
