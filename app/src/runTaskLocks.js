/**
 * The nodes a Run to here task (runTo.js) holds until it ends: its steps, their Prompts and the
 * Datasets they read. While held, their inputs and content cannot change, so each later step runs
 * with what the confirmed plan showed. Transient, per open project, never saved.
 */
import { getCurrentProjectId } from './currentProject.js';

const held = new Map();
const keyFor = (nodeId) => `${getCurrentProjectId() || ''}\0${nodeId}`;

function announce() {
  if (globalThis.document && typeof globalThis.CustomEvent === 'function') {
    globalThis.document.dispatchEvent(new CustomEvent('workflow:run-task-locks-changed'));
  }
}

export function isTaskLocked(nodeId) {
  return held.has(keyFor(String(nodeId || '')));
}

/** The held node IDs of the open project. */
export function taskLockedIds() {
  const prefix = `${getCurrentProjectId() || ''}\0`;
  return [...held.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
}

/**
 * Holds `nodeIds` for one task. Throws when one is already held by another task.
 * @returns {() => void} releases them; safe to call more than once
 */
export function holdNodes(nodeIds) {
  const ids = [...new Set((nodeIds || []).map(String).filter(Boolean))];
  const taken = ids.find((id) => isTaskLocked(id));
  if (taken) throw new Error('Part of this plan is already in another run in progress.');
  const task = {};
  const keys = ids.map(keyFor);
  for (const key of keys) held.set(key, task);
  announce();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const key of keys) if (held.get(key) === task) held.delete(key);
    announce();
  };
}
