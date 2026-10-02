import { buildProcessDatasetBindings, referencedDatasetAliases } from './processDatasetBindings.js';
import { reviewSettingsOverrides } from './nodeSettings.js';
import { datasetColorAt } from './workflowNodeColors.js';
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

export function createWorkflowNodeFactories(deps = {}) {
  // Ignore the sub-pixel movement routinely emitted between pointerdown and click by mice and
  // trackpads. Without a threshold, that harmless jitter is classified as a drag and every node
  // click is suppressed by the factory click handlers below.
  const DRAG_THRESHOLD_PX = 4;

  const {
    generateNodeId,
    allocateNodePosition,
    setNodeCanvasPosition,
    scrollWrapper,
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
    openPromptDetailModal,
    openRunDetailModal,
    startRunNode,
    openSamplerDetailModal,
    openDatasetDetailModal,
    openScoreDetailModal,
    openReviewDetailModal,
    showAlert,
    escapeHtml,
    extractInputFieldsFromSections,
    deriveOutputFields,
    formatResultOutputColumnLabel,
    buildReviewComparisonRows,
    resolveRunCredentialId,
    DATASET_BORDER_COLORS,
    normalizeDatasetColorIndex,
    chooseAutomaticDatasetColorIndex,
    hasSampledDatasets,
    registerPendingRun,
    unregisterPendingRun,
    pendingRuns,
    pendingReviews,
    pendingReviewNodeIds,
    unregisterPendingReview,
    RUN_API_BASE,
    NEW_NODE_OFFSET,
    findUniqueDatasetExportName,
    isPromptNameAlreadyUsed,
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

  function onRunWorkingSetChange() {
    updateEdges();
    emitCanvasChanged();
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
      const swRect = scrollWrapper.getBoundingClientRect();
      const sl = scrollWrapper.scrollLeft;
      const st = scrollWrapper.scrollTop;
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
          groupDragEntries.push({
            el,
            left: (r.left - swRect.left + sl) / getZoomLevel(),
            top: (r.top - swRect.top + st) / getZoomLevel(),
          });
          el.classList.add('workflow-node--dragging');
        });
      } else {
        groupDragEntries = null;
        const rect = node.getBoundingClientRect();
        nodeStartLeft = (rect.left - swRect.left + sl) / getZoomLevel();
        nodeStartTop = (rect.top - swRect.top + st) / getZoomLevel();
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

  function createPromptNode({ name = '', note = '', sections = [], outputFormat, inputTypes, left, top, nodeId: givenNodeId }) {
    const nodeId = givenNodeId || generateNodeId();
    const title = (name && name.trim()) ? name.trim() : 'Prompt';
    const node = document.createElement('div');
    node.className = 'workflow-node workflow-node--prompt';
    node.setAttribute('role', 'article');
    node.setAttribute('aria-label', `Prompt node: ${title}`);
    node.dataset.nodeId = nodeId;
    node.dataset.promptSections = JSON.stringify(sections);
    node.dataset.promptName = name;
    node.dataset.promptNote = note;
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
        <span class="workflow-node__icon workflow-node__icon--prompt" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="2" y1="4" x2="12" y2="4"/><line x1="2" y1="7" x2="12" y2="7"/><line x1="2" y1="10" x2="8" y2="10"/></svg></span>
        <span class="workflow-node__title">${escapeHtml(title)}</span>
        <button type="button" class="workflow-node__delete" aria-label="Delete node">×</button>
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

    node.addEventListener('click', (e) => {
      if (e.target.closest('.workflow-node__delete')) return;
      if (e.ctrlKey || e.shiftKey) return; // handled as a selection toggle on pointerdown, not a click
      if (dragState.wasDrag()) return;
      e.preventDefault();
      e.stopPropagation();
      let sectionsData = [];
      try {
        sectionsData = JSON.parse(node.dataset.promptSections || node.dataset.promptFields || '[]');
      } catch (_) {}
      openPromptDetailModal({
        name: node.dataset.promptName || '',
        note: node.dataset.promptNote || '',
        sections: sectionsData,
        node,
        isPromptNameAlreadyUsed,
        onRunPrompt: () => {
          const currentLeft = parseFloat(node.style.left) || 0;
          const currentTop = parseFloat(node.style.top) || 0;
          const width = node.offsetWidth || 280;
          const runNode = createRunNode({
            left: currentLeft + width + NEW_NODE_OFFSET,
            top: currentTop,
            title: 'Run',
          });
          if (runNode?.dataset?.nodeId) {
            getConnectionsList().push({
              fromId: node.dataset.nodeId,
              toId: runNode.dataset.nodeId,
              type: 'prompt-to-run',
            });
            updateEdges();
          }
          updateContentSize();
          emitCanvasChanged();
          runNode?.click();
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

  function createSamplerNode({ name = '', notes = '', left, top, nodeId: givenNodeId, sourceNodeId = '', colorIndex: givenColorIndex, samplingType = 'without-replacement', sampleSizeType = 'ratio', sampleSize = 100, rowSpec = '' }) {
    const nodeId = givenNodeId || generateNodeId();
    const title = (name && name.trim()) ? name.trim() : 'Sample';
    const node = document.createElement('div');
    node.className = 'workflow-node workflow-node--sampler workflow-node--no-body';
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
        <button type="button" class="workflow-node__delete" aria-label="Delete node">×</button>
      </div>
    `;
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

  function createDatasetNode({ name = '', notes = '', left, top, nodeId: givenNodeId, samplerNodeId = '', sourceRunNodeId = '', processOutputName = '', colorIndex: givenColorIndex, headers, rows, columnTypes, rowIds }) {
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
    // Provenance only — not a live wire like samplerNodeId (which drives sampled-dataset naming/
    // regeneration). Set when this dataset was materialized from a Run's results (see
    // saveRunResultsToWorkspace); purely informational, nothing reads it to affect execution.
    if (sourceRunNodeId) node.dataset.sourceRunNodeId = sourceRunNodeId;
    if (processOutputName) node.dataset.processOutputName = processOutputName;
    const colorIndex = normalizeDatasetColorIndex(givenColorIndex) ?? chooseAutomaticDatasetColorIndex();
    node.dataset.datasetColorIndex = String(colorIndex);
    node.style.borderColor = datasetColorAt(colorIndex);
    if (Array.isArray(headers) && Array.isArray(rows)) datasetContentByNodeId.set(nodeId, { headers, rows, columnTypes, rowIds });
    const position = allocateNodePosition(left, top);
    setNodeCanvasPosition(node, position.left, position.top);
    node.innerHTML = `
      <div class="workflow-node__header">
        <span class="workflow-node__icon workflow-node__icon--dataset" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><rect x="1" y="1" width="12" height="12" rx="0.5"/><line x1="1" y1="4" x2="13" y2="4"/><line x1="1" y1="7" x2="13" y2="7"/><line x1="1" y1="10" x2="13" y2="10"/><line x1="4.5" y1="1" x2="4.5" y2="13"/><line x1="8" y1="1" x2="8" y2="13"/></svg></span>
        <span class="workflow-node__title">${escapeHtml(title)}</span>
        <button type="button" class="workflow-node__delete" aria-label="Delete node">×</button>
      </div>
      <div class="workflow-node__body workflow-node__dataset-desc">${bodyText ? `<span class="workflow-node__note">${escapeHtml(bodyText)}</span>` : '<span class="workflow-node__note-placeholder">No description.</span>'}</div>
    `;
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

    node.addEventListener('click', (e) => {
      if (e.target.closest('.workflow-node__delete')) return;
      if (e.ctrlKey || e.shiftKey) return; // handled as a selection toggle on pointerdown, not a click
      if (dragState.wasDrag()) return;
      e.preventDefault();
      e.stopPropagation();
      openDatasetDetailModal({
        node,
        getContent: () => datasetContentByNodeId.get(node.dataset.nodeId) || { headers: [], rows: [] },
        saveContent: (content) => {
          datasetContentByNodeId.set(node.dataset.nodeId, content);
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
        <span class="workflow-node__icon workflow-node__icon--run" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"><path d="M3 2v10l8-5-8-5z"/></svg></span>
        <span class="workflow-node__title">${escapeHtml(runTitle)}</span>
        <button type="button" class="workflow-node__delete" aria-label="Delete node">×</button>
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
      // A Run picks its Prompt in its window; the prompt-to-run connection records that choice,
      // so the Prompt is looked up on every call rather than fixed when the window opens.
      const currentPromptNode = () => {
        const edge = getConnectionsList().find((c) => c.toId === runNodeId && c.type === 'prompt-to-run');
        return edge ? getNodeById(edge.fromId) : null;
      };
      const promptNameOf = (promptNode) => (promptNode?.dataset?.promptName || '').trim()
        || (promptNode?.querySelector?.('.workflow-node__title')?.textContent?.trim() || '');
      function promptSectionsOf(promptNode) {
        try {
          const sections = JSON.parse(promptNode?.dataset?.promptSections || promptNode?.dataset?.promptFields || '[]');
          return Array.isArray(sections) ? sections : [];
        } catch (_) {
          return [];
        }
      }
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
      function getSubsetContent(nodeId) {
        const c = datasetContentByNodeId.get(nodeId);
        return c || { headers: [], columnTypes: [], rowIds: [], rows: [] };
      }
      function getPromptTemplate() {
        const promptNode = currentPromptNode();
        if (!promptNode) return { sections: [], outputSchema: { return_shape: 'single', fields: [] } };
        let fields = [];
        try {
          fields = JSON.parse(promptNode.dataset.promptOutputFormat || '[]');
        } catch (_) {}
        const returnShape = promptNode.dataset.promptOutputReturnShape || 'single';
        let inputTypes = {};
        try { inputTypes = JSON.parse(promptNode.dataset.promptInputTypes || '{}'); } catch (_) {}
        return { sections: promptSectionsOf(promptNode), inputTypes, outputSchema: { return_shape: returnShape, fields } };
      }
      function selectPrompt(promptNodeId) {
        const connections = getConnectionsList();
        for (let index = connections.length - 1; index >= 0; index -= 1) {
          if (connections[index].toId === runNodeId && connections[index].type === 'prompt-to-run') connections.splice(index, 1);
        }
        if (promptNodeId) connections.push({ fromId: promptNodeId, toId: runNodeId, type: 'prompt-to-run' });
        updateEdges();
        emitCanvasChanged();
      }
      openRunDetailModal({
        node,
        startRunNode,
        getWorkingSets: () => workingSets,
        getPrompts: () => Array.from(nodesLayer.querySelectorAll('.workflow-node--prompt'))
          .map((n) => ({ nodeId: n.dataset.nodeId || '', name: promptNameOf(n) || 'Prompt' })),
        getPromptId: () => currentPromptNode()?.dataset?.nodeId || '',
        selectPrompt,
        getPromptInputFields: () => extractInputFieldsFromSections(promptSectionsOf(currentPromptNode())),
        getSubsetContent,
        getPromptTemplate,
        unregisterPendingRun,
        getPendingRunId: () => pendingRuns.get(node.dataset.nodeId) || null,
        getPromptName: () => promptNameOf(currentPromptNode()),
        getUniqueDatasetExportName: findUniqueDatasetExportName,
        isRunNameAlreadyUsedForPrompt,
        onWorkingSetChange: onRunWorkingSetChange,
        getRunMappingsFromCanvas: () => Array.from(nodesLayer.querySelectorAll('.workflow-node--run')).map((n) => {
          try {
            const raw = n.dataset.runInputToColumn;
            if (!raw) return null;
            const o = JSON.parse(raw);
            return typeof o === 'object' && o !== null ? o : null;
          } catch (_) { return null; }
        }).filter(Boolean),
      });
    });

    return node;
  }

  /** Process node: runs user-written process(df), with one primary Dataset and optional named inputs. */
  function createProcessNode({ left, top, nodeId: givenNodeId, title: givenTitle, code, dfCode, primaryDatasetId = '', datasetAliases = '' }) {
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
    if (primaryDatasetId) node.dataset.processPrimaryDatasetId = String(primaryDatasetId);
    if (datasetAliases) node.dataset.processDatasetAliases = String(datasetAliases);
    const position = allocateNodePosition(left, top);
    setNodeCanvasPosition(node, position.left, position.top);
    node.innerHTML = `
      <div class="workflow-node__header">
        <span class="workflow-node__icon workflow-node__icon--process" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 3L1 7l3 4M10 3l3 4-3 4"/></svg></span>
        <span class="workflow-node__title">${escapeHtml(processTitle)}</span>
        <button type="button" class="workflow-node__delete" aria-label="Delete node">×</button>
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
      const processNodeId = node.dataset.nodeId;
      function getProcessDatasets() {
        const datasets = Array.from(nodesLayer.querySelectorAll('.workflow-node--dataset'))
          .map((datasetNode) => {
            const savedColorIndex = datasetNode.dataset.datasetColorIndex != null
              ? parseInt(datasetNode.dataset.datasetColorIndex, 10)
              : 0;
            const colorIndex = Number.isFinite(savedColorIndex) && savedColorIndex >= 0
              ? savedColorIndex % DATASET_BORDER_COLORS.length
              : 0;
            return {
              nodeId: datasetNode.dataset.nodeId,
              name: datasetNode.dataset.datasetName || 'Dataset',
              color: datasetColorAt(colorIndex),
              content: datasetContentByNodeId.get(datasetNode.dataset.nodeId),
            };
          })
          .filter((dataset) => dataset.content);
        const incoming = getConnectionsList().find((connection) => (
          connection.toId === processNodeId && connection.type === 'dataset-to-process'
        ));
        const primaryDatasetId = datasets.some((dataset) => dataset.nodeId === node.dataset.processPrimaryDatasetId)
          ? node.dataset.processPrimaryDatasetId
          : (incoming?.fromId || '');
        if (primaryDatasetId) node.dataset.processPrimaryDatasetId = primaryDatasetId;
        return { datasets, primaryDatasetId };
      }
      function syncProcessDependencies(code) {
        const { datasets, primaryDatasetId } = getProcessDatasets();
        const bindings = buildProcessDatasetBindings(datasets, primaryDatasetId);
        node.dataset.processDatasetAliases = JSON.stringify(Object.fromEntries(bindings.map((binding) => [binding.nodeId, binding.alias])));
        const required = new Set([primaryDatasetId, ...referencedDatasetAliases(code, bindings)]);
        const allConnections = getConnectionsList();
        for (let index = allConnections.length - 1; index >= 0; index -= 1) {
          if (allConnections[index].toId === processNodeId && allConnections[index].type === 'dataset-to-process') allConnections.splice(index, 1);
        }
        bindings.filter((binding) => required.has(binding.nodeId)).forEach((binding) => {
          allConnections.push({ fromId: binding.nodeId, toId: processNodeId, type: 'dataset-to-process' });
        });
        updateEdges();
        emitCanvasChanged();
      }
      openProcessDetailModal({
        node,
        runProcessNode,
        getProcessDatasets,
        syncProcessDependencies,
        setPrimaryDataset: (datasetNodeId, code) => {
          if (datasetNodeId) node.dataset.processPrimaryDatasetId = datasetNodeId;
          else delete node.dataset.processPrimaryDatasetId;
          syncProcessDependencies(code);
        },
        getUniqueDatasetExportName: findUniqueDatasetExportName,
      });
    });

    return node;
  }

  function createScoreNode({ left, top, nodeId: givenNodeId, title: givenTitle }) {
    const nodeId = givenNodeId || generateNodeId();
    const node = document.createElement('div');
    node.className = 'workflow-node workflow-node--score workflow-node--no-body';
    node.setAttribute('role', 'article');
    node.setAttribute('aria-label', 'Score node');
    node.dataset.nodeId = nodeId;
    node.dataset.nodeType = 'score';
    const scoreTitle = (givenTitle != null && givenTitle !== '') ? String(givenTitle) : 'Score';
    const position = allocateNodePosition(left, top);
    setNodeCanvasPosition(node, position.left, position.top);
    node.innerHTML = `
      <div class="workflow-node__header">
        <span class="workflow-node__icon workflow-node__icon--score" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8v4M6 5v7M9 3v9M12 6v6"/></svg></span>
        <span class="workflow-node__title">${escapeHtml(scoreTitle)}</span>
        <button type="button" class="workflow-node__delete" aria-label="Delete node">×</button>
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
        const wsId = (runNode.dataset.runWorkingSetId || '').trim();
        const wsContent = wsId ? datasetContentByNodeId.get(wsId) : null;
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
        const wsId = (runNode && runNode.dataset.runWorkingSetId) ? runNode.dataset.runWorkingSetId.trim() : '';
        const c = wsId ? datasetContentByNodeId.get(wsId) : null;
        return c ? { headers: (c.headers || []).slice(), rows: (c.rows || []).map((r) => r.slice()) } : { headers: [], rows: [] };
      }
      function getGroundTruthContent(wsNodeId) {
        const c = datasetContentByNodeId.get(wsNodeId || '');
        if (!c) return { headers: [], rows: [] };
        return { headers: (c.headers || []).slice(), rows: (c.rows || []).map((r) => r.slice()) };
      }
      async function getReviewPayload() {
        if (!promptNode || !runNode || !node) return null;
        let sections = [];
        try {
          sections = JSON.parse(promptNode.dataset.promptSections || promptNode.dataset.promptFields || '[]');
        } catch (_) {}
        if (!Array.isArray(sections) || sections.length === 0) return null;
        const promptFullText = sections.map((s) => `## ${(s.name || '').trim() || '(unnamed)'}\n\n${(s.content || '').trim()}`).join('\n\n');
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
        const comparison_rows = await buildReviewComparisonRows(node, runNode, datasetContentByNodeId, sections);
        return {
          prompt_sections: sections,
          prompt_full_text: promptFullText,
          run_results: runResults,
          output_fields: outputFields,
          output_schema,
          comparison_rows,
          review_method: (node.dataset.reviewMethod || '').trim() || undefined,
          score_mapping: node.dataset.scoreMapping || undefined,
          target_section_index: Number.isInteger(parseInt(node.dataset.gepaTargetSectionIndex, 10))
            ? parseInt(node.dataset.gepaTargetSectionIndex, 10)
            : undefined,
          settings_overrides: reviewSettingsOverrides(node),
        };
      }
      openScoreDetailModal({
        node,
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
    node.setAttribute('aria-label', 'Review node');
    node.dataset.nodeId = nodeId;
    node.dataset.nodeType = 'promptReview';
    const promptReviewTitle = (givenTitle != null && givenTitle !== '') ? String(givenTitle) : 'Review';
    node.dataset.promptReviewName = String(promptReviewTitle || '').trim() || 'Review';
    const position = allocateNodePosition(left, top);
    setNodeCanvasPosition(node, position.left, position.top);
    node.innerHTML = `
      <div class="workflow-node__header">
        <span class="workflow-node__icon workflow-node__icon--prompt-review" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="2" width="10" height="10" rx="1"/><path d="M4 7l2.5 2.5L10 4"/></svg></span>
        <span class="workflow-node__title">${escapeHtml(promptReviewTitle)}</span>
        <button type="button" class="workflow-node__delete" aria-label="Delete node">×</button>
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
        let sections = [];
        try {
          sections = JSON.parse(promptNode.dataset.promptSections || promptNode.dataset.promptFields || '[]');
        } catch (_) {}
        if (!Array.isArray(sections) || sections.length === 0) return null;
        const promptFullText = sections.map((s) => `## ${(s.name || '').trim() || '(unnamed)'}\n\n${(s.content || '').trim()}`).join('\n\n');
        let runResults = [];
        let outputFields = [];
        try {
          runResults = JSON.parse(runNode.dataset.runResults || '[]');
          outputFields = JSON.parse(runNode.dataset.runOutputFields || '[]');
        } catch (_) {}
        const comparison_rows = await buildReviewComparisonRows(scoreNode, runNode, datasetContentByNodeId, sections);
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
        const runWsId = (runNode.dataset.runWorkingSetId || '').trim();
        const gtId = (scoreNode.dataset.scoreGroundTruthId || '').trim();
        let run_input_to_column = {};
        try {
          const raw = runNode.dataset.runInputToColumn || '{}';
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') run_input_to_column = parsed;
        } catch (_) {}
        const run_credential_id = await resolveRunCredentialId(runNode);
        return {
          prompt_sections: sections,
          prompt_full_text: promptFullText,
          run_results: runResults,
          output_fields: outputFields,
          comparison_rows,
          output_schema,
          score_mapping: scoreNode.dataset.scoreMapping || '[]',
          run_credential_id,
          run_input_to_column,
          getRunWorkingSetContent: () => runWsId ? (datasetContentByNodeId.get(runWsId) || { headers: [], rows: [] }) : { headers: [], rows: [] },
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
      function onExportNewPrompt(sections) {
        document.dispatchEvent(new CustomEvent('workflow:add-prompt-from-review', {
          detail: { sections, afterReviewNodeId: node.dataset.nodeId },
        }));
      }
      openReviewDetailModal({
        node,
        getPayload,
        getReviewResult,
        updateReviewResult,
        onExportNewPrompt,
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
