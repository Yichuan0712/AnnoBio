import test from 'node:test';
import assert from 'node:assert/strict';

import { extractInputFields, promptPlaceholders } from '../src/promptText.js';
import { paragraphAround, rebuildWorkingFromApplied } from '../src/reviewWorkingText.js';
import { planChangeSet } from '../src/agent/operations/changeSet.js';

test('a prompt\'s inputs are its {placeholders}, each once, in order of first use; {{ }} are literal', () => {
  const text = 'Read {abstract} and {title}.\nQuote {abstract} again, but not {{this}}.';
  assert.deepEqual(extractInputFields(text), ['abstract', 'title']);
  assert.deepEqual(promptPlaceholders(text).map((p) => [p.key, text.slice(p.start, p.end)]),
    [['abstract', '{abstract}'], ['title', '{title}'], ['abstract', '{abstract}']]);
  assert.deepEqual(extractInputFields(''), []);
});

test('accepted suggestions apply to the whole prompt text, in order; one whose sentence is gone is skipped', () => {
  const original = 'Task: tag genes.\n\nRules: one per line.\nBe brief.';
  const suggestions = [
    { applied: true, old_sentence: 'one per line.', new_sentence: 'one gene per line.' },
    { applied: false, old_sentence: 'Be brief.', new_sentence: 'Be thorough.' },
    { applied: true, old_sentence: 'Not in the prompt.', new_sentence: 'X' },
    { applied: true, old_sentence: 'Task:  tag genes.', new_sentence: 'Task: tag human genes.' },
  ];
  assert.equal(rebuildWorkingFromApplied(original, suggestions), 'Task: tag human genes.\n\nRules: one gene per line.\nBe brief.');
  assert.equal(rebuildWorkingFromApplied(original, []), original);
});

test('an edit\'s context is the paragraph holding its sentence, or the whole text when the sentence is gone', () => {
  const text = 'First paragraph.\n\nRules: one per line.\nBe brief.\n\nLast paragraph.';
  assert.equal(paragraphAround(text, 'Be brief.'), 'Rules: one per line.\nBe brief.');
  assert.equal(paragraphAround(text, 'missing'), text);
});

test('the Agent edits a prompt\'s text by replacing text that appears exactly once', () => {
  const state = { nodes: [{ type: 'prompt', nodeId: 'p', name: 'Tag', text: 'Tag {text}. Be brief. Be brief.',
    outputFormat: { returnShape: 'single', fields: [{ key: 'tags', type: 'str', description: 'Tags' }] } }], connections: [] };
  const plan = (op) => planChangeSet(state, [op], { extractInputFields });
  const version = plan({ op: 'add_prompt_version', ref: '$v', prompt: 'p', text_edits: [{ old: 'Tag {text}.', new: 'Tag genes in {text}.' }] });
  const added = version.state.nodes.find((node) => node.nodeId === version.refs.$v);
  assert.equal(added.text, 'Tag genes in {text}. Be brief. Be brief.');
  assert.deepEqual(version.items[0].diffs[0], { label: 'Prompt', before: state.nodes[0].text, after: added.text });
  assert.throws(() => plan({ op: 'add_prompt_version', prompt: 'p', text_edits: [{ old: 'Be brief.', new: 'Be clear.' }] }), /appears more than once/);
  assert.throws(() => plan({ op: 'add_prompt_version', prompt: 'p', text_edits: [{ old: 'missing', new: 'x' }] }), /is not in the prompt text/);
  assert.throws(() => plan({ op: 'add_prompt_version', prompt: 'p', text: 'x', text_edits: [] }), /either text or text_edits/);
  const rewritten = plan({ op: 'update', node: 'p', set: { text: 'Summarize {abstract}.' } });
  assert.equal(rewritten.state.nodes[0].text, 'Summarize {abstract}.');
});
