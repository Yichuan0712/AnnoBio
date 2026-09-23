/**
 * Detects "pipelines" (chains of Prompt/Process steps) from a canvas state — the same shape
 * getCanvasState()/loadCanvasState() in workflowCanvas.js produce/consume: `{nodes, connections}`.
 * Pure function, no DOM — takes plain JSON, returns plain JSON, so it's usable both live (fed
 * getCanvasState()'s output) and offline (fed a saved project's state) without any canvas
 * instance at all.
 *
 * A "pipeline" here means only Prompt (+ the Run that executes it) and Process nodes — Dataset
 * nodes are treated as the (invisible) pipes between steps, not steps themselves, and
 * Score/PromptReview are evaluation/tuning scaffolding, not part of "the thing that produces
 * output" this is meant to describe. See the AnnoBio canvas→code-export planning discussion this
 * was built for.
 *
 * How a Dataset "pipe" is resolved between two steps:
 *  - Producer: either `dataset.sourceRunNodeId` (a Dataset materialized from a Run's results via
 *    "Save to workspace" — see workflowCanvasRuntime.js's saveRunResultsToWorkspace), or a
 *    `process-to-dataset` connection.
 *  - Consumer: either a Run's own `runWorkingSetId` field, or a `dataset-to-process` connection.
 *
 * Known v1 limitations (documented rather than silently guessed around):
 *  - Prompt version chains (`prompt-to-prompt` edges — see addPromptVersion) are assumed linear;
 *    if a version has more than one forward version-edge, only the first-found branch is walked.
 *  - If two different producers target the same dataset id (e.g. both a stale `sourceRunNodeId`
 *    and a live `process-to-dataset` edge), the process-to-dataset edge wins — last one indexed.
 */

const STEP_KIND = { PROMPT: 'prompt', PROCESS: 'process' };

function indexConnections(connections) {
  const byTypeFrom = new Map(); // `${type}:${fromId}` -> toId[]
  const byTypeTo = new Map(); // `${type}:${toId}` -> fromId[]
  for (const c of connections) {
    if (!c || !c.type || !c.fromId || !c.toId) continue;
    const kf = `${c.type}:${c.fromId}`;
    const kt = `${c.type}:${c.toId}`;
    if (!byTypeFrom.has(kf)) byTypeFrom.set(kf, []);
    byTypeFrom.get(kf).push(c.toId);
    if (!byTypeTo.has(kt)) byTypeTo.set(kt, []);
    byTypeTo.get(kt).push(c.fromId);
  }
  return {
    from: (type, id) => byTypeFrom.get(`${type}:${id}`) || [],
    to: (type, id) => byTypeTo.get(`${type}:${id}`) || [],
  };
}

/** Groups prompt nodes into version-chains via `prompt-to-prompt` edges. Each family is
 * `{ rootId, chain: [nodeId in version order] }`. Assumes linear chains (see file doc). */
function buildPromptFamilies(promptNodes, edges) {
  const visited = new Set();
  const families = [];
  for (const p of promptNodes) {
    if (visited.has(p.nodeId)) continue;
    let rootId = p.nodeId;
    for (let guard = 0; guard < 10000; guard += 1) {
      const backs = edges.to('prompt-to-prompt', rootId);
      if (backs.length === 0) break;
      rootId = backs[0];
    }
    if (visited.has(rootId)) continue;
    const chain = [rootId];
    visited.add(rootId);
    let cur = rootId;
    for (let guard = 0; guard < 10000; guard += 1) {
      const fwd = edges.from('prompt-to-prompt', cur);
      const next = fwd.find((id) => !visited.has(id));
      if (!next) break;
      chain.push(next);
      visited.add(next);
      cur = next;
    }
    families.push({ rootId, chain });
  }
  return families;
}

function topoSort(ids, localEdges) {
  const indeg = new Map(ids.map((id) => [id, 0]));
  const adj = new Map(ids.map((id) => [id, []]));
  for (const e of localEdges) {
    adj.get(e.from).push(e.to);
    indeg.set(e.to, (indeg.get(e.to) || 0) + 1);
  }
  const queue = ids.filter((id) => indeg.get(id) === 0);
  const order = [];
  while (queue.length > 0) {
    const id = queue.shift();
    order.push(id);
    for (const next of adj.get(id) || []) {
      indeg.set(next, indeg.get(next) - 1);
      if (indeg.get(next) === 0) queue.push(next);
    }
  }
  if (order.length < ids.length) {
    // A cycle shouldn't be reachable given these edge types, but don't silently drop steps if it
    // somehow happens — just append whatever topoSort couldn't place, in original order.
    for (const id of ids) if (!order.includes(id)) order.push(id);
  }
  return order;
}

/**
 * @param {{nodes: object[], connections: {fromId:string,toId:string,type:string}[]}} canvasState
 * @returns {Array<{id: string, steps: Array<
 *   {id: string, kind: 'prompt', versions: Array<{promptNodeId: string, promptName: string, runNodeIds: string[]}>, defaultVersionIndex: number}
 *   | {id: string, kind: 'process', processNodeId: string, processName: string}
 * >}>}
 */
