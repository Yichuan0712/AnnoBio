/**
 * Detects "pipelines" (chains of Prompt/Process steps) from a canvas state — the same shape
 * getCanvasState()/loadCanvasState() in workflowCanvas.js produce/consume: `{nodes, connections}`.
 * Pure function, no DOM — takes plain JSON, returns plain JSON, so it's usable both live (fed
 * getCanvasState()'s output) and offline (fed a saved project's state) without any canvas
 * instance at all.
 *
 * A "pipeline" here is a graph of Prompt (+ the Generate that executes it) and Process steps, joined by
 * the `data` connections that make one step read another's output (docs/design/DATA_FLOW_DESIGN.md
 * §6.1). Most pipelines read as a linear sequence, but a Process may also read several inputs and
 * form an explicit merge point. A pipeline needs at least one Prompt/Generate step or Process. Where one input
 * feeds both Prompt/Generate steps and Processes, each kind starts its own pipeline (see splitByConsumerKind).
 * Score/PromptReview stay out: they're evaluation/tuning scaffolding, not part of "the thing that
 * produces output" this is meant to describe. See the AnnoBio canvas→code-export planning
 * discussion this was built for.
 *
 * Between the steps sit "slot" steps (kind 'dataset'), where data passes from one step to the next:
 *  - an input slot (`dataset:before:<readers>`) lists the Datasets a first step reads. A Dataset is
 *    only ever an input: one saved from a step's results starts a new pipeline, it does not chain.
 *  - an output slot (`dataset:after:<producer step>`, or `...:branch:<port>` for a Process's named
 *    branches) holds the outputs of one producer step: one per Run of a Prompt that other steps read,
 *    or one branch of a Process. Every branch a Process returns has a slot, read or not, as every
 *    branch is an output of the pipeline (pipeline_compile.py).
 */
import { generateDisplayName } from './nodeLabels.js';
import { effectiveProcessOutputs, showsProcessOutputs } from './processOutputPorts.js';
import { processInputSources, runInputSource } from './stepInputs.js';

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

/**
 * Groups Prompt nodes into version families via `prompt-to-prompt` edges. A family may branch when
 * a Prompt version is duplicated or receives more than one next version, so collect the complete
 * connected component and topologically order all of its versions instead of following one edge.
 */
