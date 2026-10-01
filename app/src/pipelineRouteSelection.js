/** Pure Current Pipeline route selection. No DOM, network or canvas mutation. */

function promptRunOptions(step) {
  const options = [];
  for (const version of step?.versions || []) {
    const runs = Array.isArray(version.runs)
      ? version.runs
      : (version.runNodeIds || []).map((runNodeId) => ({ runNodeId, runName: 'Run' }));
    for (const run of runs) {
      options.push({
        value: run.runNodeId,
        stepId: step.id,
        promptNodeId: version.promptNodeId,
        runNodeId: run.runNodeId,
        promptName: version.promptName,
        runName: run.runName || 'Run',
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
 * Resolves one route through the workflow graph. Choices are made at the node where paths diverge,
 * so shared prefixes and suffixes appear once instead of being repeated as Branch 1/2/3 rows.
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

  function buildDatasetStep(step) {
    const producerRunId = selectedRunByStepId.get(step.producerStepId) || null;
    const datasets = producerRunId
      ? step.datasets.filter((dataset) => dataset.producerRunNodeId === producerRunId)
      : step.datasets;
    const options = datasets.map((dataset) => ({
      value: dataset.datasetNodeId,
      label: dataset.datasetName,
      dataset,
      stepId: step.id,
    }));
    const selected = chooseOption(step.id, options, selectedByChoiceId);
    return selected ? {
      kind: 'dataset', choiceId: step.id, options, selectedValue: selected.value, selectedOption: selected,
    } : null;
  }

  function buildPromptStep(step, allowedRunIds = null) {
    const restrictPromptRuns = allowedRunIds instanceof Set && allowedRunIds.size > 0;
    const options = promptRunOptions(step)
      .filter((option) => !restrictPromptRuns || allowedRunIds.has(option.runNodeId))
      .map((option) => ({ ...option, label: option.promptName || 'Prompt' }));
    const selected = chooseOption(step.id, options, selectedByChoiceId, step.defaultRunNodeId || '');
    if (!selected) return null;
    selectedRunByStepId.set(step.id, selected.runNodeId);
    return {
      kind: 'prompt', choiceId: step.id, options, selectedValue: selected.value, selectedOption: selected,
    };
  }

  function buildProcessStep(step) {
    const selected = {
      value: `process:${step.processNodeId}`,
      label: step.processName,
      stepId: step.id,
      processNodeId: step.processNodeId,
      inputDatasets: Array.isArray(step.inputDatasets) ? step.inputDatasets : [],
      kind: 'process',
    };
    return {
      kind: 'process', choiceId: step.id, options: [selected], selectedValue: selected.value, selectedOption: selected,
    };
  }

  function nextStepIdsForRouteStep(routeStep) {
    const selected = routeStep?.selectedOption;
    if (!selected) return [];
    if (selected.dataset) return selected.dataset.consumerStepIds || [];
    return (outgoing.get(selected.stepId) || []).filter((id) => stepById.has(id));
  }

  function findSharedJoin(startIds) {
    const distancesFrom = (startId) => {
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
    };
    const distanceMaps = startIds.map(distancesFrom);
    const commonIds = [...distanceMaps[0].keys()].filter((id) => (
      !startIds.includes(id) && distanceMaps.every((map) => map.has(id))
    ));
    commonIds.sort((a, b) => {
      const aDistance = distanceMaps.reduce((sum, map) => sum + map.get(a), 0);
      const bDistance = distanceMaps.reduce((sum, map) => sum + map.get(b), 0);
      return aDistance - bDistance;
    });
    return commonIds[0] || '';
  }

  function buildBranchLane(startId, joinId) {
    const lane = [];
    const seen = new Set();
    let currentId = startId;
    let allowedRunIds = null;
    while (currentId && currentId !== joinId && !seen.has(currentId) && lane.length < 100) {
      seen.add(currentId);
      const step = stepById.get(currentId);
      if (!step) break;
      const routeStep = step.kind === 'dataset'
        ? buildDatasetStep(step)
        : (step.kind === 'prompt' ? buildPromptStep(step, allowedRunIds) : buildProcessStep(step));
      if (!routeStep) break;
      lane.push(routeStep);
      if (routeStep.kind === 'dataset') {
        allowedRunIds = new Set(routeStep.selectedOption.dataset.consumerRunNodeIds || []);
      } else {
        allowedRunIds = null;
      }
      const nextIds = nextStepIdsForRouteStep(routeStep);
      currentId = nextIds.includes(joinId) ? joinId : nextIds[0];
    }
    return lane;
  }

  function walk(candidateStepIds, allowedRunIds = null) {
    if (route.length >= 200) return;
    const candidateSteps = candidateStepIds
      .map((id) => stepById.get(id))
      .filter((step) => step && !visitedStepIds.has(step.id));
    if (candidateSteps.length === 0) return;

    if (candidateSteps.every((step) => step.kind === 'dataset') && candidateSteps.length > 1) {
      const joinId = findSharedJoin(candidateSteps.map((step) => step.id));
      if (joinId) {
        const lanes = candidateSteps.map((step) => buildBranchLane(step.id, joinId)).filter((lane) => lane.length);
        if (lanes.length > 1) {
          route.push({ kind: 'branch', lanes });
          for (const lane of lanes) {
            for (const laneStep of lane) visitedStepIds.add(laneStep.selectedOption.stepId);
          }
          walk([joinId]);
          return;
        }
      }
    }

    if (candidateSteps.every((step) => step.kind === 'dataset')) {
      const choiceId = candidateSteps.length === 1
        ? candidateSteps[0].id
        : `dataset-choice:${candidateSteps.map((step) => step.id).sort().join('|')}`;
      const options = [];
      for (const step of candidateSteps) {
        const producerRunId = selectedRunByStepId.get(step.producerStepId) || null;
        const datasets = producerRunId
          ? step.datasets.filter((dataset) => dataset.producerRunNodeId === producerRunId)
          : step.datasets;
        for (const dataset of datasets) {
          options.push({
            value: dataset.datasetNodeId,
            label: dataset.datasetName,
            dataset,
            stepId: step.id,
          });
        }
      }
      const selected = chooseOption(choiceId, options, selectedByChoiceId);
      if (!selected) return;
      route.push({ kind: 'dataset', choiceId, options, selectedValue: selected.value, selectedOption: selected });
      visitedStepIds.add(selected.stepId);
      const consumerStepIds = selected.dataset.consumerStepIds
        || stepById.get(selected.stepId)?.consumerStepIds
        || [];
      walk(consumerStepIds, new Set(selected.dataset.consumerRunNodeIds || []));
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

    const allPrompts = nextOptions.every((option) => option.kind === 'prompt');
    const allProcesses = nextOptions.every((option) => option.kind === 'process');
    const displayKind = allPrompts ? 'prompt' : (allProcesses ? 'process' : 'step');
    const displayOptions = nextOptions.map((option) => ({
      ...option,
      label: allPrompts && nextOptions.length > 1
        ? `${option.promptName} — ${option.runName}`
        : option.label || option.promptName,
    }));
    route.push({
      kind: displayKind,
      choiceId,
      options: displayOptions,
      selectedValue: selected.value,
      selectedOption: selected,
    });
    visitedStepIds.add(selected.stepId);
    if (selected.kind === 'prompt') selectedRunByStepId.set(selected.stepId, selected.runNodeId);
    const nextStepIds = (outgoing.get(selected.stepId) || [])
      .filter((id) => stepById.get(id)?.kind === 'dataset');
    walk(nextStepIds);
  }

  const sourceIds = steps.filter((step) => indegree.get(step.id) === 0).map((step) => step.id);
  walk(sourceIds);
  return route;
}

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
