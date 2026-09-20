/**
 * Browser-native stand-ins for the desktop-only image IPC calls in preload.js (pickImageFiles,
 * pickImageDirectory, resolveImageCandidates, importImages, imagePreview), backed by
 * backend/project_store.py's REST endpoints instead of local disk access. Used only from
 * datasetDetailModal.js, only when `window.electronAPI` is absent.
 */
import { BACKEND_API_BASE } from './backendConfig.js';

function pickFiles({ multiple = true, directory = false } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = multiple;
    if (directory) {
      // Chromium/Edge only — acceptable for an invite-only research-tool audience, matching
      // the tradeoff already made for the folder-relative-path import flow's UX.
      input.webkitdirectory = true;
    } else {
      input.accept = 'image/png,image/jpeg,image/webp';
    }
    input.style.display = 'none';
    function settle(files) {
      input.remove();
      resolve(files);
    }
    input.addEventListener('change', () => settle(Array.from(input.files || [])));
    input.addEventListener('cancel', () => settle([]));
    document.body.appendChild(input);
    input.click();
  });
}

/** @returns {Promise<File[]>} */
export function pickImageFiles() {
  return pickFiles({ multiple: true, directory: false });
}

/**
 * @returns {Promise<{ name: string, fileMap: Map<string, File>, fileCount: number } | null>}
 *   `fileMap` keys files by their path relative to the chosen folder (matching how a desktop
 *   "base folder" pick would resolve relative paths from a dataset's path column).
 */
export async function pickImageDirectory() {
  const files = await pickFiles({ multiple: true, directory: true });
  if (!files.length) return null;
  const fileMap = new Map();
  let rootName = '';
  for (const file of files) {
    const rel = file.webkitRelativePath || file.name;
    rootName = rootName || rel.split('/')[0] || '';
    const withoutRoot = rel.includes('/') ? rel.slice(rel.indexOf('/') + 1) : rel;
    fileMap.set(withoutRoot, file);
    fileMap.set(rel, file);
  }
  return { name: rootName, fileMap, fileCount: files.length };
}

/**
 * Client-side equivalent of main.js's `assets:resolve-candidates` IPC handler, matching row
 * values (a relative path, or a JSON array of them) against files picked via a folder input
 * instead of checking existence on a server-local disk. Returns the same
 * `{ok, files: [{path, name, exists, source}]}` shape, with `path` holding a File (or null)
 * instead of a resolved absolute path string.
 */
export function resolveImageCandidatesFromFileMap(rawValues, fileMap) {
  return rawValues.map((rawValue, rowIndex) => {
    try {
      const value = String(rawValue || '').trim();
      const rawPaths = value.startsWith('[') ? JSON.parse(value) : (value ? [value] : []);
      if (!Array.isArray(rawPaths) || rawPaths.some((item) => typeof item !== 'string')) {
        throw new Error('Use a path or a JSON array of paths.');
      }
      const files = rawPaths.map((entry) => {
        const normalized = entry.replace(/^\.\/+/, '').replace(/\\/g, '/');
        const file = fileMap.get(normalized) || null;
        const name = normalized.split('/').pop() || normalized;
        return { path: file, name, exists: !!file, source: entry };
      });
      return { ok: true, files };
    } catch (error) {
      return { ok: false, files: [], error: `Row ${rowIndex + 1}: ${error.message}` };
    }
  });
}

/** @param {File[]} files @returns {Promise<Array<{id, path, name, mime, bytes, width, height}>>} */
export async function importImages(projectId, files) {
  if (!projectId) throw new Error('Open a project before importing images.');
  if (!files.length) return [];
  const formData = new FormData();
  files.forEach((file) => formData.append('files', file));
  const res = await fetch(`${BACKEND_API_BASE}/api/projects/${projectId}/assets/import`, {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.detail || 'Could not import images.');
  }
  return res.json();
}

export async function imagePreview(projectId, assetId, thumbnail = true) {
  if (!projectId) throw new Error('Open a project before previewing images.');
  const res = await fetch(`${BACKEND_API_BASE}/api/projects/${projectId}/assets/${encodeURIComponent(assetId)}/preview?thumbnail=${thumbnail}`);
  if (!res.ok) throw new Error('Could not load image preview.');
  return res.json();
}

/** Triggers a browser download of the dataset as a CSV+images zip. */
export async function exportDatasetZip(projectId, content) {
  if (!projectId) throw new Error('Open a project before exporting.');
  const res = await fetch(`${BACKEND_API_BASE}/api/projects/${projectId}/export/dataset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(content),
  });
  if (!res.ok) throw new Error('Could not export dataset.');
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'dataset.zip';
  a.click();
  URL.revokeObjectURL(a.href);
}
