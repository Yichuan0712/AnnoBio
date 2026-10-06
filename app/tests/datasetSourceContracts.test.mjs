import assert from 'node:assert/strict';
import test from 'node:test';
import { datasetProducerConflicts } from '../src/pipelineProducerConflicts.js';
import { buildPipelineExportRequest } from '../src/pipelineExportDefinition.js';

test('legacy duplicate links are one source, but a different producer is a conflict', () => {
  const state = { nodes: [{ type: 'dataset', nodeId: 'out', sourceRunNodeId: 'run-a' }], connections: [
    { type: 'run-to-dataset-snapshot', fromId: 'run-a', toId: 'out' },
  ] };
  assert.deepEqual(datasetProducerConflicts(state), []);
  state.connections.push({ type: 'process-to-dataset', fromId: 'process-b', toId: 'out' });
  assert.deepEqual(datasetProducerConflicts(state), [{ datasetId: 'out', producers: ['run:run-a', 'process:process-b'] }]);
  assert.throws(() => buildPipelineExportRequest({ name: 'Invalid', canvasState: state,
    route: [{ type: 'dataset', dataset_node_id: 'out' }] }), /multiple producers/);
});
