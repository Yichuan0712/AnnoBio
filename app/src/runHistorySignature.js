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

/** The Dataset fields an input signature covers; History also uses it to tell whether an input was edited. */
export const signedTable = (content) => ({
  headers: content.headers || [],
  columnTypes: content.columnTypes || [],
  rowIds: content.rowIds || [],
  rows: content.rows || [],
});

/**
 * @param {object} [editedContent] manual edit of a derived Dataset (datasetHistoryEdits.js); an edit
 *   changes the input like editing a raw Dataset does, while unedited derived signatures stay as before.
 */
export async function datasetSignature({ nodeId, content, sourceRecordId = '', branch = '', editedContent = null }) {
  if (!nodeId) throw new Error('Dataset node ID is required for history.');
  if (sourceRecordId) {
    if (!branch) throw new Error('Derived Dataset branch is required for history.');
    return sha256Signature({
      kind: 'derived-dataset', nodeId, sourceRecordId, branch,
      edited: editedContent ? signedTable(editedContent) : undefined,
    });
  }
  if (!content) throw new Error('Dataset has no current result.');
  return sha256Signature({ kind: 'dataset', nodeId, content: signedTable(content) });
}

export async function runInputSignature({ promptNodeId, prompt, datasetNodeId, datasetSignature: dataSignature, mapping }) {
  if (!promptNodeId || !datasetNodeId || !dataSignature) throw new Error('Run history input is incomplete.');
  return sha256Signature({
    kind: 'run', promptNodeId, datasetNodeId, datasetSignature: dataSignature,
    prompt: {
      sections: prompt?.sections || [],
      outputFormat: prompt?.outputFormat || [],
      returnShape: prompt?.returnShape || 'single',
      inputTypes: prompt?.inputTypes || {},
    },
    mapping: mapping || {},
  });
}

export async function processInputSignature({ code, primaryDatasetId, bindings }) {
  if (!primaryDatasetId || !Array.isArray(bindings) || !bindings.length) throw new Error('Process history input is incomplete.');
  return sha256Signature({
    kind: 'process', code: String(code || ''), primaryDatasetId,
    bindings: bindings.map(({ nodeId, alias, signature }) => ({ nodeId, alias, signature }))
      .sort((a, b) => a.nodeId.localeCompare(b.nodeId)),
  });
}
