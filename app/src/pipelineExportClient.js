import { BACKEND_API_BASE } from './backendConfig.js';

function selectedNodeIds(route) {
  const ids = new Set();
  for (const item of route || []) {
    for (const key of ['dataset_node_id', 'process_node_id', 'prompt_node_id', 'run_node_id']) {
      if (item?.[key]) ids.add(item[key]);
    }
  }
  return ids;
}

/** Keep the export request code-only: Dataset rows, cached results and review state never leave the renderer. */
function exportCanvasDefinition(canvasState, route) {
  const ids = selectedNodeIds(route);
  const nodes = (canvasState?.nodes || [])
    .filter((node) => ids.has(node?.nodeId))
    .map((node) => {
      if (node.type === 'dataset') {
        return {
          type: 'dataset',
          nodeId: node.nodeId,
          name: node.name,
          sourceRunNodeId: node.sourceRunNodeId,
          processOutputName: node.processOutputName,
          datasetContent: {
            headers: node.datasetContent?.headers || [],
            columnTypes: node.datasetContent?.columnTypes || [],
          },
        };
      }
      if (node.type === 'process') {
        return {
          type: 'process',
          nodeId: node.nodeId,
          name: node.name,
          code: node.code,
          dfCode: node.dfCode,
          activeMode: node.activeMode,
          primaryDatasetId: node.primaryDatasetId,
        };
      }
      if (node.type === 'prompt') {
        return {
          type: 'prompt',
          nodeId: node.nodeId,
          name: node.name,
          note: node.note,
          sections: node.sections,
          outputFormat: node.outputFormat,
          inputTypes: node.inputTypes,
        };
      }
      if (node.type === 'run') {
        return {
          type: 'run',
          nodeId: node.nodeId,
          runName: node.runName,
          runWorkingSetId: node.runWorkingSetId,
          runCredentialId: node.runCredentialId,
          runInputToColumn: node.runInputToColumn,
        };
      }
      return null;
    })
    .filter(Boolean);
  const executableEdgeTypes = new Set([
    'dataset-to-process',
    'process-to-dataset',
    'prompt-to-run',
    'prompt-to-prompt',
  ]);
  const connections = (canvasState?.connections || []).filter((edge) => (
    executableEdgeTypes.has(edge?.type) && ids.has(edge?.fromId) && ids.has(edge?.toId)
  ));
  return { version: canvasState?.version || 2, nodes, connections };
}

function downloadName(response, fallback) {
  const disposition = response.headers.get('Content-Disposition') || '';
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try { return decodeURIComponent(encoded); } catch (_) {}
  }
  return disposition.match(/filename="([^"]+)"/i)?.[1] || fallback;
}

/**
 * Ask the backend to validate and package one concrete Current Pipeline route.
 *
 * The payload contains live canvas configuration but no credentials beyond their opaque ids. The
 * backend writes only non-secret model metadata into the archive and never includes Dataset rows.
 */
export async function exportPythonPipeline({ name, canvasState, route }) {
  const response = await fetch(`${BACKEND_API_BASE}/api/pipeline/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, canvas_state: exportCanvasDefinition(canvasState, route), route }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(typeof body.detail === 'string' ? body.detail : 'Could not export this Pipeline.');
  }
  const blob = await response.blob();
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = downloadName(response, `${name || 'pipeline'}.zip`);
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(href), 0);
}
