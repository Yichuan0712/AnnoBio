import { importChemblDatasetMeta } from './meta.js';

/** Keep in sync with backend/chembl_client.py CHEMBL_FIELDS. */
const VALID_CHEMBL_FIELDS = new Set([
  'chembl_id',
  'pref_name',
  'synonyms',
  'molecule_type',
  'max_phase',
  'first_approval',
  'therapeutic_flag',
  'oral',
  'black_box_warning',
  'natural_product',
  'atc_classifications',
  'canonical_smiles',
  'standard_inchi',
  'standard_inchi_key',
  'molecular_formula',
  'molecular_weight',
  'alogp',
]);

const DEFAULT_CHEMBL_FIELDS = ['chembl_id', 'pref_name', 'molecule_type', 'max_phase', 'canonical_smiles', 'molecular_formula'];

function toCleanString(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeBoolean(value, fallback = false) {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizeChemblIds(value) {
  const list = Array.isArray(value) ? value : [];
  const chemblIds = list.map((item) => toCleanString(item).toUpperCase()).filter(Boolean);
  if (chemblIds.length === 0) {
    throw new Error('At least one ChEMBL id (chembl_id) is required.');
  }
  return chemblIds;
}

function normalizeFields(value) {
  const list = Array.isArray(value) ? value : [];
  const requested = list.map((item) => toCleanString(item)).filter(Boolean);
  const fields = (requested.length > 0 ? requested : DEFAULT_CHEMBL_FIELDS)
    .filter((field) => VALID_CHEMBL_FIELDS.has(field));
  if (fields.length === 0) {
    throw new Error(
      `No valid ChEMBL fields given. Valid fields: ${[...VALID_CHEMBL_FIELDS].join(', ')}.`
    );
  }
  return fields;
}

function safeNameFromArgs(args = {}) {
  const name = toCleanString(args?.name);
  return name || 'ChEMBL Import';
}

export const importChemblDatasetSkill = Object.freeze({
  meta: importChemblDatasetMeta,
  getProgressLabel({ args = {} } = {}) {
    const chemblIdCount = Array.isArray(args?.chembl_ids) ? args.chembl_ids.length : 0;
    return `Importing ${chemblIdCount || ''} ChEMBL molecule${chemblIdCount === 1 ? '' : 's'} into ${safeNameFromArgs(args)}...`;
  },
  summarizeResult({ result = null } = {}) {
    const name = String(result?.name || result?.requestedName || '').trim() || 'ChEMBL Import';
    const nodeId = String(result?.nodeId || '').trim();
    const rowCount = Array.isArray(result?.rows) ? result.rows.length : 0;
    const notFoundCount = Array.isArray(result?.notFoundIds) ? result.notFoundIds.length : 0;
    if (!nodeId) return `ChEMBL import into ${name} failed`;
    const base = `Imported ${rowCount} molecule${rowCount === 1 ? '' : 's'} from ChEMBL into dataset ${name}`;
    return notFoundCount > 0 ? `${base} (${notFoundCount} ChEMBL ID${notFoundCount === 1 ? '' : 's'} not found)` : base;
  },
  async execute({ args = {}, runtime = {} } = {}) {
    if (typeof runtime?.importChemblDataset !== 'function') {
      throw new Error('ChEMBL import runtime is unavailable.');
    }
    const chemblIds = normalizeChemblIds(args?.chembl_ids);
    const fields = normalizeFields(args?.fields);
    const name = toCleanString(args?.name) || 'ChEMBL Import';
    const notes = toCleanString(args?.notes);
    const left = Number.isFinite(Number(args?.left)) ? Number(args.left) : undefined;
    const top = Number.isFinite(Number(args?.top)) ? Number(args.top) : undefined;
    const ensureUniqueName = normalizeBoolean(args?.ensure_unique_name, true);

    const result = await runtime.importChemblDataset({
      chemblIds,
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
