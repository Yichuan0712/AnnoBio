/**
 * Which project is currently open. Web uses its opaque project id for assets and persisted runs.
 * Desktop normally lets Electron own the path, but Pipeline history derives a non-path stable id
 * from this resolved path so a page reload can reattach without using a temporary asset session.
 */
let currentProjectId = null;

export function setCurrentProjectId(id) {
  currentProjectId = id || null;
  if (globalThis.document && typeof globalThis.CustomEvent === 'function') {
    globalThis.document.dispatchEvent(new CustomEvent('workflow:project-changed', {
      detail: { projectId: currentProjectId },
    }));
  }
}

export function getCurrentProjectId() {
  return currentProjectId;
}

/** Stable, non-path project owner for persisted Pipeline runs.
 * Web already has an opaque project id. Desktop derives one from Electron's resolved project path;
 * Save As intentionally creates a different run-history owner. */
export async function getPipelineProjectId() {
  const value = String(currentProjectId || '').trim();
  if (!value) throw new Error('Open or save a project before running a Pipeline.');
  if (!globalThis.window?.electronAPI) return value;
  const bytes = new TextEncoder().encode(value.replaceAll('\\', '/').toLowerCase());
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `desktop:${hex}`;
}
