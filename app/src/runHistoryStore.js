import { BACKEND_API_BASE } from './backendConfig.js';

function desktopApi() {
  return typeof window !== 'undefined' ? window.electronAPI : null;
}

async function readJson(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.detail || response.statusText || 'History request failed.');
  return body;
}

function historyUrl(projectId, recordId = '') {
  if (!projectId) throw new Error('Open a project before using node history.');
  const base = `${BACKEND_API_BASE}/api/projects/${encodeURIComponent(projectId)}/history`;
  return recordId ? `${base}/${encodeURIComponent(recordId)}` : base;
}

export async function loadRunHistoryIndex(projectId) {
  const desktop = desktopApi();
  if (desktop) return desktop.loadRunHistoryIndex(projectId);
  return readJson(await fetch(historyUrl(projectId)));
}

export async function loadRunHistoryRecord(projectId, recordId) {
  const desktop = desktopApi();
  if (desktop) return desktop.loadRunHistoryRecord(projectId, recordId);
  return readJson(await fetch(historyUrl(projectId, recordId)));
}

export async function saveRunHistoryRecord(projectId, record) {
  const desktop = desktopApi();
  if (desktop) return desktop.saveRunHistoryRecord(projectId, record);
  return readJson(await fetch(historyUrl(projectId, record.id), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ record }),
  }));
}

export async function deleteRunHistoryRecords(projectId, recordId, expectedIds) {
  const desktop = desktopApi();
  if (desktop) return desktop.deleteRunHistoryRecords(projectId, recordId, expectedIds);
  return readJson(await fetch(`${historyUrl(projectId)}/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ record_id: recordId, expected_ids: expectedIds }),
  }));
}
