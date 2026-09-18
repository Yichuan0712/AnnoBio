export const importPreprintDatasetMeta = Object.freeze({
  name: 'import_preprint_dataset',
  description:
    'Fetch preprints from bioRxiv or medRxiv by DOI and create a new dataset node on the workflow canvas, one row per preprint. ' +
    'Requires exact DOIs; this tool does not search bioRxiv/medRxiv by keyword. Each DOI is looked up on bioRxiv first, then medRxiv.',
  input_schema: {
    dois: 'array of strings (required exact bioRxiv/medRxiv DOIs to fetch, e.g. ["10.1101/2020.09.16.300343"])',
    fields: 'array of strings (optional columns to import; any of "doi", "title", "abstract", "authors", "corresponding_author", "corresponding_institution", "date", "category", "server", "version", "license", "published"; defaults to doi/title/abstract/authors/date/server)',
    name: 'string (optional dataset node name)',
    notes: 'string (optional dataset description)',
    left: 'number (optional x position)',
    top: 'number (optional y position)',
    ensure_unique_name: 'boolean (optional, defaults to true)',
  },
});
