import assert from 'node:assert/strict';
import test from 'node:test';
import { planChangeSet } from '../src/agent/operations/changeSet.js';
import { upgradeCanvasState } from '../src/canvasFormat.js';

const extractInputFields = (sections) => [...new Set(sections
  .flatMap((section) => [...String(section.content || '').matchAll(/\{([^{}]+)\}/g)].map((match) => match[1])))];

const canvas = (run = {}) => upgradeCanvasState({
  nodes: [
    { type: 'dataset', nodeId: 'raw', name: 'Raw', datasetContent: { headers: ['text', 'title'], columnTypes: ['text', 'text'], rows: [['a', 'A']] } },
    { type: 'prompt', nodeId: 'p1', name: 'Extract', sections: [{ name: 'Task', content: 'Read {text}' }] },
    { type: 'prompt', nodeId: 'p2', name: 'Classify', sections: [{ name: 'Task', content: 'Classify {title}' }] },
    { type: 'run', nodeId: 'r', runName: 'Run', runWorkingSetId: 'raw', runInputToColumn: JSON.stringify({ text: 'text' }), ...run },
  ],
  connections: [{ fromId: 'p1', toId: 'r', type: 'prompt-to-run' }],
});
const plan = (state, set) => planChangeSet(state, [{ op: 'update', node: 'r', set }], { extractInputFields });
const promptOf = (state) => state.connections.filter((c) => c.type === 'prompt-to-run' && c.toId === 'r').map((c) => c.fromId);

// A Run picks its Prompt in its window, so the Agent can switch it too, under the same lock.
test('the Agent can point a Run at another Prompt', () => {
  const result = plan(canvas(), { prompt: 'p2', input_mapping: { title: 'title' } });
  assert.deepEqual(promptOf(result.state), ['p2'], 'exactly one prompt-to-run connection, to the new Prompt');
  assert.deepEqual(JSON.parse(result.state.nodes.find((n) => n.nodeId === 'r').runInputToColumn), { title: 'title' });
  assert.ok(result.items[0].lines.includes('Prompt "Classify"'));
});

test('a new Prompt needs a mapping for its own inputs', () => {
  assert.throws(() => plan(canvas(), { prompt: 'p2' }), /no column for prompt input "title"/);
});

test('a Run with results keeps its Prompt, input and mapping, as in the Run window', () => {
  const ran = canvas({ runResults: JSON.stringify([{ input_row_index: 0, output: { a: 'x' } }]) });
  for (const set of [{ prompt: 'p2', input_mapping: { title: 'title' } }, { input: 'raw' }, { input_mapping: { text: 'title' } }]) {
    assert.throws(() => plan(ran, set), /already has results/);
  }
  assert.throws(() => plan(canvas({ runCompleted: '1' }), { input: 'raw' }), /already has results/);
});

test('a history-enabled Run can switch inputs; editing a saved Dataset only changes its table', () => {
  const state = canvas({ runResults: JSON.stringify([{ input_row_index: 0, output: { a: 'x' } }]), runCompleted: '1' });
  state.historyVersion = 1;
  const changed = plan(state, { prompt: 'p2', input_mapping: { title: 'title' } });
  assert.deepEqual(promptOf(changed.state), ['p2']);
  state.nodes.push({ type: 'run', nodeId: 'another-run', runName: 'Earlier run', historyRecordId: 'record-1' });
  const savedFrom = { kind: 'run', nodeId: 'another-run', port: 'result', recordId: 'record-1' };
  state.nodes.find((node) => node.nodeId === 'raw').savedFrom = savedFrom;
  const edited = planChangeSet(state, [{ op: 'update', node: 'raw', set: { rows: [['changed', 'A']] } }], { extractInputFields });
  const raw = edited.state.nodes.find((node) => node.nodeId === 'raw');
  assert.deepEqual(raw.savedFrom, savedFrom);
  assert.deepEqual(raw.datasetContent.rows, [['changed', 'A']]);
  assert.deepEqual(edited.items[0].lines.filter((line) => /copy/i.test(line)), []);
});
