/**
 * Draws a node's data and creation/provenance ports (nodePorts.js) with one shared dot style.
 * Lines are drawn to these dots by workflowCanvas.js renderEdge, which finds them by
 * `data-port-side` and `data-port-id`.
 */
import { ADD_INPUT_PORT, LINEAGE_PORT, portLayout } from './nodePorts.js';
import { iconDataset, iconEvaluate, iconPrompt, iconRun } from './icons.js';

const PORTS_CLASS = 'workflow-node__ports';
const DOT_CLASS = 'workflow-node__port';

function dot(side, item, title, { lineage = false } = {}) {
  const el = document.createElement('span');
  el.className = DOT_CLASS;
  if (lineage) el.classList.add(`${DOT_CLASS}--lineage`);
  // A temporary dot (nodePorts.js missingOutputPorts) cannot be read from either.
  if (item?.unavailable || item?.missing) el.classList.add(`${DOT_CLASS}--unavailable`);
  if (item?.missing) el.classList.add(`${DOT_CLASS}--missing`);
  if (item?.fixed) el.classList.add(`${DOT_CLASS}--fixed`);
  el.dataset.portSide = side;
  if (item) {
    el.dataset.portId = item.id;
    if (item.type) el.dataset.portType = item.type;
  }
  if (lineage) el.dataset.portId = LINEAGE_PORT;
  if (title) el.title = title;
  return el;
}

function row(side, item, title, lineageTitle, { lineage = false } = {}) {
  const el = document.createElement('div');
  el.className = 'workflow-node__port-row';
  el.dataset.portSide = side;
  if (title) el.title = title;
  if (lineage) el.classList.add('workflow-node__port-row--lineage');
  if (!item) {
    el.classList.add('workflow-node__port-row--lineage');
    el.append(dot(side, null, lineageTitle, { lineage: true }));
    return el;
  }
  el.dataset.portId = item.id;
  const connected = side === 'left' ? !!item.source : !!item.readers?.length;
  if (connected) el.classList.add('workflow-node__port-row--connected');
  if (item.unavailable || item.missing) el.classList.add('workflow-node__port-row--unavailable');
  if (item.missing) el.classList.add('workflow-node__port-row--missing');
  if (item.mismatch) el.classList.add('workflow-node__port-row--mismatch');
  if (item.unconnected) el.classList.add('workflow-node__port-row--unconnected');
  if (item.id === ADD_INPUT_PORT) el.classList.add('workflow-node__port-row--add-input');
  el.append(dot(side, item, title, { lineage }));
  if (item.icon) {
    const icon = item.icon === 'prompt' ? iconPrompt(12) : item.icon === 'run' ? iconRun(12)
      : item.icon === 'evaluate' ? iconEvaluate(12) : iconDataset(12);
    icon.classList.add('workflow-node__port-icon');
    el.append(icon);
  }
  if (item.showLabel) {
    const name = document.createElement('span');
    name.className = 'workflow-node__port-name';
    name.textContent = item.displayLabel ?? item.label;
    el.append(name);
  }
  return el;
}

/**
 * Replaces the dots of `node` with those `ports` describe; `titles` is portTitles() for them. A node
 * with no body of its own shows the header alone when it has no port rows.
 */
export function renderNodePorts(node, ports, titles) {
  const header = node.querySelector('.workflow-node__header');
  if (!header) return;
  header.querySelectorAll(`:scope > .${DOT_CLASS}`).forEach((el) => el.remove());
  node.querySelector(`:scope > .${PORTS_CLASS}`)?.remove();
  node.querySelector(':scope > .workflow-node__prompt-context')?.remove();
  const layout = portLayout(ports);
  const titleOf = (side, item) => (side === 'left' ? titles?.inputs : titles?.outputs)?.[item.id] || '';
  const lineageTitle = (side) => (side === 'left' ? titles?.lineageIn : titles?.lineageOut) || '';

  const sides = [];
  for (const side of ['left', 'right']) {
    const { rows, lineage } = layout[side];
    const items = rows.map((item) => row(side, item, titleOf(side, item)));
    if (lineage === 'row') items.push(row(side, side === 'right' ? ports?.lineageOutput : null,
      lineageTitle(side), lineageTitle(side), { lineage: true }));
    if (items.length) {
      const column = document.createElement('div');
      column.className = `workflow-node__ports-side workflow-node__ports-side--${side}`;
      column.append(...items);
      sides.push(column);
    }
  }
  if (sides.length) {
    const container = document.createElement('div');
    container.className = PORTS_CLASS;
    container.append(...sides);
    header.after(container);
  }
  if (ports?.promptContext) {
    const context = document.createElement('div');
    context.className = 'workflow-node__prompt-context';
    context.classList.toggle('workflow-node__prompt-context--unconnected', !ports.promptContext.nodeId);
    context.title = `Prompt: ${ports.promptContext.name}`;
    const icon = iconPrompt(12);
    icon.classList.add('workflow-node__prompt-context-icon');
    const name = document.createElement('span');
    name.className = 'workflow-node__prompt-context-name';
    name.textContent = ports.promptContext.name;
    context.append(icon, name);
    header.after(context);
  }
  if (!node.querySelector(':scope > .workflow-node__body')) node.classList.toggle('workflow-node--no-body', !sides.length);
}

/** Writes the hover text of every dot and port row of `node`; `titles` is portTitles() for its ports. */
export function applyPortTitles(node, titles) {
  node.querySelectorAll(`.${DOT_CLASS}, .workflow-node__port-row`).forEach((el) => {
    const side = el.dataset.portSide;
    const isLineage = el.classList.contains(`${DOT_CLASS}--lineage`) || el.classList.contains('workflow-node__port-row--lineage');
    const text = isLineage
      ? (side === 'left' ? titles?.lineageIn : titles?.lineageOut)
      : (side === 'left' ? titles?.inputs : titles?.outputs)?.[el.dataset.portId];
    if (text) el.title = text;
    else el.removeAttribute('title');
  });
}

/** The dot an end of a line goes to (nodePorts.js edgeEndpoints), or null when the node has none for it. */
export function findPortDot(node, end, side) {
  if (!node || !end) return null;
  if (end.lineage) return node.querySelector(`.${DOT_CLASS}--lineage[data-port-side="${side}"]`);
  return node.querySelector(`.${DOT_CLASS}[data-port-side="${side}"][data-port-id="${CSS.escape(String(end.portId))}"]`);
}

/** The centre of `element` relative to the border box of `node`, in unscaled canvas pixels. */
export function centerWithin(element, node) {
  let x = element.offsetWidth / 2;
  let y = element.offsetHeight / 2;
  for (let el = element; el && el !== node; el = el.offsetParent) {
    x += el.offsetLeft;
    y += el.offsetTop;
  }
  return { x: x + node.clientLeft, y: y + node.clientTop };
}
