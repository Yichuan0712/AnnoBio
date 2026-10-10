/**
 * Dragging lines between ports (docs/design/NODE_PORTS_PLAN.md §3.3, step 3): from an output to an
 * input, from an empty input back to an output, or picking a line up off an input to move it to
 * another input or drop it on the canvas, which disconnects it. Which ports may be joined comes from
 * nodePorts.js; this module follows the pointer, shows what can be joined and why not, and hands the
 * resulting ops to the canvas.
 */
import { applyPortOp, checkConnect, checkDisconnect, nodePorts } from './nodePorts.js';
import { centerWithin } from './workflowNodePorts.js';

const DOT = '.workflow-node__port';
const SOLID_DOT = `${DOT}:not(${DOT}--lineage)`;
const LINEAGE_HINT = 'Hollow dots show where a node came from and what was made from it. They cannot be connected by dragging.';
const TIP_MS = 3500;

export const AUTO_PAN_MARGIN = 40;
export const AUTO_PAN_MAX_SPEED = 18;

/**
 * How far to scroll the canvas in one frame while dragging with the pointer at (clientX, clientY):
 * nothing in the middle of `rect`, faster the closer the pointer is to an edge, and at most
 * `maxSpeed` once it is at or past the edge.
 * @returns {{ dx: number, dy: number }}
 */
export function autoPanStep(clientX, clientY, rect, { margin = AUTO_PAN_MARGIN, maxSpeed = AUTO_PAN_MAX_SPEED } = {}) {
  const axis = (position, start, end) => {
    if (position < start + margin) return -Math.ceil(maxSpeed * Math.min(1, (start + margin - position) / margin));
    if (position > end - margin) return Math.ceil(maxSpeed * Math.min(1, (position - (end - margin)) / margin));
    return 0;
  };
  return { dx: axis(clientX, rect.left, rect.right), dy: axis(clientY, rect.top, rect.bottom) };
}

/** A copy of a canvas state that ops can change without touching the original (node getters kept). */
function copyState(state) {
  return {
    ...state,
    nodes: state.nodes.map((node) => Object.create(Object.getPrototypeOf(node), Object.getOwnPropertyDescriptors(node))),
    connections: state.connections.map((edge) => ({ ...edge })),
  };
}

/** The curve a line being dragged follows, from the output end to the input end. */
function dragPath(from, to) {
  const pull = Math.max(40, Math.abs(to.x - from.x) / 2);
  return `M ${from.x} ${from.y} C ${from.x + pull} ${from.y}, ${to.x - pull} ${to.y}, ${to.x} ${to.y}`;
}

/**
 * @param {{ canvas: HTMLElement, nodesLayer: HTMLElement, edgesLayer: SVGSVGElement, scrollWrapper: HTMLElement,
 *   getState: () => object, clientToCanvas: (x: number, y: number) => { x: number, y: number },
 *   applyOps: (ops: object[]) => void, showBranchMenu: (x: number, y: number, node: HTMLElement, port: string) => void,
 *   promptInputs?: (prompt: object) => string[], dragThreshold?: number }} options
 */
