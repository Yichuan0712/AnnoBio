import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPipelines } from '../src/pipelineDetection.js';
import { normalizePipelineNames, pipelineDisplayName } from '../src/pipelineNames.js';

const process = nodeId => ({ type: 'process', nodeId, name: nodeId, dfCode: 'def process(df):\n    return df' });
const data = (fromId, toId) => ({ type: 'data', fromId, toId, fromPort: 'result', alias: 'df' });
const state = () => ({ nodes: [{ type: 'dataset', nodeId: 'raw', name: 'Input' }, process('root')], connections: [data('raw', 'root')] });

test('pipeline names survive numbering changes, appended steps, alternatives and JSON round trips', () => {
  const canvas = state();
  const key = detectPipelines(canvas)[0].nameKey;
  canvas.pipelineNames = { [key]: 'Curation "alpha" <beta>' };
  canvas.nodes.unshift(process('unrelated'));
  assert.equal(detectPipelines(canvas).find(p => p.nameKey === key).name, 'Curation "alpha" <beta>');
  canvas.nodes.push(process('after'));
  canvas.connections.push(data('root', 'after'));
  assert.equal(detectPipelines(canvas).find(p => p.nameKey === key).name, 'Curation "alpha" <beta>');
  canvas.nodes.push(process('alternative'));
  canvas.connections.push(data('raw', 'alternative'));
  const restored = JSON.parse(JSON.stringify(canvas));
  assert.equal(detectPipelines(restored).find(p => p.nameKey === key).name, 'Curation "alpha" <beta>');
});

test('pipelines split at a shared intermediate output keep distinct name keys', () => {
  const canvas = state();
  canvas.nodes.push({ type: 'prompt', nodeId: 'prompt', name: 'Extract', text: 'Read' },
    { type: 'run', nodeId: 'run' }, process('other'));
  canvas.connections.push(data('root', 'run'), { type: 'prompt-to-run', fromId: 'prompt', toId: 'run' }, data('root', 'other'));
  const pipelines = detectPipelines(canvas);
  assert.equal(pipelines.length, 2);
  assert.notEqual(pipelines[0].nameKey, pipelines[1].nameKey);
  canvas.pipelineNames = { [pipelines[0].nameKey]: 'Extraction', [pipelines[1].nameKey]: 'Processing' };
  assert.deepEqual(detectPipelines(canvas).map(p => p.name), ['Extraction', 'Processing']);
});

test('old projects keep default titles and malformed or empty saved names are ignored', () => {
  assert.equal(pipelineDisplayName(detectPipelines(state())[0], 0), 'Pipeline 1');
  assert.deepEqual(normalizePipelineNames({ a: '  Name  ', b: '', c: ' ', d: 2 }), { a: 'Name' });
  assert.deepEqual(normalizePipelineNames(['not a map']), {});
});
