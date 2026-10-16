import assert from 'node:assert/strict';
import test from 'node:test';
import { FLOW_CARD_HEIGHT, FLOW_CARD_WIDTH, layoutPipelineFlow } from '../src/pipelineFlow.js';
import { getVisibleRoute } from '../src/pipelineRouteSelection.js';

const step = name => ({ kind: 'process', selectedValue: name, selectedOption: { kind: 'process', label: name }, options: [{ value: name, label: name }] });
const branch = (...lanes) => ({ kind: 'branch', lanes });
const named = (graph, name) => graph.nodes.find(node => node.step.selectedValue === name);
function checkGeometry(graph) {
  for (const [index, node] of graph.nodes.entries()) {
    assert(node.x >= 0 && node.y >= 0);
    assert(node.x + node.width <= graph.width);
    assert(node.y + FLOW_CARD_HEIGHT <= graph.height);
    for (const other of graph.nodes.slice(index + 1)) {
      const overlap = node.x < other.x + other.width && other.x < node.x + node.width
        && node.y < other.y + FLOW_CARD_HEIGHT && other.y < node.y + FLOW_CARD_HEIGHT;
      assert(!overlap, `Cards overlap: ${node.id}, ${other.id}`);
    }
  }
  for (const edge of graph.edges) {
    const from = graph.nodes.find(node => node.id === edge.from);
    const to = graph.nodes.find(node => node.id === edge.to);
    assert(to.x > from.x + from.width, 'Connections must point forward');
    assert(!/NaN|undefined/.test(edge.path));
    assert(edge.path.startsWith(`M${from.x + from.width} ${from.y + FLOW_CARD_HEIGHT / 2}`));
    assert(edge.path.endsWith(`H${to.x}`));
  }
}

test('long routes stay on one baseline and retain their order and source selections', () => {
  const route = Array.from({ length: 10 }, (_, index) => step(`step-${index}`));
  const original = structuredClone(route);
  const graph = layoutPipelineFlow(route);
  assert.deepEqual(route, original);
  assert.equal(new Set(graph.nodes.map(node => node.y)).size, 1);
  assert.deepEqual(graph.nodes.map(node => node.step.selectedValue), route.map(item => item.selectedValue));
  assert.equal(graph.edges.length, 9);
  assert(graph.width > 1800);
  checkGeometry(graph);
});

test('uneven branches share an entry column and join at one shared continuation', () => {
  const graph = layoutPipelineFlow([step('split'), branch([step('a')], [step('b'), step('c')]), step('merge')]);
  assert.equal(named(graph, 'a').x, named(graph, 'b').x);
  assert(named(graph, 'a').y < named(graph, 'b').y);
  const merge = named(graph, 'merge');
  assert.equal(graph.nodes.filter(node => node.step.selectedValue === 'merge').length, 1);
  assert.deepEqual(graph.edges.filter(edge => edge.to === merge.id).map(edge => edge.from).sort(), [named(graph, 'a').id, named(graph, 'c').id].sort());
  checkGeometry(graph);
});

test('an unused output adds no endpoint or extra lane to the overview', () => {
  const unused = { kind: 'dataset', selectedOption: { output: { port: 'unused', consumerStepIds: [] } } };
  const graph = layoutPipelineFlow(getVisibleRoute([step('split'), branch([step('used')], [unused]), step('next')]));
  assert.deepEqual(graph.nodes.map(node => node.step.selectedValue), ['split', 'used', 'next']);
  assert.equal(graph.edges.length, 2);
  assert.equal(new Set(graph.nodes.map(node => node.y)).size, 1);
  checkGeometry(graph);
});

test('a direct lane draws a continuous bypass into the shared Process without a phantom card or terminal', () => {
  const graph = layoutPipelineFlow([step('split'), branch([{ kind: 'passthrough' }], [step('rewrite'), step('search')]), step('merge')]);
  const bypass = graph.nodes.find(node => node.step.kind === 'passthrough');
  const incoming = graph.edges.find(edge => edge.to === bypass.id);
  const outgoing = graph.edges.find(edge => edge.from === bypass.id);
  assert.equal(bypass.width, 0);
  assert.equal(incoming.from, named(graph, 'split').id);
  assert.equal(outgoing.to, named(graph, 'merge').id);
  assert.equal(incoming.arrow, false);
  assert.equal(outgoing.arrow, true);
  assert.equal(graph.nodes.filter(node => node.step.kind === 'empty').length, 0);
  assert.equal(graph.edges.filter(edge => edge.to === named(graph, 'merge').id).length, 2);
  checkGeometry(graph);
});

test('nested branches and branches at the beginning fit without duplicated or overlapping cards', () => {
  const route = [branch([step('a'), branch([step('b'), step('c')], [step('d')]), step('e')], [step('f')]), step('g')];
  const graph = layoutPipelineFlow(route);
  assert.equal(graph.nodes.length, 7);
  assert.equal(new Set(graph.nodes.map(node => node.step.selectedValue)).size, 7);
  checkGeometry(graph);
});

test('choice options are one card rather than parallel branches', () => {
  const selected = { ...step('v2'), options: [{ value: 'v1', label: 'Version 1' }, { value: 'v2', label: 'Version 2' }] };
  const graph = layoutPipelineFlow([selected, step('next')]);
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.nodes[0].step.selectedValue, 'v2');
  assert.equal(graph.nodes[0].step.options.length, 2);
  checkGeometry(graph);
});

test('an empty route produces a finite empty diagram', () => {
  const graph = layoutPipelineFlow([]);
  assert.deepEqual(graph.nodes, []);
  assert.deepEqual(graph.edges, []);
  assert(Number.isFinite(graph.width) && Number.isFinite(graph.height));
});
