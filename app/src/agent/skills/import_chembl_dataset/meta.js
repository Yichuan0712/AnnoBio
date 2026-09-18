export const importChemblDatasetMeta = Object.freeze({
  name: 'import_chembl_dataset',
  description:
    'Fetch drug/molecule records from ChEMBL by ChEMBL id and create a new dataset node on the workflow canvas, one row per molecule. ' +
    'Requires exact ChEMBL ids; this tool does not search ChEMBL by keyword.',
  input_schema: {
    chembl_ids: 'array of strings (required exact ChEMBL ids to fetch, e.g. ["CHEMBL25", "CHEMBL192"])',
    fields: 'array of strings (optional columns to import; any of "chembl_id", "pref_name", "synonyms", "molecule_type", "max_phase", "first_approval", "therapeutic_flag", "oral", "black_box_warning", "natural_product", "atc_classifications", "canonical_smiles", "standard_inchi", "standard_inchi_key", "molecular_formula", "molecular_weight", "alogp"; defaults to chembl_id/pref_name/molecule_type/max_phase/canonical_smiles/molecular_formula)',
    name: 'string (optional dataset node name)',
    notes: 'string (optional dataset description)',
    left: 'number (optional x position)',
    top: 'number (optional y position)',
    ensure_unique_name: 'boolean (optional, defaults to true)',
  },
});
