import test from 'node:test';
import assert from 'node:assert/strict';
import { imageCell, normalizeDatasetContent, pdfCell } from '../src/datasetContent.js';
import { planChangeSet } from '../src/agent/operations/changeSet.js';
import { inspectWorkflowNode, readNodeRows } from '../src/agent/canvas/workflowNodeInspector.js';
import { buildWorkspaceSummary } from '../src/agent/context/workspaceSummary.js';
import { extractInputFields } from '../src/promptText.js';

const context = { extractInputFields };
const plan = (state, operations, extra = {}) => planChangeSet(state, operations, { ...context, ...extra });
const find = (result, ref) => result.state.nodes.find((node) => node.nodeId === (result.refs[ref] || ref));
const source = () => ({ nodes: [{ type: 'dataset', nodeId: 'source', name: 'Source', datasetContent: normalizeDatasetContent({
  headers: ['value'], rows: Array.from({ length: 8 }, (_, index) => [String(index + 1)]),
  rowIds: Array.from({ length: 8 }, (_, index) => `row-${index}`),
}) }], connections: [] });

test('Agent schemas retain Allow None and numeric/list examples across inspection and new versions', () => {
  const original = plan({ nodes: [], connections: [] }, [{ op: 'add_prompt', ref: '$prompt', name: 'Extract',
    text: 'Read {text}.',
    output: { return_shape: 'single', fields: [
      { key: 'genes', type: 'list_str', description: 'Gene symbols', allow_none: true, examples: [['A', 'B']] },
      { key: 'weights', type: 'list_float', description: 'Weights', examples: [[0, '1.5']] },
      { key: 'confidence', type: 'float', description: 'Confidence', examples: [0, '0.5'] },
    ] },
  }]);
  const prompt = find(original, '$prompt');
  const fields = prompt.outputFormat.fields;
  assert.deepEqual(fields.map((field) => field.examples), [[['A', 'B']], [[0, 1.5]], [0, 0.5]]);
  assert.equal(fields[0].allowNone, true);
  assert.match(original.items[0].diffs[1].after, /allows None/);
  assert.deepEqual(inspectWorkflowNode(original.state, prompt.nodeId, context).details.output.fields, fields);
  const version = plan(original.state, [{ op: 'add_prompt_version', ref: '$version', prompt: prompt.nodeId,
    output: { return_shape: 'table' } }]);
  assert.deepEqual(find(version, '$version').outputFormat, { returnShape: 'table', fields });
  assert.deepEqual(original.state.nodes[0].outputFormat.fields, fields);
});

test('Agent schema edits reject duplicate names and malformed list/numeric examples', () => {
  const add = { op: 'add_prompt', text: 'Read.',
    output: { fields: [{ key: 'a', type: 'str', description: 'Answer' }] } };
  const empty = { nodes: [], connections: [] };
  assert.equal(plan(empty, [add]).state.nodes[0].outputFormat.returnShape, 'table');
  assert.throws(() => plan(empty, [{ ...add, text: '   ' }]), /text must be the prompt text/);
  assert.throws(() => plan(empty, [{ ...add, output: { fields: [{ key: 'a', type: 'list_str', examples: ['A,B'] }] } }]), /each list example as an array/);
  assert.throws(() => plan(empty, [{ ...add, output: { fields: [{ key: 'a', type: 'float', examples: ['bad'] }] } }]), /numeric examples/);
});

test('existing Samples share the canvas quota, lock settings and release rows when an output is removed', async () => {
  const state = source();
  const snapshot = structuredClone(state);
  const configured = plan(state, [{ op: 'add_sampler', ref: '$sample', source: 'source', create_dataset: false,
    sampling: 'random', size_unit: 'rows', size: 2 }]);
  const sampleId = configured.refs.$sample;
  assert.equal(inspectWorkflowNode(configured.state, sampleId).details.settingsLocked, false);
  const drawn = plan(configured.state, Array.from({ length: 4 }, (_, index) => ({ op: 'sample_dataset', sampler: sampleId, ref: `$pull${index}` })));
  assert.deepEqual(state, snapshot);
  const outputs = drawn.state.nodes.filter((node) => node.samplerNodeId === sampleId);
  assert.equal(new Set(outputs.flatMap((node) => node.sampledSourceRowIds)).size, 8);
  const inspected = inspectWorkflowNode(drawn.state, sampleId);
  assert.deepEqual(inspected.details.progress, { completed: 4, total: 4, remaining: 0, rowsPerSample: 2, remainingRows: 0 });
  assert.equal(inspected.details.settingsLocked, true);
  assert.equal(inspected.details.canCreateSample, false);
  assert.equal(inspectWorkflowNode(drawn.state, 'source').contentLock.locked, true);
  assert.match(await buildWorkspaceSummary(drawn.state), /without replacement, 2 rows; 4\/4 samples created, 0 remaining; settings locked/);
  assert.throws(() => plan(drawn.state, [{ op: 'sample_dataset', sampler: sampleId }]), /Not enough remaining data/);
  assert.throws(() => plan(drawn.state, [{ op: 'update', node: sampleId, set: { size: 1 } }]), /settings are locked/);
  const removed = plan(drawn.state, [{ op: 'remove', node: outputs[0].nodeId }]);
  assert.equal(inspectWorkflowNode(removed.state, sampleId).details.progress.remaining, 1);
  const again = plan(removed.state, [{ op: 'sample_dataset', sampler: sampleId, ref: '$again' }]);
  assert.deepEqual(new Set(find(again, '$again').sampledSourceRowIds), new Set(outputs[0].sampledSourceRowIds));
});

