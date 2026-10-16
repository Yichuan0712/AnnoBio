import { generateDisplayName } from './nodeLabels.js';
/** Pure Pipeline route selection. No DOM, network or canvas mutation. */

function promptRunOptions(step) {
  const options = [];
  for (const version of step?.versions || []) {
    const runs = Array.isArray(version.runs)
      ? version.runs
      : (version.runNodeIds || []).map((runNodeId) => ({ runNodeId, runName: 'Generate' }));
    for (const run of runs) {
      options.push({
        value: run.runNodeId,
        stepId: step.id,
        promptNodeId: version.promptNodeId,
        runNodeId: run.runNodeId,
        inputDatasetNodeId: run.inputDatasetNodeId || '',
        promptName: version.promptName,
        runName: generateDisplayName(run.runName),
        kind: 'prompt',
      });
    }
  }
  return options;
}

function chooseOption(choiceId, options, selectedByChoiceId, preferredValue = '') {
  const stored = selectedByChoiceId.get(choiceId);
  return options.find((option) => option.value === stored)
    || options.find((option) => option.value === preferredValue)
    || options[0]
    || null;
}

/**
 * Resolves one route through the workflow graph. Choices are made on the Prompt or Process step
 * where paths diverge, so shared prefixes and suffixes appear once instead of being repeated as
 * Branch 1/2/3 rows. A branch is a Process's named outputs, or the Datasets one Process merges.
 */
