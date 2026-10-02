import assert from 'node:assert/strict';
import test from 'node:test';
import { createUndoHistory } from '../src/undoHistory.js';

globalThis.document ??= { dispatchEvent() {} };
globalThis.CustomEvent ??= class CustomEvent { constructor(type) { this.type = type; } };

/** The renderer's wiring: every canvas change pushes the live state; undo/redo reload the canvas. */
function setup(nodes) {
  const canvas = { state: { version: 2, nodes, connections: [] } };
  const history = createUndoHistory({
    loadCanvasState: (state) => { canvas.state = structuredClone(state); },
    getCanvasState: () => structuredClone(canvas.state),
  });
  history.reset(structuredClone(canvas.state));
  const change = (edit) => {
    edit(canvas.state);
    history.push(structuredClone(canvas.state));
  };
  const node = (id) => canvas.state.nodes.find((item) => item.nodeId === id);
  return { canvas, history, change, node };
}

const prompt = { type: 'prompt', nodeId: 'p', name: 'v1' };
const run = { type: 'run', nodeId: 'r', runName: 'Run', runPending: false };
const results = '[{"input_row_index":0,"output":{"answer":"paid"}}]';

test('undoing an edit made before a run keeps the run results', () => {
  const { history, change, node } = setup([{ ...prompt }, { ...run }]);
  change((state) => { state.nodes[0].name = 'v2'; });
  change(() => Object.assign(node('r'), { runResults: results, runCompleted: '1' }));
  history.undo();
  assert.equal(node('p').name, 'v1', 'the authored edit is undone');
  assert.equal(node('r').runResults, results, 'the run results survive undo');
  history.redo();
  assert.equal(node('p').name, 'v2');
  assert.equal(node('r').runResults, results, 'and redo');
});

test('undoing a delete brings the node back with its latest results', () => {
  const { canvas, history, change, node } = setup([{ ...prompt }, { ...run }]);
  change(() => Object.assign(node('r'), { runResults: results, runCompleted: '1' }));
  change((state) => { state.nodes = state.nodes.filter((item) => item.nodeId !== 'r'); });
  history.undo();
  assert.equal(node('r').runResults, results);
  assert.equal(canvas.state.version, 2, 'other top-level fields are kept');
});

test('redoing an undone add keeps results the node got before the undo', () => {
  const { history, change, node } = setup([{ ...prompt }]);
  change((state) => { state.nodes.push({ ...run }); });
  change(() => Object.assign(node('r'), { runResults: results, runCompleted: '1' }));
  history.undo();
  assert.equal(node('r'), undefined);
  history.redo();
  assert.equal(node('r').runResults, results);
});

test('results the user cleared stay cleared after undo', () => {
  const { history, change, node } = setup([{ ...prompt }, { ...run, runResults: results, runCompleted: '1' }]);
  change((state) => { state.nodes[0].name = 'v2'; });
  change(() => { delete node('r').runResults; delete node('r').runCompleted; });
  history.undo();
  assert.equal(node('p').name, 'v1');
  assert.equal(node('r').runResults, undefined);
  assert.equal(node('r').runCompleted, undefined);
});

test('results written without a canvas-changed event are read from the live canvas at undo', () => {
  const { history, change, node } = setup([{ ...prompt }, { type: 'process', nodeId: 'x', name: 'Process' }]);
  change((state) => { state.nodes[0].name = 'v2'; });
  node('x').dfResults = '{"result":[]}'; // no push
  history.undo();
  assert.equal(node('x').dfResults, '{"result":[]}');
});

test('job output alone still does not create an undo step', () => {
  const { history, change, node } = setup([{ ...prompt }, { ...run }]);
  change(() => Object.assign(node('r'), { runResults: results }));
  assert.equal(history.canUndo(), false);
});