function buildPromptFamilies(promptNodes, edges) {
  const promptIds = new Set(promptNodes.map((prompt) => prompt.nodeId));
  const versionEdges = [];
  const adjacent = new Map(promptNodes.map((prompt) => [prompt.nodeId, new Set()]));
  for (const prompt of promptNodes) {
    for (const nextId of edges.from('prompt-to-prompt', prompt.nodeId)) {
      if (!promptIds.has(nextId)) continue;
      versionEdges.push({ from: prompt.nodeId, to: nextId });
      adjacent.get(prompt.nodeId).add(nextId);
      adjacent.get(nextId).add(prompt.nodeId);
    }
  }

  const visited = new Set();
  const families = [];
  for (const prompt of promptNodes) {
    if (visited.has(prompt.nodeId)) continue;
    const componentIds = [];
    const stack = [prompt.nodeId];
    visited.add(prompt.nodeId);
    while (stack.length > 0) {
      const currentId = stack.pop();
      componentIds.push(currentId);
      for (const nextId of adjacent.get(currentId) || []) {
        if (visited.has(nextId)) continue;
        visited.add(nextId);
        stack.push(nextId);
      }
    }
    const idSet = new Set(componentIds);
    const componentEdges = versionEdges.filter((edge) => idSet.has(edge.from) && idSet.has(edge.to));
    const chain = topoSort(componentIds, componentEdges);
    const rootId = chain.find((id) => !componentEdges.some((edge) => edge.to === id)) || chain[0];
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
 *   {id: string, kind: 'prompt', versions: Array<{promptNodeId: string, promptName: string,
 *      runs: Array<{runNodeId: string, runName: string, inputDatasetNodeId: string}>, runNodeIds: string[]}>,
 *      defaultVersionIndex: number, defaultRunNodeId: string}
 *   | {id: string, kind: 'process', processNodeId: string, processName: string}
 *   | {id: string, kind: 'dataset', producerStepId: string|null, consumerStepIds: string[],
 *      datasets?: Array<{datasetNodeId: string, datasetName: string, consumerStepIds: string[], consumerRunNodeIds: string[]}>,
 *      outputs?: Array<{producerNodeId: string, port: string, consumerStepIds: string[], consumerRunNodeIds: string[]}>}
 * >, edges: Array<{from: string, to: string}>}>}
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
      .map((versionId) => {
        const runNodeIds = runsByVersion.get(versionId);
        return {
          promptNodeId: versionId,
          promptName: nodeById.get(versionId)?.name || 'Prompt',
          runs: runNodeIds.map((runNodeId) => {
            const input = runInputSource(canvasState, runNodeId);
            return {
              runNodeId,
              runName: generateDisplayName(nodeById.get(runNodeId)?.runName),
              // The Dataset it reads, when it starts from one rather than from another step's output.
              inputDatasetNodeId: input?.kind === 'dataset' ? input.nodeId : '',
            };
          }),
          // Kept for callers that only need membership in the selected Prompt version.
          runNodeIds,
        };
      });
    const defaultVersionIndex = versions.length - 1;
    const step = {
      id: `prompt:${family.rootId}`,
      kind: STEP_KIND.PROMPT,
      versions,
      defaultVersionIndex, // latest version in the chain, not necessarily "correct" — see file doc
      defaultRunNodeId: versions[defaultVersionIndex]?.runs.at(-1)?.runNodeId || '',
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
      // The Datasets it starts from; the steps whose outputs it reads come in through slots.
      inputDatasets: processInputSources(canvasState, p.nodeId).filter((source) => source.kind === 'dataset')
        .map((source) => ({
          datasetNodeId: source.nodeId,
          datasetName: nodeById.get(source.nodeId)?.name || 'Dataset',
        })),
    };
    steps.push(step);
    processNodeToStep.set(p.nodeId, step);
  }

  if (steps.length === 0) return [];

  // Every input of every step: a Dataset it starts from, or another step's output it reads.
  const reads = []; // { source, consumerStepId, runNodeId }
  for (const run of runNodes) {
    const consumer = runNodeToStep.get(run.nodeId);
    const source = runInputSource(canvasState, run.nodeId);
    if (consumer && source) reads.push({ source, consumerStepId: consumer.id, runNodeId: run.nodeId });
  }
  for (const p of processNodes) {
    for (const source of processInputSources(canvasState, p.nodeId)) {
      reads.push({ source, consumerStepId: processNodeToStep.get(p.nodeId).id, runNodeId: null });
    }
  }
  const addReader = (item, read) => {
    if (!item.consumerStepIds.includes(read.consumerStepId)) item.consumerStepIds.push(read.consumerStepId);
    if (read.runNodeId && !item.consumerRunNodeIds.includes(read.runNodeId)) item.consumerRunNodeIds.push(read.runNodeId);
  };

  // Input slots: the Datasets the steps start from, grouped by the steps that read them, so the
  // Datasets one step can start from are alternatives in one slot. A Dataset nothing reads has none.
  const datasetReaders = new Map(); // dataset nodeId -> { consumerStepIds, consumerRunNodeIds }
  for (const read of reads.filter((item) => item.source.kind === 'dataset')) {
    if (nodeById.get(read.source.nodeId)?.type !== 'dataset') continue;
    if (!datasetReaders.has(read.source.nodeId)) datasetReaders.set(read.source.nodeId, { consumerStepIds: [], consumerRunNodeIds: [] });
    addReader(datasetReaders.get(read.source.nodeId), read);
  }
  const slots = new Map(); // slot key -> { producerStepId, consumerStepIds: Set, datasets?: [], outputs?: [] }
  for (const ds of datasetNodes) {
    const readers = datasetReaders.get(ds.nodeId);
    if (!readers) continue;
    const key = `before:${[...readers.consumerStepIds].sort().join(',')}`;
    if (!slots.has(key)) slots.set(key, { producerStepId: null, consumerStepIds: new Set(), datasets: [] });
    const slot = slots.get(key);
    slot.datasets.push({ datasetNodeId: ds.nodeId, datasetName: ds.name || 'Dataset', ...readers });
    readers.consumerStepIds.forEach((id) => slot.consumerStepIds.add(id));
  }

  // Output slots. The Generates of one Prompt are alternatives in one slot, so the slot follows whichever
  // Run the route selects. A Process's named branches are separate slots, in the order it returns
  // them, so the Current Pipeline can draw the fork, an empty lane for a branch nothing reads, and
  // the later merge.
  const outputSlot = (key, producerStepId) => {
    if (!slots.has(key)) slots.set(key, { producerStepId, consumerStepIds: new Set(), outputs: [] });
    return slots.get(key);
  };
  const outputIn = (slot, producerNodeId, port) => {
    let output = slot.outputs.find((item) => item.producerNodeId === producerNodeId && item.port === port);
    if (!output) {
      output = { producerNodeId, port, consumerStepIds: [], consumerRunNodeIds: [] };
      slot.outputs.push(output);
    }
    return output;
  };
  const processSlotKeys = new Map(); // `${process nodeId}\u0000${port}` -> slot key
  for (const p of processNodes) {
    const step = processNodeToStep.get(p.nodeId);
    const outputs = effectiveProcessOutputs({ detected: p.processOutputPorts, dfResults: p.dfResults });
    const readPorts = [...new Set(reads.filter((read) => read.source.kind === 'process' && read.source.nodeId === p.nodeId)
      .map((read) => read.source.port))];
    const branched = showsProcessOutputs(outputs) || readPorts.some((port) => port !== 'result');
    const ports = branched ? [...outputs.ports, ...readPorts.filter((port) => !outputs.ports.includes(port))] : readPorts;
    for (const port of ports) {
      const key = branched ? `after:${step.id}:branch:${port}` : `after:${step.id}`;
      outputIn(outputSlot(key, step.id), p.nodeId, port);
      processSlotKeys.set(`${p.nodeId}\u0000${port}`, key);
    }
  }
  for (const read of reads) {
    const { source } = read;
    let slot = null;
    if (source.kind === 'run' && runNodeToStep.has(source.nodeId)) {
      const producer = runNodeToStep.get(source.nodeId);
      slot = outputSlot(`after:${producer.id}`, producer.id);
    } else if (source.kind === 'process') {
      slot = slots.get(processSlotKeys.get(`${source.nodeId}\u0000${source.port}`)) || null;
    }
    if (!slot) continue;
    addReader(outputIn(slot, source.nodeId, source.port), read);
    slot.consumerStepIds.add(read.consumerStepId);
  }

  const stepEdges = [];
  for (const [key, slot] of slots) {
    const step = {
      id: `dataset:${key}`,
      kind: STEP_KIND.DATASET,
      producerStepId: slot.producerStepId,
      consumerStepIds: [...slot.consumerStepIds],
      ...(slot.datasets ? { datasets: slot.datasets } : { outputs: slot.outputs }),
    };
    steps.push(step);
    if (slot.producerStepId) stepEdges.push({ from: slot.producerStepId, to: step.id });
    for (const consumerStepId of slot.consumerStepIds) {
      // A step reading its own output would close a cycle — skip that edge rather than hand
      // topoSort a loop.
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

  return components
    .flatMap((componentIds) => {
      const idSet = new Set(componentIds);
      const localEdges = stepEdges.filter((e) => idSet.has(e.from) && idSet.has(e.to));
      const order = topoSort(componentIds, localEdges);
      return splitByConsumerKind(order.map((id) => stepById.get(id)), localEdges);
    })
    .map((pipeline, index) => ({ id: `pipeline-${index + 1}`, ...pipeline }));
}

const MAX_PIPELINES_PER_COMPONENT = 32;

/**
 * A Dataset read by both Prompt/Generate steps and Processes starts different pipelines rather than one with a
 * mixed choice: running a Prompt and transforming data are different jobs, not versions of one step.
 * Each variant keeps one consumer kind at that Dataset and drops whatever only the other kind reached.
 * A Process needs all of its inputs, so losing any input drops it; a Prompt step stays while any of
 * its Runs still has an input.
 */
function splitByConsumerKind(orderedSteps, edges) {
  const results = [];
  const seen = new Set();
  const queue = [{ steps: orderedSteps, edges }];
  while (queue.length > 0 && results.length < MAX_PIPELINES_PER_COMPONENT) {
    const variant = queue.shift();
    const stepById = new Map(variant.steps.map((step) => [step.id, step]));
    const mixed = variant.steps.find((step) => step.kind === STEP_KIND.DATASET
      && new Set(step.consumerStepIds.map((id) => stepById.get(id)?.kind).filter(Boolean)).size > 1);
    if (!mixed) {
      if (!variant.steps.some((step) => step.kind !== STEP_KIND.DATASET)) continue;
      const signature = variant.steps.map((step) => step.id).join('|');
      if (seen.has(signature)) continue;
      seen.add(signature);
      results.push(variant);
      continue;
    }
    for (const kind of [STEP_KIND.PROMPT, STEP_KIND.PROCESS]) {
      const cut = new Set(mixed.consumerStepIds.filter((id) => stepById.get(id)?.kind !== kind));
      queue.push(pruneVariant(variant, mixed.id, cut, kind));
    }
  }
  return results;
}

function pruneVariant({ steps, edges }, datasetStepId, cutConsumerIds, keptKind) {
  const isCut = (e) => e.from === datasetStepId && cutConsumerIds.has(e.to);
  const dropped = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of steps) {
      if (dropped.has(step.id)) continue;
      const incoming = edges.filter((e) => e.to === step.id);
      const liveIncoming = incoming.filter((e) => !isCut(e) && !dropped.has(e.from));
      const outgoing = edges.filter((e) => e.from === step.id);
      const liveOutgoing = outgoing.filter((e) => !isCut(e) && !dropped.has(e.to));
      const lostInput = step.kind === STEP_KIND.PROCESS
        ? liveIncoming.length < incoming.length
        : incoming.length > 0 && liveIncoming.length === 0;
      const orphanSource = incoming.length === 0 && outgoing.length > 0 && liveOutgoing.length === 0;
      if (lostInput || orphanSource) {
        dropped.add(step.id);
        changed = true;
      }
    }
  }
  const keep = (id) => !dropped.has(id) && !cutConsumerIds.has(id);
  return {
    steps: steps.filter((step) => !dropped.has(step.id)).map((step) => {
      if (step.kind !== STEP_KIND.DATASET) return step;
      const atCut = step.id === datasetStepId;
      const keepHere = (id) => (atCut ? keep(id) : !dropped.has(id));
      const narrow = (item) => ({
        ...item,
        consumerStepIds: item.consumerStepIds.filter(keepHere),
        consumerRunNodeIds: atCut && keptKind === STEP_KIND.PROCESS ? [] : item.consumerRunNodeIds,
      });
      return {
        ...step,
        consumerStepIds: step.consumerStepIds.filter(keepHere),
        ...(step.datasets ? { datasets: step.datasets.map(narrow) } : { outputs: step.outputs.map(narrow) }),
      };
    }),
    edges: edges.filter((e) => !isCut(e) && !dropped.has(e.from) && !dropped.has(e.to)),
  };
}
