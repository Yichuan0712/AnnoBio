/** Transient cancellation handles shared by canvas jobs and node windows, never saved in projects. */
import { getCurrentProjectId } from './currentProject.js';
const active = new Map();
const keyFor = (nodeId) => `${getCurrentProjectId() || ''}\0${nodeId}`;

export function hasNodeExecution(nodeId) { return active.has(keyFor(nodeId)); }
export function nodeExecutionIdentity(nodeId) { return active.get(keyFor(nodeId))?.id || null; }

export function registerNodeStop(nodeId, stop) {
  const key = keyFor(nodeId);
  if (active.has(key)) throw new Error('This node already has an active task.');
  const task = { stop, id: globalThis.crypto.randomUUID() };
  active.set(key, task);
  return () => { if (active.get(key) === task) active.delete(key); };
}

export async function stopNodeExecution(nodeId) {
  const task = active.get(keyFor(nodeId));
  if (!task) return false;
  await task.stop();
  return true;
}

/** Remember a stop requested while an API job is still starting, then cancel its exact job ID. */
export function registerNodeJob(nodeId, cancel) {
  let jobId = '';
  let stopped = false;
  const release = registerNodeStop(nodeId, async () => {
    stopped = true;
    if (jobId) await cancel(jobId);
  });
  return { release, get stopped() { return stopped; },
    async started(id) { jobId = id; if (stopped) await cancel(id); } };
}