export function detectPipelines(canvasState) {
  const nodes = Array.isArray(canvasState?.nodes) ? canvasState.nodes : [];
  const connections = Array.isArray(canvasState?.connections) ? canvasState.connections : [];
  const nodeById = new Map(nodes.map((n) => [n.nodeId, n]));
  const edges = indexConnections(connections);

  const promptNodes = nodes.filter((n) => n.type === 'prompt');
  const processNodes = nodes.filter((n) => n.type === 'process');
  const runNodes = nodes.filter((n) => n.type === 'run');
  const datasetNodes = nodes.filter((n) => n.type === 'dataset');

  const families = buildPromptFamilies(promptNodes, edges);

  const steps = [];
  const runNodeToStep = new Map();
  const processNodeToStep = new Map();

  for (const family of families) {
    const runsByVersion = new Map();
    for (const versionId of family.chain) {
      const runIds = edges.from('prompt-to-run', versionId);
      if (runIds.length > 0) runsByVersion.set(versionId, runIds);
    }
    // A version with no Run at all is an unrun draft — not part of any executable pipeline yet.
    if (runsByVersion.size === 0) continue;
    const versions = family.chain
      .filter((id) => runsByVersion.has(id))
      .map((versionId) => ({
        promptNodeId: versionId,
        promptName: nodeById.get(versionId)?.name || 'Prompt',
        runNodeIds: runsByVersion.get(versionId),
      }));
    const step = {
      id: `prompt:${family.rootId}`,
      kind: STEP_KIND.PROMPT,
      versions,
      defaultVersionIndex: versions.length - 1, // latest version in the chain, not necessarily "correct" — see file doc
    };
    steps.push(step);
    for (const v of versions) {
      for (const runId of v.runNodeIds) runNodeToStep.set(runId, step);
    }
  }

  for (const p of processNodes) {
    const step = {
      id: `process:${p.nodeId}`,
      kind: STEP_KIND.PROCESS,
      processNodeId: p.nodeId,
      processName: p.name || 'Process',
    };
    steps.push(step);
    processNodeToStep.set(p.nodeId, step);
  }

  if (steps.length === 0) return [];

  // Resolve each dataset's producing step, if any.
  const datasetProducerStep = new Map();
  for (const ds of datasetNodes) {
    if (ds.sourceRunNodeId && runNodeToStep.has(ds.sourceRunNodeId)) {
      datasetProducerStep.set(ds.nodeId, runNodeToStep.get(ds.sourceRunNodeId));
    }
  }
  for (const c of connections) {
    if (c.type === 'process-to-dataset' && processNodeToStep.has(c.fromId)) {
      datasetProducerStep.set(c.toId, processNodeToStep.get(c.fromId));
    }
  }

  // Step-to-step edges, resolved through whichever dataset connects them.
  const stepEdges = [];
  for (const run of runNodes) {
    const consumerStep = runNodeToStep.get(run.nodeId);
    if (!consumerStep) continue;
    const producerStep = run.runWorkingSetId ? datasetProducerStep.get(run.runWorkingSetId) : null;
    if (producerStep && producerStep.id !== consumerStep.id) {
      stepEdges.push({ from: producerStep.id, to: consumerStep.id });
    }
  }
  for (const c of connections) {
    if (c.type !== 'dataset-to-process') continue;
    const consumerStep = processNodeToStep.get(c.toId);
    const producerStep = datasetProducerStep.get(c.fromId);
    if (consumerStep && producerStep && producerStep.id !== consumerStep.id) {
      stepEdges.push({ from: producerStep.id, to: consumerStep.id });
    }
  }

  // Group into connected components (undirected, for grouping only — ordering below stays directed).
  const stepById = new Map(steps.map((s) => [s.id, s]));
  const adjacency = new Map(steps.map((s) => [s.id, new Set()]));
  for (const e of stepEdges) {
    adjacency.get(e.from)?.add(e.to);
    adjacency.get(e.to)?.add(e.from);
  }
  const visited = new Set();
  const components = [];
  for (const s of steps) {
    if (visited.has(s.id)) continue;
    const component = [];
    const stack = [s.id];
    visited.add(s.id);
    while (stack.length > 0) {
      const cur = stack.pop();
      component.push(cur);
      for (const next of adjacency.get(cur) || []) {
        if (!visited.has(next)) {
          visited.add(next);
          stack.push(next);
        }
      }
    }
    components.push(component);
  }

  return components.map((componentIds, index) => {
    const idSet = new Set(componentIds);
    const localEdges = stepEdges.filter((e) => idSet.has(e.from) && idSet.has(e.to));
    const order = topoSort(componentIds, localEdges);
    return {
      id: `pipeline-${index + 1}`,
      steps: order.map((id) => stepById.get(id)),
    };
  });
}