test('Sample settings are editable before sampling; specified rows repeat, normalize ranges and preserve duplicates', () => {
  const created = plan(source(), [{ op: 'add_sampler', ref: '$sample', source: 'source', create_dataset: false }]);
  const sampleId = created.refs.$sample;
  const edited = plan(created.state, [
    { op: 'update', node: sampleId, set: { sampling: 'rows', rows: '4-2 2 99' } },
    { op: 'sample_dataset', sampler: sampleId, ref: '$one' },
    { op: 'sample_dataset', sampler: sampleId, ref: '$two' },
  ]);
  assert.deepEqual(find(edited, '$one').datasetContent.rows, [['2'], ['3'], ['4'], ['2']]);
  assert.deepEqual(find(edited, '$two').datasetContent.rows, find(edited, '$one').datasetContent.rows);
  const inspection = inspectWorkflowNode(edited.state, sampleId);
  assert.equal(inspection.details.progress, null);
  assert.equal(inspection.details.settingsLocked, true);
  assert.equal(inspection.details.canCreateSample, true);
  const renamed = plan(edited.state, [{ op: 'update', node: sampleId, set: { name: 'Repeated rows' } }]);
  assert.equal(find(renamed, sampleId).name, 'Repeated rows');
});

const media = () => ({ nodes: [{ type: 'dataset', nodeId: 'media', name: 'Media', datasetContent: normalizeDatasetContent({
  headers: ['label', 'photos', 'other photos', 'paper', 'empty PDF'], columnTypes: ['text', 'image', 'image', 'pdf', 'pdf'],
  rows: [['A', imageCell(['img1', 'img2'], ['a.png', 'b.png']), imageCell(), pdfCell(['pdf1'], ['paper.pdf']), pdfCell()],
    ['B', imageCell(), imageCell(['img3'], ['c.png']), pdfCell(), pdfCell()]], rowIds: ['row-a', 'row-b'],
}) }], connections: [] });

test('Dataset edits and copies preserve uploaded files, empty column types and row identity', () => {
  const state = media();
  const snapshot = structuredClone(state);
  const rows = readNodeRows(state, 'media');
  assert.deepEqual(rows.rowIds, ['row-a', 'row-b']);
  assert.deepEqual(rows.rows[0].photos, imageCell(['img1', 'img2'], ['a.png', 'b.png']));
  const changed = plan(state, [{ op: 'update', node: 'media', set: {
    rows: rows.rows.map(({ row, ...cells }) => ({ ...cells, label: `${cells.label}!` })).reverse(),
    row_ids: rows.rowIds.slice().reverse(),
  } }]);
  assert.deepEqual(state, snapshot);
  assert.deepEqual(find(changed, 'media').datasetContent.rowIds, ['row-b', 'row-a']);
  assert.deepEqual(find(changed, 'media').datasetContent.columnTypes, ['text', 'image', 'image', 'pdf', 'pdf']);
  assert.deepEqual(find(changed, 'media').datasetContent.rows[1][3], pdfCell(['pdf1'], ['paper.pdf']));
  const copies = plan(changed.state, [
    { op: 'duplicate_dataset', dataset: 'media', ref: '$copy' },
    { op: 'duplicate_dataset', dataset: 'media', as_version: true, ref: '$version' },
  ]);
  assert.deepEqual(find(copies, '$version').datasetContent, find(changed, 'media').datasetContent);
  assert.notDeepEqual(find(copies, '$copy').datasetContent.rowIds, find(changed, 'media').datasetContent.rowIds);
  assert.deepEqual(find(copies, '$copy').datasetContent.columnTypes, ['text', 'image', 'image', 'pdf', 'pdf']);
  assert.ok(copies.state.connections.some((edge) => edge.type === 'dataset-to-dataset' && edge.toId === copies.refs.$version));
});

