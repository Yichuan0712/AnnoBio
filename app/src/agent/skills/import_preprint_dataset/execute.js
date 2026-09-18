import { importPreprintDatasetMeta } from './meta.js';

/** Keep in sync with backend/preprint_client.py PREPRINT_FIELDS. */
const VALID_PREPRINT_FIELDS = new Set([
  'doi',
  'title',
  'abstract',
  'authors',
  'corresponding_author',
  'corresponding_institution',
  'date',
  'category',
  'server',
  'version',
  'license',
  'published',
]);

const DEFAULT_PREPRINT_FIELDS = ['doi', 'title', 'abstract', 'authors', 'date', 'server'];

function toCleanString(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeBoolean(value, fallback = false) {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizeDois(value) {
  const list = Array.isArray(value) ? value : [];
  const dois = list.map((item) => toCleanString(item)).filter(Boolean);
  if (dois.length === 0) {
    throw new Error('At least one bioRxiv/medRxiv DOI is required.');
  }
  return dois;
}

function normalizeFields(value) {
  const list = Array.isArray(value) ? value : [];
  const requested = list.map((item) => toCleanString(item)).filter(Boolean);
  const fields = (requested.length > 0 ? requested : DEFAULT_PREPRINT_FIELDS)
    .filter((field) => VALID_PREPRINT_FIELDS.has(field));
  if (fields.length === 0) {
    throw new Error(
      `No valid bioRxiv/medRxiv fields given. Valid fields: ${[...VALID_PREPRINT_FIELDS].join(', ')}.`
    );
  }
  return fields;
}

function safeNameFromArgs(args = {}) {
  const name = toCleanString(args?.name);
  return name || 'bioRxiv/medRxiv Import';
}

export const importPreprintDatasetSkill = Object.freeze({
  meta: importPreprintDatasetMeta,
  getProgressLabel({ args = {} } = {}) {
    const doiCount = Array.isArray(args?.dois) ? args.dois.length : 0;
    return `Importing ${doiCount || ''} preprint${doiCount === 1 ? '' : 's'} into ${safeNameFromArgs(args)}...`;
  },
  summarizeResult({ result = null } = {}) {
    const name = String(result?.name || result?.requestedName || '').trim() || 'bioRxiv/medRxiv Import';
    const nodeId = String(result?.nodeId || '').trim();
    const rowCount = Array.isArray(result?.rows) ? result.rows.length : 0;
    const notFoundCount = Array.isArray(result?.notFoundIds) ? result.notFoundIds.length : 0;
    if (!nodeId) return `bioRxiv/medRxiv import into ${name} failed`;
    const base = `Imported ${rowCount} preprint${rowCount === 1 ? '' : 's'} from bioRxiv/medRxiv into dataset ${name}`;
    return notFoundCount > 0 ? `${base} (${notFoundCount} DOI${notFoundCount === 1 ? '' : 's'} not found)` : base;
  },
  async execute({ args = {}, runtime = {} } = {}) {
    if (typeof runtime?.importPreprintDataset !== 'function') {
      throw new Error('bioRxiv/medRxiv import runtime is unavailable.');
    }
    const dois = normalizeDois(args?.dois);
    const fields = normalizeFields(args?.fields);
    const name = toCleanString(args?.name) || 'bioRxiv/medRxiv Import';
    const notes = toCleanString(args?.notes);
    const left = Number.isFinite(Number(args?.left)) ? Number(args.left) : undefined;
    const top = Number.isFinite(Number(args?.top)) ? Number(args.top) : undefined;
    const ensureUniqueName = normalizeBoolean(args?.ensure_unique_name, true);

    const result = await runtime.importPreprintDataset({
      dois,
      fields,
      name,
      notes,
      left,
      top,
      ensureUniqueName,
    });
    return {
      ...result,
      requestedFields: fields,
    };
  },
});
