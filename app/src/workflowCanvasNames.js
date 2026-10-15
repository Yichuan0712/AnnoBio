export function createWorkflowCanvasNames(deps = {}) {
  const {
    nodesLayer,
    getNodeList,
    getConnections,
    getNodeById,
    EDGE_TYPE_PROMPT_TO_RUN,
    EDGE_TYPE_SCORE_TO_PROMPT_REVIEW,
  } = deps;

  function stripCopyOrVersionSuffix(name) {
    const s = (name || '').trim();
    const copyMatch = s.match(/^(.*)\s+\(Copy\s+\d+\)$/);
    if (copyMatch) return stripCopyOrVersionSuffix(copyMatch[1].trim());
    const versionMatch = s.match(/^(.*)\s+v(\d+)$/);
    if (versionMatch) return stripCopyOrVersionSuffix(versionMatch[1].trim());
    return s || 'Prompt';
  }

  function stripCopySuffixOnly(name) {
    const s = (name || '').trim();
    const copyMatch = s.match(/^(.*)\s+\(Copy\s+\d+\)$/);
    if (copyMatch) return stripCopySuffixOnly(copyMatch[1].trim());
    return s;
  }

  function stripVersionSuffixOnly(name) {
    const s = (name || '').trim();
    const versionMatch = s.match(/^(.*)\s+v(\d+)$/);
    if (versionMatch) return versionMatch[1].trim();
    return s;
  }

  function getConnectionsList() {
    return Array.isArray(getConnections?.()) ? getConnections() : [];
  }

  function isPromptNameAlreadyUsed(nameToCheck, excludeNodeId = null) {
    const normalized = (nameToCheck || '').trim().toLowerCase();
    const nodes = Array.isArray(getNodeList?.()) ? getNodeList() : [];
    for (const n of nodes) {
      if (excludeNodeId && n.dataset.nodeId === excludeNodeId) continue;
      const existing = (n.dataset.promptName || '').trim().toLowerCase();
      if (existing === normalized) return true;
    }
    return false;
  }

  function isDatasetNameAlreadyUsed(nameToCheck, excludeNodeId = null) {
    const normalized = (nameToCheck || '').trim().toLowerCase();
    const datasetNodes = nodesLayer.querySelectorAll('.workflow-node--dataset');
    for (const n of datasetNodes) {
      if (excludeNodeId && n.dataset.nodeId === excludeNodeId) continue;
      const existing = (n.dataset.datasetName || n.dataset.subsetName || '').trim().toLowerCase();
      if (existing === normalized) return true;
    }
    return false;
  }

  function findUniqueDatasetExportName(baseName) {
    const base = (baseName || '').trim() || 'Dataset';
    if (!isDatasetNameAlreadyUsed(base)) return base;
    let n = 1;
    let candidate;
    do {
      candidate = `${base} Copy ${n}`;
      n += 1;
    } while (isDatasetNameAlreadyUsed(candidate));
    return candidate;
  }

  function isSamplerNameAlreadyUsedForSource(nameToCheck, sourceNodeId, excludeNodeId = null) {
    const normalized = (nameToCheck || '').trim().toLowerCase();
    if (!normalized) return true;
    const samplerNodes = nodesLayer.querySelectorAll('.workflow-node--sampler');
    for (const n of samplerNodes) {
      if (n.dataset.sourceNodeId !== sourceNodeId) continue;
      if (excludeNodeId && n.dataset.nodeId === excludeNodeId) continue;
      const existing = (n.dataset.samplerName || '').trim().toLowerCase();
      if (existing === normalized) return true;
    }
    return false;
  }

  function getNextDefaultSamplerName(sourceNodeId) {
    if (!sourceNodeId) return 'Sample 1';
    let count = 0;
    nodesLayer.querySelectorAll('.workflow-node--sampler').forEach((n) => {
      if (n.dataset.sourceNodeId === sourceNodeId) count += 1;
    });
    return `Sample ${count + 1}`;
  }

  function findUniqueSamplerName(baseName, sourceNodeId) {
    const base = (baseName || '').trim() || 'Sample';
    if (!isSamplerNameAlreadyUsedForSource(base, sourceNodeId)) return base;
    let n = 2;
    let candidate = '';
    do {
      candidate = `${base} ${n}`;
      n += 1;
    } while (isSamplerNameAlreadyUsedForSource(candidate, sourceNodeId));
    return candidate;
  }

  function isRunNameAlreadyUsedForPromptNodeId(nameToCheck, promptNodeId, excludeRunNodeId = null) {
    const normalized = (nameToCheck || '').trim().toLowerCase();
    if (!normalized) return true;
    if (!promptNodeId) return false;
    const runEdges = getConnectionsList().filter((c) => c.fromId === promptNodeId && c.type === EDGE_TYPE_PROMPT_TO_RUN);
    for (const edge of runEdges) {
      if (edge.toId === excludeRunNodeId) continue;
      const runNode = getNodeById(edge.toId);
      const existing = (runNode?.dataset?.runName ?? runNode?.querySelector?.('.workflow-node__title')?.textContent ?? '').trim() || 'Run';
      if (existing.toLowerCase() === normalized) return true;
    }
    return false;
  }

  function findUniqueRunName(baseName, promptNodeId) {
    const base = (baseName || '').trim() || 'Run';
    if (!isRunNameAlreadyUsedForPromptNodeId(base, promptNodeId)) return base;
    let n = 2;
    let candidate = '';
    do {
      candidate = `${base} ${n}`;
      n += 1;
    } while (isRunNameAlreadyUsedForPromptNodeId(candidate, promptNodeId));
    return candidate;
  }

  function isReviewNameAlreadyUsedForScoreNodeId(nameToCheck, scoreNodeId, excludeReviewNodeId = null) {
    const normalized = (nameToCheck || '').trim().toLowerCase();
    if (!normalized) return true;
    if (!scoreNodeId) return false;
    const reviewEdges = getConnectionsList().filter((c) => c.fromId === scoreNodeId && c.type === EDGE_TYPE_SCORE_TO_PROMPT_REVIEW);
    for (const edge of reviewEdges) {
      if (edge.toId === excludeReviewNodeId) continue;
      const reviewNode = getNodeById(edge.toId);
      const existing = (
        reviewNode?.dataset?.promptReviewName
        ?? reviewNode?.querySelector?.('.workflow-node__title')?.textContent
        ?? ''
      ).trim() || 'Optimize';
      if (existing.toLowerCase() === normalized) return true;
    }
    return false;
  }

  function findUniqueReviewName(baseName, scoreNodeId) {
    const base = (baseName || '').trim() || 'Optimize';
    if (!isReviewNameAlreadyUsedForScoreNodeId(base, scoreNodeId)) return base;
    let n = 2;
    let candidate = '';
    do {
      candidate = `${base} ${n}`;
      n += 1;
    } while (isReviewNameAlreadyUsedForScoreNodeId(candidate, scoreNodeId));
    return candidate;
  }

  function findUniquePromptName(baseName, isNewVersion) {
    if (isNewVersion) {
      const raw = (baseName || '').trim() || 'Prompt';
      const versionBase = stripVersionSuffixOnly(raw).trim() || 'Prompt';
      const nodes = Array.isArray(getNodeList?.()) ? getNodeList() : [];
      let nextV = 2;
      const versionPrefix = versionBase + ' v';
      for (const n of nodes) {
        const name = (n.dataset.promptName || '').trim();
        const nBase = stripVersionSuffixOnly(name).trim();
        if (nBase !== versionBase) continue;
        if (name === versionBase) {
          nextV = Math.max(nextV, 2);
          continue;
        }
        if (!name.startsWith(versionPrefix)) continue;
        const numStr = name.slice(versionPrefix.length).trim();
        if (!/^\d+$/.test(numStr)) continue;
        const num = parseInt(numStr, 10);
        if (Number.isFinite(num) && num >= 1) nextV = Math.max(nextV, num + 1);
      }
      return `${versionBase} v${nextV}`;
    }
    const base = stripCopySuffixOnly(baseName || '').trim() || 'Prompt';
    let n = 1;
    let candidate;
    do {
      candidate = `${base} (Copy ${n})`;
      n += 1;
    } while (isPromptNameAlreadyUsed(candidate));
    return candidate;
  }

  function findUniqueWorkingDatasetName(baseName, isNewVersion) {
    const raw = (baseName || '').trim() || 'Dataset';
    const base = isNewVersion
      ? (stripCopyOrVersionSuffix(raw).trim() || 'Dataset')
      : (stripCopySuffixOnly(raw) || 'Dataset');
    let n = isNewVersion ? 2 : 1;
    let candidate;
    do {
      candidate = isNewVersion ? `${base} v${n}` : `${base} (Copy ${n})`;
      n += 1;
    } while (isDatasetNameAlreadyUsed(candidate));
    return candidate;
  }

  function findNextWorkingDatasetVersionName(baseName, excludeNodeId) {
    void excludeNodeId;
    const raw = (baseName || 'Dataset').trim() || 'Dataset';
    const versionBase = stripVersionSuffixOnly(raw).trim() || 'Dataset';
    const datasetNodes = nodesLayer.querySelectorAll('.workflow-node--dataset');
    let nextV = 2;
    const versionPrefix = versionBase + ' v';
    for (const n of datasetNodes) {
      const name = (n.dataset.datasetName || n.dataset.subsetName || '').trim();
      const nBase = stripVersionSuffixOnly(name).trim();
      if (nBase !== versionBase) continue;
      if (name === versionBase) {
        nextV = Math.max(nextV, 2);
        continue;
      }
      if (!name.startsWith(versionPrefix)) continue;
      const numStr = name.slice(versionPrefix.length).trim();
      if (!/^\d+$/.test(numStr)) continue;
      const num = parseInt(numStr, 10);
      if (Number.isFinite(num) && num >= 1) nextV = Math.max(nextV, num + 1);
    }
    return `${versionBase} v${nextV}`;
  }

  return {
    isPromptNameAlreadyUsed,
    isDatasetNameAlreadyUsed,
    findUniqueDatasetExportName,
    isSamplerNameAlreadyUsedForSource,
    getNextDefaultSamplerName,
    findUniqueSamplerName,
    isRunNameAlreadyUsedForPromptNodeId,
    findUniqueRunName,
    isReviewNameAlreadyUsedForScoreNodeId,
    findUniqueReviewName,
    findUniquePromptName,
    findUniqueWorkingDatasetName,
    findNextWorkingDatasetVersionName,
  };
}
