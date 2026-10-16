import { BACKEND_API_BASE } from './backendConfig.js';
import { cloneCell, isAssetCell } from './datasetContent.js';
import { getCurrentProjectId } from './currentProject.js';
import { prepareAssets } from './runClient.js';
import { isValidRunOutputForScoreRow } from './scoreMatchPrimitives.js';

export function buildMatchRunRowInputDict(result, input) {
  const values = typeof result?.input_row_index === 'number' ? input?.rows?.[result.input_row_index] || [] : [];
  return Object.fromEntries((input?.headers || []).map((header, index) => [String(header ?? ''), cloneCell(values[index])]));
}

export function buildMatchRunRowOutputDict(result) {
  const output = result?.output && typeof result.output === 'object' ? result.output : {};
  return Object.fromEntries(Object.entries(output).map(([key, value]) => [key, value == null ? '' : String(value)]));
}

export function buildMatchGtRowDict(content, rowIndex) {
  return Object.fromEntries((content?.headers || []).map((header, index) => [String(header ?? ''), cloneCell(content.rows?.[rowIndex]?.[index])]));
}

export function buildCodeMatchInputs({ results, outputFields, input, groundTruth }) {
  const valid = (results || []).filter((result) => isValidRunOutputForScoreRow(result, outputFields || []));
  if (!valid.length) throw new Error('No model outputs to match.');
  if (!groundTruth?.rows?.length) throw new Error('Ground truth dataset has no rows.');
  return {
    runRowIndices: valid.map((result) => result.row_index),
    runRows: valid.map((result) => ({ input_row: buildMatchRunRowInputDict(result, input), output_row: buildMatchRunRowOutputDict(result) })),
    gtRows: groundTruth.rows.map((_, index) => ({ gt_row: buildMatchGtRowDict(groundTruth, index) })),
  };
}

/** The Score window's code-matching job, with its input/output dictionaries and partial results. */
export async function runScoreCode({ code, results, outputFields, input, groundTruth, signal, onStarted, onProgress,
  pollMs = 700, timeoutMs = 5 * 60 * 1000 }) {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const payload = buildCodeMatchInputs({ results, outputFields, input, groundTruth });
  const settingsResponse = await fetch(`${BACKEND_API_BASE}/api/settings`, { signal });
  const settings = settingsResponse.ok ? await settingsResponse.json() : {};
  const pythonPath = String(settings.python_path || '').trim();
  if (!pythonPath) throw new Error('Set a Python interpreter path in Settings → Python first.');
  const cells = [...payload.runRows.flatMap((row) => [...Object.values(row.input_row), ...Object.values(row.output_row)]),
    ...payload.gtRows.flatMap((row) => Object.values(row.gt_row))];
  const session = cells.some(isAssetCell) ? await prepareAssets(getCurrentProjectId()) : {};
  const response = await fetch(`${BACKEND_API_BASE}/api/score/match/run`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({ python_path: pythonPath, code, run_rows: payload.runRows, gt_rows: payload.gtRows, ...session }),
  });
  const started = await response.json().catch(() => ({}));
  if (!response.ok || !started.job_id) throw new Error(typeof started.detail === 'string' ? started.detail : 'Failed to start code matching.');
  const jobId = started.job_id;
  let stopRequested = false;
  const cancel = () => {
    if (stopRequested) return;
    stopRequested = true;
    void fetch(`${BACKEND_API_BASE}/api/score/match/run/cancel/${jobId}`, { method: 'POST' }).catch(() => {});
  };
  signal?.addEventListener('abort', cancel, { once: true });
  const startedAt = Date.now();
  try {
    await onStarted?.(jobId);
    if (signal?.aborted) cancel();
    for (;;) {
      if (timeoutMs > 0 && Date.now() - startedAt > timeoutMs) throw new Error('Code matching timed out and was stopped.');
      // Keep polling after cancellation to retain the partial results returned by the Score API.
      const poll = await fetch(`${BACKEND_API_BASE}/api/score/match/run/result/${jobId}`);
      const data = await poll.json().catch(() => ({}));
      if (!poll.ok && poll.status !== 202) throw new Error(data.detail || 'Could not read code matching results.');
      onProgress?.(data.completed ?? data.results?.length ?? 0, data.total || payload.runRows.length);
      if (data.status === 'running') { await new Promise((resolve) => setTimeout(resolve, pollMs)); continue; }
      if (data.error) throw new Error(String(data.error));
      if (!['done', 'completed', 'cancelled'].includes(data.status)) throw new Error('Invalid code matching result.');
      return { ...payload, outcomes: data.results || [], gtRowCount: payload.gtRows.length,
        wasCancelled: stopRequested || data.status === 'cancelled' };
    }
  } catch (error) {
    cancel();
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}