export function buildSelectedRoute(pipeline, selectedByChoiceId) {
  const steps = Array.isArray(pipeline?.steps) ? pipeline.steps : [];
  const stepById = new Map(steps.map((step) => [step.id, step]));
  const outgoing = new Map(steps.map((step) => [step.id, []]));
  const indegree = new Map(steps.map((step) => [step.id, 0]));
  for (const edge of pipeline?.edges || []) {
    if (!stepById.has(edge.from) || !stepById.has(edge.to)) continue;
    if (!outgoing.get(edge.from).includes(edge.to)) outgoing.get(edge.from).push(edge.to);
    indegree.set(edge.to, indegree.get(edge.to) + 1);
  }

  const route = [];
  const visitedStepIds = new Set();
  const selectedRunByStepId = new Map();

  /**
   * What a slot offers: the Datasets an input slot lets the first step start from, or, between steps,
   * the output of the Generate the route selected upstream (a Process slot holds one output).
   */
  function datasetOptions(step) {
    if (step.outputs) {
      const producerRunId = selectedRunByStepId.get(step.producerStepId) || null;
      const outputs = producerRunId ? step.outputs.filter((output) => output.producerNodeId === producerRunId) : step.outputs;
      return outputs.map((output) => ({
        value: `${output.producerNodeId}:${output.port}`,
        label: output.port,
        output,
        stepId: step.id,
      }));
    }
    return step.datasets.map((dataset) => ({
      value: dataset.datasetNodeId,
      label: dataset.datasetName,
      dataset,
      stepId: step.id,
    }));
  }

  /** The Dataset or step output a slot option carries. */
  const optionItem = (option) => option.dataset || option.output;

  function datasetFeeds(item, selected) {
    if (selected?.kind === 'prompt') return (item.consumerRunNodeIds || []).includes(selected.runNodeId);
    if (selected?.kind === 'process') return (item.consumerStepIds || []).includes(selected.stepId);
    return false;
  }

  function distancesFrom(startId) {
    const distances = new Map([[startId, 0]]);
    const queue = [startId];
    while (queue.length) {
      const current = queue.shift();
      for (const next of outgoing.get(current) || []) {
        if (distances.has(next)) continue;
        distances.set(next, distances.get(current) + 1);
        queue.push(next);
      }
    }
    return distances;
  }

  /**
   * The Process where the start steps' paths first meet: it reads from each of them, so each is a
   * branch it needs. Paths that first meet anywhere else (a Prompt, whose Runs are alternatives) or
   * never meet are not branches.
   */
  function findMergingProcess(startIds) {
    const distanceMaps = startIds.map(distancesFrom);
    const commonIds = [...distanceMaps[0].keys()].filter((id) => (
      !startIds.includes(id) && distanceMaps.every((map) => map.has(id))
    ));
    const reach = new Map(commonIds.map((id) => [id, distancesFrom(id)]));
    const firstMeetings = commonIds.filter((id) => !commonIds.some((other) => other !== id && reach.get(other).has(id)));
    if (!firstMeetings.length || firstMeetings.some((id) => stepById.get(id)?.kind !== 'process')) return '';
    const distance = (id) => distanceMaps.reduce((sum, map) => sum + map.get(id), 0);
    return firstMeetings.sort((a, b) => distance(a) - distance(b))[0];
  }

  /** Named outputs of one Process: the only place a route forks. */
  function isProcessFork(datasetSteps) {
    const producerStepId = datasetSteps[0]?.producerStepId || '';
    return producerStepId.startsWith('process:')
      && datasetSteps.every((step) => step.producerStepId === producerStepId && step.id.includes(':branch:'));
  }

  /**
   * Appends the route from the candidate steps to `out`, stopping before `stopId` (a branch's merge
   * point). A branch comes only from a Process: its named outputs fork, and the steps whose results
   * one Process reads merge there, so each of them runs. Steps that read one Dataset and never meet
   * at a Process are alternatives, chosen on the step; so is any other choice between Datasets.
   */
  function walk(candidateStepIds, allowedRunIds = null, out = route, stopId = '') {
    if (out.length >= 200) return;
    if (stopId && candidateStepIds.includes(stopId)) return;
    const candidateSteps = candidateStepIds
      .map((id) => stepById.get(id))
      .filter((step) => step && !visitedStepIds.has(step.id));
    if (candidateSteps.length === 0) return;

    const datasetCandidates = candidateSteps.filter((step) => step.kind === 'dataset').length;
    if (candidateSteps.length > 1 && (datasetCandidates === 0 || datasetCandidates === candidateSteps.length)) {
      // An unused output is still part of the selected route, but cannot prevent the connected
      // outputs from finding their shared Process (including a direct-to-merge output).
      const mergingSteps = candidateSteps.filter(step => step.kind !== 'dataset'
        || !step.producerStepId || outgoing.get(step.id)?.length);
      const joinId = mergingSteps.length > 1 ? findMergingProcess(mergingSteps.map(step => step.id)) : '';
      if (joinId || (datasetCandidates && isProcessFork(candidateSteps))) {
        const lanes = candidateSteps.map((step) => {
          const lane = [];
          walk([step.id], datasetCandidates ? null : allowedRunIds, lane, joinId);
          return lane;
        }).filter((lane) => lane.length);
        if (lanes.length > 1) {
          out.push({ kind: 'branch', lanes });
          if (joinId) walk([joinId], null, out, stopId);
          return;
        }
      }
    }

    if (candidateSteps.every((step) => step.kind === 'dataset')) {
      const options = candidateSteps.flatMap(datasetOptions);
      if (options.length === 0) return;
      const choiceId = candidateSteps.length === 1
        ? candidateSteps[0].id
        : `dataset-choice:${candidateSteps.map((step) => step.id).sort().join('|')}`;
      const datasetStep = { kind: 'dataset', choiceId, options, selectedValue: options[0].value, selectedOption: options[0] };
      out.push(datasetStep);
      for (const option of options) visitedStepIds.add(option.stepId);
      const consumerStepIds = [...new Set(options.flatMap((option) => (
        optionItem(option).consumerStepIds || stepById.get(option.stepId)?.consumerStepIds || []
      )))];
      const consumerRunIds = new Set(options.flatMap((option) => optionItem(option).consumerRunNodeIds || []));
      const nextIndex = out.length;
      walk(consumerStepIds, consumerRunIds, out, stopId);
      // Of several Datasets, the route uses the one the chosen next step reads.
      const used = options.length > 1
        ? options.find((option) => datasetFeeds(optionItem(option), out[nextIndex]?.selectedOption))
        : null;
      if (used) {
        datasetStep.selectedValue = used.value;
        datasetStep.selectedOption = used;
      }
      return;
    }

    const nextOptions = [];
    const restrictPromptRuns = allowedRunIds instanceof Set && allowedRunIds.size > 0;
    for (const step of candidateSteps) {
      if (step.kind === 'prompt') {
        for (const option of promptRunOptions(step)) {
          if (!restrictPromptRuns || allowedRunIds.has(option.runNodeId)) nextOptions.push(option);
        }
      } else if (step.kind === 'process') {
        nextOptions.push({
          value: `process:${step.processNodeId}`,
          label: step.processName,
          stepId: step.id,
          processNodeId: step.processNodeId,
          inputDatasets: Array.isArray(step.inputDatasets) ? step.inputDatasets : [],
          kind: 'process',
        });
      }
    }
    if (nextOptions.length === 0) return;

    const choiceId = candidateSteps.length === 1
      ? candidateSteps[0].id
      : `step-choice:${candidateSteps.map((step) => step.id).sort().join('|')}`;
    const firstPromptStep = candidateSteps.find((step) => step.kind === 'prompt');
    const preferredValue = firstPromptStep?.defaultRunNodeId || '';
    const selected = chooseOption(choiceId, nextOptions, selectedByChoiceId, preferredValue);
    if (!selected) return;

    // A Generate step is named by its Prompt and its own name, even when it is the only choice.
    const displayOptions = nextOptions.map((option) => ({
      ...option,
      label: option.kind === 'prompt' ? `${option.promptName} — ${option.runName}` : option.label,
    }));
    out.push({
      kind: selected.kind,
      choiceId,
      options: displayOptions,
      selectedValue: selected.value,
      selectedOption: selected,
    });
    visitedStepIds.add(selected.stepId);
    if (selected.kind === 'prompt') selectedRunByStepId.set(selected.stepId, selected.runNodeId);
    const nextStepIds = (outgoing.get(selected.stepId) || [])
      .filter((id) => stepById.get(id)?.kind === 'dataset');
    walk(nextStepIds, null, out, stopId);
  }

  const sourceIds = steps.filter((step) => indegree.get(step.id) === 0).map((step) => step.id);
  walk(sourceIds);
  return route;
}

