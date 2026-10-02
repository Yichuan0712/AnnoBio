/**
 * Runs Process code through the backend's /api/process/df/run job, the same request the Process
 * detail view sends: `df` is the primary Dataset and every other canvas Dataset is its
 * df_<name> alias. Used by the Agent (try_process, and running a Process node it was asked to run).
 */
import { BACKEND_API_BASE } from './backendConfig.js';
import { getCurrentProjectId } from './currentProject.js';
import { cloneCell, isAssetCell, normalizeDatasetContent } from './datasetContent.js';
import { prepareAssets } from './runClient.js';

const POLL_MS = 700;
const MAX_WAIT_MS = 5 * 60 * 1000;

function rowsHaveAssetCells(rows) {
  return (rows || []).some((row) => (row || []).some((cell) => isAssetCell(cell)));
}

/** The backend returns each branch as a list of row objects; the canvas stores {headers, rows}. */
export function rowsFromDicts(rowDicts) {
  const keys = [];
  (rowDicts || []).forEach((row) => {
    if (!row || typeof row !== 'object') return;
    Object.keys(row).forEach((key) => { if (!keys.includes(key)) keys.push(key); });
  });
  const rows = (rowDicts || []).map((row) => keys.map((key) => (row && typeof row === 'object' ? cloneCell(row[key]) : '')));
  return normalizeDatasetContent({ headers: keys, rows });
}

async function readPythonPath() {
  const res = await fetch(`${BACKEND_API_BASE}/api/settings`);
  const settings = res.ok ? await res.json() : null;
  const pythonPath = String(settings?.python_path || '').trim();
  if (!pythonPath) throw new Error('No Python interpreter is set. Choose one in Settings → Python.');
  return pythonPath;
}

/**
 * @param {{code: string, bindings: {alias: string, primary: boolean, content: {headers: string[], rows: any[][]}}[],
 *   signal?: AbortSignal, onStarted?: (jobId: string) => void, timeoutMs?: number}} options
 * @returns {Promise<{outputs: Record<string, {headers: string[], rows: any[][]}>, cancelled: boolean}>}
 *   throws with the Process error (traceback text) when the code fails
 */
export async function runProcessCode({ code, bindings, signal, onStarted, timeoutMs = MAX_WAIT_MS }) {
  const primary = bindings.find((binding) => binding.primary);
  if (!primary) throw new Error('The Process has no primary Dataset.');
  const pythonPath = await readPythonPath();
  const allRows = bindings.flatMap((binding) => binding.content?.rows || []);
  const session = rowsHaveAssetCells(allRows) ? await prepareAssets(getCurrentProjectId()) : {};
  const start = await fetch(`${BACKEND_API_BASE}/api/process/df/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      python_path: pythonPath,
      code,
      headers: primary.content.headers,
      rows: primary.content.rows,
      input_datasets: Object.fromEntries(bindings.map((binding) => [binding.alias, binding.content])),
      primary_dataset_id: 'df',
      ...session,
    }),
    signal,
  });
  const started = await start.json().catch(() => ({}));
  if (!start.ok) throw new Error(typeof started.detail === 'string' ? started.detail : 'The Process could not be started.');
  const jobId = started.job_id;
  const cancel = () => fetch(`${BACKEND_API_BASE}/api/process/df/run/cancel/${jobId}`, { method: 'POST' }).catch(() => {});
  try { await onStarted?.(jobId); } catch (error) { await cancel(); throw error; }
  signal?.addEventListener('abort', cancel, { once: true });
  const startedAt = Date.now();
  try {
    for (;;) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (timeoutMs > 0 && Date.now() - startedAt > timeoutMs) {
        cancel();
        throw new Error('The Process took longer than 5 minutes and was stopped.');
      }
      const res = await fetch(`${BACKEND_API_BASE}/api/process/df/run/result/${jobId}`, { signal });
      const data = await res.json().catch(() => ({}));
      if (!res.ok && res.status !== 202) throw new Error(data.detail || 'Could not read the Process result.');
      if (data.status === 'running') {
        await new Promise((resolve) => { setTimeout(resolve, POLL_MS); });
        continue;
      }
      if (data.error) throw new Error(String(data.error));
      const outputs = Object.fromEntries(Object.entries(data.outputs || {})
        .map(([branch, rowDicts]) => {
          const { headers, rows } = rowsFromDicts(rowDicts);
          return [branch, { headers, rows }];
        }));
      return { outputs, cancelled: data.status === 'cancelled' };
    }
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}
