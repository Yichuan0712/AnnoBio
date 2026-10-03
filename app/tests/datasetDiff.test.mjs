import test from 'node:test';
import assert from 'node:assert/strict';
import { diffDatasets, diffCellText } from '../src/datasetDiff.js';
import { imageCell } from '../src/datasetContent.js';

const statuses = (diff) => diff.rows.map((r) => `${r.status}:${r.before}:${r.after}`);

test('Rows that keep their row IDs are compared cell by cell, wherever they moved', () => {
  const before = { headers: ['text', 'label'], rowIds: ['a', 'b', 'c'], rows: [['one', 'pos'], ['two', 'neg'], ['three', 'neu']] };
  const after = { headers: ['text', 'label'], rowIds: ['a', 'c', 'd'], rows: [['one', 'neg'], ['three', 'neu'], ['four', 'pos']] };
  const diff = diffDatasets(before, after);
  assert.equal(diff.method, 'rowId');
  assert.deepEqual(statuses(diff), ['changed:0:0', 'removed:1:-1', 'same:2:1', 'added:-1:2']);
  assert.deepEqual(diff.rows[0].changed, [1]);
  assert.deepEqual(diff.summary, {
    addedRows: 1, removedRows: 1, changedRows: 1, unchangedRows: 1, changedCells: 1, addedColumns: [], removedColumns: [],
  });
});

test('An edited row is not mistaken for a removed and an added row when IDs are shared', () => {
  const before = { headers: ['text'], rowIds: ['a'], rows: [['completely different']] };
  const after = { headers: ['text'], rowIds: ['a'], rows: [['nothing alike']] };
  assert.deepEqual(statuses(diffDatasets(before, after)), ['changed:0:0']);
});

test('Columns are matched by name; added and removed columns are reported, not counted as cell edits', () => {
  const before = { headers: ['id', 'old', 'label'], rowIds: ['a'], rows: [['1', 'x', 'pos']] };
  const after = { headers: ['id', 'label', 'note'], rowIds: ['a'], rows: [['1', 'pos', 'n']] };
  const diff = diffDatasets(before, after);
  assert.deepEqual(diff.columns.map((c) => `${c.status}:${c.name}`), ['same:id', 'removed:old', 'same:label', 'added:note']);
  assert.deepEqual(statuses(diff), ['same:0:0']);
  assert.deepEqual(diff.summary.addedColumns, ['note']);
  assert.deepEqual(diff.summary.removedColumns, ['old']);
});

test('Versions without shared IDs match identical rows, then pair similar leftovers as edits', () => {
  const before = { headers: ['text', 'label'], rowIds: ['1', '2', '3', '4'], rows: [['a', 'p'], ['b', 'n'], ['c', 'p'], ['d', 'n']] };
  const after = { headers: ['text', 'label'], rowIds: ['x', 'y', 'z', 'w'], rows: [['a', 'p'], ['b', 'p'], ['zzz', 'qqq'], ['d', 'n']] };
  const diff = diffDatasets(before, after);
  assert.equal(diff.method, 'content');
  assert.deepEqual(statuses(diff), ['same:0:0', 'changed:1:1', 'removed:2:-1', 'added:-1:2', 'same:3:3']);
});

test('Asset cells compare by asset, not by display name', () => {
  const before = { headers: ['img'], rowIds: ['a'], rows: [[imageCell(['asset-1'], ['cat.png'])]] };
  const after = { headers: ['img'], rowIds: ['a'], rows: [[imageCell(['asset-2'], ['cat.png'])]] };
  assert.deepEqual(statuses(diffDatasets(before, after)), ['changed:0:0']);
  assert.equal(diffCellText(before.rows[0][0], after.rows[0][0]), null);
});

test('Cell text diffs by word, and by character for Chinese', () => {
  assert.deepEqual(diffCellText('the cat sat', 'the dog sat'), [
    { type: 'same', text: 'the ' }, { type: 'remove', text: 'cat' }, { type: 'add', text: 'dog' }, { type: 'same', text: ' sat' },
  ]);
  assert.deepEqual(diffCellText('正面情绪', '负面情绪'), [
    { type: 'remove', text: '正' }, { type: 'add', text: '负' }, { type: 'same', text: '面情绪' },
  ]);
});
