export const importClinicaltrialsDatasetMeta = Object.freeze({
  name: 'import_clinicaltrials_dataset',
  description:
    'Fetch studies from ClinicalTrials.gov by NCT id and create a new dataset node on the workflow canvas, one row per study. ' +
    'Requires exact NCT ids; this tool does not search ClinicalTrials.gov by keyword.',
  input_schema: {
    nct_ids: 'array of strings (required exact ClinicalTrials.gov ids to fetch, e.g. ["NCT00001372", "NCT04280705"])',
    fields: 'array of strings (optional columns to import; any of "nct_id", "brief_title", "official_title", "brief_summary", "detailed_description", "conditions", "interventions", "phase", "study_type", "overall_status", "start_date", "completion_date", "sponsor", "eligibility_criteria", "sex", "minimum_age", "maximum_age"; defaults to nct_id/brief_title/brief_summary/conditions/phase/overall_status)',
    name: 'string (optional dataset node name)',
    notes: 'string (optional dataset description)',
    left: 'number (optional x position)',
    top: 'number (optional y position)',
    ensure_unique_name: 'boolean (optional, defaults to true)',
  },
});
