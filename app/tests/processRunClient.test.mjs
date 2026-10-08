import test from 'node:test';
import assert from 'node:assert/strict';

import { rowsFromDicts } from '../src/processRunClient.js';

test('a branch without rows keeps the columns the backend reports', () => {
  const table = rowsFromDicts([], ['PMID', 'label']);
  assert.deepEqual([table.headers, table.rows], [['PMID', 'label'], []]);
});

test('rows follow the reported column order, and a result from an older job still reads its keys', () => {
  assert.deepEqual(rowsFromDicts([{ label: 'pos', PMID: '1' }], ['PMID', 'label']).rows, [['1', 'pos']]);
  assert.deepEqual(rowsFromDicts([{ label: 'pos', PMID: '1' }]).headers, ['label', 'PMID']);
});
