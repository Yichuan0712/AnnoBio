import { importPubmedDatasetMeta } from './meta.js';

/** Keep in sync with backend/pubmed_client.py PUBMED_FIELDS. */
const VALID_PUBMED_FIELDS = new Set([
  'pmid',
  'title',
  'abstract',
  'authors',
  'year',
  'journal',
  'doi',
  'mesh_terms',
  'publication_type',
]);

const DEFAULT_PUBMED_FIELDS = ['pmid', 'title', 'abstract', 'authors', 'year'];

function toCleanString(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeBoolean(value, fallback = false) {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizePmids(value) {
  const list = Array.isArray(value) ? value : [];
  const pmids = list.map((item) => toCleanString(item)).filter(Boolean);
  if (pmids.length === 0) {
    throw new Error('At least one PubMed id (pmid) is required.');
  }
  return pmids;
}

function normalizeFields(value) {
  const list = Array.isArray(value) ? value : [];
  const requested = list.map((item) => toCleanString(item)).filter(Boolean);
  const fields = (requested.length > 0 ? requested : DEFAULT_PUBMED_FIELDS)
    .filter((field) => VALID_PUBMED_FIELDS.has(field));
  if (fields.length === 0) {
    throw new Error(
      `No valid PubMed fields given. Valid fields: ${[...VALID_PUBMED_FIELDS].join(', ')}.`
    );
  }
  return fields;
}

function safeNameFromArgs(args = {}) {
  const name = toCleanString(args?.name);
  return name || 'PubMed Import';
}

export const importPubmedDatasetSkill = Object.freeze({
  meta: importPubmedDatasetMeta,
  getProgressLabel({ args = {} } = {}) {
    const pmidCount = Array.isArray(args?.pmids) ? args.pmids.length : 0;
    return `Importing ${pmidCount || ''} PubMed article${pmidCount === 1 ? '' : 's'} into ${safeNameFromArgs(args)}...`;
  },
  summarizeResult({ result = null } = {}) {
    const name = String(result?.name || result?.requestedName || '').trim() || 'PubMed Import';
    const nodeId = String(result?.nodeId || '').trim();
    const rowCount = Array.isArray(result?.rows) ? result.rows.length : 0;
    const notFoundCount = Array.isArray(result?.notFoundIds) ? result.notFoundIds.length : 0;
    if (!nodeId) return `PubMed import into ${name} failed`;
    const base = `Imported ${rowCount} article${rowCount === 1 ? '' : 's'} from PubMed into dataset ${name}`;
    return notFoundCount > 0 ? `${base} (${notFoundCount} PMID${notFoundCount === 1 ? '' : 's'} not found)` : base;
  },
  async execute({ args = {}, runtime = {} } = {}) {
    if (typeof runtime?.importPubmedDataset !== 'function') {
      throw new Error('PubMed import runtime is unavailable.');
    }
    const pmids = normalizePmids(args?.pmids);
    const fields = normalizeFields(args?.fields);
    const name = toCleanString(args?.name) || 'PubMed Import';
    const notes = toCleanString(args?.notes);
    const left = Number.isFinite(Number(args?.left)) ? Number(args.left) : undefined;
    const top = Number.isFinite(Number(args?.top)) ? Number(args.top) : undefined;
    const ensureUniqueName = normalizeBoolean(args?.ensure_unique_name, true);

    const result = await runtime.importPubmedDataset({
      pmids,
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
