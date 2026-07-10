export const importPubmedDatasetMeta = Object.freeze({
  name: 'import_pubmed_dataset',
  description:
    'Fetch articles from PubMed by PMID and create a new dataset node on the workflow canvas, one row per article. ' +
    'Requires exact PMIDs; this tool does not search PubMed by keyword.',
  input_schema: {
    pmids: 'array of strings (required exact PubMed ids to fetch, e.g. ["13252012", "7834742"])',
    fields: 'array of strings (optional columns to import; any of "pmid", "title", "abstract", "authors", "year", "journal", "doi", "mesh_terms", "publication_type"; defaults to pmid/title/abstract/authors/year)',
    name: 'string (optional dataset node name)',
    notes: 'string (optional dataset description)',
    left: 'number (optional x position)',
    top: 'number (optional y position)',
    ensure_unique_name: 'boolean (optional, defaults to true)',
  },
});