export function attachPortDrag({ canvas, nodesLayer, edgesLayer, scrollWrapper, getState, clientToCanvas, applyOps, showBranchMenu, promptInputs, dragThreshold = 4 }) {
  let drag = null;
  let tip = null;
  let tipTimer = 0;

  function showTip(text, clientX, clientY) {
    hideTip();
    if (!text) return;
    tip = document.createElement('div');
    tip.className = 'workflow-port-tip';
    tip.textContent = text;
    tip.style.left = `${clientX + 14}px`;
    tip.style.top = `${clientY + 14}px`;
    document.body.appendChild(tip);
    tipTimer = setTimeout(hideTip, TIP_MS);
  }
  function hideTip() {
    clearTimeout(tipTimer);
    tip?.remove();
    tip = null;
  }

  /** A click that follows a press on a dot must not open the node's window. */
  function swallowClick() {
    const handler = (e) => { e.stopPropagation(); e.preventDefault(); };
    window.addEventListener('click', handler, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', handler, { capture: true }), 400);
  }

  const portOfDot = (dot) => ({ nodeId: dot.closest('.workflow-node')?.dataset.nodeId || '', portId: dot.dataset.portId || '' });

  function dotPoint(dot) {
    const node = dot.closest('.workflow-node');
    const center = centerWithin(dot, node);
    return { x: (parseFloat(node.style.left) || 0) + center.x, y: (parseFloat(node.style.top) || 0) + center.y };
  }

  /** The solid dot under the pointer: the dot itself or the row of a named port. */
  function dotAt(clientX, clientY) {
    const el = document.elementFromPoint(clientX, clientY);
    const dot = el?.closest?.(DOT) || el?.closest?.('.workflow-node__port-row')?.querySelector(DOT);
    return dot && dot.matches(SOLID_DOT) ? dot : null;
  }

  function begin(e, dot) {
    const state = getState();
    const { nodeId, portId } = portOfDot(dot);
    const side = dot.dataset.portSide;
    const ports = nodePorts(state, nodeId);
    const port = (side === 'left' ? ports?.inputs : ports?.outputs)?.find((item) => item.id === portId);
    if (!port) return null;
    if (side === 'right') {
      if (port.unavailable) return { refused: port.unavailable };
      return { mode: 'out', state, dot, from: { nodeId, portId }, port };
    }
    if (port.fixed) return { refused: port.fixed };
    if (!port.source) return { mode: 'in', state, dot, to: { nodeId, portId }, port };
    const disconnect = checkDisconnect(state, { nodeId, portId });
    if (!disconnect.ok) return { refused: disconnect.reason };
    return { mode: 'lift', state, dot, to: { nodeId, portId }, from: { nodeId: port.source.nodeId, portId: port.source.port }, disconnect: disconnect.op, port };
  }

  /** Marks every dot the line could end on, and keeps why the others cannot take it. */
  function markTargets() {
    const { mode, state } = drag;
    // A line picked up is checked as if it were already gone from where it was.
    const checked = mode === 'lift' ? copyState(state) : state;
    if (mode === 'lift') applyPortOp(checked, drag.disconnect, { promptInputs });
    drag.checks = new Map();
    const side = mode === 'in' ? 'right' : 'left';
    for (const dot of nodesLayer.querySelectorAll(`${SOLID_DOT}[data-port-side="${side}"]`)) {
      const at = portOfDot(dot);
      const result = mode === 'in' ? checkConnect(checked, at, drag.to) : checkConnect(checked, drag.from, at);
      drag.checks.set(dot, result);
      dot.classList.add(result.ok ? 'workflow-node__port--target' : 'workflow-node__port--refused');
    }
    if (mode === 'lift') {
      drag.checks.set(drag.dot, { ok: true, op: null });
      drag.dot.classList.remove('workflow-node__port--refused');
      drag.dot.classList.add('workflow-node__port--target');
      drag.liftedEdge = [...edgesLayer.querySelectorAll('.workflow-edge')].find((group) => (
        group.getAttribute('data-to-id') === drag.to.nodeId && group.getAttribute('data-to-port') === drag.to.portId
      ));
      drag.liftedEdge?.classList.add('workflow-edge--lifted');
    }
    drag.dot.classList.add('workflow-node__port--origin');
    canvas.classList.add('workflow-canvas--port-dragging');
  }

  function drawLine() {
    if (!drag.path) {
      const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      group.setAttribute('class', 'workflow-port-drag');
      drag.path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      drag.path.setAttribute('class', 'workflow-port-drag__line');
      group.appendChild(drag.path);
      edgesLayer.appendChild(group);
    }
    const pointer = clientToCanvas(drag.clientX, drag.clientY);
    const target = drag.hover && drag.checks.get(drag.hover)?.ok ? dotPoint(drag.hover) : pointer;
    const fixed = dotPoint(drag.mode === 'lift' ? drag.sourceDot || drag.dot : drag.dot);
    drag.path.setAttribute('d', drag.mode === 'in' ? dragPath(target, fixed) : dragPath(fixed, target));
  }

  function hover(clientX, clientY) {
    const dot = dotAt(clientX, clientY);
    if (dot === drag.hover) return;
    drag.hover?.classList.remove('workflow-node__port--hover');
    drag.hover = dot && drag.checks.has(dot) ? dot : null;
    drag.hover?.classList.add('workflow-node__port--hover');
    const result = drag.hover && drag.checks.get(drag.hover);
    if (result && !result.ok) showTip(result.reason, clientX, clientY);
    else hideTip();
  }

  function autoPan() {
    if (!drag?.started) return;
    const { dx, dy } = autoPanStep(drag.clientX, drag.clientY, scrollWrapper.getBoundingClientRect());
    if (dx || dy) {
      scrollWrapper.scrollLeft += dx;
      scrollWrapper.scrollTop += dy;
      drawLine();
    }
    drag.frame = requestAnimationFrame(autoPan);
  }

  function end() {
    if (!drag) return;
    cancelAnimationFrame(drag.frame);
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerUp);
    document.removeEventListener('pointercancel', onPointerCancel);
    document.removeEventListener('keydown', onKeyDown, true);
    nodesLayer.querySelectorAll(DOT).forEach((dot) => dot.classList.remove(
      'workflow-node__port--target', 'workflow-node__port--refused', 'workflow-node__port--hover', 'workflow-node__port--origin',
    ));
    drag.liftedEdge?.classList.remove('workflow-edge--lifted');
    drag.path?.parentNode?.remove();
    canvas.classList.remove('workflow-canvas--port-dragging');
    hideTip();
    drag = null;
  }

  function onPointerDown(e) {
    const dot = e.target.closest?.(DOT);
    if (!dot || e.button !== 0) return;
    // A press on a dot never drags its node, opens its window or pans the canvas.
    e.stopPropagation();
    e.preventDefault();
    hideTip();
    swallowClick();
    if (dot.classList.contains('workflow-node__port--lineage')) {
      showTip(LINEAGE_HINT, e.clientX, e.clientY);
      return;
    }
    const started = begin(e, dot);
    if (!started) return;
    if (started.refused) {
      showTip(started.refused, e.clientX, e.clientY);
      return;
    }
    drag = { ...started, startX: e.clientX, startY: e.clientY, clientX: e.clientX, clientY: e.clientY, started: false };
    if (drag.mode === 'lift') {
      drag.sourceDot = nodesLayer.querySelector(`.workflow-node[data-node-id="${CSS.escape(drag.from.nodeId)}"] ${SOLID_DOT}[data-port-side="right"][data-port-id="${CSS.escape(drag.from.portId)}"]`);
    }
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', onPointerCancel);
    document.addEventListener('keydown', onKeyDown, true);
  }

  function onPointerMove(e) {
    drag.clientX = e.clientX;
    drag.clientY = e.clientY;
    if (!drag.started) {
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < dragThreshold) return;
      drag.started = true;
      markTargets();
      drag.frame = requestAnimationFrame(autoPan);
    }
    hover(e.clientX, e.clientY);
    drawLine();
  }

  function onPointerUp(e) {
    const current = drag;
    if (!current.started) {
      end();
      // A click on a Process branch offers new steps on it, as a click on its name does.
      const node = current.dot.closest('.workflow-node');
      if (current.mode === 'out' && node?.classList.contains('workflow-node--process')) showBranchMenu(e.clientX, e.clientY, node, current.from.portId);
      return;
    }
    const dot = dotAt(e.clientX, e.clientY);
    const result = dot ? current.checks.get(dot) : null;
    end();
    if (current.mode === 'lift') {
      if (dot === current.dot) return;
      if (!dot) applyOps([current.disconnect]);
      else if (result?.ok) applyOps([current.disconnect, result.op]);
      return;
    }
    if (result?.ok && result.op) applyOps([result.op]);
  }

  function onPointerCancel() {
    end();
  }

  function onKeyDown(e) {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    end();
  }

  nodesLayer.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('pointerdown', (e) => { if (!e.target.closest?.(DOT)) hideTip(); }, true);

  return { showTip, isDragging: () => !!drag };
}
