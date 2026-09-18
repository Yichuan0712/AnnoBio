import { importClinicaltrialsDatasetMeta } from './meta.js';

/** Keep in sync with backend/clinicaltrials_client.py CT_FIELDS. */
const VALID_CLINICALTRIALS_FIELDS = new Set([
  'nct_id',
  'brief_title',
  'official_title',
  'brief_summary',
  'detailed_description',
  'conditions',
  'interventions',
  'phase',
  'study_type',
  'overall_status',
  'start_date',
  'completion_date',
  'sponsor',
  'eligibility_criteria',
  'sex',
  'minimum_age',
  'maximum_age',
]);

const DEFAULT_CLINICALTRIALS_FIELDS = ['nct_id', 'brief_title', 'brief_summary', 'conditions', 'phase', 'overall_status'];

function toCleanString(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeBoolean(value, fallback = false) {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizeNctIds(value) {
  const list = Array.isArray(value) ? value : [];
  const nctIds = list.map((item) => toCleanString(item).toUpperCase()).filter(Boolean);
  if (nctIds.length === 0) {
    throw new Error('At least one ClinicalTrials.gov id (nct_id) is required.');
  }
  return nctIds;
}

function normalizeFields(value) {
  const list = Array.isArray(value) ? value : [];
  const requested = list.map((item) => toCleanString(item)).filter(Boolean);
  const fields = (requested.length > 0 ? requested : DEFAULT_CLINICALTRIALS_FIELDS)
    .filter((field) => VALID_CLINICALTRIALS_FIELDS.has(field));
  if (fields.length === 0) {
    throw new Error(
      `No valid ClinicalTrials.gov fields given. Valid fields: ${[...VALID_CLINICALTRIALS_FIELDS].join(', ')}.`
    );
  }
  return fields;
}

function safeNameFromArgs(args = {}) {
  const name = toCleanString(args?.name);
  return name || 'ClinicalTrials.gov Import';
}

export const importClinicaltrialsDatasetSkill = Object.freeze({
  meta: importClinicaltrialsDatasetMeta,
  getProgressLabel({ args = {} } = {}) {
    const nctIdCount = Array.isArray(args?.nct_ids) ? args.nct_ids.length : 0;
    return `Importing ${nctIdCount || ''} ClinicalTrials.gov stud${nctIdCount === 1 ? 'y' : 'ies'} into ${safeNameFromArgs(args)}...`;
  },
  summarizeResult({ result = null } = {}) {
    const name = String(result?.name || result?.requestedName || '').trim() || 'ClinicalTrials.gov Import';
    const nodeId = String(result?.nodeId || '').trim();
    const rowCount = Array.isArray(result?.rows) ? result.rows.length : 0;
    const notFoundCount = Array.isArray(result?.notFoundIds) ? result.notFoundIds.length : 0;
    if (!nodeId) return `ClinicalTrials.gov import into ${name} failed`;
    const base = `Imported ${rowCount} stud${rowCount === 1 ? 'y' : 'ies'} from ClinicalTrials.gov into dataset ${name}`;
    return notFoundCount > 0 ? `${base} (${notFoundCount} NCT ID${notFoundCount === 1 ? '' : 's'} not found)` : base;
  },
  async execute({ args = {}, runtime = {} } = {}) {
    if (typeof runtime?.importClinicaltrialsDataset !== 'function') {
      throw new Error('ClinicalTrials.gov import runtime is unavailable.');
    }
    const nctIds = normalizeNctIds(args?.nct_ids);
    const fields = normalizeFields(args?.fields);
    const name = toCleanString(args?.name) || 'ClinicalTrials.gov Import';
    const notes = toCleanString(args?.notes);
    const left = Number.isFinite(Number(args?.left)) ? Number(args.left) : undefined;
    const top = Number.isFinite(Number(args?.top)) ? Number(args.top) : undefined;
    const ensureUniqueName = normalizeBoolean(args?.ensure_unique_name, true);

    const result = await runtime.importClinicaltrialsDataset({
      nctIds,
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
