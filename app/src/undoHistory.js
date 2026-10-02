/**
 * Undo/redo for the workflow canvas.
 *
 * Node state lives on scattered DOM `dataset` attributes (see workflowCanvas.js), not a central
 * store, so there's no single place to hook a command/action pattern into. Instead this snapshots
 * the same full-state shape getCanvasState()/loadCanvasState() already use for save/load, and
 * treats "undo" as "restore an earlier snapshot" — reusing plumbing that's exercised on every
 * save/open instead of inventing a second serialization path.
 *
 * Run/Review/Score-match jobs stream partial results into existing nodes via repeated
 * `workflow:canvas-changed` events while they're in flight; those aren't something the user
 * authored and the backend job can't be un-run, so they shouldn't spam the undo stack. A snapshot
 * is only pushed when the fields a user actually edits (name/note/sections/mapping/position/...)
 * differ from the last pushed snapshot — see VOLATILE_FIELDS_BY_TYPE.
 *
 * For the same reason undo/redo never roll those fields back: snapshots store only what the user
 * authored, and a restore puts back each node's latest job output from the live canvas. Otherwise
 * undoing an edit made before a run would erase the run's paid results (and autosave them away).
 */

const MAX_HISTORY = 50;

const VOLATILE_FIELDS_BY_TYPE = {
  run: ['runResults', 'runCompleted', 'runPending', 'runProgress', 'runInputContent', 'runOutputBracketCollapsed'],
  score: ['reviewResult', 'scoreMatchResult', 'scoreOutputBracketCollapsed', 'scoreGtBracketCollapsed', 'scoreTableRulesColumnFilter'],
  promptReview: ['reviewResult', 'reviewProgress', 'reviewPending'],
  process: ['results', 'dfResults'],
};

function stripVolatileFields(state) {
  const nodes = Array.isArray(state?.nodes)
    ? state.nodes.map((n) => {
        const drop = VOLATILE_FIELDS_BY_TYPE[n?.type];
        if (!drop) return n;
        const copy = { ...n };
        for (const key of drop) delete copy[key];
        return copy;
      })
    : [];
  return { ...state, nodes, connections: state?.connections || [] };
}

function fingerprint(snapshot) {
  try {
    return JSON.stringify(snapshot);
  } catch (_) {
    return String(Math.random());
  }
}

/** A node's job-output fields, including which ones are absent (cleared results stay cleared). */
function volatileFieldsOf(node) {
  const keys = VOLATILE_FIELDS_BY_TYPE[node?.type];
  if (!keys) return null;
  return Object.fromEntries(keys.filter((key) => node[key] !== undefined).map((key) => [key, node[key]]));
}

/**
 * @param {{ loadCanvasState: (state: object) => void, getCanvasState?: () => object,
 *   onChange?: (info: { canUndo: boolean, canRedo: boolean }) => void }} deps getCanvasState reads
 *   the live canvas right before a restore, so job output that changed since the last push is kept.
 */
export function createUndoHistory({ loadCanvasState, getCanvasState, onChange } = {}) {
  /** @type {object[]} */
  let past = []; // past[past.length - 1] is the current state, without job-output fields
  /** @type {object[]} */
  let future = [];
  let lastFingerprint = null;
  let restoring = false;
  /** Latest job output per node id. Kept for removed nodes too, so undoing a delete (or redoing an
   * add) brings the node back with the results it had, not the ones from when it was snapshotted. */
  let latestOutputs = new Map();

  function recordOutputs(state) {
    for (const node of Array.isArray(state?.nodes) ? state.nodes : []) {
      const fields = volatileFieldsOf(node);
      if (fields && node.nodeId) latestOutputs.set(node.nodeId, { type: node.type, fields });
    }
  }

  function withLatestOutputs(snapshot) {
    return {
      ...snapshot,
      nodes: snapshot.nodes.map((node) => {
        const latest = latestOutputs.get(node.nodeId);
        return latest && latest.type === node.type ? { ...node, ...latest.fields } : node;
      }),
    };
  }

  function notify() {
    onChange?.({ canUndo: past.length > 1, canRedo: future.length > 0 });
  }

  /** Call once at startup and every time a project is loaded/created/merged — undo history doesn't cross project boundaries. */
  function reset(state) {
    latestOutputs = new Map();
    recordOutputs(state);
    const snapshot = state ? stripVolatileFields(state) : null;
    past = snapshot ? [snapshot] : [];
    future = [];
    lastFingerprint = snapshot ? fingerprint(snapshot) : null;
    notify();
  }

  /** Call after every settled canvas edit (mirrors the existing autosave's `workflow:canvas-changed` hook). */
  function push(state) {
    if (restoring || !state) return;
    recordOutputs(state);
    const snapshot = stripVolatileFields(state);
    const fp = fingerprint(snapshot);
    if (fp === lastFingerprint) return; // only volatile (job-result) fields changed
    past.push(snapshot);
    if (past.length > MAX_HISTORY) past.shift();
    future = [];
    lastFingerprint = fp;
    notify();
  }

  function restore(snapshot) {
    if (getCanvasState) recordOutputs(getCanvasState());
    restoring = true;
    try {
      loadCanvasState(withLatestOutputs(snapshot));
      // loadCanvasState() doesn't fire workflow:canvas-changed itself (unlike a live user edit) —
      // dispatch it so the existing autosave listener persists the restored state, same as any
      // other change. The `restoring` guard above keeps this from bouncing back into push().
      document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
    } finally {
      restoring = false;
    }
    lastFingerprint = fingerprint(snapshot);
  }

  function undo() {
    if (past.length <= 1) return;
    const current = past.pop();
    future.push(current);
    restore(past[past.length - 1]);
    notify();
  }

  function redo() {
    if (future.length === 0) return;
    const next = future.pop();
    past.push(next);
    restore(next);
    notify();
  }

  return {
    reset,
    push,
    undo,
    redo,
    canUndo: () => past.length > 1,
    canRedo: () => future.length > 0,
  };
}