test('image movement follows the table drag operation and respects content locks', () => {
  const state = media();
  const op = { op: 'move_image', dataset: 'media', from_row: 1, from_column: 'photos', image: 2, to_row: 2, to_column: 'other photos' };
  const changed = plan(state, [op]);
  const content = find(changed, 'media').datasetContent;
  assert.deepEqual(content.rows[0][1], imageCell(['img1'], ['a.png']));
  assert.deepEqual(content.rows[1][2], imageCell(['img3', 'img2'], ['c.png', 'b.png']));
  assert.deepEqual(content.rowIds, ['row-a', 'row-b']);
  assert.equal(state.nodes[0].datasetContent.rows[0][1].assetIds.length, 2);
  assert.throws(() => plan(state, [op], { contentLocks: new Map([['media', ['run']]]) }), /content is locked/);
  assert.throws(() => plan(state, [{ ...op, to_column: 'label' }]), /Both columns must be image columns/);
});

test('typed tables can reuse files but reject invented assets and accidental stringification', () => {
  const state = media();
  const created = plan(state, [{ op: 'add_dataset', ref: '$new', columns: [{ name: 'image', type: 'image' }, { name: 'PDF', type: 'pdf' }],
    rows: [[imageCell(['img2']), pdfCell(['pdf1'])]] }]);
  assert.deepEqual(find(created, '$new').datasetContent.rows[0], [imageCell(['img2'], ['b.png']), pdfCell(['pdf1'], ['paper.pdf'])]);
  assert.throws(() => plan(state, [{ op: 'add_dataset', columns: [{ name: 'x', type: 'image' }], rows: [[imageCell(['not-uploaded'])]] }]), /Unknown image asset/);
  assert.throws(() => plan(state, [{ op: 'add_dataset', columns: ['x'], rows: [[imageCell(['img1'])]] }]), /is text; use a scalar/);
});

test('a version of a sampled Dataset keeps provenance without consuming another pull', () => {
  const drawn = plan(source(), [{ op: 'add_sampler', ref: '$sample', dataset_ref: '$data', source: 'source', size: 2, size_unit: 'rows' }]);
  const copied = plan(drawn.state, [{ op: 'duplicate_dataset', dataset: drawn.refs.$data, ref: '$version', as_version: true }]);
  assert.equal(find(copied, '$version').samplerNodeId, drawn.refs.$sample);
  assert.equal(inspectWorkflowNode(copied.state, drawn.refs.$sample).details.progress.completed, 1);
});

test('standalone Generate and Process nodes can be created first and connected later, like the toolbar', () => {
  const created = plan(source(), [
    { op: 'add_run', ref: '$run' },
    { op: 'add_process', ref: '$process' },
    { op: 'update', node: '$process', set: { code: 'def process(df):\n    return df.head(2)' } },
  ]);
  assert.equal(created.state.connections.length, 0);
  assert.deepEqual(inspectWorkflowNode(created.state, created.refs.$run).details.input, null);
  assert.equal(inspectWorkflowNode(created.state, created.refs.$process).details.primaryInput, null);
  const connected = plan(created.state, [
    { op: 'connect', node: created.refs.$process, input: 'df', source: 'source' },
    { op: 'connect', node: created.refs.$run, input: 'input', source: 'source' },
  ]);
  assert.equal(inspectWorkflowNode(connected.state, created.refs.$process).details.primaryInput.nodeId, 'source');
  assert.equal(inspectWorkflowNode(connected.state, created.refs.$run).details.input.nodeId, 'source');
  assert.throws(() => plan(source(), [{ op: 'add_run', input_mapping: { text: 'value' } }]), /Connect a Prompt and Data input/);
});

test('a duplicated Process copies its code without inputs or results', () => {
  const created = plan(source(), [{ op: 'add_process', ref: '$process', primary_input: 'source', code: 'def process(df):\n    return df' }]);
  const original = find(created, '$process');
  original.processOutputPorts = { ports: ['result'], dynamic: false };
  original.dfResults = JSON.stringify({ headers: ['value'], rows: [['old result']] });
  const duplicated = plan(created.state, [{ op: 'duplicate_process', process: original.nodeId, ref: '$copy' }]);
  const copy = find(duplicated, '$copy');
  assert.equal(copy.dfCode, original.dfCode);
  assert.deepEqual(copy.processOutputPorts, original.processOutputPorts);
  assert.equal(copy.dfResults, undefined);
  assert.equal(duplicated.state.connections.some((edge) => edge.toId === copy.nodeId), false);
});

test('reading an unknown Process branch reports the mistake instead of returning another branch', () => {
  const result = readNodeRows({ nodes: [{ type: 'process', nodeId: 'p', name: 'Split',
    dfResults: JSON.stringify({ outputs: { kept: { headers: ['x'], rows: [['a']] } } }) }], connections: [] }, 'p', { branch: 'typo' });
  assert.match(result.error, /Unknown Process output "typo"/);
  assert.equal(result.rows, undefined);
});
