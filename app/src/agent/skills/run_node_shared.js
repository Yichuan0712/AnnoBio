function toCleanString(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeBoolean(value, fallback = false) {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizeNodeId(value, label) {
  const normalized = toCleanString(value);
  if (!normalized) {
    throw new Error(`${label} is required.`);
  }
  return normalized;
}

function normalizeMappingObject(value) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Run input mapping must be an object.');
  }
  const normalized = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = toCleanString(rawKey);
    if (!key) continue;
    normalized[key] = toCleanString(rawValue);
  }
  return normalized;
}

function getSnapshotNodes(workflowSnapshot) {
  return Array.isArray(workflowSnapshot?.nodes) ? workflowSnapshot.nodes : [];
}

export function findWorkflowNodeById(workflowSnapshot, nodeId) {
  const normalizedNodeId = toCleanString(nodeId);
  if (!normalizedNodeId) return null;
  return getSnapshotNodes(workflowSnapshot).find((node) => toCleanString(node?.id) === normalizedNodeId) || null;
}

export function getPromptInputFieldsFromSnapshot(workflowSnapshot, promptNodeId) {
  const promptNode = findWorkflowNodeById(workflowSnapshot, promptNodeId);
  if (!promptNode || String(promptNode?.type || '').trim() !== 'prompt') {
    throw new Error('Prompt node was not found.');
  }
  return Array.isArray(promptNode?.preview?.inputFields)
    ? promptNode.preview.inputFields.map((field) => toCleanString(field)).filter(Boolean)
    : [];
}

export function getDatasetHeadersFromSnapshot(workflowSnapshot, workingSetId) {
  const datasetNode = findWorkflowNodeById(workflowSnapshot, workingSetId);
  if (!datasetNode || String(datasetNode?.type || '').trim() !== 'dataset') {
    throw new Error('Working set dataset node was not found.');
  }
  return Array.isArray(datasetNode?.preview?.headers)
    ? datasetNode.preview.headers.map((header) => toCleanString(header)).filter(Boolean)
    : [];
}

export function buildRunNodeSpec(args = {}, context = {}) {
  const promptNodeId = normalizeNodeId(args?.prompt_node_id || args?.promptNodeId, 'Prompt node id');
  const workingSetId = normalizeNodeId(args?.working_set_id || args?.workingSetId, 'Working set dataset node id');
  const inputToColumn = normalizeMappingObject(args?.input_to_column || args?.inputToColumn);
  const credentialId = toCleanString(args?.credential_id || args?.credentialId);
  const name = toCleanString(args?.name) || 'Run';
  const left = Number.isFinite(Number(args?.left)) ? Number(args.left) : null;
  const top = Number.isFinite(Number(args?.top)) ? Number(args.top) : null;
  const ensureUniqueName = normalizeBoolean(args?.ensure_unique_name, true);

  const promptInputFields = Array.isArray(context?.promptInputFields)
    ? context.promptInputFields.map((field) => toCleanString(field)).filter(Boolean)
    : [];
  const datasetHeaders = Array.isArray(context?.datasetHeaders)
    ? context.datasetHeaders.map((header) => toCleanString(header)).filter(Boolean)
    : [];

  if (promptInputFields.length > 0) {
    const promptFieldSet = new Set(promptInputFields);
    const unknownInputs = Object.keys(inputToColumn).filter((field) => !promptFieldSet.has(field));
    if (unknownInputs.length > 0) {
      throw new Error(`Unknown prompt inputs in mapping: ${unknownInputs.join(', ')}.`);
    }
    const missingInputs = promptInputFields.filter((field) => !toCleanString(inputToColumn[field]));
    if (missingInputs.length > 0) {
      throw new Error(`Missing input mappings for: ${missingInputs.join(', ')}.`);
    }
  }

  if (datasetHeaders.length > 0) {
    const headerSet = new Set(datasetHeaders);
    const unknownColumns = Object.values(inputToColumn).filter((column) => column && !headerSet.has(column));
    if (unknownColumns.length > 0) {
      throw new Error(`Mapped dataset columns were not found: ${unknownColumns.join(', ')}.`);
    }
  }

  return {
    promptNodeId,
    workingSetId,
    inputToColumn,
    ...(credentialId ? { credentialId } : {}),
    name,
    ...(left != null ? { left } : {}),
    ...(top != null ? { top } : {}),
    ensureUniqueName,
  };
}

export function summarizeRunNodeSpec(spec = {}) {
  const inputToColumn = spec?.inputToColumn && typeof spec.inputToColumn === 'object' && !Array.isArray(spec.inputToColumn)
    ? spec.inputToColumn
    : (spec?.input_to_column && typeof spec.input_to_column === 'object' && !Array.isArray(spec.input_to_column)
      ? spec.input_to_column
      : {});
  return {
    name: toCleanString(spec?.name) || 'Run',
    promptNodeId: toCleanString(spec?.promptNodeId || spec?.prompt_node_id),
    workingSetId: toCleanString(spec?.workingSetId || spec?.working_set_id),
    credentialId: toCleanString(spec?.credentialId || spec?.credential_id),
    mappedInputs: Object.keys(inputToColumn).map((key) => toCleanString(key)).filter(Boolean),
    mappingCount: Object.keys(inputToColumn).length,
  };
}
