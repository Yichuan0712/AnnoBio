import biomniDatabases from './biomniDatabaseCatalog.js';

/** Database selection metadata; selectable columns are supplied by the backend registry. */
const database = (source, label, category, description, idLabel, placeholder, hint = '') => ({
  source, label, category, description, idLabel, placeholder,
  hint: hint || `${description} Paste identifiers and choose the columns to import.`,
  noun: ['record', 'records'], idNoun: 'ID',
});

export const REFERENCE_DATABASES = [
  database('europepmc', 'Europe PMC', 'Literature', 'Articles and preprints with abstracts and publication metadata.',
    'PMIDs, PMCIDs or Europe PMC preprint IDs', '11532001\nPMC13570426\nPPR1235907'),
  database('openalex', 'OpenAlex', 'Literature', 'Scholarly works, abstracts, citation counts and topics.',
    'OpenAlex work IDs or DOIs', 'W1651253277\n10.1126/sciadv.aaz9899'),
  database('uniprot', 'UniProt', 'Proteins and structures', 'Protein names, functions, sequences and annotations.',
    'UniProt accessions', 'P24941\nP06493'),
  database('pubchem', 'PubChem', 'Compounds and drugs', 'Chemical names, molecular properties and structures.',
    'PubChem compound CIDs', '2244\n3672'),
  database('dailymed', 'DailyMed', 'Compounds and drugs', 'Drug labels, publication dates and full label text.',
    'SPL set IDs', '02b3a604-3f09-47e7-add1-b9038b3a268b'),
  database('openfda', 'openFDA', 'Compounds and drugs', 'Drug label indications, dosage, warnings and product information.',
    'SPL set IDs', '0058175f-3474-40c3-a046-6cfaec86d84b'),
  database('ensembl', 'Ensembl', 'Genes and variants', 'Gene, transcript and protein annotations with genomic coordinates.',
    'Ensembl stable IDs', 'ENSG00000141510\nENSG00000012048'),
  database('clinvar', 'ClinVar', 'Genes and variants', 'Genetic variants, germline classifications and review status.',
    'Variation IDs or VCV / RCV accessions', '7105\nVCV000007105'),
  database('gwas', 'GWAS Catalog', 'Genes and variants', 'Study traits, sample sizes and publication information.',
    'GWAS study accessions', 'GCST000001'),
  database('gnomad', 'gnomAD', 'Genes and variants', 'Population allele counts and frequencies for genetic variants.',
    'GRCh38 variant IDs (chromosome-position-ref-alt)', '1-55051215-G-GA',
    'Import variant frequencies from gnomAD v4 using GRCh38 coordinates. Each ID must include chromosome, position, reference and alternate alleles.'),
  database('pdb', 'PDB', 'Proteins and structures', 'Experimental structures, methods, resolution and download links.',
    'PDB entry IDs', '1CRN\n4HHB'),
  database('alphafold', 'AlphaFold DB', 'Proteins and structures', 'Predicted structures, confidence values and download links.',
    'UniProt accessions', 'P04637\nP24941',
    'Import protein and model metadata, confidence values and structure download links. Models are not downloaded automatically.'),
  database('interpro', 'InterPro', 'Proteins and structures', 'Protein families, domains and functional annotations.',
    'InterPro accessions', 'IPR000001\nIPR000719'),
  database('reactome', 'Reactome', 'Pathways and associations', 'Biological pathways, descriptions and supporting publications.',
    'Reactome stable IDs', 'R-HSA-109581\nR-HSA-69278'),
  database('string', 'STRING', 'Pathways and associations', 'Protein identifiers, organism names and functional annotations.',
    'Species-prefixed STRING protein IDs', '9606.ENSP00000269305\n9606.ENSP00000266970',
    'Import protein annotations using full STRING IDs. The species prefix (for example, 9606 for human) keeps the organism explicit.'),
  database('opentargets', 'Open Targets', 'Pathways and associations', 'Target, disease and drug descriptions and identifiers.',
    'Ensembl gene, disease ontology or ChEMBL IDs', 'ENSG00000141510\nMONDO_0005148\nCHEMBL25'),
  database('geo', 'GEO', 'Experimental data', 'Expression study descriptions, organisms and sample counts.',
    'GEO series, dataset or platform accessions', 'GSE100',
    'Import study metadata and source download links. Expression matrices and sample files are not downloaded automatically.'),
  database('pride', 'PRIDE', 'Experimental data', 'Proteomics projects, protocols, organisms and instruments.',
    'ProteomeXchange project accessions', 'PXD000001'),
  database('encode', 'ENCODE', 'Experimental data', 'Functional genomics experiments, assays, biosamples and file links.',
    'ENCODE experiment accessions', 'ENCSR000AKS',
    'Import experiment metadata and released file download links. Assay files are not downloaded automatically.'),
  ...biomniDatabases.map((item) => ({
    ...database(item.source, item.label, item.category, item.description, item.idLabel, item.placeholder,
      item.kind === 'snapshot' ? 'Choose a dataset file and download it, then select columns and import rows. Downloaded files are shared across projects.'
        : item.source === 'blast' ? 'Search NCBI with a DNA or protein sequence. Long-running searches retain their request ID and result link. Import RID:job-ID later to retrieve results.' : ''),
    kind: item.kind, oneTitlePerLine: item.kind === 'snapshot',
  })),
];

