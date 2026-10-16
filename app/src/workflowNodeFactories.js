import { reviewSettingsOverrides } from './nodeSettings.js';
import { datasetColorAt, promptColorAt } from './workflowNodeColors.js';
import { isTaskLocked } from './runTaskLocks.js';
import { sourceKey } from './stepInputs.js';
import { readSavedFrom } from './savedDatasets.js';
import { iconDataset, iconEvaluate, iconPrompt, iconRun, iconTrash } from './icons.js';

export function formatSamplerDescription(samplerNode) {
  if (!samplerNode || !samplerNode.dataset) return '';
  const name = (samplerNode.dataset.samplerName || '').trim() || 'Sample';
  const type = samplerNode.dataset.samplerSamplingType || 'without-replacement';
  const typeLabel = type === 'with-replacement' ? 'with replacement' : type === 'specify-rows' ? 'specify rows' : 'without replacement';
  if (type === 'specify-rows') {
    const rowSpec = (samplerNode.dataset.samplerRowSpec || '').trim();
    return rowSpec ? `${name} · ${typeLabel}: ${rowSpec}` : `${name} · ${typeLabel}`;
  }
  const sizeType = samplerNode.dataset.samplerSampleSizeType || 'ratio';
  const size = samplerNode.dataset.samplerSampleSize != null ? String(samplerNode.dataset.samplerSampleSize).trim() : '100';
  const sizeLabel = sizeType === 'ratio' ? `${size}%` : `${size} rows`;
  return `${name} · ${typeLabel}, ${sizeLabel}`;
}

/** Compact settings shown inside the Sample node, without repeating its title. */
export function formatSamplerSettings(samplerNode) {
  if (!samplerNode?.dataset) return '';
  const type = samplerNode.dataset.samplerSamplingType || 'without-replacement';
  if (type === 'specify-rows') {
    const rows = (samplerNode.dataset.samplerRowSpec || '').trim();
    return rows ? `Specify rows\n${rows}` : 'Specify rows';
  }
  const mode = type === 'with-replacement' ? 'With replacement' : 'Without replacement';
  const sizeType = samplerNode.dataset.samplerSampleSizeType || 'ratio';
  const size = samplerNode.dataset.samplerSampleSize != null ? String(samplerNode.dataset.samplerSampleSize).trim() : '100';
  return `${mode}\n${sizeType === 'ratio' ? `${size}%` : `${size} rows`}`;
}

