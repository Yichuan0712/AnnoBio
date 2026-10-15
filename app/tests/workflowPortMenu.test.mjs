import test from 'node:test';
import assert from 'node:assert/strict';

import { attachPortDrag } from '../src/workflowPortDrag.js';
import { attachContextMenuDismissal } from '../src/workflowContextMenu.js';

class Element extends EventTarget {
  constructor() {
    super();
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.attributes = new Map();
    this.classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => this.classes.add(name)),
      remove: (...names) => names.forEach((name) => this.classes.delete(name)),
      contains: (name) => this.classes.has(name),
    };
  }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
    this.parentNode = null;
  }
  contains(element) { return this === element || this.children.some((child) => child.contains(element)); }
  setAttribute(key, value) { this.attributes.set(key, value); }
  getAttribute(key) { return this.attributes.get(key); }
  closest(selector) {
    if (selector === '.workflow-node__port' && this.dataset.portId) return this;
    if (selector === '.workflow-node' && this.dataset.nodeId) return this;
    return this.parentNode?.closest(selector) || null;
  }
  matches() { return !!this.dataset.portId; }
}

function emit(target, type, values = {}) {
  const event = new Event(type, { cancelable: true });
  Object.entries(values).forEach(([key, value]) => Object.defineProperty(event, key, { value }));
  target.dispatchEvent(event);
  return event;
}

