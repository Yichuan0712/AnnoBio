/** Canonical JSON keeps a signature stable across save/load and object key insertion order. */
export function canonicalJson(value) {
  const normalize = (item) => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.keys(item).sort()
        .filter((key) => item[key] !== undefined)
        .map((key) => [key, normalize(item[key])]));
    }
    return item;
  };
  return JSON.stringify(normalize(value));
}

export async function sha256Signature(value) {
  const encoded = new TextEncoder().encode(canonicalJson(value));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', encoded);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export async function datasetSignature({ nodeId, content }) {
  if (!nodeId) throw new Error('Dataset node ID is required for history.');
  if (!content) throw new Error('Dataset has no content.');
  return sha256Signature({
    kind: 'dataset', nodeId,
    content: {
      headers: content.headers || [],
      columnTypes: content.columnTypes || [],
      rowIds: content.rowIds || [],
      rows: content.rows || [],
    },
  });
}

export async function runInputSignature({ promptNodeId, prompt, datasetNodeId, datasetSignature: dataSignature, mapping }) {
  if (!promptNodeId || !datasetNodeId || !dataSignature) throw new Error('Run history input is incomplete.');
  return sha256Signature({
    kind: 'run', promptNodeId, datasetNodeId, datasetSignature: dataSignature,
    prompt: {
      text: String(prompt?.text || ''),
      outputFormat: prompt?.outputFormat || [],
      returnShape: prompt?.returnShape || 'single',
      inputTypes: prompt?.inputTypes || {},
    },
    mapping: mapping || {},
  });
}

/**
 * A Process's inputs as History signs them. Each binding is signed under its source key
 * (stepInputs.js sourceKey): a Dataset's node ID, or `node:port` for a step's output, since two
 * branches of one Process can both be inputs. `primaryDatasetId` is the key of the df binding.
 */
export async function processInputSignature({ code, primaryDatasetId, bindings }) {
  if (!primaryDatasetId || !Array.isArray(bindings) || !bindings.length) throw new Error('Process history input is incomplete.');
  return sha256Signature({
    kind: 'process', code: String(code || ''), primaryDatasetId,
    bindings: bindings.map(({ key, nodeId, alias, signature }) => ({ nodeId: key || nodeId, alias, signature }))
      .sort((a, b) => a.nodeId.localeCompare(b.nodeId)),
  });
}

/** One port of a Run or Process as of one of its History records: what a step input signs. */
export async function stepOutputSignature({ nodeId, recordId, port }) {
  if (!nodeId || !recordId || !port) throw new Error('Step output history input is incomplete.');
  return sha256Signature({ kind: 'step-output', nodeId, recordId, port });
}
