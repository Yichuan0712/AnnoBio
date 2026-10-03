/**
 * Prompt version families for the Prompt Optimization panel (promptOptimizationPanel.js).
 *
 * A version's parent is the Prompt it was made from: "Add new version" (a prompt-to-prompt edge) or
 * applying a Review (the new Prompt's prompt-review-to-prompt edge, traced back through
 * Review → Score → Run → Prompt). Duplicates are standalone, so they start their own family.
 * Pure: takes canvas state ({ nodes, connections }), returns plain data.
 */

const nodeId = (node) => String(node?.nodeId || node?.id || '');

/**
 * @returns {Array<{ rootId: string, versions: Array<{ promptId: string, name: string, depth: number,
 *   treePrefix: string, treeContinuation: string, parentId: string, via: ''|'version'|'review', reviewName: string,
 *   runs: Array<{ runId: string, name: string, scores: Array<{ scoreId: string, name: string, groundTruthId: string, groundTruthName: string }> }> }> }>}
 *   Versions are in family order (each parent before its children). `treePrefix` draws that tree in
 *   plain characters ("├─ ", "└─ ", "│  ") so it survives copying and export; `treeContinuation` is
 *   the guide for a version's further Run/Score rows. Families with one version and
 *   no Run are left out: there is nothing to compare yet.
 */
export function buildPromptFamilies(canvasState) {
  const nodes = Array.isArray(canvasState?.nodes) ? canvasState.nodes : [];
  const connections = Array.isArray(canvasState?.connections) ? canvasState.connections : [];
  const byId = new Map(nodes.map((node) => [nodeId(node), node]));
  const isType = (id, type) => byId.get(id)?.type === type;
  const fromOf = (type, toId) => connections.find((edge) => edge?.type === type && edge.toId === toId)?.fromId || '';
  const toAll = (type, fromId) => connections.filter((edge) => edge?.type === type && edge.fromId === fromId).map((edge) => edge.toId);

  const parentOf = new Map();
  for (const edge of connections) {
    if (edge?.type === 'prompt-to-prompt' && isType(edge.fromId, 'prompt') && isType(edge.toId, 'prompt') && !parentOf.has(edge.toId)) {
      parentOf.set(edge.toId, { parentId: edge.fromId, via: 'version', reviewName: '' });
    }
  }
  for (const edge of connections) {
    if (edge?.type !== 'prompt-review-to-prompt' || !isType(edge.toId, 'prompt') || parentOf.has(edge.toId)) continue;
    const scoreId = fromOf('score-to-prompt-review', edge.fromId);
    const runId = fromOf('run-to-score', scoreId);
    const promptId = fromOf('prompt-to-run', runId);
    if (!isType(promptId, 'prompt') || promptId === edge.toId) continue;
    const review = byId.get(edge.fromId);
    parentOf.set(edge.toId, { parentId: promptId, via: 'review', reviewName: String(review?.promptReviewName || review?.name || 'Review') });
  }

  const children = new Map();
  for (const [childId, { parentId }] of parentOf) {
    if (!children.has(parentId)) children.set(parentId, []);
    children.get(parentId).push(childId);
  }
  // A parent chain that loops back has no root; break it at the first Prompt in canvas order.
  const prompts = nodes.filter((node) => node.type === 'prompt').map(nodeId);
  const hasRootAbove = (id) => {
    const seen = new Set();
    let current = id;
    while (parentOf.has(current)) {
      if (seen.has(current)) return false;
      seen.add(current);
      current = parentOf.get(current).parentId;
    }
    return true;
  };
  const roots = prompts.filter((id) => !parentOf.has(id) || !hasRootAbove(id));

  const runsOf = (promptId) => toAll('prompt-to-run', promptId).filter((id) => isType(id, 'run')).map((runId) => ({
    runId,
    name: String(byId.get(runId)?.runName || 'Run'),
    scores: toAll('run-to-score', runId).filter((id) => isType(id, 'score')).map((scoreId) => {
      const score = byId.get(scoreId);
      const groundTruthId = String(score?.scoreGroundTruthId || '');
      return {
        scoreId,
        name: String(score?.scoreName || 'Score'),
        groundTruthId,
        groundTruthName: String(byId.get(groundTruthId)?.name || ''),
      };
    }),
  }));

  const visited = new Set();
  const families = [];
  for (const rootId of roots) {
    if (visited.has(rootId)) continue;
    const versions = [];
    const visit = (promptId, depth, guide = '', isLast = true) => {
      if (visited.has(promptId)) return;
      visited.add(promptId);
      const link = depth === 0 ? null : parentOf.get(promptId);
      const version = {
        promptId,
        name: String(byId.get(promptId)?.name || 'Prompt'),
        depth,
        treePrefix: depth === 0 ? '' : `${guide}${isLast ? '└─ ' : '├─ '}`,
        parentId: link?.parentId || '',
        via: link?.via || '',
        reviewName: link?.reviewName || '',
        runs: runsOf(promptId),
      };
      versions.push(version);
      const childGuide = depth === 0 ? '' : `${guide}${isLast ? '   ' : '│  '}`;
      const childIds = (children.get(promptId) || []).filter((childId) => !visited.has(childId));
      version.treeContinuation = `${childGuide}${childIds.length ? '│' : ''}`.trimEnd();
      childIds.forEach((childId, index) => visit(childId, depth + 1, childGuide, index === childIds.length - 1));
    };
    visit(rootId, 0);
    if (versions.length > 1 || versions.some((version) => version.runs.length)) families.push({ rootId, versions });
  }
  return families;
}

