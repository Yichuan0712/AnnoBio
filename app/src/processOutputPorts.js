/**
 * The output branches of a Process node: what its code was detected to return (`processOutputPorts`,
 * from the backend's static detection in backend/process_outputs.py) and, once it has run, what its
 * current result returned.
 */
import { sha256Signature } from './runHistorySignature.js';

/**
 * A stored detection, or null when there is none or it is unreadable.
 * @param {object|string|undefined} value
 * @returns {{ ports: string[], dynamic: boolean, error: string, codeHash: string } | null}
 */
export function parseProcessOutputPorts(value) {
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch (_) { return null; }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return {
    ports: Array.isArray(parsed.ports) ? parsed.ports.filter((port) => typeof port === 'string' && port) : [],
    dynamic: parsed.dynamic === true,
    error: typeof parsed.error === 'string' ? parsed.error : '',
    codeHash: typeof parsed.codeHash === 'string' ? parsed.codeHash : '',
  };
}

/** The hash a detection is stored with, so unchanged code is not sent for detection again. */
export function codeHashOf(code) {
  return sha256Signature({ code: String(code || '') });
}

/** Branch names the current result returned, or null when the Process has no result. */
function resultPorts(dfResults) {
  let parsed = dfResults;
  if (typeof dfResults === 'string') {
    try { parsed = JSON.parse(dfResults); } catch (_) { return null; }
  }
  if (parsed?.outputs && typeof parsed.outputs === 'object' && Object.keys(parsed.outputs).length) {
    return Object.keys(parsed.outputs);
  }
  if (Array.isArray(parsed?.headers) && Array.isArray(parsed?.rows)) return ['result'];
  return null;
}

/**
 * The branches a Process offers downstream.
 * - With a result: a run returns one of the code's possible dicts, so the detected branches stay
 *   offered while the result's branches are among them. A branch the detection did not find means
 *   the detection was wrong: the result's branches are used and `mismatch` is set.
 * - Without a result: the detection, if it succeeded. A dynamic detection offers no branch yet.
 * @param {{ detected?: object|string, dfResults?: object|string }} node fields
 * @returns {{ ports: string[], dynamic: boolean, mismatch: boolean, source: 'run'|'code'|'none' }}
 */
export function effectiveProcessOutputs({ detected, dfResults }) {
  const parsed = parseProcessOutputPorts(detected);
  const known = parsed && !parsed.error ? parsed : null;
  const actual = resultPorts(dfResults);
  if (actual) {
    if (known && !known.dynamic) {
      if (actual.every((port) => known.ports.includes(port))) {
        return { ports: known.ports.slice(), dynamic: false, mismatch: false, source: 'run' };
      }
      return { ports: actual, dynamic: false, mismatch: true, source: 'run' };
    }
    return { ports: actual, dynamic: false, mismatch: false, source: 'run' };
  }
  if (known) return { ports: known.dynamic ? [] : known.ports.slice(), dynamic: known.dynamic, mismatch: false, source: 'code' };
  return { ports: [], dynamic: false, mismatch: false, source: 'none' };
}

/** Whether the node shows its branches: named ones, or the note that they are not known yet. */
export function showsProcessOutputs({ ports, dynamic }) {
  return dynamic || ports.length > 1 || (ports.length === 1 && ports[0] !== 'result');
}
