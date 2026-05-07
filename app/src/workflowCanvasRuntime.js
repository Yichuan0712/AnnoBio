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
    formatResultOutputColumnLabel,
    parseScoreMappingBundle,
    serializeScoreMappingBundle,
    flattenScoreRules,
    runReviewStart,
    getScoreExportData,
    DATASET_BORDER_COLORS,
    RUN_API_BASE,
    NEW_NODE_OFFSET,
    getNodeById,
    getConnections,
    datasetContentByNodeId,
    scrollWrapper,
    createPromptNode,
    createRunNode,
    createScoreNode,
    createDatasetNode,
    createSamplerNode,
    createPromptReviewNode,
    updateContentSize,
    updateEdges,
    syncScoreNodeProgressFromUpstreamRun,
    setRunNodeProgress,
    registerPendingRun,
    pendingRuns,
    resolveRunCredentialId,
    resolveReviewCredentialId,
    pendingReviewNodeIds,
    pendingReviews,
    registerPendingReview,
    buildReviewComparisonRows,
    findUniquePromptName,
    isPromptNameAlreadyUsed,
    getPromptDataFromNode,
    isRunNameAlreadyUsedForPromptNodeId,
    findUniqueRunName,
    findUniqueDatasetExportName,
    findUniqueWorkingDatasetName,
    isDatasetNameAlreadyUsed,
    isSamplerNameAlreadyUsedForSource,
    getNextDefaultSamplerName,
    findUniqueSamplerName,
    findUniqueReviewName,
    prepareSampledDatasetFromSampler,
    escapeRegex,
    emitCanvasChanged,
    emitRunResultsUpdated,
  } = deps;

  function getConnectionsList() {
    return Array.isArray(getConnections?.()) ? getConnections() : [];
  }

  function addPromptNode({
    name = '',
    note = '',
    sections = [],
    outputFormat,
    left,
    top,
    ensureUniqueName = true,
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
      left,
      top,
    });
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

  function addRunNode({
    promptNodeId = '',
    workingSetId = '',
    inputToColumn = {},
    credentialId = '',
    name = '',
    left,
    top,
    ensureUniqueName = true,
  } = {}) {
    const normalizedPromptNodeId = String(promptNodeId || '').trim();
    const normalizedWorkingSetId = String(workingSetId || '').trim();
    if (!normalizedPromptNodeId) {
      throw new Error('Prompt node id is required.');
    }
    if (!normalizedWorkingSetId) {
      throw new Error('Working set dataset node id is required.');
    }
    const promptNode = getNodeById(normalizedPromptNodeId);
    if (!promptNode || !promptNode.classList.contains('workflow-node--prompt')) {
      throw new Error('Prompt node was not found.');
    }
    const workingSetNode = getNodeById(normalizedWorkingSetId);
    if (!workingSetNode || !workingSetNode.classList.contains('workflow-node--dataset')) {
      throw new Error('Working set dataset node was not found.');
    }

    let promptSections = [];
    try {
      promptSections = JSON.parse(promptNode.dataset.promptSections || promptNode.dataset.promptFields || '[]');
    } catch (_) {}
    const promptInputFields = extractInputFieldsFromSections(Array.isArray(promptSections) ? promptSections : []);
    const content = datasetContentByNodeId.get(normalizedWorkingSetId) || { headers: [], rows: [] };
    const datasetHeaders = Array.isArray(content.headers) ? content.headers.map((header) => String(header ?? '')) : [];
    const headerSet = new Set(datasetHeaders);
    const normalizedCredentialId = String(credentialId == null ? '' : credentialId).trim();
    const normalizedInputToColumn = inputToColumn && typeof inputToColumn === 'object' && !Array.isArray(inputToColumn)
      ? Object.fromEntries(
        Object.entries(inputToColumn)
          .map(([key, value]) => [String(key || '').trim(), String(value == null ? '' : value).trim()])
          .filter(([key]) => Boolean(key))
      )
      : {};
    const promptFieldSet = new Set(promptInputFields);
    const unknownInputs = Object.keys(normalizedInputToColumn).filter((field) => promptInputFields.length > 0 && !promptFieldSet.has(field));
    if (unknownInputs.length > 0) {
      throw new Error(`Unknown prompt inputs in mapping: ${unknownInputs.join(', ')}.`);
    }
    const missingInputs = promptInputFields.filter((field) => !String(normalizedInputToColumn[field] || '').trim());
    if (missingInputs.length > 0) {
      throw new Error(`Missing input mappings for: ${missingInputs.join(', ')}.`);
    }
    const unknownColumns = Object.values(normalizedInputToColumn).filter((column) => column && !headerSet.has(column));
    if (unknownColumns.length > 0) {
      throw new Error(`Mapped dataset columns were not found: ${unknownColumns.join(', ')}.`);
    }

    const requestedName = (name || '').trim() || 'Run';
    const finalName = ensureUniqueName && isRunNameAlreadyUsedForPromptNodeId(requestedName, normalizedPromptNodeId)
      ? findUniqueRunName(requestedName, normalizedPromptNodeId)
      : requestedName;
    const resolvedLeft = typeof left === 'number'
      ? left
      : (parseFloat(promptNode.style.left) || 0) + (promptNode.offsetWidth || 280) + NEW_NODE_OFFSET;
    const resolvedTop = typeof top === 'number' ? top : (parseFloat(promptNode.style.top) || 0);
    const node = createRunNode({
      left: resolvedLeft,
      top: resolvedTop,
      title: finalName,
    });
    if (node?.dataset) {
      node.dataset.runName = finalName;
      node.dataset.runWorkingSetId = normalizedWorkingSetId;
      node.dataset.runInputToColumn = JSON.stringify(normalizedInputToColumn);
      if (normalizedCredentialId) {
        node.dataset.runCredentialId = normalizedCredentialId;
      } else {
        delete node.dataset.runCredentialId;
      }
      const workingSetColorIndex = workingSetNode.dataset.datasetColorIndex != null
        ? parseInt(workingSetNode.dataset.datasetColorIndex, 10)
        : 0;
      const workingSetColor = DATASET_BORDER_COLORS[workingSetColorIndex % DATASET_BORDER_COLORS.length];
      node.style.borderColor = workingSetColor || '';
      const bar = node.querySelector('.workflow-node__run-progress');
      if (bar) bar.style.background = workingSetColor || bar.style.background;
    }
    if (node?.dataset?.nodeId) {
      getConnectionsList().push({
        fromId: normalizedPromptNodeId,
        toId: node.dataset.nodeId,
        type: 'prompt-to-run',
      });
      updateEdges();
    }
    updateContentSize();
    emitCanvasChanged();
    return {
      created: true,
      nodeId: String(node?.dataset?.nodeId || '').trim(),
      promptNodeId: normalizedPromptNodeId,
      workingSetId: normalizedWorkingSetId,
      name: String(node?.dataset?.runName || finalName).trim() || finalName,
      credentialId: String(node?.dataset?.runCredentialId || '').trim(),
      credentialMode: normalizedCredentialId ? 'explicit' : 'default-if-available',
      inputToColumn: normalizedInputToColumn,
      mappedInputs: Object.keys(normalizedInputToColumn),
      missingInputs: [],
      position: {
        left: Number.parseFloat(node?.style?.left || '') || 0,
        top: Number.parseFloat(node?.style?.top || '') || 0,
      },
      nameWasAdjusted: finalName !== requestedName,
      requestedName,
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

    const connections = getConnectionsList();
    const promptEdge = connections.find((c) => c.toId === normalizedRunNodeId && c.type === 'prompt-to-run');
    const promptNode = promptEdge ? getNodeById(promptEdge.fromId) : null;
    if (!promptNode) {
      throw new Error('This run node is not connected to an upstream prompt.');
    }

    const workingSetId = String(node.dataset.runWorkingSetId || '').trim();
    if (!workingSetId) {
      throw new Error('This run node has no selected input dataset.');
    }
    const content = datasetContentByNodeId.get(workingSetId);
    const headers = Array.isArray(content?.headers) ? content.headers.slice() : [];
    const rows = Array.isArray(content?.rows) ? content.rows.map((row) => (Array.isArray(row) ? row.slice() : [])) : [];
    if (rows.length === 0) {
      throw new Error('Dataset has no rows.');
    }

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

    const credentialId = await resolveRunCredentialId(node);
    if (!credentialId) {
      throw new Error('This run node has no selected credential.');
    }

    let existingResults = [];
    try {
      existingResults = JSON.parse(node.dataset.runResults || '[]');
      if (!Array.isArray(existingResults)) existingResults = [];
    } catch (_) {
      existingResults = [];
    }
    const nextRowIndex = getNextRowIndex(existingResults, rows.length);
    const rowsToRun = rows.slice(nextRowIndex);
    if (rowsToRun.length === 0) {
      if (existingResults.length > 0) {
        node.dataset.runCompleted = '1';
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

    const prompts = rowsToRun.map((row) => {
      let text = templateText;
      inputFields.forEach((inputName) => {
        const columnName = String(runInputToColumn[inputName] || '').trim();
        const headerIndex = headers.indexOf(columnName);
        const value = headerIndex >= 0 ? row[headerIndex] ?? '' : '';
        text = text.replace(new RegExp(`\\{${escapeRegex(inputName)}\\}`, 'g'), String(value));
      });
      return text;
    });

    node.dataset.runInputContent = JSON.stringify({ headers, rows });
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

    const response = await fetch(`${RUN_API_BASE}/api/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        credential_id: credentialId,
        prompts,
        output_schema: outputSchema,
        run_node_id: normalizedRunNodeId,
      }),
    });
    const data = await response.json().catch(() => ({}));

    if (response.status === 202) {
      const runId = String(data?.run_id || '').trim();
      if (!runId) {
        throw new Error('Run started but no run id was returned by the backend.');
      }
      if (runId) registerPendingRun(normalizedRunNodeId, runId);
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
    setRunNodeProgress(node, rows.length, rows.length);
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

  function saveRunResultsToWorkspace({
    runNodeId = '',
    name = '',
    notes = '',
    left,
    top,
    ensureUniqueName = true,
  } = {}) {
    const normalizedRunNodeId = String(runNodeId || '').trim();
    if (!normalizedRunNodeId) {
      throw new Error('Run node id is required.');
    }
    const runNode = getNodeById(normalizedRunNodeId);
    if (!runNode || !runNode.classList.contains('workflow-node--run')) {
      throw new Error('Run node was not found.');
    }

    let results = [];
    try {
      results = JSON.parse(runNode.dataset.runResults || '[]');
      if (!Array.isArray(results)) results = [];
    } catch (_) {
      results = [];
    }
    if (results.length === 0) {
      throw new Error('Run node has no saved results.');
    }

    const connections = getConnectionsList();
    const promptEdge = connections.find((c) => c.toId === normalizedRunNodeId && c.type === 'prompt-to-run');
    const promptNode = promptEdge ? getNodeById(promptEdge.fromId) : null;
    const promptName = (promptNode?.dataset?.promptName || promptNode?.querySelector('.workflow-node__title')?.textContent || '').trim() || 'Prompt';
    const runName = (runNode.dataset.runName || runNode.querySelector('.workflow-node__title')?.textContent || '').trim() || 'Run';
    const baseName = `${promptName} ${runName}`.trim();
    const requestedName = String(name || '').trim();

    let runContent = null;
    if (runNode.dataset.runInputContent) {
      try {
        runContent = JSON.parse(runNode.dataset.runInputContent);
      } catch (_) {}
    }
    if (!runContent) {
      const workingSetId = String(runNode.dataset.runWorkingSetId || '').trim();
      const workingSetContent = datasetContentByNodeId.get(workingSetId);
      if (workingSetContent) {
        runContent = {
          headers: Array.isArray(workingSetContent.headers) ? workingSetContent.headers.slice() : [],
          rows: Array.isArray(workingSetContent.rows) ? workingSetContent.rows.map((row) => (Array.isArray(row) ? row.slice() : [])) : [],
        };
      }
    }
    results = runContent ? embedInputRow(results, runContent) : results;
    results = markEmptyOutputAsError(results);

    let schemaFields = [];
    try {
      const raw = promptNode?.dataset?.promptOutputFormat || '[]';
      schemaFields = JSON.parse(raw);
      if (!Array.isArray(schemaFields)) schemaFields = [];
    } catch (_) {
      schemaFields = [];
    }
    let outputFields = deriveOutputFields(results, schemaFields);
    if (outputFields.length === 0 && results.some((item) => item && item.error)) {
      outputFields = [{ key: 'error', display: 'Error' }];
    }
    if (outputFields.length === 0 && results.length > 0) {
      const first = results.find((item) => item?.output && typeof item.output === 'object' && Object.keys(item.output).length > 0);
      if (first) outputFields = Object.keys(first.output).map((key) => ({ key, display: key }));
    }
    if (outputFields.length === 0 && schemaFields.length > 0) {
      outputFields = schemaFields
        .map((field) => ({
          key: String(field?.key || '').trim(),
          display: String(field?.display || field?.key || '').trim() || 'field',
        }))
        .filter((field) => field.key);
    }

    const inputHeaders = Array.isArray(runContent?.headers) ? runContent.headers.slice() : [];
    const inputHeaderLabels = inputHeaders.map((header) => `Input: ${String(header ?? '').trim() || ' '}`);
    const exportHeaders = [
      'Input: #',
      ...inputHeaderLabels,
      formatResultOutputColumnLabel('#'),
      ...outputFields.map((field) => formatResultOutputColumnLabel((field?.display || field?.key || '').trim() || 'output')),
    ];
    const exportRows = results.map((result) => {
      const outputPart = result?.error
        ? outputFields.map(() => String(result.error))
        : outputFields.map((field) => {
          const value = result?.output?.[field.key];
          if (value == null) return '—';
          if (Array.isArray(value)) return value.join(', ');
          return String(value);
        });
      const inputRow = Array.isArray(result?.input_row) ? result.input_row : [];
      const inputPart = inputHeaders.map((_, index) => (inputRow[index] == null ? '—' : String(inputRow[index])));
      const inputNum = String((result?.input_row_index ?? 0) + 1);
      const outputNum = String((result?.row_index ?? 0) + 1);
      return [inputNum, ...inputPart, outputNum, ...outputPart];
    });

    const runCompleted = runNode.dataset.runCompleted === '1';
    const defaultNotes = `Exported from ${promptName} ${runName}.\n${runCompleted ? 'Run completed.' : 'Run incomplete.'}`;
    const datasetName = requestedName || findUniqueDatasetExportName(baseName);
    const visiblePadding = 40;
    const startLeft = typeof left === 'number' ? left : (scrollWrapper.scrollLeft + visiblePadding);
    const startTop = typeof top === 'number' ? top : (scrollWrapper.scrollTop + visiblePadding);
    const created = addDatasetNode({
      name: datasetName,
      notes: String(notes || '').trim() || defaultNotes,
      headers: exportHeaders,
      rows: exportRows,
      left: startLeft,
      top: startTop,
      ensureUniqueName: requestedName ? ensureUniqueName : false,
    });
    return {
      ...created,
      runNodeId: normalizedRunNodeId,
      exportedRowCount: exportRows.length,
      runCompleted,
      sourcePromptName: promptName,
      sourceRunName: runName,
    };
  }

  async function saveScoreResultsToWorkspace({
    scoreNodeId = '',
    name = '',
    notes = '',
    left,
    top,
    ensureUniqueName = true,
  } = {}) {
    const normalizedScoreNodeId = String(scoreNodeId || '').trim();
    if (!normalizedScoreNodeId) {
      throw new Error('Score node id is required.');
    }
    const scoreNode = getNodeById(normalizedScoreNodeId);
    if (!scoreNode || !scoreNode.classList.contains('workflow-node--score')) {
      throw new Error('Score node was not found.');
    }

    const connections = getConnectionsList();
    const runEdge = connections.find((c) => c.toId === normalizedScoreNodeId && c.type === 'run-to-score');
    const runNode = runEdge ? getNodeById(runEdge.fromId) : null;
    const promptEdge = runNode ? connections.find((c) => c.toId === runNode.dataset.nodeId && c.type === 'prompt-to-run') : null;
    const promptNode = promptEdge ? getNodeById(promptEdge.fromId) : null;

    function getRunResultColumns() {
      if (!runNode) return [];
      const cols = [];
      cols.push({ key: '#', label: '#' });
      let results = [];
      try {
        results = JSON.parse(runNode.dataset.runResults || '[]');
        if (!Array.isArray(results)) results = [];
      } catch (_) {}
      let schemaFields = [];
      if (promptNode) {
        try {
          const raw = promptNode.dataset.promptOutputFormat || '[]';
          schemaFields = JSON.parse(raw);
          if (!Array.isArray(schemaFields)) schemaFields = [];
        } catch (_) {}
      }
      const outputFields = deriveOutputFields(results, schemaFields);
      outputFields.forEach((field) => cols.push({
        key: field.key || '',
        label: formatResultOutputColumnLabel((field.display || field.key || '').trim() || field.key || '—'),
      }));
      const wsId = (runNode.dataset.runWorkingSetId || '').trim();
      const wsContent = wsId ? datasetContentByNodeId.get(wsId) : null;
      const wsHeaders = (wsContent && wsContent.headers) ? wsContent.headers.slice() : [];
      cols.push({ key: '[#]', label: 'Input: #' });
      wsHeaders.forEach((header) => {
        const headerText = String(header ?? '').trim() || ' ';
        cols.push({ key: `[${headerText}]`, label: `Input: ${headerText}` });
      });
      return cols;
    }

    function getRunResults() {
      if (!runNode) return { results: [], outputFields: [] };
      let results = [];
      try {
        results = JSON.parse(runNode.dataset.runResults || '[]');
        if (!Array.isArray(results)) results = [];
      } catch (_) {}
      let schemaFields = [];
      if (promptNode) {
        try {
          const raw = promptNode.dataset.promptOutputFormat || '[]';
          schemaFields = JSON.parse(raw);
          if (!Array.isArray(schemaFields)) schemaFields = [];
        } catch (_) {}
      }
      const outputFields = deriveOutputFields(results, schemaFields);
      return { results, outputFields };
    }

    function getRunWorkingSetContent() {
      const wsId = (runNode && runNode.dataset.runWorkingSetId) ? runNode.dataset.runWorkingSetId.trim() : '';
      const content = wsId ? datasetContentByNodeId.get(wsId) : null;
      return content
        ? { headers: (content.headers || []).slice(), rows: (content.rows || []).map((row) => row.slice()) }
        : { headers: [], rows: [] };
    }

    function getGroundTruthContent(wsNodeId) {
      const content = datasetContentByNodeId.get(wsNodeId || '');
      if (!content) return { headers: [], rows: [] };
      return { headers: (content.headers || []).slice(), rows: (content.rows || []).map((row) => row.slice()) };
    }

    function getGroundTruthHeaders(wsNodeId) {
      const content = datasetContentByNodeId.get(wsNodeId || '');
      return (content && content.headers) ? content.headers.slice() : [];
    }

    const payload = await getScoreExportData({
      node: scoreNode,
      getRunResults,
      getRunWorkingSetContent,
      getGroundTruthContent,
      getGroundTruthHeaders,
      getRunResultColumns,
    });
    if (!payload || !Array.isArray(payload.headers) || !Array.isArray(payload.rows)) {
      throw new Error('Score node has no exportable comparison results.');
    }

    const scoreName = (scoreNode.querySelector('.workflow-node__title')?.textContent || '').trim() || 'Score';
    const requestedName = String(name || '').trim();
    const datasetName = requestedName || findUniqueDatasetExportName(`${scoreName} comparison`);
    const datasetNotes = String(notes || '').trim() || `Exported from Score "${scoreName}". Run vs ground truth comparison.`;
    const visiblePadding = 40;
    const startLeft = typeof left === 'number' ? left : (scrollWrapper.scrollLeft + visiblePadding);
    const startTop = typeof top === 'number' ? top : (scrollWrapper.scrollTop + visiblePadding);
    const created = addDatasetNode({
      name: datasetName,
      notes: datasetNotes,
      headers: payload.headers,
      rows: payload.rows,
      left: startLeft,
      top: startTop,
      ensureUniqueName: requestedName ? ensureUniqueName : false,
    });
    return {
      ...created,
      scoreNodeId: normalizedScoreNodeId,
      exportedRowCount: payload.rows.length,
      sourceScoreName: scoreName,
    };
  }

  function addScoreNode({
    runNodeId = '',
    groundTruthNodeId = '',
    scoreMapping = null,
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
    if (!hasRules) {
      throw new Error('Score mapping must include at least one rule.');
    }

    const requestedName = (name || '').trim() || 'Score';
    const resolvedLeft = typeof left === 'number'
      ? left
      : (parseFloat(runNode.style.left) || 0) + (runNode.offsetWidth || 280) + NEW_NODE_OFFSET;
    const resolvedTop = typeof top === 'number' ? top : (parseFloat(runNode.style.top) || 0);
    const scoreNode = createScoreNode({
      left: resolvedLeft,
      top: resolvedTop,
      title: requestedName,
    });
    if (scoreNode?.dataset) {
      scoreNode.dataset.scoreGroundTruthId = normalizedGroundTruthNodeId;
      scoreNode.dataset.scoreMapping = serializeScoreMappingBundle(inputRoot, outputRoot);
      if (reviewCredentialId) {
        scoreNode.dataset.reviewCredentialId = String(reviewCredentialId).trim();
      } else {
        delete scoreNode.dataset.reviewCredentialId;
      }
      const colorIndex = groundTruthNode.dataset.datasetColorIndex != null ? parseInt(groundTruthNode.dataset.datasetColorIndex, 10) : 0;
      const color = DATASET_BORDER_COLORS[colorIndex % DATASET_BORDER_COLORS.length];
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
      position: {
        left: Number.parseFloat(scoreNode?.style?.left || '') || 0,
        top: Number.parseFloat(scoreNode?.style?.top || '') || 0,
      },
      requestedName,
    };
  }

  async function buildReviewPayloadForScoreNode(scoreNode) {
    if (!scoreNode || !scoreNode.classList.contains('workflow-node--score')) {
      throw new Error('Score node was not found.');
    }
    const connections = getConnectionsList();
    const runEdge = connections.find((c) => c.toId === scoreNode.dataset.nodeId && c.type === 'run-to-score');
    const runNode = runEdge ? getNodeById(runEdge.fromId) : null;
    if (!runNode || !runNode.classList.contains('workflow-node--run')) {
      throw new Error('Score node is not connected to an upstream run.');
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
      throw new Error('Upstream run must have results before starting review.');
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

    const scoreMappingRaw = String(scoreNode.dataset.scoreMapping || '').trim();
    const { inputRoot, outputRoot } = parseScoreMappingBundle(scoreMappingRaw || '{}');
    const ruleCount = [...flattenScoreRules(inputRoot), ...flattenScoreRules(outputRoot)].length;
    if (ruleCount <= 0) {
      throw new Error('Score node must include at least one scoring rule.');
    }

    const groundTruthNodeId = (scoreNode.dataset.scoreGroundTruthId || '').trim();
    if (!groundTruthNodeId) {
      throw new Error('Score node must select a ground-truth dataset before review.');
    }

    const comparisonRows = await buildReviewComparisonRows(scoreNode, runNode, datasetContentByNodeId, sections);
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
      throw new Error('Score node id is required.');
    }
    const scoreNode = getNodeById(normalizedScoreNodeId);
    if (!scoreNode || !scoreNode.classList.contains('workflow-node--score')) {
      throw new Error('Score node was not found.');
    }
    const requestedName = (name || '').trim() || 'Review';
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
      throw new Error('Score node id is required.');
    }
    const scoreNode = getNodeById(normalizedScoreNodeId);
    if (!scoreNode || !scoreNode.classList.contains('workflow-node--score')) {
      throw new Error('Score node was not found.');
    }

    const { payload } = await buildReviewPayloadForScoreNode(scoreNode);
    const resolvedReviewCredentialId = await resolveReviewCredentialId(scoreNode, reviewCredentialId);
    if (!resolvedReviewCredentialId) {
      throw new Error('Review credential id is required before starting review.');
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
    if (!reviewNodeId) {
      throw new Error('Review node could not be created.');
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
      throw new Error('Review request did not start successfully.');
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

  function addDatasetNode({
    name = '',
    notes = '',
    headers = [],
    rows = [],
    left,
    top,
    samplerNodeId = '',
    colorIndex,
    ensureUniqueName = true,
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
      colorIndex,
      headers: Array.isArray(headers) ? headers.map((header) => String(header == null ? '' : header)) : [],
      rows: Array.isArray(rows) ? rows.map((row) => (Array.isArray(row) ? row.map((cell) => String(cell == null ? '' : cell)) : [])) : [],
    });
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

  function addSampledDatasetNode({
    samplerNodeId = '',
    name = '',
    notes = '',
    maxSampleUses = null,
    left,
    top,
    ensureUniqueName = true,
  } = {}) {
    const normalizedSamplerNodeId = String(samplerNodeId || '').trim();
    const prepared = prepareSampledDatasetFromSampler({
      samplerNodeId: normalizedSamplerNodeId,
      name,
      notes,
      left,
      top,
    });

    const newNode = addDatasetNode({
      name: prepared.datasetName,
      notes: prepared.datasetNotes,
      left: prepared.startLeft,
      top: prepared.startTop,
      samplerNodeId: normalizedSamplerNodeId,
      headers: prepared.datasetHeaders,
      rows: prepared.datasetRows,
      ensureUniqueName,
    });
    if (newNode?.nodeId) {
      getConnectionsList().push({
        fromId: normalizedSamplerNodeId,
        toId: newNode.nodeId,
        type: 'sampler-to-dataset',
      });
      updateEdges();
      emitCanvasChanged();
    }
    return {
      ...newNode,
      samplerNodeId: normalizedSamplerNodeId,
      sourceNodeId: prepared.sourceNodeId,
      sampleUseCount: prepared.existingCount + (newNode?.nodeId ? 1 : 0),
      maxSampleUses: Number.isFinite(Number(maxSampleUses)) ? Math.max(1, Math.floor(Number(maxSampleUses))) : null,
    };
  }

  return {
    addPromptNode,
    addRunNode,
    startRunNode,
    saveRunResultsToWorkspace,
    saveScoreResultsToWorkspace,
    addScoreNode,
    addPromptReviewNode,
    createAndRunReviewNode,
    addDatasetNode,
    addSamplerNode,
    addSampledDatasetNode,
  };
}