export function createWorkflowNodeFactories(deps = {}) {
  // Ignore the sub-pixel movement routinely emitted between pointerdown and click by mice and
  // trackpads. Without a threshold, that harmless jitter is classified as a drag and every node
  // click is suppressed by the factory click handlers below.
  const DRAG_THRESHOLD_PX = 4;

  const {
    generateNodeId,
    allocateNodePosition,
    setNodeCanvasPosition,
    clientToCanvasPoint,
    nodesLayer,
    getZoomLevel,
    updateContentSize,
    updateEdges,
    emitCanvasChanged,
    showNodeContextMenu,
    handleWorkflowNodeDeleteClick,
    removeConnectionsInvolvingNodeId,
    getNodeById,
    getConnections,
    datasetContentByNodeId,
    readRunInputSource,
    writeRunInputSource,
    readRunInputTable,
    describeSource,
    readProcessInputRows,
    revealNode,
    readSourceOutput,
    readStepInputStatus,
    sourceColor,
    readProcessPrimarySource,
    writeProcessPrimarySource,
    readProcessInputBindings,
    readProcessInputAliases,
    writeProcessInputs,
    openPromptDetailModal,
    openRunDetailModal,
    startRunNode,
    runToHere,
    loadStaleRecord,
    resumeReviewNode,
    openSamplerDetailModal,
    openDatasetDetailModal,
    openScoreDetailModal,
    openReviewDetailModal,
    showAlert,
    escapeHtml,
    extractInputFields,
    deriveOutputFields,
    formatResultOutputColumnLabel,
    buildReviewComparisonRows,
    resolveRunCredentialId,
    resolveReviewCredentialId,
    runReviewStart,
    DATASET_BORDER_COLORS,
    normalizeDatasetColorIndex,
    chooseAutomaticNodeColorIndex,
    hasSampledDatasets,
    registerPendingRun,
    unregisterPendingRun,
    pendingRuns,
    getHistoryForNode,
    isContentLocked,
    pendingReviews,
    pendingReviewNodeIds,
    registerPendingReview,
    unregisterPendingReview,
    RUN_API_BASE,
    NEW_NODE_OFFSET,
    isRunNameAlreadyUsedForPrompt,
    openProcessDetailModal,
    runProcessNode,
    toggleNodeSelection,
    isNodeSelected,
    clearSelection,
    getSelectedNodeIds,
  } = deps;

  function getConnectionsList() {
    return Array.isArray(getConnections?.()) ? getConnections() : [];
  }

  function attachDrag(node) {
    let dragStartX = 0;
    let dragStartY = 0;
    let nodeStartLeft = 0;
    let nodeStartTop = 0;
    let lastInteractionWasDrag = false;
    // Set when the drag started on a node that's part of a multi-node selection — every entry
    // moves together by the same delta. null means a normal single-node drag (the common case).
    let groupDragEntries = null;

    function onPointerDown(e) {
      if (e.button !== 0) return;
      if (e.target.closest('.workflow-node__delete')) return;
      const nodeId = node.dataset.nodeId;
      // Ctrl/Shift+click toggles this node into/out of the selection instead of starting a drag
      // or opening the detail modal (see the `if (e.ctrlKey || e.shiftKey) return;` guard each
      // factory's own click handler adds right after this).
      if (e.ctrlKey || e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        toggleNodeSelection?.(nodeId, e.ctrlKey ? 'toggle' : 'add');
        return;
      }
      e.preventDefault();
      lastInteractionWasDrag = false;
      dragStartX = e.clientX;
      dragStartY = e.clientY;

      const isGroupDrag = isNodeSelected?.(nodeId) && (getSelectedNodeIds?.()?.size || 0) > 1;
      if (!isGroupDrag) clearSelection?.();

      if (isGroupDrag) {
        groupDragEntries = [];
        getSelectedNodeIds().forEach((id) => {
          const el = getNodeById(id);
          if (!el) return;
          const r = el.getBoundingClientRect();
          const start = clientToCanvasPoint(r.left, r.top);
          groupDragEntries.push({ el, left: start.x, top: start.y });
          el.classList.add('workflow-node--dragging');
        });
      } else {
        groupDragEntries = null;
        const rect = node.getBoundingClientRect();
        const start = clientToCanvasPoint(rect.left, rect.top);
        nodeStartLeft = start.x;
        nodeStartTop = start.y;
        node.classList.add('workflow-node--dragging');
      }

      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp, { once: true });
    }

    function onPointerMove(e) {
      const clientDx = e.clientX - dragStartX;
      const clientDy = e.clientY - dragStartY;
      if (!lastInteractionWasDrag && Math.hypot(clientDx, clientDy) < DRAG_THRESHOLD_PX) return;
      lastInteractionWasDrag = true;
      const dx = clientDx / getZoomLevel();
      const dy = clientDy / getZoomLevel();
      if (groupDragEntries) {
        groupDragEntries.forEach(({ el, left, top }) => setNodeCanvasPosition(el, left + dx, top + dy));
      } else {
        setNodeCanvasPosition(node, nodeStartLeft + dx, nodeStartTop + dy);
      }
      updateEdges();
    }

    function onPointerUp() {
      if (groupDragEntries) {
        groupDragEntries.forEach(({ el }) => el.classList.remove('workflow-node--dragging'));
      } else {
        node.classList.remove('workflow-node--dragging');
      }
      groupDragEntries = null;
      document.removeEventListener('pointermove', onPointerMove);
      updateContentSize();
      updateEdges();
      if (lastInteractionWasDrag) emitCanvasChanged();
    }

    node.addEventListener('pointerdown', onPointerDown);
    return {
      wasDrag: () => lastInteractionWasDrag,
    };
  }

  function createPromptNode({ name = '', note = '', text = '', outputFormat, inputTypes, optimizationMethodId = '', left, top, nodeId: givenNodeId, colorIndex: givenColorIndex }) {
    const nodeId = givenNodeId || generateNodeId();
    const title = (name && name.trim()) ? name.trim() : 'Prompt';
    const node = document.createElement('div');
    node.className = 'workflow-node workflow-node--prompt';
    node.setAttribute('role', 'article');
    node.setAttribute('aria-label', `Prompt node: ${title}`);
    node.dataset.nodeId = nodeId;
    node.dataset.promptText = String(text || '');
    node.dataset.promptName = name;
    node.dataset.promptNote = note;
    if (optimizationMethodId) node.dataset.optimizationMethodId = optimizationMethodId;
    const colorIndex = normalizeDatasetColorIndex(givenColorIndex) ?? chooseAutomaticNodeColorIndex();
    node.dataset.promptColorIndex = String(colorIndex);
    node.style.borderColor = promptColorAt(colorIndex);
    node.dataset.promptInputTypes = JSON.stringify(inputTypes && typeof inputTypes === 'object' ? inputTypes : {});
    let ofList = outputFormat?.fields ?? (Array.isArray(outputFormat) ? outputFormat : []);
    if (!ofList.length && outputFormat?.columns?.length) {
      ofList = outputFormat.columns.map((key) => ({
        key: key || '',
        type: 'str',
        examples: (outputFormat.examples || []).map((r) => r[key]).filter((v) => v != null && v !== ''),
      }));
    }
    ofList = ofList.map((o) => ({ key: o.key || '', type: o.type || 'str', description: o.description ?? '', examples: o.examples || [], allowNone: o.allowNone === true }));
    node.dataset.promptOutputFormat = JSON.stringify(ofList);
    node.dataset.promptOutputReturnShape = outputFormat?.returnShape ?? 'single';
    const position = allocateNodePosition(left, top);
    setNodeCanvasPosition(node, position.left, position.top);
    const noteTrimmed = (note || '').trim();
    const hasNote = noteTrimmed.length > 0;
    if (!hasNote) node.classList.add('workflow-node--no-body');
    node.innerHTML = `
      <div class="workflow-node__header">
        <span class="workflow-node__icon workflow-node__icon--prompt" aria-hidden="true">${iconPrompt(14).outerHTML}</span>
        <span class="workflow-node__title">${escapeHtml(title)}</span>
        <button type="button" class="workflow-node__delete" aria-label="Delete node" title="Delete node">${iconTrash(12).outerHTML}</button>
      </div>
      ${hasNote ? `<div class="workflow-node__body"><span class="workflow-node__note">${escapeHtml(noteTrimmed)}</span></div>` : ''}
    `;
    nodesLayer.appendChild(node);

    const deleteBtn = node.querySelector('.workflow-node__delete');
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      void handleWorkflowNodeDeleteClick(nodeId, 'prompt', () => {
        removeConnectionsInvolvingNodeId(nodeId);
        node.remove();
        updateContentSize();
        updateEdges();
        emitCanvasChanged();
      });
    });

    const dragState = attachDrag(node);

    node.addEventListener('click', async (e) => {
      if (e.target.closest('.workflow-node__delete')) return;
      if (e.ctrlKey || e.shiftKey) return; // handled as a selection toggle on pointerdown, not a click
      if (dragState.wasDrag()) return;
      e.preventDefault();
      e.stopPropagation();
      await openPromptNode(nodeId);
    });

    node.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.workflow-node__delete')) return;
      e.preventDefault();
      e.stopPropagation();
      showNodeContextMenu(e.clientX, e.clientY, node);
    });

    return node;
  }

  /** Open a Prompt from its canvas card, respecting content locks. */
  async function openPromptNode(nodeId) {
    const node = getNodeById(nodeId);
    if (!node?.classList.contains('workflow-node--prompt')) return;
    const locked = !!(await isContentLocked?.(node.dataset.nodeId));
    openPromptDetailModal({
      name: node.dataset.promptName || '', text: node.dataset.promptText || '', node, locked,
      onRunPrompt: (credentialId) => {
        const runNode = createRunNode({
          left: (parseFloat(node.style.left) || 0) + (node.offsetWidth || 280) + NEW_NODE_OFFSET,
          top: parseFloat(node.style.top) || 0, title: 'Run',
        });
        // The model picked beside Create Run; without one the Run takes the Settings default when opened.
        if (runNode && credentialId) runNode.dataset.runCredentialId = credentialId;
        if (runNode?.dataset?.nodeId) {
          getConnectionsList().push({ fromId: node.dataset.nodeId, toId: runNode.dataset.nodeId, type: 'prompt-to-run' });
          updateEdges();
        }
        updateContentSize();
        emitCanvasChanged();
      },
    });
  }

  function createSamplerNode({ name = '', notes = '', left, top, nodeId: givenNodeId, sourceNodeId = '', colorIndex: givenColorIndex, samplingType = 'without-replacement', sampleSizeType = 'ratio', sampleSize = 100, rowSpec = '' }) {
    const nodeId = givenNodeId || generateNodeId();
    const title = (name && name.trim()) ? name.trim() : 'Sample';
    const node = document.createElement('div');
    node.className = 'workflow-node workflow-node--sampler';
    node.setAttribute('role', 'article');
    node.setAttribute('aria-label', `Sample node: ${title}`);
    node.dataset.nodeId = nodeId;
    node.dataset.samplerName = name;
    node.dataset.samplerNote = notes;
    node.dataset.nodeType = 'sampler';
    node.dataset.samplerSamplingType = samplingType;
    if (samplingType === 'specify-rows') {
      node.dataset.samplerRowSpec = (rowSpec || '').trim();
    } else {
      node.dataset.samplerSampleSizeType = sampleSizeType;
      node.dataset.samplerSampleSize = String(sampleSize);
    }
    if (sourceNodeId) node.dataset.sourceNodeId = sourceNodeId;
    let colorIndex = typeof givenColorIndex === 'number' && givenColorIndex >= 0 ? givenColorIndex : 0;
    colorIndex = colorIndex % DATASET_BORDER_COLORS.length;
    node.dataset.samplerColorIndex = String(colorIndex);
    const position = allocateNodePosition(left, top);
    setNodeCanvasPosition(node, position.left, position.top);
    node.innerHTML = `
      <div class="workflow-node__header">
        <span class="workflow-node__icon workflow-node__icon--sampler" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><path d="M2 2h10l-2 5H4L2 2z"/><line x1="4" y1="7" x2="10" y2="7"/><line x1="5" y1="11" x2="9" y2="11"/><line x1="6" y1="13" x2="8" y2="13"/></svg></span>
        <span class="workflow-node__title">${escapeHtml(title)}</span>
        <button type="button" class="workflow-node__delete" aria-label="Delete node" title="Delete node">${iconTrash(12).outerHTML}</button>
      </div>
    `;
    node.insertAdjacentHTML('beforeend', `<div class="workflow-node__body workflow-node__sampler-settings"><span class="workflow-node__note">${escapeHtml(formatSamplerSettings(node))}</span></div><div class="workflow-node__sample-progress" role="progressbar" aria-label="Samples created" aria-valuenow="0" aria-valuemin="0" aria-valuemax="1" hidden></div>`);
    nodesLayer.appendChild(node);

    const deleteBtn = node.querySelector('.workflow-node__delete');
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      void handleWorkflowNodeDeleteClick(nodeId, 'sampler', () => {
        removeConnectionsInvolvingNodeId(nodeId);
        node.remove();
        updateContentSize();
        updateEdges();
        emitCanvasChanged();
      });
    });

    const dragState = attachDrag(node);

    node.addEventListener('click', (e) => {
      if (e.target.closest('.workflow-node__delete')) return;
      if (e.ctrlKey || e.shiftKey) return; // handled as a selection toggle on pointerdown, not a click
      if (dragState.wasDrag()) return;
      e.preventDefault();
      e.stopPropagation();
      openSamplerDetailModal({ node, hasSampledDatasets });
    });

    node.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.workflow-node__delete')) return;
      e.preventDefault();
      e.stopPropagation();
      showNodeContextMenu(e.clientX, e.clientY, node);
    });

    return node;
  }

  function createDatasetNode({ name = '', notes = '', left, top, nodeId: givenNodeId, samplerNodeId = '', sampledSourceRowIds, savedFrom = null, colorIndex: givenColorIndex, headers, rows, columnTypes, rowIds }) {
    const nodeId = givenNodeId || generateNodeId();
    const title = (name && name.trim()) ? name.trim() : 'Dataset';
    const samplerNode = samplerNodeId ? getNodeById(samplerNodeId) : null;
    const samplerDesc = formatSamplerDescription(samplerNode);
    const notesTrimmed = (notes !== undefined && notes !== null) ? String(notes).trim() : '';
    const bodyText = notesTrimmed || samplerDesc || '';
    const node = document.createElement('div');
    node.className = 'workflow-node workflow-node--dataset';
    node.setAttribute('role', 'article');
    node.setAttribute('aria-label', `Dataset node: ${title}`);
    node.dataset.nodeId = nodeId;
    node.dataset.datasetName = name;
    if (notes !== undefined && notes !== null) node.dataset.datasetNote = String(notes);
    node.dataset.nodeType = 'dataset';
    if (samplerNodeId) node.dataset.samplerNodeId = samplerNodeId;
    if (Array.isArray(sampledSourceRowIds)) node.dataset.sampledSourceRowIds = JSON.stringify(sampledSourceRowIds);
    // Where a Dataset saved from a step came from; shown only (savedDatasets.js).
    const origin = readSavedFrom(savedFrom);
    if (origin) node.dataset.savedFrom = JSON.stringify(origin);
    const colorIndex = normalizeDatasetColorIndex(givenColorIndex) ?? chooseAutomaticNodeColorIndex();
    node.dataset.datasetColorIndex = String(colorIndex);
    node.style.borderColor = datasetColorAt(colorIndex);
    if (Array.isArray(headers) && Array.isArray(rows)) datasetContentByNodeId.set(nodeId, { headers, rows, columnTypes, rowIds });
    const position = allocateNodePosition(left, top);
    setNodeCanvasPosition(node, position.left, position.top);
    node.innerHTML = `
      <div class="workflow-node__header">
        <span class="workflow-node__icon workflow-node__icon--dataset" aria-hidden="true"></span>
        <span class="workflow-node__title">${escapeHtml(title)}</span>
        <button type="button" class="workflow-node__delete" aria-label="Delete node" title="Delete node">${iconTrash(12).outerHTML}</button>
      </div>
      <div class="workflow-node__body workflow-node__dataset-desc">${bodyText ? `<span class="workflow-node__note">${escapeHtml(bodyText)}</span>` : '<span class="workflow-node__note-placeholder">No description.</span>'}</div>
    `;
    node.querySelector('.workflow-node__icon--dataset').append(iconDataset(14));
    nodesLayer.appendChild(node);

    const deleteBtn = node.querySelector('.workflow-node__delete');
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      void handleWorkflowNodeDeleteClick(nodeId, 'dataset', () => {
        removeConnectionsInvolvingNodeId(nodeId);
        datasetContentByNodeId.delete(nodeId);
        node.remove();
        updateContentSize();
        updateEdges();
        emitCanvasChanged();
      });
    });

    const dragState = attachDrag(node);

    node.addEventListener('click', async (e) => {
      if (e.target.closest('.workflow-node__delete')) return;
      if (e.ctrlKey || e.shiftKey) return; // handled as a selection toggle on pointerdown, not a click
      if (dragState.wasDrag()) return;
      e.preventDefault();
      e.stopPropagation();
      // Content locks once it has produced a result (contentLocks.js); until then it can be edited.
      const readOnly = !!(await isContentLocked?.(node.dataset.nodeId));
      openDatasetDetailModal({
        node,
        getContent: () => datasetContentByNodeId.get(node.dataset.nodeId) || { headers: [], rows: [] },
        readOnly,
        saveContent: (content) => {
          const id = node.dataset.nodeId;
          // A run in progress reads it (runTaskLocks.js); the window may have opened before it started.
          if (isTaskLocked(id)) {
            showAlert('This Dataset is read by a run in progress. Stop the run before changing it.', { title: 'Dataset' });
            return false;
          }
          datasetContentByNodeId.set(id, content);
          emitCanvasChanged();
        },
      });
    });

    node.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.workflow-node__delete')) return;
      e.preventDefault();
      e.stopPropagation();
      showNodeContextMenu(e.clientX, e.clientY, node);
    });

    return node;
  }

  function createRunNode({ left, top, nodeId: givenNodeId, title: givenTitle }) {
    const nodeId = givenNodeId || generateNodeId();
    const node = document.createElement('div');
    node.className = 'workflow-node workflow-node--run workflow-node--no-body';
    node.setAttribute('role', 'article');
    node.setAttribute('aria-label', 'Run node');
    node.dataset.nodeId = nodeId;
    node.dataset.nodeType = 'run';
    const runTitle = (givenTitle != null && givenTitle !== '') ? String(givenTitle) : 'Run';
    node.dataset.runName = runTitle;
    const position = allocateNodePosition(left, top);
    setNodeCanvasPosition(node, position.left, position.top);
    node.innerHTML = `
      <div class="workflow-node__header">
        <span class="workflow-node__icon workflow-node__icon--run" aria-hidden="true">${iconRun(14).outerHTML}</span>
        <span class="workflow-node__title">${escapeHtml(runTitle)}</span>
        <button type="button" class="workflow-node__delete" aria-label="Delete node" title="Delete node">${iconTrash(12).outerHTML}</button>
      </div>
      <div class="workflow-node__run-progress" role="progressbar" aria-valuenow="0" aria-valuemin="0" aria-valuemax="100"></div>
    `;
    nodesLayer.appendChild(node);

    const deleteBtn = node.querySelector('.workflow-node__delete');
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      void handleWorkflowNodeDeleteClick(nodeId, 'run', () => {
        const runId = pendingRuns.get(nodeId);
        if (runId) {
          unregisterPendingRun(nodeId);
          fetch(`${RUN_API_BASE}/api/run/cancel/${runId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          }).catch(() => {});
        }
        removeConnectionsInvolvingNodeId(nodeId);
        node.remove();
        updateContentSize();
        updateEdges();
        emitCanvasChanged();
      });
    });

    const dragState = attachDrag(node);

    node.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.workflow-node__delete')) return;
      e.preventDefault();
      e.stopPropagation();
      showNodeContextMenu(e.clientX, e.clientY, node);
    });

    node.addEventListener('click', (e) => {
      if (e.target.closest('.workflow-node__delete')) return;
      if (e.ctrlKey || e.shiftKey) return; // handled as a selection toggle on pointerdown, not a click
      if (dragState.wasDrag()) return;
      e.preventDefault();
      e.stopPropagation();
      const runNodeId = node.dataset.nodeId;
      // The Prompt is connected on the canvas (prompt-to-run); it is looked up on every call.
      const currentPromptNode = () => {
        const edge = getConnectionsList().find((c) => c.toId === runNodeId && c.type === 'prompt-to-run');
        return edge ? getNodeById(edge.fromId) : null;
      };
      const promptNameOf = (promptNode) => (promptNode?.dataset?.promptName || '').trim()
        || (promptNode?.querySelector?.('.workflow-node__title')?.textContent?.trim() || '');
      function getPromptTemplate() {
        const promptNode = currentPromptNode();
        if (!promptNode) return { outputSchema: { return_shape: 'single', fields: [] } };
        let fields = [];
        try {
          fields = JSON.parse(promptNode.dataset.promptOutputFormat || '[]');
        } catch (_) {}
        const returnShape = promptNode.dataset.promptOutputReturnShape || 'single';
        let inputTypes = {};
        try { inputTypes = JSON.parse(promptNode.dataset.promptInputTypes || '{}'); } catch (_) {}
        return { inputTypes, outputSchema: { return_shape: returnShape, fields } };
      }
      openRunDetailModal({
        node,
        startRunNode,
        // The table the input gives (stepOutputs.js); the Prompt and the input are shown, not chosen, here.
        getInputTable: (source) => readSourceOutput(source),
        getPromptId: () => currentPromptNode()?.dataset?.nodeId || '',
        describePrompt: () => {
          const promptNode = currentPromptNode();
          return promptNode ? {
            nodeId: promptNode.dataset.nodeId,
            label: promptNameOf(promptNode) || 'Prompt',
            color: promptColorAt(normalizeDatasetColorIndex(promptNode.dataset.promptColorIndex) ?? 0),
          } : null;
        },
        describeInput: () => {
          const source = readRunInputSource(node);
          return source ? { nodeId: source.nodeId, ...describeSource(source) } : null;
        },
        revealNode,
        getPromptInputFields: () => extractInputFields(currentPromptNode()?.dataset?.promptText || ''),
        getPromptTemplate,
        unregisterPendingRun,
        getPendingRunId: () => pendingRuns.get(node.dataset.nodeId) || null,
        isRunNameAlreadyUsedForPrompt,
        getInputSource: () => readRunInputSource(node),
        getInputStatus: () => readStepInputStatus(node),
        // Clicking Run while an input has no result runs the steps before it too (Run to here).
        runToHere: (options) => runToHere(node.dataset.nodeId, options),
        loadStaleRecord: () => loadStaleRecord(node.dataset.nodeId),
        getRunMappingsFromCanvas: () => Array.from(nodesLayer.querySelectorAll('.workflow-node--run')).map((n) => {
          try {
            const raw = n.dataset.runInputToColumn;
            if (!raw) return null;
            const o = JSON.parse(raw);
            return typeof o === 'object' && o !== null ? o : null;
          } catch (_) { return null; }
        }).filter(Boolean),
        history: getHistoryForNode?.(runNodeId),
      });
    });

    return node;
  }

  /** Process node: runs user-written process(df), with one primary Dataset and optional named inputs. */
  function createProcessNode({ left, top, nodeId: givenNodeId, title: givenTitle, code, dfCode, outputPorts }) {
    const nodeId = givenNodeId || generateNodeId();
    const node = document.createElement('div');
    node.className = 'workflow-node workflow-node--process workflow-node--no-body';
    node.setAttribute('role', 'article');
    node.setAttribute('aria-label', 'Process node');
    node.dataset.nodeId = nodeId;
    node.dataset.nodeType = 'process';
    const processTitle = (givenTitle != null && givenTitle !== '') ? String(givenTitle) : 'Process';
    node.dataset.processName = processTitle;
    // ``code`` is retained as a load-only legacy field. New nodes and all current callers use
    // dfCode, which is the single process(df) contract.
    if (code != null) node.dataset.processCode = String(code);
    if (dfCode != null) node.dataset.processDfCode = String(dfCode);
    if (dfCode != null) node.dataset.processActiveMode = 'df';
    if (outputPorts) node.dataset.processOutputPorts = typeof outputPorts === 'string' ? outputPorts : JSON.stringify(outputPorts);
    const position = allocateNodePosition(left, top);
    setNodeCanvasPosition(node, position.left, position.top);
    node.innerHTML = `
      <div class="workflow-node__header">
        <span class="workflow-node__icon workflow-node__icon--process" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 3L1 7l3 4M10 3l3 4-3 4"/></svg></span>
        <span class="workflow-node__title">${escapeHtml(processTitle)}</span>
        <button type="button" class="workflow-node__delete" aria-label="Delete node" title="Delete node">${iconTrash(12).outerHTML}</button>
      </div>
      <div class="workflow-node__process-progress" role="progressbar" aria-valuenow="0" aria-valuemin="0" aria-valuemax="100"></div>
    `;
    nodesLayer.appendChild(node);

    const deleteBtn = node.querySelector('.workflow-node__delete');
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      void handleWorkflowNodeDeleteClick(nodeId, 'process', () => {
        removeConnectionsInvolvingNodeId(nodeId);
        node.remove();
        updateContentSize();
        updateEdges();
        emitCanvasChanged();
      });
    });

    const dragState = attachDrag(node);

    node.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.workflow-node__delete')) return;
      e.preventDefault();
      e.stopPropagation();
      showNodeContextMenu(e.clientX, e.clientY, node);
    });

    node.addEventListener('click', (e) => {
      if (e.target.closest('.workflow-node__delete')) return;
      if (e.ctrlKey || e.shiftKey) return; // handled as a selection toggle on pointerdown, not a click
      if (dragState.wasDrag()) return;
      e.preventDefault();
      e.stopPropagation();
      // A branch offers new steps on that branch (outputMenu.js) instead of opening the window.
      const branch = e.target.closest('.workflow-node__port-row[data-port-side="right"][data-port-id]:not(.workflow-node__port-row--unavailable)');
      if (branch) {
        showNodeContextMenu(e.clientX, e.clientY, node, { port: branch.dataset.portId });
        return;
      }
      const processNodeId = node.dataset.nodeId;
      /** The key of the Process's df, recording the fallback (its first input) so it stays put when inputs change. */
      function primaryKey() {
        const primary = readProcessPrimarySource(node);
        if (primary) writeProcessPrimarySource(node, primary);
        return sourceKey(primary);
      }
      /**
       * Every Dataset and step output with its alias, marking the ones this Process reads with `code`,
       * each with the table it gives now (none while a step has no result yet).
       */
      function getProcessInputs(code) {
        const primaryDatasetId = primaryKey();
        const bindings = readProcessInputBindings(node, code, primaryDatasetId).map((binding) => ({
          ...binding,
          color: sourceColor(binding),
          content: binding.kind === 'dataset' ? datasetContentByNodeId.get(binding.nodeId) : readSourceOutput(binding).table,
        }));
        return { bindings, primaryDatasetId, savedAliases: readProcessInputAliases(node) };
      }
      /** Connects exactly the sources the code declares or uses and saves the alias each has there. */
      function syncProcessDependencies(code) {
        const inputs = readProcessInputBindings(node, code, primaryKey()).filter((binding) => binding.input);
        writeProcessInputs(node, { primary: readProcessPrimarySource(node), inputs });
        updateEdges();
        emitCanvasChanged();
      }
      openProcessDetailModal({
        node,
        runProcessNode,
        getProcessInputs,
        syncProcessDependencies,
        // df and each parameter of the code, with what is connected to it on the canvas.
        getInputRows: (code) => readProcessInputRows(node, code),
        revealNode,
        getInputStatus: () => readStepInputStatus(node),
        runToHere: (options) => runToHere(processNodeId, options),
        loadStaleRecord: () => loadStaleRecord(processNodeId),
        history: getHistoryForNode?.(processNodeId),
      });
    });

    return node;
  }

  function createScoreNode({ left, top, nodeId: givenNodeId, title: givenTitle }) {
    const nodeId = givenNodeId || generateNodeId();
    const node = document.createElement('div');
    node.className = 'workflow-node workflow-node--score workflow-node--no-body';
    node.setAttribute('role', 'article');
    node.setAttribute('aria-label', 'Evaluate node');
    node.dataset.nodeId = nodeId;
    node.dataset.nodeType = 'score';
    const scoreTitle = (givenTitle != null && givenTitle !== '') ? String(givenTitle) : 'Evaluate';
    const position = allocateNodePosition(left, top);
    setNodeCanvasPosition(node, position.left, position.top);
    node.innerHTML = `
      <div class="workflow-node__header">
        <span class="workflow-node__icon workflow-node__icon--score" aria-hidden="true">${iconEvaluate(14).outerHTML}</span>
        <span class="workflow-node__title">${escapeHtml(scoreTitle)}</span>
        <button type="button" class="workflow-node__delete" aria-label="Delete node" title="Delete node">${iconTrash(12).outerHTML}</button>
      </div>
      <div class="workflow-node__score-progress" role="progressbar" aria-valuenow="0" aria-valuemin="0" aria-valuemax="100"></div>
    `;
    nodesLayer.appendChild(node);

    const deleteBtn = node.querySelector('.workflow-node__delete');
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      void handleWorkflowNodeDeleteClick(nodeId, 'score', () => {
        removeConnectionsInvolvingNodeId(nodeId);
        node.remove();
        updateContentSize();
        updateEdges();
        emitCanvasChanged();
      });
    });

    const dragState = attachDrag(node);

    node.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.workflow-node__delete')) return;
      e.preventDefault();
      e.stopPropagation();
      showNodeContextMenu(e.clientX, e.clientY, node);
    });

    node.addEventListener('click', (e) => {
      if (e.target.closest('.workflow-node__delete')) return;
      if (e.ctrlKey || e.shiftKey) return; // handled as a selection toggle on pointerdown, not a click
      if (dragState.wasDrag()) return;
      e.preventDefault();
      e.stopPropagation();
      const workingSets = Array.from(nodesLayer.querySelectorAll('.workflow-node--dataset')).map((n) => {
        const id = n.dataset.nodeId || '';
        const content = datasetContentByNodeId.get(id);
        const colorIndex = n.dataset.datasetColorIndex != null ? parseInt(n.dataset.datasetColorIndex, 10) : 0;
        const color = datasetColorAt(colorIndex);
        return {
          nodeId: id,
          name: (n.dataset.datasetName || n.dataset.subsetName || '').trim() || 'Dataset',
          headers: content?.headers ? content.headers.slice() : [],
          color,
        };
      });
      const runEdge = getConnectionsList().find((c) => c.toId === node.dataset.nodeId && c.type === 'run-to-score');
      const runNode = runEdge ? getNodeById(runEdge.fromId) : null;
      const promptEdge = runNode ? getConnectionsList().find((c) => c.toId === runNode.dataset.nodeId && c.type === 'prompt-to-run') : null;
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
        outputFields.forEach((f) => cols.push({ key: f.key || '', label: formatResultOutputColumnLabel((f.display || f.key || '').trim() || f.key || '—') }));
        const wsContent = readRunInputTable(runNode);
        const wsHeaders = (wsContent && wsContent.headers) ? wsContent.headers.slice() : [];
        cols.push({ key: '[#]', label: 'Input: #' });
        wsHeaders.forEach((h) => {
          const headerText = String(h ?? '').trim() || ' ';
          cols.push({ key: `[${headerText}]`, label: `Input: ${headerText}` });
        });
        return cols;
      }
      function getGroundTruthHeaders(wsNodeId) {
        const c = datasetContentByNodeId.get(wsNodeId || '');
        return (c && c.headers) ? c.headers.slice() : [];
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
        const c = readRunInputTable(runNode);
        return c ? { headers: (c.headers || []).slice(), rows: (c.rows || []).map((r) => r.slice()) } : { headers: [], rows: [] };
      }
      function getGroundTruthContent(wsNodeId) {
        const c = datasetContentByNodeId.get(wsNodeId || '');
        if (!c) return { headers: [], rows: [] };
        return { headers: (c.headers || []).slice(), rows: (c.rows || []).map((r) => r.slice()) };
      }
      async function getReviewPayload() {
        if (!promptNode || !runNode || !node) return null;
        const promptText = promptNode.dataset.promptText || '';
        if (!promptText.trim()) return null;
        let runResults = [];
        try {
          runResults = JSON.parse(runNode.dataset.runResults || '[]');
          if (!Array.isArray(runResults)) runResults = [];
        } catch (_) {}
        let schemaFields = [];
        try {
          const raw = promptNode.dataset.promptOutputFormat || '[]';
          schemaFields = JSON.parse(raw);
          if (!Array.isArray(schemaFields)) schemaFields = [];
        } catch (_) {}
        const outputFields = deriveOutputFields(runResults, schemaFields);
        let output_schema = null;
        try {
          const raw = JSON.parse(promptNode.dataset.promptOutputFormat || '[]');
          const fields = (Array.isArray(raw) ? raw : []).map((o) => ({
            key: o.key || '',
            type: o.type || 'str',
            description: o.description,
            allow_none: o.allowNone === true || o.allow_none === true,
          })).filter((f) => (f.key || '').trim());
          if (fields.length > 0) {
            output_schema = {
              return_shape: promptNode.dataset.promptOutputReturnShape || 'single',
              fields,
            };
          }
        } catch (_) {}
        const comparison_rows = await buildReviewComparisonRows(node, runNode, datasetContentByNodeId, promptText, readRunInputTable(runNode));
        return {
          prompt: promptText,
          run_results: runResults,
          output_fields: outputFields,
          output_schema,
          comparison_rows,
          review_method: (node.dataset.reviewMethod || '').trim() || undefined,
          score_mapping: node.dataset.scoreMapping || undefined,
          settings_overrides: reviewSettingsOverrides(node),
        };
      }
      openScoreDetailModal({
        node,
        revealNode,
        // A Run with results (also part way through) can be scored; one without cannot yet.
        getRunState: () => (runNode ? {
          ready: runNode.dataset.runCompleted === '1' || (() => {
            try { return JSON.parse(runNode.dataset.runResults || '[]').length > 0; } catch (_) { return false; }
          })(),
          stale: !!runNode.dataset.historyStaleRecordId,
          // Named as elsewhere: its own name once renamed, else its Prompt's (stepInputs.js runLabel).
          name: (() => {
            const own = (runNode.dataset.runName || '').trim();
            if (own && own !== 'Run') return own;
            const promptId = getConnectionsList().find((c) => c.type === 'prompt-to-run' && c.toId === runNode.dataset.nodeId)?.fromId;
            return (getNodeById(promptId)?.dataset.promptName || '').trim() || 'Run';
          })(),
        } : null),
        getWorkingSets: () => workingSets,
        getRunResultColumns,
        getGroundTruthHeaders,
        getRunResults,
        getRunWorkingSetContent,
        getGroundTruthContent,
        getReviewPayload,
        getScoreMappingsFromCanvas: () => Array.from(nodesLayer.querySelectorAll('.workflow-node--score')).map((n) => n.dataset.scoreMapping || '[]'),
        getRunInputColsCollapsed: runNode ? () => runNode.dataset.runBracketColsCollapsed !== '0' : undefined,
        setRunInputColsCollapsed: runNode
          ? (collapsed) => {
            runNode.dataset.runBracketColsCollapsed = collapsed ? '1' : '0';
            emitCanvasChanged();
          }
          : undefined,
        getScoreOutputColsCollapsed: () => node.dataset.scoreOutputBracketCollapsed === '1',
        setScoreOutputColsCollapsed: (collapsed) => {
          node.dataset.scoreOutputBracketCollapsed = collapsed ? '1' : '0';
          emitCanvasChanged();
        },
        getScoreGtColsCollapsed: () => node.dataset.scoreGtBracketCollapsed === '1',
        setScoreGtColsCollapsed: (collapsed) => {
          node.dataset.scoreGtBracketCollapsed = collapsed ? '1' : '0';
          emitCanvasChanged();
        },
      });
    });

    return node;
  }

  function createPromptReviewNode({ left, top, nodeId: givenNodeId, title: givenTitle }) {
    const nodeId = givenNodeId || generateNodeId();
    const node = document.createElement('div');
    node.className = 'workflow-node workflow-node--prompt-review workflow-node--no-body';
    node.setAttribute('role', 'article');
    node.setAttribute('aria-label', 'Optimize node');
    node.dataset.nodeId = nodeId;
    node.dataset.nodeType = 'promptReview';
    const promptReviewTitle = (givenTitle != null && givenTitle !== '') ? String(givenTitle) : 'Optimize';
    node.dataset.promptReviewName = String(promptReviewTitle || '').trim() || 'Optimize';
    const position = allocateNodePosition(left, top);
    setNodeCanvasPosition(node, position.left, position.top);
    node.innerHTML = `
      <div class="workflow-node__header">
        <span class="workflow-node__icon workflow-node__icon--prompt-review" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="2" width="10" height="10" rx="1"/><path d="M4 7l2.5 2.5L10 4"/></svg></span>
        <span class="workflow-node__title">${escapeHtml(promptReviewTitle)}</span>
        <button type="button" class="workflow-node__delete" aria-label="Delete node" title="Delete node">${iconTrash(12).outerHTML}</button>
      </div>
      <div class="workflow-node__review-progress" role="progressbar" aria-valuenow="0" aria-valuemin="0" aria-valuemax="100"></div>
    `;
    nodesLayer.appendChild(node);

    const deleteBtn = node.querySelector('.workflow-node__delete');
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      void handleWorkflowNodeDeleteClick(nodeId, 'promptReview', () => {
        const reviewId = pendingReviews.get(nodeId);
        if (reviewId) {
          unregisterPendingReview(nodeId);
          fetch(`${RUN_API_BASE}/api/review/cancel/${reviewId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          }).catch(() => {});
        } else {
          fetch(`${RUN_API_BASE}/api/review/cancel/by-node/${encodeURIComponent(nodeId)}`, { method: 'POST' }).catch(() => {});
        }
        pendingReviewNodeIds.delete(nodeId);
        removeConnectionsInvolvingNodeId(nodeId);
        node.remove();
        updateContentSize();
        updateEdges();
        emitCanvasChanged();
      });
    });

    const dragState = attachDrag(node);

    node.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.workflow-node__delete')) return;
      e.preventDefault();
      e.stopPropagation();
      showNodeContextMenu(e.clientX, e.clientY, node);
    });

    node.addEventListener('click', (e) => {
      if (e.target.closest('.workflow-node__delete')) return;
      if (e.ctrlKey || e.shiftKey) return; // handled as a selection toggle on pointerdown, not a click
      if (dragState.wasDrag()) return;
      e.preventDefault();
      e.stopPropagation();
      const scoreEdge = getConnectionsList().find((c) => c.toId === node.dataset.nodeId && c.type === 'score-to-prompt-review');
      const scoreNode = scoreEdge ? getNodeById(scoreEdge.fromId) : null;
      const runEdge = scoreNode ? getConnectionsList().find((c) => c.toId === scoreNode.dataset.nodeId && c.type === 'run-to-score') : null;
      const runNode = runEdge ? getNodeById(runEdge.fromId) : null;
      const promptEdge = runNode ? getConnectionsList().find((c) => c.toId === runNode.dataset.nodeId && c.type === 'prompt-to-run') : null;
      const promptNode = promptEdge ? getNodeById(promptEdge.fromId) : null;
      async function getPayload() {
        if (!promptNode || !runNode || !scoreNode) return null;
        const promptText = promptNode.dataset.promptText || '';
        if (!promptText.trim()) return null;
        let runResults = [];
        let outputFields = [];
        try {
          runResults = JSON.parse(runNode.dataset.runResults || '[]');
          outputFields = JSON.parse(runNode.dataset.runOutputFields || '[]');
        } catch (_) {}
        const comparison_rows = await buildReviewComparisonRows(scoreNode, runNode, datasetContentByNodeId, promptText, readRunInputTable(runNode));
        let output_schema = null;
        try {
          const raw = promptNode.dataset.promptOutputFormat || '[]';
          const fields = (Array.isArray(JSON.parse(raw)) ? JSON.parse(raw) : []).map((o) => ({
            key: o.key || '',
            type: o.type || 'str',
            description: o.description,
            allow_none: o.allowNone === true || o.allow_none === true,
          })).filter((f) => (f.key || '').trim());
          if (fields.length > 0) {
            output_schema = { return_shape: promptNode.dataset.promptOutputReturnShape || 'single', fields };
          }
        } catch (_) {}
        const gtId = (scoreNode.dataset.scoreGroundTruthId || '').trim();
        let run_input_to_column = {};
        try {
          const raw = runNode.dataset.runInputToColumn || '{}';
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') run_input_to_column = parsed;
        } catch (_) {}
        const run_credential_id = await resolveRunCredentialId(runNode);
        return {
          prompt: promptText,
          run_results: runResults,
          output_fields: outputFields,
          comparison_rows,
          output_schema,
          score_mapping: scoreNode.dataset.scoreMapping || '[]',
          run_credential_id,
          run_input_to_column,
          getRunWorkingSetContent: () => readRunInputTable(runNode) || { headers: [], rows: [] },
          getGroundTruthContent: () => gtId ? (datasetContentByNodeId.get(gtId) || { headers: [], rows: [] }) : { headers: [], rows: [] },
        };
      }
      function getReviewResult() {
        try {
          let raw = (node.dataset.reviewResult || '').trim();
          if (!raw && scoreNode && (scoreNode.dataset.reviewResult || '').trim()) {
            raw = scoreNode.dataset.reviewResult || '';
            node.dataset.reviewResult = raw;
            emitCanvasChanged();
          }
          if (!raw) return null;
          return JSON.parse(raw);
        } catch (_) { return null; }
      }
      function updateReviewResult(updated) {
        try {
          node.dataset.reviewResult = JSON.stringify(updated);
          emitCanvasChanged();
        } catch (e) {
          console.error('reviewResult save failed', e);
          showAlert(String(e?.message || e || 'Could not save review data.'), { title: 'Save error' });
        }
      }
      function onExportNewPrompt(text) {
        document.dispatchEvent(new CustomEvent('workflow:add-prompt-from-review', {
          detail: { text, afterReviewNodeId: node.dataset.nodeId },
        }));
      }
      async function onResumeReview() {
        try {
          await resumeReviewNode(node.dataset.nodeId);
          return true;
        } catch (error) {
          showAlert(String(error?.message || error), { title: 'Optimize' });
          return false;
        }
      }
      openReviewDetailModal({
        node,
        getPayload,
        getReviewResult,
        updateReviewResult,
        onExportNewPrompt,
        onResumeReview,
        getIsReviewStreaming: () => pendingReviewNodeIds.has(node.dataset.nodeId),
      });
    });

    return node;
  }

  return {
    createPromptNode,
    createSamplerNode,
    createDatasetNode,
    createRunNode,
    createScoreNode,
    createPromptReviewNode,
    createProcessNode,
  };
}