export const DATABASE_CATALOG = [
  database('clinicaltrials', 'ClinicalTrials.gov', 'Clinical research', 'Clinical trial summaries, eligibility, interventions and outcomes.', '', ''),
  database('preprint', 'bioRxiv / medRxiv', 'Literature', 'Biomedical preprints and their publication metadata.', '', ''),
  database('chembl', 'ChEMBL', 'Compounds and drugs', 'Bioactive molecules, drug properties and chemical identifiers.', '', ''),
  ...REFERENCE_DATABASES,
];

const bySource = new Map(DATABASE_CATALOG.map((item) => [item.source, item]));
const isDesktop = () => typeof window !== 'undefined' && Boolean(window.electronAPI);

/** Downloadable snapshots are offered only by the desktop app. */
export function availableDatabases({ includeSnapshots = isDesktop() } = {}) {
  return DATABASE_CATALOG.filter((item) => includeSnapshots || item.kind !== 'snapshot');
}

export const availableReferenceDatabases = () => {
  const visible = new Set(availableDatabases().map((item) => item.source));
  return REFERENCE_DATABASES.filter((item) => visible.has(item.source));
};
export const getDatabase = (source) => {
  const item = bySource.get(source);
  return item && (item.kind !== 'snapshot' || isDesktop()) ? item : undefined;
};
export const isOtherDatabase = (source) => Boolean(getDatabase(source));

export function filterDatabases(query = '', category = '', options = {}) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return availableDatabases(options).filter((item) => (!category || item.category === category)
    && terms.every((term) => `${item.label} ${item.category} ${item.description}`.toLowerCase().includes(term)));
}

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[c]);

export function databasePickerHtml() {
  const databases = availableDatabases();
  const categories = [...new Set(databases.map((item) => item.category))].sort();
  return `<div class="dataset-source-panel" data-source-panel="database" hidden>
    <div class="dataset-import">
      <h3 class="dataset-import-title">Choose a database</h3>
      <p class="dataset-sheet-hint">Select a source, then enter its identifiers and choose the columns to import.</p>
      <div class="dataset-database-filters">
        <label class="dataset-database-search"><span class="dataset-meta-label">Search databases</span>
          <input type="search" class="dataset-meta-input" data-database-search placeholder="Search by name or topic" />
        </label>
        <label><span class="dataset-meta-label">Category</span>
          <select class="dataset-meta-input" data-database-category><option value="">All categories</option>
            ${categories.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('')}
          </select>
        </label>
      </div>
      <div class="dataset-database-list">
        ${databases.map((item) => `<button type="button" class="dataset-database-card" data-database-source="${item.source}">
          <strong>${escapeHtml(item.label)}</strong><span class="dataset-database-category" data-category="${escapeHtml(item.category)}">${escapeHtml(item.category)}</span>
          <span class="dataset-database-description">${escapeHtml(item.description)}</span>
        </button>`).join('')}
      </div>
      <p class="dataset-sheet-hint" data-database-empty role="status" hidden>No databases match your search.</p>
    </div>
  </div>`;
}

export function mountDatabasePicker(overlay, onSelect) {
  const search = overlay.querySelector('[data-database-search]');
  const category = overlay.querySelector('[data-database-category]');
  const cards = [...overlay.querySelectorAll('[data-database-source]')];
  const filter = () => {
    const visible = new Set(filterDatabases(search.value, category.value).map((item) => item.source));
    cards.forEach((card) => { card.hidden = !visible.has(card.dataset.databaseSource); });
    overlay.querySelector('[data-database-empty]').hidden = visible.size > 0;
  };
  search.addEventListener('input', filter);
  category.addEventListener('change', filter);
  cards.forEach((card) => card.addEventListener('click', () => onSelect(card.dataset.databaseSource)));
}
