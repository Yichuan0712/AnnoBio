/**
 * Detects "pipelines" (chains of Prompt/Process steps) from a canvas state — the same shape
 * getCanvasState()/loadCanvasState() in workflowCanvas.js produce/consume: `{nodes, connections}`.
 * Pure function, no DOM — takes plain JSON, returns plain JSON, so it's usable both live (fed
 * getCanvasState()'s output) and offline (fed a saved project's state) without any canvas
 * instance at all.
 *
 * A "pipeline" here is a chain of Prompt (+ the Run that executes it), Process and Dataset steps,
 * so it reads the same way the canvas does: dataset -> prompt -> dataset -> prompt.
 * Score/PromptReview stay out: they're evaluation/tuning scaffolding, not part of "the thing that
 * produces output" this is meant to describe. See the AnnoBio canvas→code-export planning
 * discussion this was built for.
 *
 * How a Dataset attaches to the steps around it:
 *  - Produced by: either `dataset.sourceRunNodeId` (a Dataset materialized from a Run's results via
 *    "Save to workspace" — see workflowCanvasRuntime.js's saveRunResultsToWorkspace), or a
 *    `process-to-dataset` connection.
 *  - Consumed by: either a Run's own `runWorkingSetId` field, or a `dataset-to-process` connection.
 *
 * Only datasets that actually take part get a step; ones sitting unattached on the canvas don't.
 *
 * Known v1 limitations (documented rather than silently guessed around):
 *  - Prompt version chains (`prompt-to-prompt` edges — see addPromptVersion) are assumed linear;
 *    if a version has more than one forward version-edge, only the first-found branch is walked.
 *  - If two different producers target the same dataset id (e.g. both a stale `sourceRunNodeId`
 *    and a live `process-to-dataset` edge), the process-to-dataset edge wins — last one indexed.
 */

const STEP_KIND = { PROMPT: 'prompt', PROCESS: 'process', DATASET: 'dataset' };

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
 *   | {id: string, kind: 'dataset', producerStepId: string|null, consumerStepId: string|null,
 *      datasets: Array<{datasetNodeId: string, datasetName: string, producerRunNodeId: string|null,
 *        consumerRunNodeIds: string[]}>}
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

  // A step is a whole version chain, so the Run ids are kept alongside the step ids: they're what
  // lets a slot narrow its datasets down to the Prompt version actually selected (see the modal).
  const datasetProducerStepId = new Map(); // dataset nodeId -> id of the step that produced it
  const datasetProducerRunId = new Map(); // dataset nodeId -> Run that produced it, if any
  for (const ds of datasetNodes) {
    const producer = ds.sourceRunNodeId ? runNodeToStep.get(ds.sourceRunNodeId) : null;
    if (!producer) continue;
    datasetProducerStepId.set(ds.nodeId, producer.id);
    datasetProducerRunId.set(ds.nodeId, ds.sourceRunNodeId);
  }
  for (const c of connections) {
    if (c.type !== 'process-to-dataset') continue;
    const producer = processNodeToStep.get(c.fromId);
    // A Process has no versions, so nothing to narrow by — it gets a step id but no Run id.
    if (producer) datasetProducerStepId.set(c.toId, producer.id);
  }

  const datasetConsumerStepIds = new Map(); // dataset nodeId -> Set of step ids reading it
  const datasetConsumerRunIds = new Map(); // dataset nodeId -> Set of Runs reading it
  function addConsumer(datasetNodeId, stepId, runNodeId) {
    const id = String(datasetNodeId || '').trim();
    if (!id || !stepId) return;
    if (!datasetConsumerStepIds.has(id)) datasetConsumerStepIds.set(id, new Set());
    datasetConsumerStepIds.get(id).add(stepId);
    if (!runNodeId) return;
    if (!datasetConsumerRunIds.has(id)) datasetConsumerRunIds.set(id, new Set());
    datasetConsumerRunIds.get(id).add(runNodeId);
  }
  for (const run of runNodes) {
    const consumer = runNodeToStep.get(run.nodeId);
    if (consumer && run.runWorkingSetId) addConsumer(run.runWorkingSetId, consumer.id, run.nodeId);
  }
  for (const c of connections) {
    if (c.type !== 'dataset-to-process') continue;
    const consumer = processNodeToStep.get(c.toId);
    if (consumer) addConsumer(c.fromId, consumer.id, null);
  }

  // Datasets are grouped by the slot they sit in rather than one step each: a Run whose results
  // were saved to the workspace twice, or one Prompt whose Runs read different inputs, are
  // alternatives for the same slot, so they collapse into a single switchable step the way Prompt
  // versions do. A dataset nothing attaches to never gets a slot at all.
  const slots = new Map(); // slot key -> {producerStepId, consumerStepIds: Set, datasetNodeIds: []}
  for (const ds of datasetNodes) {
    const producerStepId = datasetProducerStepId.get(ds.nodeId) || null;
    const consumerStepIds = datasetConsumerStepIds.get(ds.nodeId) || new Set();
    if (!producerStepId && consumerStepIds.size === 0) continue;
    // Produced datasets belong to the slot right after their producer; an entry dataset (nothing
    // produced it) belongs to the slot in front of whatever reads it first.
    const key = producerStepId ? `after:${producerStepId}` : `before:${[...consumerStepIds][0]}`;
    if (!slots.has(key)) slots.set(key, { producerStepId, consumerStepIds: new Set(), datasetNodeIds: [] });
    const slot = slots.get(key);
    slot.datasetNodeIds.push(ds.nodeId);
    for (const id of consumerStepIds) slot.consumerStepIds.add(id);
  }

  const stepEdges = [];
  for (const [key, slot] of slots) {
    const step = {
      id: `dataset:${key}`,
      kind: STEP_KIND.DATASET,
      producerStepId: slot.producerStepId,
      // Only meaningful for an entry slot, where there's no producer to narrow by.
      consumerStepId: slot.producerStepId ? null : ([...slot.consumerStepIds][0] || null),
      datasets: slot.datasetNodeIds.map((id) => ({
        datasetNodeId: id,
        datasetName: nodeById.get(id)?.name || 'Dataset',
        producerRunNodeId: datasetProducerRunId.get(id) || null,
        consumerRunNodeIds: [...(datasetConsumerRunIds.get(id) || [])],
      })),
    };
    steps.push(step);
    if (slot.producerStepId) stepEdges.push({ from: slot.producerStepId, to: step.id });
    for (const consumerStepId of slot.consumerStepIds) {
      // A dataset feeding back into the step that produced it would close a cycle — skip that edge
      // rather than hand topoSort a loop.
      if (consumerStepId === slot.producerStepId) continue;
      stepEdges.push({ from: step.id, to: consumerStepId });
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
