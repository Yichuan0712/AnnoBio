/** Generated from the pinned Biomni source registry; backend supplies columns and options. */
export default [
  {
    "source": "kegg",
    "label": "KEGG",
    "category": "Pathways and associations",
    "description": "Genes, compounds and pathways in KEGG entries.",
    "idLabel": "KEGG entry ID",
    "placeholder": "hsa:7157",
    "kind": "online"
  },
  {
    "source": "iucn",
    "label": "IUCN Red List",
    "category": "Species and phenotypes",
    "description": "Species, taxonomy and Red List assessments. Requires an API key.",
    "idLabel": "IUCN SIS taxon ID",
    "placeholder": "15951",
    "kind": "online"
  },
  {
    "source": "paleobiology",
    "label": "Paleobiology Database",
    "category": "Species and phenotypes",
    "description": "Fossil taxa, taxonomic ranks and time ranges.",
    "idLabel": "PBDB taxon ID",
    "placeholder": "txn:54585",
    "kind": "online"
  },
  {
    "source": "jaspar",
    "label": "JASPAR",
    "category": "Pathways and associations",
    "description": "Transcription factor binding motifs and matrices.",
    "idLabel": "JASPAR matrix ID",
    "placeholder": "MA0139.1",
    "kind": "online"
  },
  {
    "source": "worms",
    "label": "WoRMS",
    "category": "Species and phenotypes",
    "description": "Marine species, accepted names and taxonomy.",
    "idLabel": "AphiaID",
    "placeholder": "1371",
    "kind": "online"
  },
  {
    "source": "cbioportal",
    "label": "cBioPortal",
    "category": "Clinical research",
    "description": "Cancer study descriptions, sample counts and publications.",
    "idLabel": "Cancer study ID",
    "placeholder": "brca_tcga",
    "kind": "online"
  },
  {
    "source": "dbsnp",
    "label": "dbSNP",
    "category": "Genes and variants",
    "description": "RefSNP variants, alleles and reference placements.",
    "idLabel": "RefSNP ID (rsÃ¢â‚¬Â¦)",
    "placeholder": "rs328",
    "kind": "online"
  },
  {
    "source": "ucsc",
    "label": "UCSC Genome Browser",
    "category": "Genes and variants",
    "description": "Reference genome sequences for a genomic interval.",
    "idLabel": "assembly/chr:start-end (zero-based start)",
    "placeholder": "hg38/chrM:0-50",
    "kind": "online"
  },
  {
    "source": "monarch",
    "label": "Monarch Initiative",
    "category": "Genes and variants",
    "description": "Genes, diseases, phenotypes and ontology annotations.",
    "idLabel": "Ontology or gene identifier",
    "placeholder": "MONDO:0007947",
    "kind": "online"
  },
  {
    "source": "regulomedb",
    "label": "RegulomeDB",
    "category": "Pathways and associations",
    "description": "Regulatory evidence for variants and genomic regions.",
    "idLabel": "rsID or chr:start-end (GRCh38)",
    "placeholder": "rs190509934",
    "kind": "online"
  },
  {
    "source": "gtopdb",
    "label": "Guide to PHARMACOLOGY",
    "category": "Compounds and drugs",
    "description": "Pharmacological targets and ligands. Requires an API key.",
    "idLabel": "targets:ID or ligands:ID",
    "placeholder": "targets:214",
    "kind": "online"
  },
  {
    "source": "remap",
    "label": "ReMap",
    "category": "Pathways and associations",
    "description": "Transcriptional regulator peaks in genomic regions.",
    "idLabel": "assembly/chr:start-end (zero-based start)",
    "placeholder": "hg38/chr1:100000-101000",
    "kind": "online"
  },
  {
    "source": "mpd",
    "label": "Mouse Phenome Database",
    "category": "Species and phenotypes",
    "description": "Mouse phenotype measurements, units and study metadata.",
    "idLabel": "MPD measurement ID",
    "placeholder": "1501",
    "kind": "online"
  },
  {
    "source": "emdb",
    "label": "EMDB",
    "category": "Proteins and structures",
    "description": "Electron microscopy structures and map download links.",
    "idLabel": "EMDB accession",
    "placeholder": "EMD-1001",
    "kind": "online"
  },
  {
    "source": "synapse",
    "label": "Synapse",
    "category": "Experimental data",
    "description": "Research projects, folders and file metadata.",
    "idLabel": "Synapse entity ID",
    "placeholder": "syn9702085",
    "kind": "online"
  },
  {
    "source": "unichem",
    "label": "UniChem",
    "category": "Compounds and drugs",
    "description": "Cross-database chemical identifiers for an InChIKey.",
    "idLabel": "InChIKey",
    "placeholder": "BSYNRYMUTXBXSQ-UHFFFAOYSA-N",
    "kind": "online"
  },
  {
    "source": "quickgo",
    "label": "QuickGO / GO",
    "category": "Pathways and associations",
    "description": "Gene Ontology terms, definitions and synonyms.",
    "idLabel": "GO term ID",
    "placeholder": "GO:0006915",
    "kind": "online"
  },
  {
    "source": "screen",
    "label": "ENCODE SCREEN",
    "category": "Pathways and associations",
    "description": "Regulatory elements and nearby genes. Requires an API key.",
    "idLabel": "hg38/chr:start-end or cCRE/chr",
    "placeholder": "hg38/chr12:53900000-53901000",
    "kind": "online"
  },
  {
    "source": "blast",
    "label": "NCBI BLAST",
    "category": "Sequences",
    "description": "Find DNA or protein sequence matches with NCBI BLAST.",
    "idLabel": "One sequence or RID:job-ID per line",
    "placeholder": "ATGCGTACGTAGCTAGCTAGCTAGCTAGCTA",
    "kind": "online"
  },
  {
    "source": "lake_interactions",
    "label": "Molecular interaction datasets",
    "category": "Data snapshots",
    "description": "Protein, RNA and genetic interaction tables.",
    "idLabel": "Optional values in a selected dataset column",
    "placeholder": "",
    "kind": "snapshot"
  },
  {
    "source": "lake_bindingdb",
    "label": "BindingDB",
    "category": "Data snapshots",
    "description": "Measured protein-compound binding affinities.",
    "idLabel": "Optional values in a selected dataset column",
    "placeholder": "",
    "kind": "snapshot"
  },
  {
    "source": "lake_repurposing",
    "label": "Drug Repurposing Hub",
    "category": "Data snapshots",
    "description": "Drug structures, development phases and targets.",
    "idLabel": "Optional values in a selected dataset column",
    "placeholder": "",
    "kind": "snapshot"
  },
  {
    "source": "lake_cellxgene",
    "label": "CELLxGENE Census",
    "category": "Data snapshots",
    "description": "Single-cell dataset metadata from CELLxGENE Census.",
    "idLabel": "Optional values in a selected dataset column",
    "placeholder": "",
    "kind": "snapshot"
  },
  {
    "source": "lake_depmap",
    "label": "DepMap",
    "category": "Data snapshots",
    "description": "Cancer dependencies, expression and cell model tables.",
    "idLabel": "Optional values in a selected dataset column",
    "placeholder": "",
    "kind": "snapshot"
  },
  {
    "source": "lake_ddinter",
    "label": "DDInter",
    "category": "Data snapshots",
    "description": "Drug-drug interactions by therapeutic category.",
    "idLabel": "Optional values in a selected dataset column",
    "placeholder": "",
    "kind": "snapshot"
  },
  {
    "source": "lake_disgenet",
    "label": "DisGeNET",
    "category": "Data snapshots",
    "description": "Curated gene-disease associations.",
    "idLabel": "Optional values in a selected dataset column",
    "placeholder": "",
    "kind": "snapshot"
  },
  {
    "source": "lake_enamine",
    "label": "Enamine REAL",
    "category": "Data snapshots",
    "description": "Compound SMILES from the Enamine library snapshot.",
    "idLabel": "Optional values in a selected dataset column",
    "placeholder": "",
    "kind": "snapshot"
  },
  {
    "source": "lake_evebio",
    "label": "EveBio",
    "category": "Data snapshots",
    "description": "Pharmome compounds, targets, assays and screening results.",
    "idLabel": "Optional values in a selected dataset column",
    "placeholder": "",
    "kind": "snapshot"
  },
  {
    "source": "lake_genebass",
    "label": "GeneBass",
    "category": "Data snapshots",
    "description": "Gene-based variant association results.",
    "idLabel": "Optional values in a selected dataset column",
    "placeholder": "",
    "kind": "snapshot"
  },
  {
    "source": "lake_ncbi_gene",
    "label": "NCBI Gene annotations",
    "category": "Data snapshots",
    "description": "Gene identifiers, symbols and annotations.",
    "idLabel": "Optional values in a selected dataset column",
    "placeholder": "",
    "kind": "snapshot"
  },
  {
    "source": "lake_go",
    "label": "Gene Ontology",
    "category": "Data snapshots",
    "description": "Gene Ontology nodes and their annotations.",
    "idLabel": "Optional values in a selected dataset column",
    "placeholder": "",
    "kind": "snapshot"
  },
  {
    "source": "lake_gtex",
    "label": "GTEx",
    "category": "Data snapshots",
    "description": "Gene expression across human tissues.",
    "idLabel": "Optional values in a selected dataset column",
    "placeholder": "",
    "kind": "snapshot"
  },
  {
    "source": "lake_gwas",
    "label": "GWAS Catalog snapshot",
    "category": "Data snapshots",
    "description": "Published genome-wide association results.",
    "idLabel": "Optional values in a selected dataset column",
    "placeholder": "",
    "kind": "snapshot"
  },
  {
    "source": "lake_hpo",
    "label": "Human Phenotype Ontology",
    "category": "Data snapshots",
    "description": "Human phenotype terms and ontology annotations.",
    "idLabel": "Optional values in a selected dataset column",
    "placeholder": "",
    "kind": "snapshot"
  },
  {
    "source": "lake_primekg",
    "label": "PrimeKG",
    "category": "Data snapshots",
    "description": "Biomedical knowledge graph nodes and relations.",
    "idLabel": "Optional values in a selected dataset column",
    "placeholder": "",
    "kind": "snapshot"
  },
  {
    "source": "lake_cell_markers",
    "label": "Cell type markers",
    "category": "Data snapshots",
    "description": "Cell type markers and associated annotations.",
    "idLabel": "Optional values in a selected dataset column",
    "placeholder": "",
    "kind": "snapshot"
  },
  {
    "source": "lake_mcpas",
    "label": "McPAS-TCR",
    "category": "Data snapshots",
    "description": "T-cell receptors and associated antigens.",
    "idLabel": "Optional values in a selected dataset column",
    "placeholder": "",
    "kind": "snapshot"
  },
  {
    "source": "lake_mirdb",
    "label": "miRDB",
    "category": "Data snapshots",
    "description": "Predicted microRNA targets.",
    "idLabel": "Optional values in a selected dataset column",
    "placeholder": "",
    "kind": "snapshot"
  },
  {
    "source": "lake_mirtarbase",
    "label": "miRTarBase",
    "category": "Data snapshots",
    "description": "MicroRNA interactions, target sites and abstracts.",
    "idLabel": "Optional values in a selected dataset column",
    "placeholder": "",
    "kind": "snapshot"
  },
  {
    "source": "lake_mousemine",
    "label": "MouseMine",
    "category": "Data snapshots",
    "description": "Mouse gene sets and functional signatures.",
    "idLabel": "Optional values in a selected dataset column",
    "placeholder": "",
    "kind": "snapshot"
  },
  {
    "source": "lake_msigdb",
    "label": "MSigDB",
    "category": "Data snapshots",
    "description": "Human gene sets and functional signatures.",
    "idLabel": "Optional values in a selected dataset column",
    "placeholder": "",
    "kind": "snapshot"
  },
  {
    "source": "lake_omim",
    "label": "OMIM",
    "category": "Data snapshots",
    "description": "Mendelian disease and gene annotations.",
    "idLabel": "Optional values in a selected dataset column",
    "placeholder": "",
    "kind": "snapshot"
  },
  {
    "source": "lake_protein_atlas",
    "label": "Human Protein Atlas",
    "category": "Data snapshots",
    "description": "Protein expression and tissue annotations.",
    "idLabel": "Optional values in a selected dataset column",
    "placeholder": "",
    "kind": "snapshot"
  },
  {
    "source": "lake_sgrna",
    "label": "Human / mouse sgRNA library",
    "category": "Data snapshots",
    "description": "Human and mouse CRISPR knockout libraries.",
    "idLabel": "Optional values in a selected dataset column",
    "placeholder": "",
    "kind": "snapshot"
  },
  {
    "source": "lake_variants",
    "label": "Annotated variants",
    "category": "Data snapshots",
    "description": "Annotated genetic variants.",
    "idLabel": "Optional values in a selected dataset column",
    "placeholder": "",
    "kind": "snapshot"
  },
  {
    "source": "lake_phipster",
    "label": "P-HIPSTER",
    "category": "Data snapshots",
    "description": "Predicted virus-host protein interactions.",
    "idLabel": "Optional values in a selected dataset column",
    "placeholder": "",
    "kind": "snapshot"
  },
  {
    "source": "lake_txgnn",
    "label": "TxGNN",
    "category": "Data snapshots",
    "description": "Drug repurposing predictions and identifier mappings.",
    "idLabel": "Optional values in a selected dataset column",
    "placeholder": "",
    "kind": "snapshot"
  }
];
