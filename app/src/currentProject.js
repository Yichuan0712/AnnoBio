/**
 * Which project is currently open. Web uses its opaque project id for assets and persisted runs.
 * Desktop normally lets Electron own the path; Pipeline history uses the run owner kept in the
 * project file (pipelineOwnerFor) so a page reload can reattach without a temporary asset session.
 */
let currentProjectId = null;
let pipelineOwnerId = null;

function announceProjectChange() {
  if (globalThis.document && typeof globalThis.CustomEvent === 'function') {
    globalThis.document.dispatchEvent(new CustomEvent('workflow:project-changed', {
      detail: { projectId: currentProjectId },
    }));
  }
}

export function setCurrentProjectId(id) {
  currentProjectId = id || null;
  pipelineOwnerId = null;
  announceProjectChange();
}

/** Desktop: the run owner of the open file, set once its canvas has loaded. */
export function setPipelineOwnerId(id) {
  pipelineOwnerId = id || null;
  announceProjectChange();
}

export function getCurrentProjectId() {
  return currentProjectId;
}

async function pathKey(path) {
  const bytes = new TextEncoder().encode(String(path).replaceAll('\\', '/').toLowerCase());
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Desktop Pipeline runs belong to one project file, not to wherever a file sits: a copy, a moved file
 * or a new file at a deleted project's path must not list another file's runs. The file keeps the hash
 * of the path it was saved at plus a random id; opened at any other path (a copy, a move, Save As) it
 * gets a new owner. Replacing a file with an older version of itself keeps its owner, and its runs. */
export async function pipelineOwnerFor(projectPath, owner) {
  const at = await pathKey(projectPath);
  return owner?.at === at && owner?.id ? owner : { at, id: globalThis.crypto.randomUUID() };
}

/** Project owner for persisted Pipeline runs. Web already has an opaque project id. */
export async function getPipelineProjectId() {
  const value = String(currentProjectId || '').trim();
  if (!value) throw new Error('Open or save a project before running a Pipeline.');
  if (!globalThis.window?.electronAPI) return value;
  if (!pipelineOwnerId) throw new Error('The project is still opening.');
  return `desktop:${pipelineOwnerId}`;
}
