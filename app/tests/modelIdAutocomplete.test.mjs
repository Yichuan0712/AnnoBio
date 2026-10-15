import test from 'node:test';
import assert from 'node:assert/strict';

import { rankModelMatches } from '../src/modelIdAutocomplete.js';

const ids = (models) => models.map((m) => m.id);
const catalog = [
  { id: 'azure/gpt-4o', provider: 'azure' },
  { id: 'ft:gpt-4o-mini-2024-07-18', provider: 'openai' },
  { id: 'gpt-4o-2024-08-06', provider: 'openai' },
  { id: 'gpt-4o-mini', provider: 'openai' },
  { id: 'gpt-4o', provider: 'openai' },
  { id: 'openrouter/openai/gpt-4o', provider: 'openrouter' },
  { id: 'anthropic/claude-sonnet-4-6', provider: 'anthropic' },
  { id: 'bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0', provider: 'bedrock' },
];

test('the exact id comes first, then ids starting with the query, then ones that only contain it', () => {
  assert.deepEqual(ids(rankModelMatches(catalog, 'gpt-4o')), [
    'gpt-4o',
    'azure/gpt-4o',
    'openrouter/openai/gpt-4o',
    'gpt-4o-mini',
    'gpt-4o-2024-08-06',
    'ft:gpt-4o-mini-2024-07-18',
  ]);
});

test('matching ignores case and surrounding spaces', () => {
  assert.deepEqual(ids(rankModelMatches(catalog, '  GPT-4O-MINI ')), ['gpt-4o-mini', 'ft:gpt-4o-mini-2024-07-18']);
});

test('every word must match somewhere, in any order', () => {
  assert.deepEqual(ids(rankModelMatches(catalog, 'sonnet claude')), [
    'anthropic/claude-sonnet-4-6',
    'bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0',
  ]);
  assert.deepEqual(ids(rankModelMatches(catalog, 'claude gpt')), []);
});

test('dots, underscores, dashes and spaces count as the same separator', () => {
  const models = [
    { id: 'claude-sonnet-4' },
    { id: 'claude-sonnet-4-5' },
    { id: 'anthropic/claude-sonnet-4.5' },
    { id: 'claude-sonnet-4-5-20250929' },
  ];
  assert.deepEqual(ids(rankModelMatches(models, 'claude sonnet 4.5')), [
    'claude-sonnet-4-5',
    'anthropic/claude-sonnet-4.5',
    'claude-sonnet-4-5-20250929',
  ]);
  const found = ids(rankModelMatches(models, 'sonnet-4_5'));
  assert.equal(found[0], 'claude-sonnet-4-5');
  assert.equal(found.length, 3);
});

test('a word may match the name or provider instead of the id', () => {
  const models = [{ id: 'x-ai/grok-4', name: 'xAI: Grok 4' }, { id: 'openai/gpt-5', name: 'OpenAI: GPT-5' }];
  assert.deepEqual(ids(rankModelMatches(models, 'xai')), ['x-ai/grok-4']);
  assert.deepEqual(ids(rankModelMatches(catalog, 'bedrock sonnet')), ['bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0']);
});

test('an empty query suggests nothing, and the list is capped', () => {
  assert.deepEqual(rankModelMatches(catalog, '   '), []);
  assert.equal(rankModelMatches(catalog, 'o').length, 8);
  assert.equal(rankModelMatches(catalog, 'o', 3).length, 3);
});