/**
 * One table row per Score of each Run of each version (a version without Runs, or a Run without
 * Scores, still gets one row). Only a version's first row names it; the others carry its tree guide.
 * @param {Map<string, {precision?: number, recall?: number, f1?: number}|null>} metrics by Score id, in percent
 */
export function familyRows(family, metrics = new Map()) {
  const byPrompt = new Map(family.versions.map((version) => [version.promptId, version]));
  return family.versions.flatMap((version) => {
    const parentName = byPrompt.get(version.parentId)?.name || '';
    const from = version.via === 'review' ? `Review "${version.reviewName}" of ${parentName}`
      : version.via === 'version' ? `New version of ${parentName}` : '';
    const lines = version.runs.length
      ? version.runs.flatMap((run) => (run.scores.length ? run.scores.map((score) => ({ run, score })) : [{ run, score: null }]))
      : [{ run: null, score: null }];
    return lines.map(({ run, score }, index) => {
      const m = score ? metrics.get(score.scoreId) : null;
      return {
        isVersionRow: index === 0,
        nodeIds: [version.promptId, run?.runId, score?.scoreId].filter(Boolean),
        tree: index === 0 ? version.treePrefix : version.treeContinuation,
        name: index === 0 ? version.name : '',
        from: index === 0 ? from : '',
        runId: run?.runId || '',
        run: run?.name || '',
        scoreId: score?.scoreId || '',
        score: score?.name || '',
        groundTruth: score?.groundTruthName || '',
        precision: m?.precision,
        recall: m?.recall,
        f1: m?.f1,
      };
    });
  });
}

export const FAMILY_SHEET_HEADERS = ['Version', 'From', 'Run', 'Score', 'Ground truth', 'Precision', 'Recall', 'F1'];

/** The table as spreadsheet rows: the tree guide is written into the Version text; metrics are fractions (0-1). */
export function familySheetRows(family, metrics) {
  const fraction = (value) => (Number.isFinite(value) ? value / 100 : '');
  return [FAMILY_SHEET_HEADERS, ...familyRows(family, metrics).map((row) => [
    `${row.tree}${row.name}`,
    row.from,
    row.runId ? row.run : 'Not run',
    row.scoreId ? row.score : (row.runId ? 'Not scored' : ''),
    row.groundTruth,
    row.scoreId ? fraction(row.precision) : '',
    row.scoreId ? fraction(row.recall) : '',
    row.scoreId ? fraction(row.f1) : '',
  ])];
}