/**
 * The route without its Datasets: a Generate or Process chip stands for the Datasets it reads.
 * Unused outputs are omitted and single remaining lanes become a straight continuation.
 * A branch whose lanes hold only Datasets says nothing the merging Process does not, so it is dropped.
 */
export function getVisibleRoute(route, continuationStepId = '') {
  return route.flatMap((step, index) => {
    if (step.kind === 'dataset' || step.kind === 'empty') return [];
    if (step.kind !== 'branch') return [step];
    // A lane may contain only a hidden output slot because it feeds the shared continuation
    // directly. That is different from an unused output. Nested branches inherit the outer join.
    const nextStepId = route.slice(index + 1).find(next => next.selectedOption?.kind)
      ?.selectedOption?.stepId || continuationStepId;
    const lanes = (step.lanes || []).map((sourceLane) => {
      const lane = getVisibleRoute(sourceLane, nextStepId);
      if (lane.length) return lane;
      const connectsDirectly = nextStepId && sourceLane.some(hidden => {
        const selected = hidden.selectedOption;
        return (selected?.output?.consumerStepIds || selected?.dataset?.consumerStepIds || []).includes(nextStepId);
      });
      return connectsDirectly ? [{ kind: 'passthrough' }] : [];
    }).filter(lane => lane.length);
    // Several direct outputs need no intermediate step or branch box in the overview.
    if (lanes.every(lane => lane.length === 1 && lane[0].kind === 'passthrough')) return [];
    if (lanes.length === 1) return lanes[0];
    return [{ ...step, lanes }];
  });
}

/**
 * The route as the compiler takes it (pipeline_compile.py): its Prompt/Generate steps and Processes, and the
 * Datasets they start from. Outputs passed between steps are not listed; the compiler follows them.
 */
export function exportRoutePayload(route) {
  const exported = [];
  const seen = new Set();
  function add(item) {
    const key = item.type === 'dataset' ? `dataset:${item.dataset_node_id}`
      : item.type === 'process' ? `process:${item.process_node_id}`
        : `prompt:${item.prompt_node_id}:${item.run_node_id}`;
    if (!seen.has(key)) {
      seen.add(key);
      exported.push(item);
    }
  }
  function visit(steps) {
    for (const step of steps || []) {
      if (step?.kind === 'branch') {
        for (const lane of step.lanes || []) visit(lane);
        continue;
      }
      const selected = step?.selectedOption;
      if (selected?.dataset?.datasetNodeId) add({ type: 'dataset', dataset_node_id: selected.dataset.datasetNodeId });
      if (selected?.kind === 'process') {
        for (const input of selected.inputDatasets || []) {
          if (input?.datasetNodeId) add({ type: 'dataset', dataset_node_id: input.datasetNodeId });
        }
        if (selected.processNodeId) add({ type: 'process', process_node_id: selected.processNodeId });
      }
      if (selected?.kind === 'prompt' && selected.promptNodeId && selected.runNodeId) {
        add({ type: 'prompt', prompt_node_id: selected.promptNodeId, run_node_id: selected.runNodeId });
      }
    }
  }
  visit(route);
  return exported;
}
