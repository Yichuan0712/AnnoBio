/** Layout the selected route without changing its choices, dependencies or export order. */
export const FLOW_CARD_WIDTH = 184;
export const FLOW_CARD_HEIGHT = 56;
const COLUMN_GAP = 56;
const LANE_GAP = 22;
const INSET = 6;

export function layoutPipelineFlow(route) {
  let nextId = 0;
  const move = (block, dx, dy) => {
    block.nodes.forEach(node => { node.x += dx; node.y += dy; });
    return block;
  };
  function sequence(steps) {
    const blocks = steps.map(step => {
      if (step.kind === 'branch') {
        const lanes = (step.lanes || []).map(lane => sequence(lane));
        let y = 0;
        const block = { nodes: [], edges: [], entries: [], exits: [], width: 0, height: 0 };
        lanes.forEach(lane => {
          move(lane, 0, y);
          for (const key of ['nodes', 'edges', 'entries', 'exits']) block[key].push(...lane[key]);
          block.width = Math.max(block.width, lane.width);
          y += lane.height + LANE_GAP;
        });
        block.height = Math.max(FLOW_CARD_HEIGHT, y - LANE_GAP);
        return block;
      }
      const id = `step-${nextId++}`;
      const passthrough = step.kind === 'passthrough';
      return {
        // A zero-width waypoint keeps a direct branch's line continuous without a fake card.
        nodes: [{ id, step, x: passthrough ? FLOW_CARD_WIDTH / 2 : 0, y: 0, width: passthrough ? 0 : FLOW_CARD_WIDTH }], edges: [], entries: [id],
        exits: [id], width: FLOW_CARD_WIDTH, height: FLOW_CARD_HEIGHT,
      };
    });
    const result = { nodes: [], edges: [], entries: [], exits: [], width: 0, height: Math.max(0, ...blocks.map(block => block.height)) };
    blocks.forEach((block, index) => {
      move(block, result.width + (index ? COLUMN_GAP : 0), (result.height - block.height) / 2);
      if (!index) result.entries = block.entries;
      for (const from of result.exits) for (const to of block.entries) result.edges.push({ from, to });
      for (const key of ['nodes', 'edges']) result[key].push(...block[key]);
      result.exits = block.exits;
      result.width += block.width + (index ? COLUMN_GAP : 0);
    });
    return result;
  }
  const graph = move(sequence(route), INSET, INSET);
  const byId = new Map(graph.nodes.map(node => [node.id, node]));
  const outgoing = new Map();
  for (const edge of graph.edges) outgoing.set(edge.from, (outgoing.get(edge.from) || 0) + 1);
  graph.edges = graph.edges.map(edge => {
    const from = byId.get(edge.from), to = byId.get(edge.to);
    const start = { x: from.x + from.width, y: from.y + FLOW_CARD_HEIGHT / 2 };
    const end = { x: to.x, y: to.y + FLOW_CARD_HEIGHT / 2 };
    // A fork shares its outgoing trunk; a join shares the trunk before its destination.
    const bendX = outgoing.get(edge.from) > 1 ? start.x + COLUMN_GAP / 2 : end.x - COLUMN_GAP / 2;
    return { ...edge, arrow: to.step.kind !== 'passthrough', path: pipelineConnectorPath(start, end, bendX) };
  });
  return { ...graph, width: graph.width + INSET * 2, height: graph.height + INSET * 2 };
}

/** Rounded orthogonal connections, with enough straight line at each end for a small arrow. */
export function pipelineConnectorPath(start, end, bendX) {
  if (start.y === end.y) return `M${start.x} ${start.y}H${end.x}`;
  const direction = Math.sign(end.y - start.y);
  const radius = Math.min(7, Math.abs(end.y - start.y) / 2, (end.x - start.x) / 2);
  return `M${start.x} ${start.y}H${bendX - radius}Q${bendX} ${start.y} ${bendX} ${start.y + direction * radius}V${end.y - direction * radius}Q${bendX} ${end.y} ${bendX + radius} ${end.y}H${end.x}`;
}
