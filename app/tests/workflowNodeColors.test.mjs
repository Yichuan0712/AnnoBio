import test from 'node:test';
import assert from 'node:assert/strict';
import { DATASET_BORDER_COLORS, nodeBaseColor, nextNodeColorIndex } from '../src/workflowNodeColors.js';
import { planChangeSet } from '../src/agent/operations/changeSet.js';
import { extractInputFields } from '../src/promptText.js';

test('a new version changes color even when its parent is the least used color after a full palette cycle', () => {
  const nodes = DATASET_BORDER_COLORS.flatMap((_, colorIndex) =>
    Array.from({ length: colorIndex === 0 ? 1 : 2 }, () => ({ type: 'prompt', colorIndex })));
  const parent = { colorIndex: 0 };
  const next = nextNodeColorIndex(nodes, DATASET_BORDER_COLORS.length - 1, nodeBaseColor(parent));
  assert.notEqual(nodeBaseColor({ colorIndex: next }), nodeBaseColor(parent));
  // A user-selected color matching another palette entry also has to be avoided.
  const custom = { color: DATASET_BORDER_COLORS[7], colorIndex: 0 };
  assert.notEqual(nodeBaseColor({ colorIndex: nextNodeColorIndex(nodes, 6, nodeBaseColor(custom)) }), nodeBaseColor(custom));
});

test('Agent creates differently colored Prompt versions within one proposal and keeps the original custom color', () => {
  const source = { type: 'prompt', nodeId: 'p', name: 'Prompt', text: 'Read {text}', color: '#dc2626', colorIndex: 0 };
  const initial = { nodes: [source], connections: [] };
  const result = planChangeSet(initial, [
    { op: 'add_prompt_version', ref: '$v2', prompt: 'p' },
    { op: 'add_prompt_version', ref: '$v3', prompt: '$v2' },
    { op: 'add_prompt', ref: '$fresh', name: 'Fresh', text: 'Read {text}', output: { return_shape: 'single', fields: [{ key: 'answer', type: 'str', description: 'The answer.' }] } },
    { op: 'add_prompt_version', prompt: '$fresh' },
  ], { extractInputFields });
  for (const edge of result.state.connections.filter((edge) => edge.type === 'prompt-to-prompt')) {
    const parent = result.state.nodes.find((node) => node.nodeId === edge.fromId);
    const child = result.state.nodes.find((node) => node.nodeId === edge.toId);
    assert.notEqual(nodeBaseColor(child), nodeBaseColor(parent));
    assert.equal(child.color, undefined);
  }
  assert.equal(result.state.nodes[0].color, '#dc2626');
  assert.deepEqual(initial, { nodes: [source], connections: [] });
});
