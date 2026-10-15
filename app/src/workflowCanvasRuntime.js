import {
  decideSuggestionAcceptance,
  reviewVerifyStateFromResult,
  verifyReviewSuggestion,
} from './reviewSuggestionActions.js';
import { rebuildWorkingFromApplied } from './reviewWorkingSections.js';
import {
  DEFAULT_LIMITS as PROMPT_EDIT_LIMITS,
  applyPromptNodeEdits,
  computeGlobalChangeRatio,
} from './promptNodeEdits.js';
import { applyScoreMappingEdits } from './scoreMappingEdits.js';
import { isScoreInputSideRuleKey } from './scoreRunGtPairing.js';
import { compileRows } from './runInputBuilder.js';
import { postRun } from './runClient.js';
import { getCurrentProjectId } from './currentProject.js';
import { imageCell } from './datasetContent.js';
import { runSettingsOverrides, reviewSettingsOverrides } from './nodeSettings.js';
import { datasetColorAt } from './workflowNodeColors.js';

export function createWorkflowCanvasRuntime(deps = {}) {
  const {
    extractInputFieldsFromSections,
    deriveOutputFields,
    getNextRowIndex,
    mergeResumeResults,
    embedInputRow,
    processApiResults,
    countCompletedInputRows,
    markEmptyOutputAsError,
    parseScoreMappingBundle,
    serializeScoreMappingBundle,
    flattenScoreRules,
    runReviewStart,
    RUN_API_BASE,
    NEW_NODE_OFFSET,
    getNodeById,
    getConnections,
    datasetContentByNodeId,
    readRunInputSource,
    readRunInput,
    readRunInputTable,
    createPromptNode,
    createScoreNode,
    createDatasetNode,
    createSamplerNode,
    createPromptReviewNode,
    updateContentSize,
    updateEdges,
    syncScoreNodeProgressFromUpstreamRun,
    setRunNodeProgress,
    setReviewNodeProgress,
    registerPendingRun,
    pendingRuns,
    pendingRunHistoryRecords,
    getHistorySession,
    getCanvasState,
    reconcileHistory,
    reconcileRunHistory,
    resolveRunCredentialId,
    resolveReviewCredentialId,
    pendingReviewNodeIds,
    pendingReviews,
    registerPendingReview,
    buildReviewComparisonRows,
    findUniquePromptName,
    isPromptNameAlreadyUsed,
    getPromptDataFromNode,
    findUniqueWorkingDatasetName,
    isDatasetNameAlreadyUsed,
    isSamplerNameAlreadyUsedForSource,
    getNextDefaultSamplerName,
    findUniqueSamplerName,
    findUniqueReviewName,
    escapeRegex,
    markNodeAsAgentCreated,
    emitCanvasChanged,
    emitRunResultsUpdated,
    emitSaveReviewResult,
    setNodeCanvasPosition,
  } = deps;

  function getConnectionsList() {
    return Array.isArray(getConnections?.()) ? getConnections() : [];
  }

  function ensureConnection(fromId, toId, type) {
    const normalizedFromId = String(fromId || '').trim();
    const normalizedToId = String(toId || '').trim();
    const normalizedType = String(type || '').trim();
    if (!normalizedFromId || !normalizedToId || !normalizedType) return false;
    const exists = getConnectionsList().some(
      (connection) => connection.fromId === normalizedFromId
        && connection.toId === normalizedToId
        && connection.type === normalizedType,
    );
    if (exists) return false;
    getConnectionsList().push({
      fromId: normalizedFromId,
      toId: normalizedToId,
      type: normalizedType,
    });
    return true;
  }

  function addPromptNode({
    name = '',
    note = '',
    sections = [],
    outputFormat,
    inputTypes,
    left,
    top,
    ensureUniqueName = true,
    agentCreated = false,
  } = {}) {
    const requestedName = (name || '').trim() || 'Prompt';
    const finalName = ensureUniqueName && isPromptNameAlreadyUsed(requestedName)
      ? findUniquePromptName(requestedName, false)
      : requestedName;
    const node = createPromptNode({
      name: finalName,
      note: String(note || ''),
      sections: Array.isArray(sections) ? sections : [],
      outputFormat,
      inputTypes,
      left,
      top,
    });
    if (agentCreated && typeof markNodeAsAgentCreated === 'function') {
      markNodeAsAgentCreated(node);
    }
    updateContentSize();
    updateEdges();
    emitCanvasChanged();
    const data = getPromptDataFromNode(node) || {};
    return {
      created: true,
      nodeId: String(node?.dataset?.nodeId || '').trim(),
      name: String(data?.name || finalName).trim() || finalName,
      note: String(data?.note || ''),
      sections: Array.isArray(data?.sections) ? data.sections : [],
      outputFormat: data?.outputFormat && typeof data.outputFormat === 'object'
        ? data.outputFormat
        : { returnShape: 'single', fields: [] },
      position: {
        left: Number.parseFloat(node?.style?.left || '') || 0,
        top: Number.parseFloat(node?.style?.top || '') || 0,
      },
      nameWasAdjusted: finalName !== requestedName,
      requestedName,
    };
  }

  function addPromptVersion({
    promptNodeId = '',
    name = '',
    note,
    edits,
    left,
    top,
    ensureUniqueName = true,
  } = {}) {
    const normalizedPromptNodeId = String(promptNodeId || '').trim();
    if (!normalizedPromptNodeId) {
      throw new Error('Prompt node id is required.');
    }
    const promptNode = getNodeById(normalizedPromptNodeId);
    if (!promptNode || !promptNode.classList.contains('workflow-node--prompt')) {
      throw new Error('Prompt node was not found.');
    }

    const sourcePromptData = getPromptDataFromNode(promptNode) || {};
    const baseData = {
      sections: Array.isArray(sourcePromptData?.sections) ? sourcePromptData.sections : [],
      outputFormat: sourcePromptData?.outputFormat && typeof sourcePromptData.outputFormat === 'object'
        ? sourcePromptData.outputFormat
        : { returnShape: 'single', fields: [] },
    };

    const editsRequested = edits != null;
    const editList = Array.isArray(edits) ? edits : (editsRequested ? edits : []);
    const editResult = applyPromptNodeEdits(baseData, editList);
    const nextData = editResult.state;
    const editWarnings = Array.isArray(editResult.warnings) ? editResult.warnings.slice() : [];

    if (editsRequested && Array.isArray(edits) && edits.length > 0) {
      const globalDiff = computeGlobalChangeRatio(baseData, nextData);
      if (globalDiff.ratio > PROMPT_EDIT_LIMITS.globalChangeRatio) {
        const error = new Error(
          `add_prompt_version refused: cumulative change ratio ${(globalDiff.ratio * 100).toFixed(0)}% across all edits exceeds the ${(PROMPT_EDIT_LIMITS.globalChangeRatio * 100).toFixed(0)}% limit. Reduce the number or scope of edits, split into multiple smaller versions, or use create_prompt_node for a from-scratch rewrite.`,
        );
        error.name = 'PromptEditError';
        error.reason = 'global_change_ratio_exceeded';
        error.changeRatio = Number(globalDiff.ratio.toFixed(4));
        error.limit = Number(PROMPT_EDIT_LIMITS.globalChangeRatio.toFixed(4));
        error.beforeChars = globalDiff.beforeChars;
        error.afterChars = globalDiff.afterChars;
        throw error;
      }
    }

    const requestedName = String(name || '').trim()
      || String(sourcePromptData?.name || '').trim()
      || 'Prompt';
    const finalName = ensureUniqueName
      ? findUniquePromptName(requestedName, true)
      : requestedName;
    const resolvedLeft = typeof left === 'number'
      ? left
      : (parseFloat(promptNode.style.left) || 0) + (promptNode.offsetWidth || 280) + NEW_NODE_OFFSET;
    const resolvedTop = typeof top === 'number' ? top : (parseFloat(promptNode.style.top) || 0);

    const created = addPromptNode({
      name: finalName,
      note: note != null ? String(note) : String(sourcePromptData?.note || ''),
      sections: nextData.sections,
      outputFormat: nextData.outputFormat,
      left: resolvedLeft,
      top: resolvedTop,
      ensureUniqueName: false,
      agentCreated: true,
    });

    if (created?.nodeId && ensureConnection(normalizedPromptNodeId, created.nodeId, 'prompt-to-prompt')) {
      updateEdges();
      emitCanvasChanged();
    }

    return {
      ...created,
      sourcePromptNodeId: normalizedPromptNodeId,
      promptNodeId: created?.nodeId || '',
      requestedName,
      nameWasAdjusted: finalName !== requestedName,
      createdAsVersion: true,
      editsApplied: editsRequested ? editList.length : 0,
      editWarnings,
    };
  }

  async function applyReviewSuggestions({
    reviewNodeId = '',
    scoreNodeId = '',
    sections,
    name = '',
    left,
    top,
    ensureUniqueName = true,
    agentCreated = false,
  } = {}) {
    const normalizedReviewNodeId = String(reviewNodeId || '').trim();
    const normalizedScoreNodeId = String(scoreNodeId || '').trim();
    let refNode = normalizedReviewNodeId ? getNodeById(normalizedReviewNodeId) : null;
    if (!refNode && normalizedScoreNodeId) {
      const reviewEdge = getConnectionsList().find(
        (connection) => connection.fromId === normalizedScoreNodeId && connection.type === 'score-to-prompt-review',
      );
      refNode = reviewEdge ? getNodeById(reviewEdge.toId) : null;
    }

    let scoreNode = null;
    if (refNode) {
      const scoreEdge = getConnectionsList().find(
        (connection) => connection.toId === refNode.dataset.nodeId && connection.type === 'score-to-prompt-review',
      );
      scoreNode = scoreEdge ? getNodeById(scoreEdge.fromId) : null;
    } else if (normalizedScoreNodeId) {
      scoreNode = getNodeById(normalizedScoreNodeId);
    }

    let sourcePromptNode = null;
    let sourcePromptData = null;
    if (scoreNode) {
      const runEdge = getConnectionsList().find(
        (connection) => connection.toId === scoreNode.dataset.nodeId && connection.type === 'run-to-score',
      );
      const runNode = runEdge ? getNodeById(runEdge.fromId) : null;
      const promptEdge = runNode
        ? getConnectionsList().find(
          (connection) => connection.toId === runNode.dataset.nodeId && connection.type === 'prompt-to-run',
        )
        : null;
      sourcePromptNode = promptEdge ? getNodeById(promptEdge.fromId) : null;
      if (sourcePromptNode?.classList?.contains('workflow-node--prompt')) {
        sourcePromptData = getPromptDataFromNode(sourcePromptNode);
      }
    }

    let resolvedSections = Array.isArray(sections)
      ? sections.map((section) => ({ name: section?.name || '', content: section?.content || '' }))
      : [];
    if (resolvedSections.length === 0 && normalizedReviewNodeId) {
      const reviewNode = getReviewNodeById(normalizedReviewNodeId);
      const reviewResult = parseReviewResult(reviewNode) || parseReviewResult(scoreNode) || {};
      resolvedSections = Array.isArray(reviewResult?.workingSections) && reviewResult.workingSections.length > 0
        ? reviewResult.workingSections.map((section) => ({ name: section?.name || '', content: section?.content || '' }))
        : (Array.isArray(reviewResult?.promptSections) ? reviewResult.promptSections : [])
          .map((section) => ({ name: section?.name || '', content: section?.content || '' }));
    }
    if (resolvedSections.length === 0) {
      throw new Error('Optimize has no prompt sections to apply.');
    }

    const requestedName = String(name || '').trim()
      || String(sourcePromptData?.name || '').trim()
      || 'Prompt (from Optimize)';
    const finalName = ensureUniqueName
      ? findUniquePromptName(requestedName, true)
      : requestedName;

    const refLeft = refNode ? (parseFloat(refNode.style.left) || 0) : 0;
    const refWidth = refNode ? (refNode.offsetWidth || 280) : 280;
    const refTop = refNode ? (parseFloat(refNode.style.top) || 0) : 0;
    const resolvedLeft = typeof left === 'number' ? left : (refNode ? refLeft + refWidth + NEW_NODE_OFFSET : undefined);
    const resolvedTop = typeof top === 'number' ? top : (refNode ? refTop : undefined);

    const created = addPromptNode({
      name: finalName,
      note: 'Exported from Optimize.',
      sections: resolvedSections,
      outputFormat: sourcePromptData?.outputFormat || undefined,
      inputTypes: sourcePromptData?.inputTypes || {},
      left: resolvedLeft,
      top: resolvedTop,
      ensureUniqueName: false,
      agentCreated,
    });
    const newNode = created?.nodeId ? getNodeById(created.nodeId) : null;

    let connectionChanged = false;
    if (refNode && newNode?.dataset?.nodeId) {
      const refHeight = refNode.offsetHeight || 80;
      const newHeight = newNode.offsetHeight || 80;
      if (typeof setNodeCanvasPosition === 'function') {
        setNodeCanvasPosition(
          newNode,
          parseFloat(newNode.style.left) || 0,
          refTop + refHeight / 2 - newHeight / 2,
        );
      }
      connectionChanged = ensureConnection(refNode.dataset.nodeId, newNode.dataset.nodeId, 'prompt-review-to-prompt') || connectionChanged;
    }

    if (connectionChanged) {
      updateEdges();
      updateContentSize();
      emitCanvasChanged();
    }

    return {
      ...created,
      reviewNodeId: normalizedReviewNodeId,
      scoreNodeId: String(scoreNode?.dataset?.nodeId || normalizedScoreNodeId).trim(),
      sourcePromptNodeId: String(sourcePromptNode?.dataset?.nodeId || '').trim(),
      sections: resolvedSections,
      applied: true,
    };
  }

  async function startRunNode({
    runNodeId = '',
  } = {}) {
    const normalizedRunNodeId = String(runNodeId || '').trim();
    if (!normalizedRunNodeId) {
      throw new Error('Run node id is required.');
    }
    const node = getNodeById(normalizedRunNodeId);
    if (!node || !node.classList.contains('workflow-node--run')) {
      throw new Error('Run node was not found.');
    }

    const existingPendingRunId = pendingRuns.get(normalizedRunNodeId) || null;
    if (existingPendingRunId) {
      return {
        started: true,
        alreadyRunning: true,
        waitRequired: true,
        runNodeId: normalizedRunNodeId,
        runId: existingPendingRunId,
      };
    }

    const historySession = getHistorySession?.();
    if (historySession) {
      const sync = await reconcileRunHistory(normalizedRunNodeId);
      if (!sync) throw new Error('Project changed while preparing Run history. Try again.');
    }
    const rerunCompleted = !!historySession && node.dataset.runCompleted === '1';

    const connections = getConnectionsList();
    const promptEdge = connections.find((c) => c.toId === normalizedRunNodeId && c.type === 'prompt-to-run');
    const promptNode = promptEdge ? getNodeById(promptEdge.fromId) : null;
    if (!promptNode) {
      throw new Error('This run node is not connected to an upstream prompt.');
    }

    // The input's table, or why it has none yet: a Dataset, or another step's complete result (stepOutputs.js).
    const input = readRunInput(node);
    if (!input.source) {
      throw new Error('This run node has no selected input dataset.');
    }
    if (input.waiting) throw new Error(input.message);
    let existingResults = [];
    if (!rerunCompleted) {
      try {
        existingResults = JSON.parse(node.dataset.runResults || '[]');
        if (!Array.isArray(existingResults)) existingResults = [];
      } catch (_) {
        existingResults = [];
      }
    }
    let content = input.table;
    if (existingResults.length > 0 && node.dataset.runInputContent) {
      try { content = JSON.parse(node.dataset.runInputContent); } catch (_) {}
    }
    const headers = Array.isArray(content?.headers) ? content.headers.slice() : [];
    const rows = Array.isArray(content?.rows) ? content.rows.map((row) => (Array.isArray(row) ? row.slice() : [])) : [];

    let sections = [];
    try {
      sections = JSON.parse(promptNode.dataset.promptSections || promptNode.dataset.promptFields || '[]');
    } catch (_) {}
    const templateText = (Array.isArray(sections) ? sections : [])
      .map((section) => String(section?.content || '').trim())
      .filter(Boolean)
      .join('\n\n');
    if (!templateText) {
      throw new Error('Prompt has no content.');
    }

    let outputFields = [];
    try {
      outputFields = JSON.parse(promptNode.dataset.promptOutputFormat || '[]');
    } catch (_) {}
    if (!Array.isArray(outputFields)) outputFields = [];
    const outputSchema = {
      return_shape: promptNode.dataset.promptOutputReturnShape || 'single',
      fields: outputFields.map((field) => ({
        key: field?.key,
        type: field?.type || 'str',
        description: field?.description,
        allow_none: field?.allowNone ?? field?.allow_none ?? false,
      })),
    };
    if (!outputSchema.fields.length) {
      throw new Error('Prompt output schema has no fields.');
    }

    let runInputToColumn = {};
    try {
      const raw = node.dataset.runInputToColumn || '{}';
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) runInputToColumn = parsed;
    } catch (_) {}
    const inputFields = extractInputFieldsFromSections(Array.isArray(sections) ? sections : []);
    const unmapped = inputFields.filter((name) => !String(runInputToColumn[name] || '').trim());
    if (unmapped.length > 0) {
      throw new Error(`Please map all prompt inputs. Unmapped: ${unmapped.join(', ')}`);
    }

    if (rows.length === 0) {
      // There are no model calls to make, but the empty Run is still a completed result for
      // this exact input and must be addressable by downstream History and Process nodes.
      const historyRecord = historySession ? (await historySession.reserve(getCanvasState(), normalizedRunNodeId)).record : null;
      if (historyRecord) node.dataset.historyRecordId = historyRecord.id;
      const runInputContent = { headers, columnTypes: content?.columnTypes || [], rowIds: content?.rowIds || [], rows: [] };
      if (historyRecord) await historySession.putRecord({
        ...historyRecord, status: 'completed', updatedAt: new Date().toISOString(),
        results: { runResults: [], runInputContent, runOutputFields: [], runProgress: 100 },
        summary: { ...historyRecord.summary, rowCount: 0, errorCount: 0 },
      });
      node.dataset.runInputContent = JSON.stringify(runInputContent);
      node.dataset.runResults = '[]';
      node.dataset.runOutputFields = '[]';
      node.dataset.runCompleted = '1';
      delete node.dataset.runResumable;
      node.dataset.runProgress = '100';
      setRunNodeProgress(node, 1, 1);
      emitRunResultsUpdated({ nodeId: normalizedRunNodeId, results: [], isComplete: true });
      emitCanvasChanged();
      return { started: true, completed: true, waitRequired: false, runNodeId: normalizedRunNodeId, runId: null, resultsCount: 0 };
    }

    const credentialId = await resolveRunCredentialId(node);
    if (!credentialId) {
      throw new Error('This run node has no selected credential.');
    }

    const nextRowIndex = getNextRowIndex(existingResults, rows.length);
    const rowsToRun = rows.slice(nextRowIndex);
    if (rowsToRun.length === 0) {
      if (existingResults.length > 0) {
        node.dataset.runCompleted = '1';
        delete node.dataset.runResumable;
        setRunNodeProgress(node, rows.length, rows.length);
        emitRunResultsUpdated({
          nodeId: normalizedRunNodeId,
          results: existingResults,
          isComplete: true,
        });
        emitCanvasChanged();
      }
      return {
        started: false,
        alreadyComplete: true,
        waitRequired: false,
        runNodeId: normalizedRunNodeId,
        runId: null,
        resultsCount: existingResults.length,
      };
    }

    let inputTypes = {};
    try { inputTypes = JSON.parse(promptNode.dataset.promptInputTypes || '{}'); } catch (_) {}
    const samples = compileRows(templateText, headers, rowsToRun, runInputToColumn, inputTypes);
    let historyRecord = historySession ? (await historySession.reserve(getCanvasState(), normalizedRunNodeId)).record : null;
    if (historyRecord) node.dataset.historyRecordId = historyRecord.id;
    if (historyRecord) {
      let model = credentialId;
      try {
        const response = await fetch(`${RUN_API_BASE}/api/credentials`);
        const credentials = response.ok ? await response.json() : [];
        const selected = Array.isArray(credentials) ? credentials.find((item) => item.id === credentialId) : null;
        model = selected?.model || selected?.llm || credentialId;
      } catch (_) { /* the credential ID still identifies the model if its label is unavailable */ }
      historyRecord = {
        ...historyRecord, credentialId, model,
        summary: { ...historyRecord.summary, model },
      };
      await historySession.putRecord(historyRecord);
    }
    if (historyRecord) pendingRunHistoryRecords.set(normalizedRunNodeId, historyRecord);

    if (rerunCompleted) {
      node.dataset.runResults = '[]';
      node.dataset.runOutputFields = '[]';
      delete node.dataset.runCompleted;
      delete node.dataset.runInputContent;
      setRunNodeProgress(node, 0, rows.length);
      if (historySession) await reconcileHistory();
    }

    node.dataset.runInputContent = JSON.stringify({ headers, columnTypes: content?.columnTypes || [], rowIds: content?.rowIds || [], rows });
    delete node.dataset.runResumable;
    if (nextRowIndex === 0) {
      if (existingResults.length === 0) {
        node.dataset.runResults = JSON.stringify([]);
      }
      node.dataset.runCompleted = '';
      setRunNodeProgress(node, 0, rows.length);
      delete node.dataset.runResumeStartIndex;
      delete node.dataset.runResumeExistingResults;
      delete node.dataset.runResumeTotalRows;
    } else {
      node.dataset.runResumeStartIndex = String(nextRowIndex);
      node.dataset.runResumeExistingResults = node.dataset.runResults || '[]';
      node.dataset.runResumeTotalRows = String(rows.length);
    }
    emitCanvasChanged();

    let response;
    let data;
    try {
      response = await postRun({
          credential_id: credentialId,
          samples,
          output_schema: outputSchema,
          run_node_id: normalizedRunNodeId,
          settings_overrides: runSettingsOverrides(node),
      }, undefined, undefined, getCurrentProjectId());
      data = await response.json().catch(() => ({}));
    } catch (error) {
      if (historyRecord) {
        historyRecord = { ...historyRecord, status: 'failed', updatedAt: new Date().toISOString(), error: String(error?.message || error) };
        await historySession.putRecord(historyRecord);
        pendingRunHistoryRecords.delete(normalizedRunNodeId);
      }
      throw error;
    }

    if (response.status === 202) {
      const runId = String(data?.run_id || '').trim();
      if (!runId) {
        if (historyRecord) {
          await historySession.putRecord({ ...historyRecord, status: 'failed', updatedAt: new Date().toISOString(), error: 'Backend did not return a Run job ID.' });
          pendingRunHistoryRecords.delete(normalizedRunNodeId);
        }
        throw new Error('Run started but no run id was returned by the backend.');
      }
      registerPendingRun(normalizedRunNodeId, runId);
      if (historyRecord) {
        historyRecord = { ...historyRecord, backendJobId: runId, updatedAt: new Date().toISOString() };
        try {
          await historySession.putRecord(historyRecord);
        } catch (error) {
          await fetch(`${RUN_API_BASE}/api/run/cancel/${runId}`, { method: 'POST' }).catch(() => {});
          throw new Error(`Run was stopped because its history job ID could not be saved: ${error?.message || error}`);
        }
        pendingRunHistoryRecords.set(normalizedRunNodeId, historyRecord);
      }
      return {
        started: true,
        waitRequired: true,
        runNodeId: normalizedRunNodeId,
        runId: runId || null,
        resultsCount: existingResults.length,
      };
    }

    if (!response.ok) {
      if (nextRowIndex > 0) {
        delete node.dataset.runResumeStartIndex;
        delete node.dataset.runResumeExistingResults;
        delete node.dataset.runResumeTotalRows;
      }
      if (historyRecord) {
        historyRecord = { ...historyRecord, status: 'failed', updatedAt: new Date().toISOString(), error: String(data?.detail || response.statusText || 'Request failed') };
        await historySession.putRecord(historyRecord);
        pendingRunHistoryRecords.delete(normalizedRunNodeId);
      }
      throw new Error(String(data?.detail || response.statusText || 'Request failed'));
    }

    let results = Array.isArray(data?.results) ? data.results : [];
    const returnedOutputFields = Array.isArray(data?.output_fields) ? data.output_fields : [];
    const runContent = { headers, rows };
    if (nextRowIndex > 0) {
      results = mergeResumeResults(existingResults, results, nextRowIndex, runContent);
      delete node.dataset.runResumeStartIndex;
      delete node.dataset.runResumeExistingResults;
      delete node.dataset.runResumeTotalRows;
    } else {
      results = processApiResults(results, runContent);
    }
    results = markEmptyOutputAsError(results);
    node.dataset.runResults = JSON.stringify(results);
    node.dataset.runCompleted = '1';
    delete node.dataset.runResumable;
    setRunNodeProgress(node, rows.length, rows.length);
    if (historyRecord) {
      historyRecord = {
        ...historyRecord, status: 'completed', updatedAt: new Date().toISOString(),
        summary: { ...historyRecord.summary, errorCount: results.filter((item) => item?.error).length },
        results: { runResults: results, runInputContent: JSON.parse(node.dataset.runInputContent), runOutputFields: returnedOutputFields, runProgress: 100 },
      };
      await historySession.putRecord(historyRecord);
      pendingRunHistoryRecords.delete(normalizedRunNodeId);
    }
    emitRunResultsUpdated({
      nodeId: normalizedRunNodeId,
      results,
      outputFields: returnedOutputFields,
      isComplete: true,
    });
    emitCanvasChanged();
    return {
      started: true,
      completed: true,
      waitRequired: false,
      runNodeId: normalizedRunNodeId,
      runId: null,
      resultsCount: results.length,
    };
  }

  function addScoreNode({
    runNodeId = '',
    groundTruthNodeId = '',
    scoreMapping = null,
    matchCode = null,
    activeMatchMode = null,
    reviewCredentialId = '',
    name = '',
    left,
    top,
  } = {}) {
    const normalizedRunNodeId = String(runNodeId || '').trim();
    const normalizedGroundTruthNodeId = String(groundTruthNodeId || '').trim();
    if (!normalizedRunNodeId) {
      throw new Error('Run node id is required.');
    }
    if (!normalizedGroundTruthNodeId) {
      throw new Error('Ground-truth dataset node id is required.');
    }
    const runNode = getNodeById(normalizedRunNodeId);
    if (!runNode || !runNode.classList.contains('workflow-node--run')) {
      throw new Error('Run node was not found.');
    }
    const groundTruthNode = getNodeById(normalizedGroundTruthNodeId);
    if (!groundTruthNode || !groundTruthNode.classList.contains('workflow-node--dataset')) {
      throw new Error('Ground-truth dataset node was not found.');
    }

    const mappingRaw = scoreMapping == null
      ? ''
      : (typeof scoreMapping === 'string' ? scoreMapping : JSON.stringify(scoreMapping));
    const { inputRoot, outputRoot } = parseScoreMappingBundle(mappingRaw);
    const rules = [...flattenScoreRules(inputRoot), ...flattenScoreRules(outputRoot)];
    const hasRules = rules.some((rule) => (rule.outputKey || '').trim() && Array.isArray(rule.gtColumns) && rule.gtColumns.some((column) => String(column || '').trim()));
    const normalizedMatchCode = matchCode != null ? String(matchCode).trim() : '';
    if (!hasRules && !normalizedMatchCode) {
      throw new Error('Evaluate mapping must include at least one rule, or provide match code for an Evaluate node using Match by code.');
    }
    const resolvedActiveMatchMode = (activeMatchMode === 'rules' || activeMatchMode === 'code')
      ? activeMatchMode
      : (normalizedMatchCode ? 'code' : 'rules');

    const requestedName = (name || '').trim() || 'Evaluate';
    const resolvedLeft = typeof left === 'number'
      ? left
      : (parseFloat(runNode.style.left) || 0) + (runNode.offsetWidth || 280) + NEW_NODE_OFFSET;
    const resolvedTop = typeof top === 'number' ? top : (parseFloat(runNode.style.top) || 0);
    const scoreNode = createScoreNode({
      left: resolvedLeft,
      top: resolvedTop,
      title: requestedName,
    });
    if (typeof markNodeAsAgentCreated === 'function') markNodeAsAgentCreated(scoreNode);
    if (scoreNode?.dataset) {
      scoreNode.dataset.scoreGroundTruthId = normalizedGroundTruthNodeId;
      scoreNode.dataset.scoreMapping = serializeScoreMappingBundle(inputRoot, outputRoot);
      if (normalizedMatchCode) {
        scoreNode.dataset.scoreMatchCode = normalizedMatchCode;
      }
      if (resolvedActiveMatchMode === 'code') {
        scoreNode.dataset.scoreActiveMatchMode = 'code';
      }
      if (reviewCredentialId) {
        scoreNode.dataset.reviewCredentialId = String(reviewCredentialId).trim();
      } else {
        delete scoreNode.dataset.reviewCredentialId;
      }
      const colorIndex = groundTruthNode.dataset.datasetColorIndex != null ? parseInt(groundTruthNode.dataset.datasetColorIndex, 10) : 0;
      const color = datasetColorAt(colorIndex);
      scoreNode.style.borderColor = color;
      const progressBar = scoreNode.querySelector('.workflow-node__score-progress');
      if (progressBar) progressBar.style.background = color;
    }
    if (scoreNode?.dataset?.nodeId) {
      getConnectionsList().push({
        fromId: normalizedRunNodeId,
        toId: scoreNode.dataset.nodeId,
        type: 'run-to-score',
      });
      updateEdges();
      syncScoreNodeProgressFromUpstreamRun(scoreNode);
    }
    updateContentSize();
    emitCanvasChanged();
    return {
      created: true,
      nodeId: String(scoreNode?.dataset?.nodeId || '').trim(),
      runNodeId: normalizedRunNodeId,
      groundTruthNodeId: normalizedGroundTruthNodeId,
      name: requestedName,
      reviewCredentialId: String(scoreNode?.dataset?.reviewCredentialId || '').trim(),
      scoreMapping: JSON.parse(serializeScoreMappingBundle(inputRoot, outputRoot)),
      ruleCount: rules.length,
      matchCode: normalizedMatchCode || null,
      activeMatchMode: scoreNode?.dataset?.scoreActiveMatchMode === 'code' ? 'code' : 'rules',
      position: {
        left: Number.parseFloat(scoreNode?.style?.left || '') || 0,
        top: Number.parseFloat(scoreNode?.style?.top || '') || 0,
      },
      requestedName,
    };
  }

  function buildEditError(message, extra = {}) {
    const error = new Error(message);
    error.name = 'ScoreMappingEditError';
    Object.assign(error, extra);
    return error;
  }

  function readDatasetHeaders(datasetNodeId) {
    const id = String(datasetNodeId || '').trim();
    if (!id) return [];
    const content = datasetContentByNodeId.get(id);
    if (!content || !Array.isArray(content.headers)) return [];
    return content.headers.map((h) => String(h ?? '').trim()).filter(Boolean);
  }

  function getScoreUpstreamHeaders(scoreNode) {
    const connections = getConnectionsList();
    const runEdge = connections.find(
      (c) => c.toId === scoreNode.dataset.nodeId && c.type === 'run-to-score',
    );
    const runNode = runEdge ? getNodeById(runEdge.fromId) : null;
    let runInputHeaders = [];
    if (runNode) {
      runInputHeaders = readDatasetHeaders(readRunInputSource(runNode)?.nodeId || '');
    }

    const groundTruthNodeId = String(scoreNode.dataset.scoreGroundTruthId || '').trim();
    const groundTruthHeaders = readDatasetHeaders(groundTruthNodeId);
    return { runInputHeaders, groundTruthHeaders };
  }

  function validateMappingAgainstHeaders(inputRoot, outputRoot, runInputHeaders, groundTruthHeaders) {
    const inputRules = flattenScoreRules(inputRoot);
    const outputRules = flattenScoreRules(outputRoot);
    const allRules = [...inputRules, ...outputRules];

    if (groundTruthHeaders.length > 0) {
      const headerSet = new Set(groundTruthHeaders);
      const unknown = [...new Set(
        allRules
          .flatMap((rule) => (Array.isArray(rule?.gtColumns) ? rule.gtColumns : []))
          .map((column) => String(column || '').trim())
          .filter((column) => column && column !== '__score_gt_row_index__' && !headerSet.has(column)),
      )];
      if (unknown.length > 0) {
        throw buildEditError(
          `Evaluate mapping references ground-truth columns not in the upstream dataset: ${unknown.join(', ')}.`,
          {
            reason: 'unknown_gt_columns',
            unknown_gt_columns: unknown,
            available_gt_headers: groundTruthHeaders,
          },
        );
      }
    }

    if (runInputHeaders.length > 0) {
      const headerSet = new Set(runInputHeaders);
      const unknown = [...new Set(
        inputRules
          .map((rule) => String(rule?.outputKey || '').trim())
          .filter(Boolean)
          .filter((outputKey) => isScoreInputSideRuleKey(outputKey))
          .map((outputKey) => {
            if (outputKey === '#' || outputKey === '[#]') return '#';
            if (outputKey.startsWith('[') && outputKey.endsWith(']')) {
              return outputKey.slice(1, -1).trim();
            }
            return '';
          })
          .filter((header) => header && header !== '#' && !headerSet.has(header)),
      )];
      if (unknown.length > 0) {
        throw buildEditError(
          `Input-side rules reference run input columns not in the upstream dataset: ${unknown.join(', ')}.`,
          {
            reason: 'unknown_run_input_columns',
            unknown_input_columns: unknown,
            available_input_headers: runInputHeaders,
          },
        );
      }
    }
  }

  function updateScoreNode({
    scoreNodeId = '',
    edits,
  } = {}) {
    const normalizedScoreNodeId = String(scoreNodeId || '').trim();
    if (!normalizedScoreNodeId) {
      throw new Error('Evaluate node id is required.');
    }
    const scoreNode = getNodeById(normalizedScoreNodeId);
    if (!scoreNode || !scoreNode.classList.contains('workflow-node--score')) {
      throw new Error('Evaluate node was not found.');
    }
    if (scoreNode.dataset.nodeOrigin !== 'agent') {
      throw buildEditError(
        `update_score_node refused: Evaluate node ${normalizedScoreNodeId} was not created by the agent. The agent can only update its own Evaluate nodes; tell the user to edit this one manually in the Evaluate detail UI.`,
        { reason: 'not_agent_created', score_node_id: normalizedScoreNodeId },
      );
    }
    if (!Array.isArray(edits)) {
      throw buildEditError(
        `update_score_node requires an "edits" array.`,
        { reason: 'edits_not_array' },
      );
    }
    if (edits.length === 0) {
      throw buildEditError(
        `update_score_node requires at least one edit op (add_rule | remove_rule | modify_rule | set_match_code | set_match_mode).`,
        { reason: 'edits_empty' },
      );
    }

    const matchCodeOps = edits.filter((edit) => edit && (edit.op === 'set_match_code' || edit.op === 'set_match_mode'));
    const ruleEdits = edits.filter((edit) => !(edit && (edit.op === 'set_match_code' || edit.op === 'set_match_mode')));

    const mappingRaw = String(scoreNode.dataset.scoreMapping || '');
    const { inputRoot: beforeInputRoot, outputRoot: beforeOutputRoot } = parseScoreMappingBundle(mappingRaw);

    const editResult = applyScoreMappingEdits(
      { inputRoot: beforeInputRoot, outputRoot: beforeOutputRoot },
      ruleEdits,
    );
    const { inputRoot: nextInputRoot, outputRoot: nextOutputRoot } = editResult.state;
    const editWarnings = Array.isArray(editResult.warnings) ? editResult.warnings.slice() : [];

    if (ruleEdits.length > 0) {
      const { runInputHeaders, groundTruthHeaders } = getScoreUpstreamHeaders(scoreNode);
      validateMappingAgainstHeaders(nextInputRoot, nextOutputRoot, runInputHeaders, groundTruthHeaders);
    }

    let nextActiveMatchMode = scoreNode.dataset.scoreActiveMatchMode === 'code' ? 'code' : 'rules';
    let nextMatchCode = String(scoreNode.dataset.scoreMatchCode || '');
    let matchCodeChanged = false;
    for (const op of matchCodeOps) {
      if (op.op === 'set_match_code') {
        const code = String(op?.code ?? '').trim();
        if (!code) {
          throw buildEditError(
            `set_match_code requires a non-empty "code" string.`,
            { reason: 'empty_match_code' },
          );
        }
        nextMatchCode = code;
        nextActiveMatchMode = 'code';
        matchCodeChanged = true;
      } else if (op.op === 'set_match_mode') {
        const mode = String(op?.mode ?? '').trim();
        if (mode !== 'rules' && mode !== 'code') {
          throw buildEditError(
            `set_match_mode requires "mode" to be "rules" or "code".`,
            { reason: 'invalid_match_mode' },
          );
        }
        nextActiveMatchMode = mode;
      } else {
        throw buildEditError(
          `Unknown op "${String(op?.op || 'unset')}". Supported match-mode ops: set_match_code, set_match_mode.`,
          { reason: 'unknown_op' },
        );
      }
    }

    const allRules = [...flattenScoreRules(nextInputRoot), ...flattenScoreRules(nextOutputRoot)];
    const hasNonEmptyRule = allRules.some((rule) => (
      String(rule?.outputKey || '').trim()
      && Array.isArray(rule?.gtColumns)
      && rule.gtColumns.some((column) => String(column || '').trim())
    ));
    if (nextActiveMatchMode !== 'code' && !hasNonEmptyRule) {
      throw buildEditError(
        `update_score_node refused: the score mapping has no usable rules while active mode is "rules" (every rule needs a non-empty outputKey and at least one gtColumn). Add rules first, or switch active mode to "code" if match code is set.`,
        { reason: 'no_usable_rule' },
      );
    }

    scoreNode.dataset.scoreMapping = serializeScoreMappingBundle(nextInputRoot, nextOutputRoot);
    if (matchCodeChanged) {
      scoreNode.dataset.scoreMatchCode = nextMatchCode;
    }
    if (matchCodeOps.length > 0) {
      scoreNode.dataset.scoreActiveMatchMode = nextActiveMatchMode;
    }

    updateEdges();
    emitCanvasChanged();

    return {
      updated: true,
      scoreNodeId: normalizedScoreNodeId,
      editsApplied: edits.length,
      ruleCount: allRules.length,
      inputRuleCount: flattenScoreRules(nextInputRoot).length,
      outputRuleCount: flattenScoreRules(nextOutputRoot).length,
      scoreMapping: JSON.parse(serializeScoreMappingBundle(nextInputRoot, nextOutputRoot)),
      activeMatchMode: nextActiveMatchMode,
      matchCodeChanged,
      invalidated: {
        scoreComparisonRows: false,
        downstreamReviewNodeIds: [],
      },
      editWarnings,
    };
  }

  function getScoreComparisonContext(scoreNode) {
    if (!scoreNode || !scoreNode.classList.contains('workflow-node--score')) return null;
    const connections = getConnectionsList();
    const runEdge = connections.find(
      (c) => c.toId === scoreNode.dataset.nodeId && c.type === 'run-to-score',
    );
    const runNode = runEdge ? getNodeById(runEdge.fromId) : null;
    if (!runNode || !runNode.classList.contains('workflow-node--run')) return null;
    const promptEdge = connections.find(
      (c) => c.toId === runNode.dataset.nodeId && c.type === 'prompt-to-run',
    );
    const promptNode = promptEdge ? getNodeById(promptEdge.fromId) : null;
    if (!promptNode || !promptNode.classList.contains('workflow-node--prompt')) return null;
    let sections = [];
    try {
      sections = JSON.parse(promptNode.dataset.promptSections || promptNode.dataset.promptFields || '[]');
    } catch (_) {}
    if (!Array.isArray(sections) || sections.length === 0) return null;
    return { runNode, sections };
  }

  function normalizeScoreRowSelectionKey(key) {
    return String(key ?? '').trim();
  }

  function isLikelyScoreRowSelectionKey(key) {
    const k = normalizeScoreRowSelectionKey(key);
    if (!k) return false;
    if (/^\d+$/.test(k)) return true;
    if (/^run:\d+$/.test(k)) return true;
    return false;
  }

  /**
   * Merge row inclusion/exclusion for Score Review + metrics (scoreRowExcludedFromScoring).
   * Only agent-created score nodes are editable here.
   */
  async function updateScoreRowSelection(options = {}) {
    const {
      scoreNodeId = '',
      exclude_row_keys,
      excludeRowKeys,
      include_row_keys,
      includeRowKeys,
    } = options || {};
    const idArg = String(scoreNodeId || '').trim();
    if (!idArg) {
      throw new Error('Evaluate node id is required.');
    }
    const scoreNode = getNodeById(idArg);
    if (!scoreNode || !scoreNode.classList.contains('workflow-node--score')) {
      throw new Error('Evaluate node was not found.');
    }
    if (scoreNode.dataset.nodeOrigin !== 'agent') {
      throw buildEditError(
        `update_score_row_selection refused: Evaluate node ${idArg} was not created by the agent. Ask the user to change row selection in the Evaluate detail UI.`,
        { reason: 'not_agent_created', score_node_id: idArg },
      );
    }

    const excludeList = Array.isArray(exclude_row_keys)
      ? exclude_row_keys
      : (Array.isArray(excludeRowKeys) ? excludeRowKeys : []);
    const includeList = Array.isArray(include_row_keys)
      ? include_row_keys
      : (Array.isArray(includeRowKeys) ? includeRowKeys : []);

    if (excludeList.length === 0 && includeList.length === 0) {
      throw buildEditError(
        'update_score_row_selection requires at least one key in exclude_row_keys or include_row_keys.',
        { reason: 'no_row_keys' },
      );
    }

    let excluded = {};
    try {
      const raw = String(scoreNode.dataset.scoreRowExcludedFromScoring || '').trim();
      excluded = raw ? JSON.parse(raw) : {};
      if (!excluded || typeof excluded !== 'object' || Array.isArray(excluded)) excluded = {};
    } catch (_) {
      excluded = {};
    }

    const invalidKeys = [];
    let validOps = 0;

    for (const k of includeList) {
      const key = normalizeScoreRowSelectionKey(k);
      if (!key) continue;
      if (!isLikelyScoreRowSelectionKey(key)) {
        invalidKeys.push(key);
        continue;
      }
      delete excluded[key];
      validOps += 1;
    }
    for (const k of excludeList) {
      const key = normalizeScoreRowSelectionKey(k);
      if (!key) continue;
      if (!isLikelyScoreRowSelectionKey(key)) {
        invalidKeys.push(key);
        continue;
      }
      excluded[key] = true;
      validOps += 1;
    }

    const hadNonEmptyKey = [...excludeList, ...includeList].some((k) => normalizeScoreRowSelectionKey(k));
    if (hadNonEmptyKey && validOps === 0) {
      throw buildEditError(
        'update_score_row_selection: no valid row keys (use "0","1",… for GT rows or "run:3" for run-only).',
        { reason: 'all_row_keys_invalid', invalid_row_keys: [...new Set(invalidKeys)] },
      );
    }

    scoreNode.dataset.scoreRowExcludedFromScoring = JSON.stringify(excluded);
    updateEdges();
    emitCanvasChanged();

    let comparisonRowCountIncluded = null;
    const ctx = getScoreComparisonContext(scoreNode);
    if (ctx) {
      try {
        const rows = await buildReviewComparisonRows(
          scoreNode,
          ctx.runNode,
          datasetContentByNodeId,
          ctx.sections,
          readRunInputTable(ctx.runNode),
        );
        comparisonRowCountIncluded = Array.isArray(rows) ? rows.length : 0;
      } catch (_) {
        comparisonRowCountIncluded = null;
      }
    }

    return {
      updated: true,
      scoreNodeId: idArg,
      scoreRowExcludedFromScoring: excluded,
      excludedRowKeyCount: Object.keys(excluded).filter((k) => excluded[k]).length,
      comparison_row_count_included: comparisonRowCountIncluded,
      invalid_row_keys: [...new Set(invalidKeys)],
      hint: invalidKeys.length > 0
        ? 'Some keys were skipped as invalid; valid keys were applied. Confirm with the user if needed. Then inspect_node for refreshed metrics.'
        : 'Call inspect_node on this score for refreshed metrics; Optimize uses only included rows.',
    };
  }

  async function buildReviewPayloadForScoreNode(scoreNode) {
    if (!scoreNode || !scoreNode.classList.contains('workflow-node--score')) {
      throw new Error('Evaluate node was not found.');
    }
    const connections = getConnectionsList();
    const runEdge = connections.find((c) => c.toId === scoreNode.dataset.nodeId && c.type === 'run-to-score');
    const runNode = runEdge ? getNodeById(runEdge.fromId) : null;
    if (!runNode || !runNode.classList.contains('workflow-node--run')) {
      throw new Error('Evaluate node is not connected to an upstream run.');
    }
    const promptEdge = connections.find((c) => c.toId === runNode.dataset.nodeId && c.type === 'prompt-to-run');
    const promptNode = promptEdge ? getNodeById(promptEdge.fromId) : null;
    if (!promptNode || !promptNode.classList.contains('workflow-node--prompt')) {
      throw new Error('Run node is not connected to an upstream prompt.');
    }

    let sections = [];
    try {
      sections = JSON.parse(promptNode.dataset.promptSections || promptNode.dataset.promptFields || '[]');
    } catch (_) {}
    if (!Array.isArray(sections) || sections.length === 0) {
      throw new Error('Upstream prompt must include at least one section.');
    }

    const promptFullText = sections.map((section) => (
      `## ${(section.name || '').trim() || '(unnamed)'}\n\n${(section.content || '').trim()}`
    )).join('\n\n');

    let runResults = [];
    try {
      runResults = JSON.parse(runNode.dataset.runResults || '[]');
      if (!Array.isArray(runResults)) runResults = [];
    } catch (_) {}
    if (runResults.length === 0) {
      throw new Error('Upstream run must have results before starting optimization.');
    }

    let schemaFields = [];
    try {
      const raw = promptNode.dataset.promptOutputFormat || '[]';
      schemaFields = JSON.parse(raw);
      if (!Array.isArray(schemaFields)) schemaFields = [];
    } catch (_) {}
    const outputFields = deriveOutputFields(runResults, schemaFields);

    let outputSchema = null;
    try {
      const raw = JSON.parse(promptNode.dataset.promptOutputFormat || '[]');
      const fields = (Array.isArray(raw) ? raw : []).map((field) => ({
        key: field.key || '',
        type: field.type || 'str',
        description: field.description,
        allow_none: field.allowNone === true || field.allow_none === true,
      })).filter((field) => (field.key || '').trim());
      if (fields.length > 0) {
        outputSchema = {
          return_shape: promptNode.dataset.promptOutputReturnShape || 'single',
          fields,
        };
      }
    } catch (_) {}

    const isCodeMatchMode = (scoreNode.dataset.scoreActiveMatchMode || 'rules') === 'code';
    if (isCodeMatchMode) {
      let hasMatchCodeResult = false;
      try {
        const parsed = JSON.parse(scoreNode.dataset.scoreMatchResult || 'null');
        hasMatchCodeResult = Boolean(parsed && Array.isArray(parsed.outcomes) && parsed.outcomes.length > 0);
      } catch (_) {}
      if (!hasMatchCodeResult) {
        throw new Error('Evaluate node uses Match by code but has no completed code-match run yet; run it from the Evaluate detail UI first.');
      }
    } else {
      const scoreMappingRaw = String(scoreNode.dataset.scoreMapping || '').trim();
      const { inputRoot, outputRoot } = parseScoreMappingBundle(scoreMappingRaw || '{}');
      const ruleCount = [...flattenScoreRules(inputRoot), ...flattenScoreRules(outputRoot)].length;
      if (ruleCount <= 0) {
        throw new Error('Evaluate node must include at least one scoring rule.');
      }
    }

    const groundTruthNodeId = (scoreNode.dataset.scoreGroundTruthId || '').trim();
    if (!groundTruthNodeId) {
      throw new Error('Evaluate node must select a ground-truth dataset before optimization.');
    }

    const comparisonRows = await buildReviewComparisonRows(scoreNode, runNode, datasetContentByNodeId, sections, readRunInputTable(runNode));
    return {
      scoreNode,
      runNode,
      promptNode,
      payload: {
        prompt_sections: sections,
        prompt_full_text: promptFullText,
        run_results: runResults,
        output_fields: outputFields,
        output_schema: outputSchema,
        comparison_rows: comparisonRows,
        review_method: (scoreNode.dataset.reviewMethod || '').trim() || undefined,
        score_mapping: scoreNode.dataset.scoreMapping || undefined,
        target_section_index: Number.isInteger(parseInt(scoreNode.dataset.gepaTargetSectionIndex, 10))
          ? parseInt(scoreNode.dataset.gepaTargetSectionIndex, 10)
          : undefined,
        settings_overrides: reviewSettingsOverrides(scoreNode),
      },
    };
  }

  function addPromptReviewNode({
    scoreNodeId = '',
    name = '',
    left,
    top,
    ensureUniqueName = false,
  } = {}) {
    const normalizedScoreNodeId = String(scoreNodeId || '').trim();
    if (!normalizedScoreNodeId) {
      throw new Error('Evaluate node id is required.');
    }
    const scoreNode = getNodeById(normalizedScoreNodeId);
    if (!scoreNode || !scoreNode.classList.contains('workflow-node--score')) {
      throw new Error('Evaluate node was not found.');
    }
    const requestedName = (name || '').trim() || 'Optimize';
    const finalName = ensureUniqueName
      ? findUniqueReviewName(requestedName, normalizedScoreNodeId)
      : requestedName;
    const resolvedLeft = typeof left === 'number'
      ? left
      : (parseFloat(scoreNode.style.left) || 0) + (scoreNode.offsetWidth || 280) + NEW_NODE_OFFSET;
    const resolvedTop = typeof top === 'number' ? top : (parseFloat(scoreNode.style.top) || 0);
    const promptReviewNode = createPromptReviewNode({
      left: resolvedLeft,
      top: resolvedTop,
      title: finalName,
    });
    if (promptReviewNode?.dataset?.nodeId) {
      promptReviewNode.dataset.promptReviewName = finalName;
      getConnectionsList().push({
        fromId: normalizedScoreNodeId,
        toId: promptReviewNode.dataset.nodeId,
        type: 'score-to-prompt-review',
      });
      updateEdges();
    }
    updateContentSize();
    emitCanvasChanged();
    return {
      created: true,
      nodeId: String(promptReviewNode?.dataset?.nodeId || '').trim(),
      reviewNodeId: String(promptReviewNode?.dataset?.nodeId || '').trim(),
      scoreNodeId: normalizedScoreNodeId,
      name: finalName,
      requestedName,
      nameWasAdjusted: finalName !== requestedName,
      position: {
        left: Number.parseFloat(promptReviewNode?.style?.left || '') || 0,
        top: Number.parseFloat(promptReviewNode?.style?.top || '') || 0,
      },
    };
  }

  async function createAndRunReviewNode({
    scoreNodeId = '',
    reviewCredentialId = '',
    name = '',
    left,
    top,
    ensureUniqueName = true,
  } = {}) {
    const normalizedScoreNodeId = String(scoreNodeId || '').trim();
    if (!normalizedScoreNodeId) {
      throw new Error('Evaluate node id is required.');
    }
    const scoreNode = getNodeById(normalizedScoreNodeId);
    if (!scoreNode || !scoreNode.classList.contains('workflow-node--score')) {
      throw new Error('Evaluate node was not found.');
    }

    const { payload } = await buildReviewPayloadForScoreNode(scoreNode);
    const resolvedReviewCredentialId = await resolveReviewCredentialId(scoreNode, reviewCredentialId);
    if (!resolvedReviewCredentialId) {
      throw new Error('Optimize credential id is required before starting optimization.');
    }
    scoreNode.dataset.reviewCredentialId = resolvedReviewCredentialId;

    const created = addPromptReviewNode({
      scoreNodeId: normalizedScoreNodeId,
      name,
      left,
      top,
      ensureUniqueName,
    });
    const reviewNodeId = String(created?.reviewNodeId || created?.nodeId || '').trim();
    const createdReviewEl = reviewNodeId ? getNodeById(reviewNodeId) : null;
    if (createdReviewEl && typeof markNodeAsAgentCreated === 'function') {
      markNodeAsAgentCreated(createdReviewEl);
    }
    if (!reviewNodeId) {
      throw new Error('Optimize node could not be created.');
    }

    await runReviewStart({
      reviewNodeId,
      payload,
      credentialId: resolvedReviewCredentialId,
      registerPendingReview,
    });

    const reviewNode = getNodeById(reviewNodeId);
    const pending = pendingReviewNodeIds.has(reviewNodeId) || pendingReviews.has(reviewNodeId);
    if (!pending) {
      throw new Error('Optimize request did not start successfully.');
    }

    return {
      ...created,
      started: true,
      waitRequired: true,
      scoreNodeId: normalizedScoreNodeId,
      reviewNodeId,
      reviewCredentialId: resolvedReviewCredentialId,
      reviewProgress: Number.parseInt(reviewNode?.dataset?.reviewProgress || '0', 10) || 0,
    };
  }

  function getReviewNodeById(reviewNodeId) {
    const normalizedReviewNodeId = String(reviewNodeId || '').trim();
    if (!normalizedReviewNodeId) {
      throw new Error('Optimize node id is required.');
    }
    const reviewNode = getNodeById(normalizedReviewNodeId);
    if (!reviewNode || !reviewNode.classList.contains('workflow-node--prompt-review')) {
      throw new Error('Optimize node was not found.');
    }
    return reviewNode;
  }

  function getReviewContext(reviewNodeId) {
    const reviewNode = getReviewNodeById(reviewNodeId);
    const connections = getConnectionsList();
    const scoreEdge = connections.find((connection) => connection.toId === reviewNode.dataset.nodeId && connection.type === 'score-to-prompt-review');
    const scoreNode = scoreEdge ? getNodeById(scoreEdge.fromId) : null;
    if (!scoreNode || !scoreNode.classList.contains('workflow-node--score')) {
      throw new Error('Optimize node is not connected to an upstream Evaluate node.');
    }
    const runEdge = connections.find((connection) => connection.toId === scoreNode.dataset.nodeId && connection.type === 'run-to-score');
    const runNode = runEdge ? getNodeById(runEdge.fromId) : null;
    if (!runNode || !runNode.classList.contains('workflow-node--run')) {
      throw new Error('Evaluate node is not connected to an upstream run.');
    }
    const promptEdge = connections.find((connection) => connection.toId === runNode.dataset.nodeId && connection.type === 'prompt-to-run');
    const promptNode = promptEdge ? getNodeById(promptEdge.fromId) : null;
    if (!promptNode || !promptNode.classList.contains('workflow-node--prompt')) {
      throw new Error('Run node is not connected to an upstream prompt.');
    }
    return { reviewNode, scoreNode, runNode, promptNode };
  }

  function parseReviewResult(node) {
    if (!node) return null;
    try {
      const raw = String(node.dataset.reviewResult || '').trim();
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function persistReviewResult({ reviewNode, scoreNode, reviewResult }) {
    if (!reviewNode || !reviewResult || typeof reviewResult !== 'object') return;
    const reviewNodeId = String(reviewNode?.dataset?.nodeId || '').trim();
    if (reviewNodeId && typeof emitSaveReviewResult === 'function') {
      emitSaveReviewResult({
        reviewNodeId,
        data: reviewResult,
      });
      return;
    }
    const serialized = JSON.stringify(reviewResult);
    reviewNode.dataset.reviewResult = serialized;
    if (scoreNode?.dataset) {
      scoreNode.dataset.reviewResult = serialized;
    }
    if (reviewResult.reviewProgress != null) {
      setReviewNodeProgress(reviewNode, reviewResult.reviewProgress);
    }
    emitCanvasChanged();
  }

  async function buildReviewVerificationPayload(reviewNodeId) {
    const { reviewNode, scoreNode, runNode, promptNode } = getReviewContext(reviewNodeId);
    let promptSections = [];
    try {
      promptSections = JSON.parse(promptNode.dataset.promptSections || promptNode.dataset.promptFields || '[]');
    } catch (_) {}
    if (!Array.isArray(promptSections) || promptSections.length === 0) {
      throw new Error('Upstream prompt must include at least one section.');
    }

    let outputFields = [];
    try {
      outputFields = JSON.parse(runNode.dataset.runOutputFields || '[]');
      if (!Array.isArray(outputFields)) outputFields = [];
    } catch (_) {}
    if (outputFields.length === 0) {
      let runResults = [];
      let schemaFields = [];
      try {
        runResults = JSON.parse(runNode.dataset.runResults || '[]');
        if (!Array.isArray(runResults)) runResults = [];
      } catch (_) {}
      try {
        schemaFields = JSON.parse(promptNode.dataset.promptOutputFormat || '[]');
        if (!Array.isArray(schemaFields)) schemaFields = [];
      } catch (_) {}
      outputFields = deriveOutputFields(runResults, schemaFields);
    }

    let outputSchema = null;
    try {
      const raw = JSON.parse(promptNode.dataset.promptOutputFormat || '[]');
      const fields = (Array.isArray(raw) ? raw : []).map((field) => ({
        key: field.key || '',
        type: field.type || 'str',
        description: field.description,
        allow_none: field.allowNone === true || field.allow_none === true,
      })).filter((field) => (field.key || '').trim());
      if (fields.length > 0) {
        outputSchema = {
          return_shape: promptNode.dataset.promptOutputReturnShape || 'single',
          fields,
        };
      }
    } catch (_) {}

    const runCredentialId = await resolveRunCredentialId(runNode);
    const groundTruthNodeId = String(scoreNode.dataset.scoreGroundTruthId || '').trim();
    const runWs = readRunInputTable(runNode) || { headers: [], rows: [] };
    const gtContent = groundTruthNodeId ? (datasetContentByNodeId.get(groundTruthNodeId) || { headers: [], rows: [] }) : { headers: [], rows: [] };

    const saved = parseReviewResult(reviewNode) || parseReviewResult(scoreNode) || {};
    const comparisonRows = Array.isArray(saved?.comparison_rows) && saved.comparison_rows.length > 0
      ? saved.comparison_rows
      : await buildReviewComparisonRows(scoreNode, runNode, datasetContentByNodeId, promptSections, readRunInputTable(runNode));

    return {
      reviewNode,
      scoreNode,
      runNode,
      promptNode,
      originals: Array.isArray(saved?.promptSections) && saved.promptSections.length > 0
        ? saved.promptSections.map((section) => ({ name: section?.name || '', content: section?.content || '' }))
        : promptSections.map((section) => ({ name: section?.name || '', content: section?.content || '' })),
      reviewResult: {
        ...saved,
        promptSections: Array.isArray(saved?.promptSections) && saved.promptSections.length > 0
          ? saved.promptSections
          : promptSections.map((section) => ({ name: section?.name || '', content: section?.content || '' })),
        workingSections: Array.isArray(saved?.workingSections) && saved.workingSections.length > 0
          ? saved.workingSections.map((section) => ({ name: section?.name || '', content: section?.content || '' }))
          : promptSections.map((section) => ({ name: section?.name || '', content: section?.content || '' })),
        suggestions: Array.isArray(saved?.suggestions) ? saved.suggestions.map((suggestion) => ({ ...suggestion })) : [],
        verify_states: saved?.verify_states && typeof saved.verify_states === 'object' ? { ...saved.verify_states } : {},
        verify_results: saved?.verify_results && typeof saved.verify_results === 'object' ? { ...saved.verify_results } : {},
        comparison_rows: comparisonRows,
      },
      verificationPayload: {
        run_credential_id: runCredentialId,
        output_schema: outputSchema,
        score_mapping: scoreNode.dataset.scoreMapping || '{}',
        output_fields: outputFields,
        runWs,
        gtContent,
      },
    };
  }

  async function verifyReviewSuggestions({
    reviewNodeId = '',
    suggestionIds = [],
  } = {}) {
    const {
      reviewNode,
      scoreNode,
      reviewResult,
      originals,
      verificationPayload,
    } = await buildReviewVerificationPayload(reviewNodeId);
    const normalizedSuggestionIds = Array.isArray(suggestionIds)
      ? suggestionIds.map((value) => String(value || '').trim()).filter(Boolean)
      : [];
    const limitToIds = normalizedSuggestionIds.length > 0 ? new Set(normalizedSuggestionIds) : null;
    const suggestions = Array.isArray(reviewResult.suggestions) ? reviewResult.suggestions : [];
    if (suggestions.length === 0) {
      throw new Error('Optimize node has no suggestions to verify.');
    }

    const verifiedSuggestions = [];
    const skippedSuggestions = [];
    for (const suggestion of suggestions) {
      const suggestionId = String(suggestion?.suggestion_id ?? '').trim();
      if (!suggestionId) continue;
      if (limitToIds && !limitToIds.has(suggestionId)) continue;
      if (String(suggestion?.source || '').toLowerCase() === 'assistant') {
        skippedSuggestions.push({
          suggestionId,
          reason: 'Assistant-authored suggestions are skipped by verification.',
        });
        continue;
      }
      const existingVerifyState = String(reviewResult.verify_states?.[suggestionId] || '').trim();
      const existingVerifyResult = reviewResult.verify_results?.[suggestionId] || null;
      const hasReusableVerifyResult =
        existingVerifyState
        && existingVerifyState !== 'idle'
        && existingVerifyState !== 'verifying'
        && existingVerifyState !== 'optimizing'
        && existingVerifyResult
        && typeof existingVerifyResult === 'object';
      if (hasReusableVerifyResult) {
        skippedSuggestions.push({
          suggestionId,
          reason: `Suggestion already has verify state "${existingVerifyState}".`,
          status: existingVerifyState,
          verifyResult: existingVerifyResult,
        });
        continue;
      }
      const verifyResult = await verifyReviewSuggestion({
        suggestion,
        originals,
        comparisonRows: reviewResult.comparison_rows,
        reviewPayload: verificationPayload,
        apiBase: RUN_API_BASE,
      });
      reviewResult.verify_states[suggestionId] = reviewVerifyStateFromResult(verifyResult);
      reviewResult.verify_results[suggestionId] = verifyResult;
      verifiedSuggestions.push({
        suggestionId,
        status: reviewResult.verify_states[suggestionId],
        verifyResult,
      });
    }

    persistReviewResult({ reviewNode, scoreNode, reviewResult });

    const fullyVerifiedCount = verifiedSuggestions.reduce(
      (sum, item) => sum + (item.status === 'verified' ? 1 : 0),
      0,
    );
    return {
      reviewNodeId: String(reviewNode.dataset.nodeId || '').trim(),
      verifiedCount: verifiedSuggestions.length,
      fullyVerifiedCount,
      partialOrFailedCount: Math.max(0, verifiedSuggestions.length - fullyVerifiedCount),
      skippedCount: skippedSuggestions.length,
      verifiedSuggestions,
      skippedSuggestions,
    };
  }

  async function acceptReviewSuggestions({
    reviewNodeId = '',
    suggestionIds = [],
  } = {}) {
    const {
      reviewNode,
      scoreNode,
      reviewResult,
      originals,
    } = await buildReviewVerificationPayload(reviewNodeId);
    const normalizedSuggestionIds = Array.isArray(suggestionIds)
      ? suggestionIds.map((value) => String(value || '').trim()).filter(Boolean)
      : [];
    const limitToIds = normalizedSuggestionIds.length > 0 ? new Set(normalizedSuggestionIds) : null;
    const suggestions = Array.isArray(reviewResult.suggestions) ? reviewResult.suggestions : [];
    if (suggestions.length === 0) {
      throw new Error('Optimize node has no suggestions to accept.');
    }

    const decisions = [];
    for (const suggestion of suggestions) {
      const suggestionId = String(suggestion?.suggestion_id ?? '').trim();
      if (!suggestionId) continue;
      if (limitToIds && !limitToIds.has(suggestionId)) continue;
      const verifyResult = reviewResult.verify_results?.[suggestionId] || null;
      const decision = decideSuggestionAcceptance({
        suggestion,
        verifyResult,
        originals,
      });
      suggestion.applied = decision.accept === true;
      decisions.push({
        ...decision,
        status: reviewResult.verify_states?.[suggestionId] || 'idle',
      });
    }

    const nextWorkingSections = rebuildWorkingFromApplied(originals, suggestions);
    if (nextWorkingSections && nextWorkingSections.length > 0) {
      reviewResult.workingSections = nextWorkingSections.map((section) => ({
        name: section?.name || '',
        content: section?.content || '',
      }));
    }
    reviewResult.suggestions = suggestions.map((suggestion) => ({
      ...suggestion,
      applied: suggestion?.applied === true,
    }));
    persistReviewResult({ reviewNode, scoreNode, reviewResult });

    return {
      reviewNodeId: String(reviewNode.dataset.nodeId || '').trim(),
      acceptedCount: decisions.reduce((sum, decision) => sum + (decision.accept ? 1 : 0), 0),
      rejectedCount: decisions.reduce((sum, decision) => sum + (!decision.accept ? 1 : 0), 0),
      acceptedSuggestionIds: decisions.filter((decision) => decision.accept).map((decision) => decision.suggestionId),
      rejectedSuggestionIds: decisions.filter((decision) => !decision.accept).map((decision) => decision.suggestionId),
      decisions,
      workingSections: Array.isArray(reviewResult.workingSections) ? reviewResult.workingSections.slice() : [],
    };
  }

  function addDatasetNode({
    name = '',
    notes = '',
    headers = [],
    rows = [],
    columnTypes,
    rowIds,
    left,
    top,
    samplerNodeId = '',
    sampledSourceRowIds,
    savedFrom = null,
    colorIndex,
    ensureUniqueName = true,
    agentCreated = false,
  } = {}) {
    const requestedName = (name || '').trim() || 'Dataset';
    const finalName = ensureUniqueName && isDatasetNameAlreadyUsed(requestedName)
      ? findUniqueWorkingDatasetName(requestedName, false)
      : requestedName;
    const node = createDatasetNode({
      name: finalName,
      notes: String(notes || ''),
      left,
      top,
      samplerNodeId: String(samplerNodeId || '').trim(),
      sampledSourceRowIds,
      savedFrom,
      colorIndex,
      headers,
      rows,
      columnTypes,
      rowIds,
    });
    if (agentCreated && typeof markNodeAsAgentCreated === 'function') markNodeAsAgentCreated(node);
    updateContentSize();
    updateEdges();
    emitCanvasChanged();
    const content = datasetContentByNodeId.get(node?.dataset?.nodeId || '') || { headers: [], rows: [] };
    return {
      created: true,
      nodeId: String(node?.dataset?.nodeId || '').trim(),
      name: String(node?.dataset?.datasetName || finalName).trim() || finalName,
      notes: String(node?.dataset?.datasetNote || notes || ''),
      headers: Array.isArray(content.headers) ? content.headers.slice() : [],
      rows: Array.isArray(content.rows) ? content.rows.map((row) => (Array.isArray(row) ? row.slice() : [])) : [],
      position: {
        left: Number.parseFloat(node?.style?.left || '') || 0,
        top: Number.parseFloat(node?.style?.top || '') || 0,
      },
      nameWasAdjusted: finalName !== requestedName,
      requestedName,
    };
  }

  function addSamplerNode({
    sourceNodeId = '',
    name = '',
    samplingType = 'without-replacement',
    sampleSizeType = 'ratio',
    sampleSize = 100,
    rowSpec = '',
    left,
    top,
    colorIndex,
    ensureUniqueName = true,
  } = {}) {
    const normalizedSourceNodeId = String(sourceNodeId || '').trim();
    if (!normalizedSourceNodeId) {
      throw new Error('Sampler source dataset node id is required.');
    }
    const sourceNode = getNodeById(normalizedSourceNodeId);
    if (!sourceNode || !sourceNode.classList.contains('workflow-node--dataset')) {
      throw new Error('Sampler source dataset node was not found.');
    }

    const requestedName = (name || '').trim() || getNextDefaultSamplerName(normalizedSourceNodeId);
    const finalName = ensureUniqueName && isSamplerNameAlreadyUsedForSource(requestedName, normalizedSourceNodeId)
      ? findUniqueSamplerName(requestedName, normalizedSourceNodeId)
      : requestedName;
    const resolvedLeft = typeof left === 'number'
      ? left
      : (parseFloat(sourceNode.style.left) || 0) + (sourceNode.offsetWidth || 280) + NEW_NODE_OFFSET;
    const resolvedTop = typeof top === 'number' ? top : (parseFloat(sourceNode.style.top) || 0);
    const node = createSamplerNode({
      name: finalName,
      notes: '',
      left: resolvedLeft,
      top: resolvedTop,
      sourceNodeId: normalizedSourceNodeId,
      colorIndex,
      samplingType,
      sampleSizeType,
      sampleSize,
      rowSpec,
    });
    if (typeof markNodeAsAgentCreated === 'function') markNodeAsAgentCreated(node);
    if (node?.dataset?.nodeId) {
      getConnectionsList().push({
        fromId: normalizedSourceNodeId,
        toId: node.dataset.nodeId,
        type: 'dataset-to-sampler',
      });
      updateEdges();
    }
    updateContentSize();
    emitCanvasChanged();
    return {
      created: true,
      nodeId: String(node?.dataset?.nodeId || '').trim(),
      sourceNodeId: normalizedSourceNodeId,
      name: String(node?.dataset?.samplerName || finalName).trim() || finalName,
      samplingType: String(node?.dataset?.samplerSamplingType || samplingType || 'without-replacement'),
      sampleSizeType: String(node?.dataset?.samplerSampleSizeType || sampleSizeType || ''),
      sampleSize: node?.dataset?.samplerSampleSize != null ? parseInt(node.dataset.samplerSampleSize, 10) : null,
      rowSpec: String(node?.dataset?.samplerRowSpec || rowSpec || '').trim(),
      position: {
        left: Number.parseFloat(node?.style?.left || '') || 0,
        top: Number.parseFloat(node?.style?.top || '') || 0,
      },
      nameWasAdjusted: finalName !== requestedName,
      requestedName,
    };
  }

  const PUBMED_IMPORT_POLL_INTERVAL_MS = 1200;
  const PUBMED_IMPORT_MAX_WAIT_MS = 5 * 60 * 1000;

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function importPubmedDataset({
    pmids = [],
    fields = [],
    name = '',
    notes = '',
    left,
    top,
    ensureUniqueName = true,
  } = {}) {
    const normalizedIds = (Array.isArray(pmids) ? pmids : [])
      .map((id) => String(id == null ? '' : id).trim())
      .filter(Boolean);
    if (normalizedIds.length === 0) {
      throw new Error('At least one PubMed id is required.');
    }
    const normalizedFields = (Array.isArray(fields) ? fields : [])
      .map((field) => String(field == null ? '' : field).trim())
      .filter(Boolean);
    if (normalizedFields.length === 0) {
      throw new Error('At least one PubMed field is required.');
    }

    const startResponse = await fetch(`${RUN_API_BASE}/api/pubmed/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: normalizedIds, fields: normalizedFields }),
    });
    const startData = await startResponse.json().catch(() => ({}));
    if (!startResponse.ok) {
      throw new Error(String(startData?.detail || startResponse.statusText || 'Failed to start PubMed import.'));
    }
    const jobId = String(startData?.job_id || '').trim();
    if (!jobId) {
      throw new Error('PubMed import started but no job id was returned by the backend.');
    }

    const startedAt = Date.now();
    let result = null;
    while (true) {
      if (Date.now() - startedAt > PUBMED_IMPORT_MAX_WAIT_MS) {
        throw new Error('PubMed import timed out.');
      }
      const pollResponse = await fetch(`${RUN_API_BASE}/api/pubmed/import/result/${jobId}`);
      const pollData = await pollResponse.json().catch(() => ({}));
      if (!pollResponse.ok && pollResponse.status !== 202) {
        throw new Error(String(pollData?.detail || pollResponse.statusText || 'Failed to fetch PubMed import result.'));
      }
      if (pollData?.status === 'running') {
        await delay(PUBMED_IMPORT_POLL_INTERVAL_MS);
        continue;
      }
      result = pollData;
      break;
    }

    if (result?.error) {
      throw new Error(String(result.error));
    }

    const headers = Array.isArray(result?.headers) ? result.headers : [];
    const rows = Array.isArray(result?.rows) ? result.rows : [];
    const notFound = Array.isArray(result?.not_found) ? result.not_found : [];
    if (rows.length === 0) {
      throw new Error(notFound.length > 0
        ? `None of the ${notFound.length} PMID${notFound.length === 1 ? '' : 's'} were found on PubMed.`
        : 'PubMed import returned no rows.');
    }

    const finalName = String(name || '').trim() || 'PubMed Import';
    const finalNotes = String(notes || '').trim() || `Imported ${rows.length} article${rows.length === 1 ? '' : 's'} from PubMed.`;
    const created = addDatasetNode({
      name: finalName,
      notes: finalNotes,
      headers,
      rows,
      left,
      top,
      ensureUniqueName,
      agentCreated: true,
    });

    return {
      ...created,
      requestedIds: normalizedIds,
      notFoundIds: notFound,
      wasCancelled: result?.status === 'cancelled',
    };
  }

  const CLINICALTRIALS_IMPORT_POLL_INTERVAL_MS = 1200;
  const CLINICALTRIALS_IMPORT_MAX_WAIT_MS = 5 * 60 * 1000;

  async function importClinicaltrialsDataset({
    nctIds = [],
    fields = [],
    name = '',
    notes = '',
    left,
    top,
    ensureUniqueName = true,
  } = {}) {
    const normalizedIds = (Array.isArray(nctIds) ? nctIds : [])
      .map((id) => String(id == null ? '' : id).trim().toUpperCase())
      .filter(Boolean);
    if (normalizedIds.length === 0) {
      throw new Error('At least one ClinicalTrials.gov id is required.');
    }
    const normalizedFields = (Array.isArray(fields) ? fields : [])
      .map((field) => String(field == null ? '' : field).trim())
      .filter(Boolean);
    if (normalizedFields.length === 0) {
      throw new Error('At least one ClinicalTrials.gov field is required.');
    }

    const startResponse = await fetch(`${RUN_API_BASE}/api/clinicaltrials/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: normalizedIds, fields: normalizedFields }),
    });
    const startData = await startResponse.json().catch(() => ({}));
    if (!startResponse.ok) {
      throw new Error(String(startData?.detail || startResponse.statusText || 'Failed to start ClinicalTrials.gov import.'));
    }
    const jobId = String(startData?.job_id || '').trim();
    if (!jobId) {
      throw new Error('ClinicalTrials.gov import started but no job id was returned by the backend.');
    }

    const startedAt = Date.now();
    let result = null;
    while (true) {
      if (Date.now() - startedAt > CLINICALTRIALS_IMPORT_MAX_WAIT_MS) {
        throw new Error('ClinicalTrials.gov import timed out.');
      }
      const pollResponse = await fetch(`${RUN_API_BASE}/api/clinicaltrials/import/result/${jobId}`);
      const pollData = await pollResponse.json().catch(() => ({}));
      if (!pollResponse.ok && pollResponse.status !== 202) {
        throw new Error(String(pollData?.detail || pollResponse.statusText || 'Failed to fetch ClinicalTrials.gov import result.'));
      }
      if (pollData?.status === 'running') {
        await delay(CLINICALTRIALS_IMPORT_POLL_INTERVAL_MS);
        continue;
      }
      result = pollData;
      break;
    }

    if (result?.error) {
      throw new Error(String(result.error));
    }

    const headers = Array.isArray(result?.headers) ? result.headers : [];
    const rows = Array.isArray(result?.rows) ? result.rows : [];
    const notFound = Array.isArray(result?.not_found) ? result.not_found : [];
    if (rows.length === 0) {
      throw new Error(notFound.length > 0
        ? `None of the ${notFound.length} NCT ID${notFound.length === 1 ? '' : 's'} were found on ClinicalTrials.gov.`
        : 'ClinicalTrials.gov import returned no rows.');
    }

    const finalName = String(name || '').trim() || 'ClinicalTrials.gov Import';
    const finalNotes = String(notes || '').trim() || `Imported ${rows.length} stud${rows.length === 1 ? 'y' : 'ies'} from ClinicalTrials.gov.`;
    const created = addDatasetNode({
      name: finalName,
      notes: finalNotes,
      headers,
      rows,
      left,
      top,
      ensureUniqueName,
      agentCreated: true,
    });

    return {
      ...created,
      requestedIds: normalizedIds,
      notFoundIds: notFound,
      wasCancelled: result?.status === 'cancelled',
    };
  }

  const PREPRINT_IMPORT_POLL_INTERVAL_MS = 1200;
  const PREPRINT_IMPORT_MAX_WAIT_MS = 5 * 60 * 1000;

  async function importPreprintDataset({
    dois = [],
    fields = [],
    name = '',
    notes = '',
    left,
    top,
    ensureUniqueName = true,
  } = {}) {
    const normalizedIds = (Array.isArray(dois) ? dois : [])
      .map((id) => String(id == null ? '' : id).trim())
      .filter(Boolean);
    if (normalizedIds.length === 0) {
      throw new Error('At least one bioRxiv/medRxiv DOI is required.');
    }
    const normalizedFields = (Array.isArray(fields) ? fields : [])
      .map((field) => String(field == null ? '' : field).trim())
      .filter(Boolean);
    if (normalizedFields.length === 0) {
      throw new Error('At least one bioRxiv/medRxiv field is required.');
    }

    const startResponse = await fetch(`${RUN_API_BASE}/api/preprint/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: normalizedIds, fields: normalizedFields }),
    });
    const startData = await startResponse.json().catch(() => ({}));
    if (!startResponse.ok) {
      throw new Error(String(startData?.detail || startResponse.statusText || 'Failed to start bioRxiv/medRxiv import.'));
    }
    const jobId = String(startData?.job_id || '').trim();
    if (!jobId) {
      throw new Error('bioRxiv/medRxiv import started but no job id was returned by the backend.');
    }

    const startedAt = Date.now();
    let result = null;
    while (true) {
      if (Date.now() - startedAt > PREPRINT_IMPORT_MAX_WAIT_MS) {
        throw new Error('bioRxiv/medRxiv import timed out.');
      }
      const pollResponse = await fetch(`${RUN_API_BASE}/api/preprint/import/result/${jobId}`);
      const pollData = await pollResponse.json().catch(() => ({}));
      if (!pollResponse.ok && pollResponse.status !== 202) {
        throw new Error(String(pollData?.detail || pollResponse.statusText || 'Failed to fetch bioRxiv/medRxiv import result.'));
      }
      if (pollData?.status === 'running') {
        await delay(PREPRINT_IMPORT_POLL_INTERVAL_MS);
        continue;
      }
      result = pollData;
      break;
    }

    if (result?.error) {
      throw new Error(String(result.error));
    }

    const headers = Array.isArray(result?.headers) ? result.headers : [];
    const rows = Array.isArray(result?.rows) ? result.rows : [];
    const notFound = Array.isArray(result?.not_found) ? result.not_found : [];
    if (rows.length === 0) {
      throw new Error(notFound.length > 0
        ? `None of the ${notFound.length} DOI${notFound.length === 1 ? '' : 's'} were found on bioRxiv or medRxiv.`
        : 'bioRxiv/medRxiv import returned no rows.');
    }

    const finalName = String(name || '').trim() || 'bioRxiv/medRxiv Import';
    const finalNotes = String(notes || '').trim() || `Imported ${rows.length} preprint${rows.length === 1 ? '' : 's'} from bioRxiv/medRxiv.`;
    const created = addDatasetNode({
      name: finalName,
      notes: finalNotes,
      headers,
      rows,
      left,
      top,
      ensureUniqueName,
      agentCreated: true,
    });

    return {
      ...created,
      requestedIds: normalizedIds,
      notFoundIds: notFound,
      wasCancelled: result?.status === 'cancelled',
    };
  }

  const CHEMBL_IMPORT_POLL_INTERVAL_MS = 1200;
  const CHEMBL_IMPORT_MAX_WAIT_MS = 5 * 60 * 1000;

  async function importChemblDataset({
    chemblIds = [],
    fields = [],
    name = '',
    notes = '',
    left,
    top,
    ensureUniqueName = true,
  } = {}) {
    const normalizedIds = (Array.isArray(chemblIds) ? chemblIds : [])
      .map((id) => String(id == null ? '' : id).trim().toUpperCase())
      .filter(Boolean);
    if (normalizedIds.length === 0) {
      throw new Error('At least one ChEMBL id is required.');
    }
    const normalizedFields = (Array.isArray(fields) ? fields : [])
      .map((field) => String(field == null ? '' : field).trim())
      .filter(Boolean);
    if (normalizedFields.length === 0) {
      throw new Error('At least one ChEMBL field is required.');
    }

    const startResponse = await fetch(`${RUN_API_BASE}/api/chembl/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: normalizedIds, fields: normalizedFields }),
    });
    const startData = await startResponse.json().catch(() => ({}));
    if (!startResponse.ok) {
      throw new Error(String(startData?.detail || startResponse.statusText || 'Failed to start ChEMBL import.'));
    }
    const jobId = String(startData?.job_id || '').trim();
    if (!jobId) {
      throw new Error('ChEMBL import started but no job id was returned by the backend.');
    }

    const startedAt = Date.now();
    let result = null;
    while (true) {
      if (Date.now() - startedAt > CHEMBL_IMPORT_MAX_WAIT_MS) {
        throw new Error('ChEMBL import timed out.');
      }
      const pollResponse = await fetch(`${RUN_API_BASE}/api/chembl/import/result/${jobId}`);
      const pollData = await pollResponse.json().catch(() => ({}));
      if (!pollResponse.ok && pollResponse.status !== 202) {
        throw new Error(String(pollData?.detail || pollResponse.statusText || 'Failed to fetch ChEMBL import result.'));
      }
      if (pollData?.status === 'running') {
        await delay(CHEMBL_IMPORT_POLL_INTERVAL_MS);
        continue;
      }
      result = pollData;
      break;
    }

    if (result?.error) {
      throw new Error(String(result.error));
    }

    const headers = Array.isArray(result?.headers) ? result.headers : [];
    const rows = Array.isArray(result?.rows) ? result.rows : [];
    const notFound = Array.isArray(result?.not_found) ? result.not_found : [];
    if (rows.length === 0) {
      throw new Error(notFound.length > 0
        ? `None of the ${notFound.length} ChEMBL ID${notFound.length === 1 ? '' : 's'} were found on ChEMBL.`
        : 'ChEMBL import returned no rows.');
    }

    const finalName = String(name || '').trim() || 'ChEMBL Import';
    const finalNotes = String(notes || '').trim() || `Imported ${rows.length} molecule${rows.length === 1 ? '' : 's'} from ChEMBL.`;
    const created = addDatasetNode({
      name: finalName,
      notes: finalNotes,
      headers,
      rows,
      left,
      top,
      ensureUniqueName,
      agentCreated: true,
    });

    return {
      ...created,
      requestedIds: normalizedIds,
      notFoundIds: notFound,
      wasCancelled: result?.status === 'cancelled',
    };
  }

  return {
    addPromptNode,
    addPromptVersion,
    startRunNode,
    addScoreNode,
    updateScoreNode,
    updateScoreRowSelection,
    addPromptReviewNode,
    createAndRunReviewNode,
    verifyReviewSuggestions,
    acceptReviewSuggestions,
    applyReviewSuggestions,
    addDatasetNode,
    addSamplerNode,
    importPubmedDataset,
    importClinicaltrialsDataset,
    importPreprintDataset,
    importChemblDataset,
  };
}
