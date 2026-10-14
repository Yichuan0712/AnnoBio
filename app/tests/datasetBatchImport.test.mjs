import test from 'node:test';
import assert from 'node:assert/strict';
import { imageCell, moveImageAsset } from '../src/datasetContent.js';
import { buildBatchAssetPlan, suggestBatchMatchColumn } from '../src/datasetBatchImportPlan.js';

const rows = [
  ['alpha.png', 'unrelated', imageCell(['old'], ['old.png'])],
  ['beta.png', 'alpha.png', imageCell()],
  ['gamma.png', 'unrelated', imageCell()],
];
const files = ['alpha.png', 'beta.png', 'extra.png'].map((name) => ({ name }));

test('suggests the filename column with the most unambiguous matches', () => {
  assert.deepEqual(suggestBatchMatchColumn(rows, [0, 1], files), { columnIndex: 0, matchCount: 2 });
});

test('previews unmatched files and skips filled cells by default', () => {
  const plan = buildBatchAssetPlan({ rows, files, targetColumn: 2, sourceColumn: 0, mode: 'filename', kind: 'image' });
  assert.deepEqual(plan.assignments.map((entry) => entry.rowIndex), [0, 1, null]);
  assert.equal(plan.unmatchedFiles, 1);
  assert.equal(plan.skippedFiles, 1);
  assert.deepEqual(plan.importable.map((entry) => entry.file.name), ['beta.png']);
});

test('manual mapping and append mode can resolve an unmatched file', () => {
  const plan = buildBatchAssetPlan({
    rows, files, targetColumn: 2, sourceColumn: 0, mode: 'filename', kind: 'image',
    manualRows: new Map([[2, 2]]), existingMode: 'append',
  });
  assert.deepEqual(plan.importable.map((entry) => entry.rowIndex), [0, 1, 2]);
});

test('duplicate filename rows remain unmatched until a destination is chosen', () => {
  const duplicateRows = [rows[0], ['alpha.png', '', imageCell()]];
  const plan = buildBatchAssetPlan({
    rows: duplicateRows, files: [files[0]], targetColumn: 2, sourceColumn: 0, mode: 'filename', kind: 'image',
  });
  assert.equal(plan.assignments[0].reason, 'Multiple rows match');
  assert.equal(plan.importable.length, 0);
});

test('row order starts at the selected dataset row', () => {
  const plan = buildBatchAssetPlan({ rows, files, targetColumn: 2, mode: 'row-order', startRow: 1, kind: 'image' });
  assert.deepEqual(plan.assignments.map((entry) => entry.rowIndex), [1, 2, null]);
});

test('default placement fills empty cells and makes new rows for the rest', () => {
  const plan = buildBatchAssetPlan({ rows, files, targetColumn: 2, mode: 'empty', kind: 'image' });
  assert.deepEqual(plan.assignments.map((entry) => entry.rowIndex), [1, 2, 3]);
  assert.equal(plan.newRows, 1);
  assert.equal(plan.importable.length, 3);
});

test('dragging a staged file to a filled image cell appends it there', () => {
  const plan = buildBatchAssetPlan({
    rows, files: [files[0]], targetColumn: 2, mode: 'empty', kind: 'image',
    manualTargets: new Map([[0, { rowIndex: 0, columnIndex: 2, placement: 'append' }]]),
  });
  assert.equal(plan.importable[0].rowIndex, 0);
  assert.equal(plan.importable[0].placement, 'append');
  assert.equal(plan.skippedFiles, 0);
});

test('manual placement reserves its empty cell so automatic placement does not collide', () => {
  const plan = buildBatchAssetPlan({
    rows, files, targetColumn: 2, mode: 'empty', kind: 'image',
    manualTargets: new Map([[0, { rowIndex: 2, columnIndex: 2, placement: 'append' }]]),
  });
  assert.deepEqual(plan.assignments.map((entry) => entry.rowIndex), [2, 1, 3]);
});

test('moving an image keeps other source images and appends to the target', () => {
  const moved = moveImageAsset(imageCell(['a', 'b'], ['a.png', 'b.png']), imageCell(['c'], ['c.png']), 0);
  assert.deepEqual(moved.source, imageCell(['b'], ['b.png']));
  assert.deepEqual(moved.target, imageCell(['c', 'a'], ['c.png', 'a.png']));
});
