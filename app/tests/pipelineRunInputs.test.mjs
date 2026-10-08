import assert from 'node:assert/strict';
import test from 'node:test';

import { pipelineRunIntro } from '../src/pipelineRunDialog.js';
import { pipelineInputSteps } from '../src/pipelineRunInputs.js';

const table = (headers, rows) => ({ headers, rows });

test('Run Pipeline lists each step that reads a Dataset, in route order', () => {
  const data = (fromId, toId, alias) => ({ type: 'data', fromId, fromPort: 'result', toId, ...(alias ? { alias } : {}) });
  const state = {
    nodes: [
      { type: 'dataset', nodeId: 'sample', name: 'Sampled examples', colorIndex: 2, datasetContent: table(['text'], [['a'], ['b']]) },
      { type: 'dataset', nodeId: 'lookup', name: 'Lookup', datasetContent: table(['label'], [['x']]) },
      { type: 'prompt', nodeId: 'p1', name: 'Extract' },
      { type: 'prompt', nodeId: 'p2', name: 'Explain' },
      { type: 'run', nodeId: 'r1' },
      { type: 'run', nodeId: 'r2' },
      { type: 'process', nodeId: 'join', name: 'Join' },
    ],
    connections: [
      { type: 'prompt-to-run', fromId: 'p1', toId: 'r1' },
      { type: 'prompt-to-run', fromId: 'p2', toId: 'r2' },
      data('sample', 'r1'), data('sample', 'r2'), data('r1', 'join', 'df'), data('lookup', 'join', 'df_lookup'),
    ],
  };
  const route = [
    { type: 'dataset', dataset_node_id: 'sample' },
    { type: 'prompt', prompt_node_id: 'p1', run_node_id: 'r1' },
    { type: 'prompt', prompt_node_id: 'p2', run_node_id: 'r2' },
    { type: 'dataset', dataset_node_id: 'lookup' },
    { type: 'process', process_node_id: 'join' },
  ];
  // The Join reads Extract's results from inside the route, so only its Lookup is listed.
  assert.deepEqual(pipelineInputSteps(state, route), [
    { nodeId: 'r1', kind: 'run', name: 'Extract', inputs: [{ nodeId: 'sample', name: 'Sampled examples', colorIndex: 2 }] },
    { nodeId: 'r2', kind: 'run', name: 'Explain', inputs: [{ nodeId: 'sample', name: 'Sampled examples', colorIndex: 2 }] },
    { nodeId: 'join', kind: 'process', name: 'Join', inputs: [{ nodeId: 'lookup', name: 'Lookup', colorIndex: undefined }] },
  ]);
});

test('the prepare-inputs sentence matches one step or several, and one Dataset or several', () => {
  const step = (inputs) => ({ inputs });
  assert.equal(
    pipelineRunIntro([step([{}])]),
    'This step reads a Dataset from outside the Pipeline. Open it to change that Dataset.',
  );
  assert.equal(
    pipelineRunIntro([step([{}, {}])]),
    'This step reads Datasets from outside the Pipeline. Open it to change them.',
  );
  assert.equal(
    pipelineRunIntro([step([{}]), step([{}])]),
    'These steps read Datasets from outside the Pipeline. Open a step to change what it reads.',
  );
});
