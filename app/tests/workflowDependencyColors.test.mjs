import test from 'node:test';
import assert from 'node:assert/strict';
import { dependencyColorSources, dependentNodeVisualColors } from '../src/workflowDependencyColors.js';

const node = (nodeId, nodeType, fields = {}) => ({ dataset: { nodeId, nodeType, ...fields } });

test('Sample and Process follow their Dataset inputs, with the Process primary input first', () => {
  const nodes = new Map([
    ['sample', node('sample', 'sampler', { sourceNodeId: 'data-a' })],
    ['process', node('process', 'process')],
  ]);
  const edges = [
    { fromId: 'data-a', fromPort: 'result', toId: 'process', type: 'data', alias: 'df_a' },
    { fromId: 'data-b', fromPort: 'result', toId: 'process', type: 'data', alias: 'df' },
  ];
  assert.deepEqual(dependencyColorSources(nodes.get('sample'), nodes, edges), {
    datasetIds: ['data-a'], promptId: '',
  });
  assert.deepEqual(dependencyColorSources(nodes.get('process'), nodes, edges), {
    datasetIds: ['data-b', 'data-a'], promptId: '',
  });
});

test('Run, Score, and Review retain all Dataset sources and the selected Prompt', () => {
  const nodes = new Map([
    ['run', node('run', 'run')],
    ['score', node('score', 'score', { scoreGroundTruthId: 'truth' })],
    ['review', node('review', 'promptReview')],
  ]);
  const edges = [
    { fromId: 'input', fromPort: 'result', toId: 'run', type: 'data' },
    { fromId: 'prompt', toId: 'run', type: 'prompt-to-run' },
    { fromId: 'run', toId: 'score', type: 'run-to-score' },
    { fromId: 'score', toId: 'review', type: 'score-to-prompt-review' },
  ];
  assert.deepEqual(dependencyColorSources(nodes.get('run'), nodes, edges), {
    datasetIds: ['input'], promptId: 'prompt',
  });
  const combined = { datasetIds: ['truth', 'input'], promptId: 'prompt' };
  assert.deepEqual(dependencyColorSources(nodes.get('score'), nodes, edges), combined);
  assert.deepEqual(dependencyColorSources(nodes.get('review'), nodes, edges), combined);
});

test('Removing an upstream connection removes its inherited color source', () => {
  const nodes = new Map([['review', node('review', 'promptReview')]]);
  assert.deepEqual(dependencyColorSources(nodes.get('review'), nodes, []), {
    datasetIds: [], promptId: '',
  });
});

test('Prompt colors the border and the bottom strip uses one Dataset color', () => {
  assert.deepEqual(dependentNodeVisualColors(['#111111', '#222222'], '#333333'), {
    borderColor: '#333333',
    dataColor: '#111111',
  });
  assert.deepEqual(dependentNodeVisualColors(['#111111']), {
    borderColor: '#111111',
    dataColor: '#111111',
  });
  assert.deepEqual(dependentNodeVisualColors([], '#333333'), {
    borderColor: '#333333', dataColor: '',
  });
  assert.deepEqual(dependentNodeVisualColors(['', '#222222'], '#333333'), {
    borderColor: '#333333', dataColor: '#222222',
  });
});