function setup(t, { menuAvailable = true, creation = false, input = false, fixed = false } = {}) {
  const original = Object.fromEntries(['document', 'window', 'requestAnimationFrame', 'cancelAnimationFrame'].map((key) => [key, globalThis[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  });
  t.mock.method(globalThis, 'setTimeout', () => 0);
  const document = new EventTarget();
  const canvas = new Element();
  const nodesLayer = new Element();
  const edgesLayer = new Element();
  const background = new Element();
  const scrollWrapper = new Element();
  scrollWrapper.appendChild(background);
  const node = new Element();
  node.dataset.nodeId = 'data';
  node.style = { left: '20px', top: '30px' };
  node.clientLeft = node.clientTop = 0;
  const dot = new Element();
  dot.dataset = { portId: input ? (fixed ? 'run' : 'input') : creation ? '__lineage__' : 'result', portSide: input ? 'left' : 'right' };
  if (creation) dot.classList.add('workflow-node__port--lineage');
  Object.assign(dot, { offsetWidth: 9, offsetHeight: 9, offsetLeft: 155, offsetTop: 30, offsetParent: node });
  node.appendChild(dot);
  nodesLayer.appendChild(node);
  nodesLayer.querySelectorAll = (selector) => selector.includes('[data-port-side="left"]') ? [] : [dot];
  document.createElementNS = () => new Element();
  document.createElement = () => new Element();
  document.body = new Element();
  document.elementFromPoint = () => background;
  globalThis.document = document;
  globalThis.window = new EventTarget();
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  const menu = new Element();
  const item = menu.appendChild(new Element());
  let closeMenu;
  let source;
  const operations = [];
  const api = attachPortDrag({
    canvas, nodesLayer, edgesLayer, scrollWrapper,
    getState: () => ({ nodes: [{ nodeId: 'data', type: input ? (fixed ? 'score' : 'run') : 'dataset' }], connections: [] }),
    clientToCanvas: (x, y) => ({ x, y }), applyOps: (ops) => operations.push(...ops),
    showOutputMenu: (x, y, nodeId, port, onClose) => {
      source = { x, y, nodeId, port };
      if (!menuAvailable) return null;
      closeMenu = attachContextMenuDismissal(menu, { ownerDocument: document, onClose });
      return closeMenu;
    },
    showInputMenu: (x, y, nodeId, port, onClose) => {
      source = { x, y, nodeId, port, side: 'input' };
      closeMenu = attachContextMenuDismissal(menu, { ownerDocument: document, onClose });
      return closeMenu;
    },
  });
  const startDrag = () => {
    emit(nodesLayer, 'pointerdown', { target: dot, button: 0, clientX: 180, clientY: 65 });
    emit(document, 'pointermove', { clientX: 300, clientY: 180 });
  };
  const dragToEmpty = () => {
    startDrag();
    emit(document, 'pointerup', { clientX: 320, clientY: 200 });
  };
  return { document, canvas, edgesLayer, menu, item, operations, api, dragToEmpty, startDrag,
    source: () => source, closeMenu: () => closeMenu() };
}

test('dropping an output on empty canvas keeps the line fixed at release while its menu is open', (t) => {
  const ui = setup(t);
  ui.dragToEmpty();
  assert.deepEqual(ui.source(), { x: 320, y: 200, nodeId: 'data', port: 'result' });
  assert.equal(ui.edgesLayer.children.length, 1);
  const path = ui.edgesLayer.children[0].children[0];
  const frozen = path.getAttribute('d');
  assert.ok(frozen.endsWith('320 200'), frozen);
  assert.equal(ui.api.isDragging(), false);
  assert.equal(ui.canvas.classList.contains('workflow-canvas--port-dragging'), false);
  emit(ui.document, 'pointermove', { clientX: 500, clientY: 400 });
  emit(ui.document, 'pointerdown', { target: ui.item });
  assert.equal(path.getAttribute('d'), frozen);
  assert.equal(ui.edgesLayer.children.length, 1, 'interacting inside the menu must keep the preview');
  assert.deepEqual(ui.operations, [], 'an unfinished line must not change the saved graph');
  ui.closeMenu();
  assert.equal(ui.edgesLayer.children.length, 0, 'closing the creation menu clears its preview');
});

test('a creation output can be dragged to empty canvas and cancelled without changing existing connections', (t) => {
  const ui = setup(t, { creation: true });
  ui.dragToEmpty();
  assert.equal(ui.source().port, '__lineage__');
  assert.equal(ui.edgesLayer.children.length, 1);
  assert.equal(ui.api.isDragging(), false);
  ui.closeMenu();
  assert.equal(ui.edgesLayer.children.length, 0);
  assert.deepEqual(ui.operations, []);
});

test('an empty input keeps a reversed preview while choosing its upstream node', (t) => {
  const ui = setup(t, { input: true });
  ui.dragToEmpty();
  assert.deepEqual(ui.source(), { x: 320, y: 200, nodeId: 'data', port: 'input', side: 'input' });
  const path = ui.edgesLayer.children[0].children[0].getAttribute('d');
  assert.ok(path.startsWith('M 320 200'), path);
  emit(ui.document, 'keydown', { key: 'Escape' });
  assert.equal(ui.edgesLayer.children.length, 0);
  assert.deepEqual(ui.operations, []);
});

test('a fixed Evaluate input still refuses dragging after all dots use the same style', (t) => {
  const ui = setup(t, { input: true, fixed: true });
  ui.dragToEmpty();
  assert.equal(ui.source(), undefined);
  assert.equal(ui.api.isDragging(), false);
  assert.equal(ui.edgesLayer.children.length, 0);
  assert.deepEqual(ui.operations, []);
});

test('clicking outside or pressing Escape clears the pending line and all menu listeners', (t) => {
  const ui = setup(t);
  for (const cancel of [
    () => emit(ui.document, 'pointerdown', { target: new Element() }),
    () => emit(ui.document, 'keydown', { key: 'Escape' }),
  ]) {
    ui.dragToEmpty();
    assert.equal(ui.edgesLayer.children.length, 1);
    cancel();
    assert.equal(ui.edgesLayer.children.length, 0);
    assert.deepEqual(ui.operations, []);
    ui.closeMenu(); // Repeated cancellation is harmless.
  }
});

test('a missing creation menu never leaves an orphan temporary line', (t) => {
  const ui = setup(t, { menuAvailable: false });
  ui.dragToEmpty();
  assert.equal(ui.edgesLayer.children.length, 0);
  assert.equal(ui.api.isDragging(), false);
  assert.deepEqual(ui.operations, []);
});

test('Escape during the drag cancels it before a creation menu can appear', (t) => {
  const ui = setup(t);
  ui.startDrag();
  assert.equal(ui.api.isDragging(), true);
  assert.equal(ui.edgesLayer.children.length, 1);
  emit(ui.document, 'keydown', { key: 'Escape' });
  emit(ui.document, 'pointerup', { clientX: 320, clientY: 200 });
  assert.equal(ui.edgesLayer.children.length, 0);
  assert.equal(ui.api.isDragging(), false);
  assert.equal(ui.source(), undefined);
});
