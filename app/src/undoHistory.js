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
  return { nodes, connections: state?.connections || [] };
}

function fingerprint(state) {
  try {
    return JSON.stringify(stripVolatileFields(state));
  } catch (_) {
    return String(Math.random());
  }
}

/**
 * @param {{ loadCanvasState: (state: object) => void, onChange?: (info: { canUndo: boolean, canRedo: boolean }) => void }} deps
 */
export function createUndoHistory({ loadCanvasState, onChange } = {}) {
  /** @type {object[]} */
  let past = []; // past[past.length - 1] is the current state
  /** @type {object[]} */
  let future = [];
  let lastFingerprint = null;
  let restoring = false;

  function notify() {
    onChange?.({ canUndo: past.length > 1, canRedo: future.length > 0 });
  }

  /** Call once at startup and every time a project is loaded/created/merged — undo history doesn't cross project boundaries. */
  function reset(state) {
    past = state ? [state] : [];
    future = [];
    lastFingerprint = state ? fingerprint(state) : null;
    notify();
  }

  /** Call after every settled canvas edit (mirrors the existing autosave's `workflow:canvas-changed` hook). */
  function push(state) {
    if (restoring || !state) return;
    const fp = fingerprint(state);
    if (fp === lastFingerprint) return; // only volatile (job-result) fields changed
    past.push(state);
    if (past.length > MAX_HISTORY) past.shift();
    future = [];
    lastFingerprint = fp;
    notify();
  }

  function restore(state) {
    restoring = true;
    try {
      loadCanvasState(state);
      // loadCanvasState() doesn't fire workflow:canvas-changed itself (unlike a live user edit) —
      // dispatch it so the existing autosave listener persists the restored state, same as any
      // other change. The `restoring` guard above keeps this from bouncing back into push().
      document.dispatchEvent(new CustomEvent('workflow:canvas-changed'));
    } finally {
      restoring = false;
    }
    lastFingerprint = fingerprint(state);
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
