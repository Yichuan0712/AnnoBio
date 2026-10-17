import test from 'node:test';
import assert from 'node:assert/strict';
import { imageCell, normalizeDatasetContent, pdfCell } from '../src/datasetContent.js';
import { compileInput } from '../src/runInputBuilder.js';
import { planChangeSet } from '../src/agent/operations/changeSet.js';
import { inspectWorkflowNode } from '../src/agent/canvas/workflowNodeInspector.js';
import { extractInputFields } from '../src/promptText.js';

const plan = (state, operations) => planChangeSet(state, operations, { extractInputFields });
const canvas = () => ({ nodes: [
  { type: 'dataset', nodeId: 'photos', name: 'Photos', datasetContent: normalizeDatasetContent({
    headers: ['photo', 'caption'], columnTypes: ['image', 'text'], rows: [[imageCell(['a1'], ['a.png']), 'A cat']] }) },
  { type: 'prompt', nodeId: 'p', name: 'Describe', text: 'Describe {photo} given {caption}',
    outputFormat: { returnShape: 'single', fields: [{ key: 'answer', type: 'str' }] } },
], connections: [] });

test('an input sends what its cell holds: image and PDF cells as files, anything else as text', () => {
  const { content } = compileInput('See {photo}, {doc} and {note}.', {
    photo: imageCell(['img-1']), doc: pdfCell(['pdf-1']), note: 'plain',
  });
  assert.deepEqual(content.filter((block) => block.type !== 'text').map((block) => [block.type, block.asset_id]),
    [['image_ref', 'img-1'], ['pdf_ref', 'pdf-1']]);
  assert.match(content.map((block) => block.text || '').join(''), /plain\./);
});

test('the Agent cannot give Prompt inputs a type', () => {
  const output = { fields: [{ key: 'answer', type: 'str', description: 'The answer' }] };
  assert.throws(() => plan(canvas(), [{ op: 'add_prompt', text: 'Read {photo}', output, input_types: { photo: 'image' } }]), /have no type/);
  assert.throws(() => plan(canvas(), [{ op: 'add_prompt_version', prompt: 'p', input_types: { photo: 'image' } }]), /have no type/);
  assert.throws(() => plan(canvas(), [{ op: 'update', node: 'p', set: { input_types: { photo: 'image' } } }]), /have no type/);
  const added = plan(canvas(), [{ op: 'add_prompt', ref: '$p', text: 'Read {photo}', output }]);
  assert.equal('inputTypes' in added.state.nodes.at(-1), false);
  assert.deepEqual(inspectWorkflowNode(canvas(), 'p', { extractInputFields }).details.inputs, ['photo', 'caption']);
});

test('the Agent maps an image column to a Prompt input like the Generate window does', () => {
  const result = plan(canvas(), [{ op: 'add_run', ref: '$g', prompt: 'p', input: 'photos',
    input_mapping: { photo: 'photo', caption: 'caption' } }]);
  assert.deepEqual(JSON.parse(result.state.nodes.at(-1).runInputToColumn), { photo: 'photo', caption: 'caption' });
});
