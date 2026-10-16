import test from 'node:test';
import assert from 'node:assert/strict';
import { BatchAssetDraft } from '../src/batchAssetDraft.js';
import { buildBatchAssetPlan } from '../src/datasetBatchImportPlan.js';
import { imageCell, pdfCell } from '../src/datasetContent.js';

const emptyPlan = { importable: [] };
const fixture = () => [[imageCell(['a', 'b'], ['a.png', 'b.png']), imageCell(), pdfCell(['p'], ['p.pdf'])]];

test('moving and reordering existing images changes only the import draft', () => {
  const rows = fixture();
  const before = structuredClone(rows);
  const draft = new BatchAssetDraft(rows, ['image', 'image', 'pdf'], 'image');
  const items = draft.items(emptyPlan, 0, 0);
  draft.moveExisting(items[1].key, 0, 0, 0, 0);
  draft.placeInOrder(0, 0, items[1].key, items[0].key, items);
  assert.equal(draft.hasExistingChanges(emptyPlan), true);
  assert.deepEqual(draft.resultCells(emptyPlan, [])[0].cell.assetIds, ['b', 'a']);
  draft.moveExisting(items[1].key, 0, 0, 0, 1);
  draft.placeInOrder(0, 1, items[1].key, null, []);
  const result = draft.resultCells(emptyPlan, []);
  assert.deepEqual(result.map((entry) => entry.cell.assetIds), [['a'], ['b']]);
  assert.deepEqual(rows, before);
  assert.deepEqual(rows[0][2], before[0][2]);
});

test('pending images can be inserted before existing images and retain their uploaded identity', () => {
  const draft = new BatchAssetDraft(fixture(), ['image', 'image', 'pdf'], 'image');
  const file = { key: 'file:one', name: 'new.png' };
  const plan = { importable: [{ file, rowIndex: 0, columnIndex: 0 }] };
  const items = draft.items(plan, 0, 0);
  draft.placeInOrder(0, 0, file.key, items[1].key, items);
  assert.deepEqual(draft.resultCells(plan, [{ id: 'new', name: 'new.png' }])[0].cell, imageCell(['a', 'new', 'b'], ['a.png', 'new.png', 'b.png']));
  assert.throws(() => draft.resultCells(plan, []), /No dataset cells were changed/);
});

test('existing PDFs can be reordered without uploading files', () => {
  const rows = [[pdfCell(['p', 'q'], ['p.pdf', 'q.pdf'])]];
  const draft = new BatchAssetDraft(rows, ['pdf'], 'pdf');
  const items = draft.items(emptyPlan, 0, 0);
  draft.moveExisting(items[1].key, 0, 0, 0, 0);
  draft.placeInOrder(0, 0, items[1].key, items[0].key, items);
  assert.deepEqual(draft.resultCells(emptyPlan, [])[0].cell, pdfCell(['q', 'p'], ['q.pdf', 'p.pdf']));
});

test('legacy missing asset names do not count as an edit', () => {
  const draft = new BatchAssetDraft([[imageCell(['a'])]], ['image'], 'image');
  assert.equal(draft.hasExistingChanges(emptyPlan), false);
  assert.equal(draft.moveExisting('asset:0:0:0', 0, 0, 0, 1), false);
});

test('moving existing assets into a previewed new row preserves them without mutating original rows', () => {
  const rows = fixture();
  const draft = new BatchAssetDraft(rows, ['image', 'image', 'pdf'], 'image');
  const first = draft.items(emptyPlan, 0, 0)[0];
  assert.equal(draft.moveExisting(first.key, 0, 0, 1, 1), true);
  assert.deepEqual(draft.planningRows()[1][1].assetIds, ['a']);
  assert.equal(rows.length, 1);
  assert.deepEqual(draft.resultCells(emptyPlan, []).find((entry) => entry.rowIndex === 1).cell.assetIds, ['a']);
});

test('manual placement in a new preview row reserves that row for automatic allocation', () => {
  const rows = [[imageCell(['old'])]];
  const files = ['one.png', 'two.png', 'three.png'].map((name) => ({ name }));
  const plan = buildBatchAssetPlan({ rows, files, targetColumn: 0, mode: 'empty', kind: 'image', manualTargets: new Map([[1, { rowIndex: 1, columnIndex: 0, placement: 'append' }]]) });
  assert.deepEqual(plan.importable.map((entry) => entry.rowIndex), [2, 1, 3]);
  const invalid = buildBatchAssetPlan({ rows, files, targetColumn: 0, mode: 'empty', kind: 'image', manualTargets: new Map([[1, { rowIndex: 100, columnIndex: 0, placement: 'append' }]]) });
  assert.equal(invalid.assignments[1].rowIndex, null);
});
