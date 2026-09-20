/**
 * Which project is currently open. Desktop code never reads this — Electron's own ProjectAssets
 * instance in the main process already knows, via the file path threaded through electronAPI
 * calls. It exists for the web build, where image-bearing run/review requests (see
 * runClient.js) need a project id to register that project's images against, and reach that
 * from modal/runtime modules that have no other path back to renderer.js's local state.
 */
let currentProjectId = null;

export function setCurrentProjectId(id) {
  currentProjectId = id || null;
}

export function getCurrentProjectId() {
  return currentProjectId;
}
