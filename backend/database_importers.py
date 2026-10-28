"""Record adapters for Dataset imports from public biomedical databases.

Each adapter resolves explicit identifiers and returns one row per identifier. Large assay matrices
and structure binaries are represented by source/download links rather than downloaded implicitly.
"""
from __future__ import annotations

import json
import re
import time
from html import unescape
from urllib.parse import quote
from xml.etree import ElementTree

import httpx


def _cell(value):
    if value is None:
        return ""
    if isinstance(value, bool):
        return "Yes" if value else "No"
    if isinstance(value, dict):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list):
        return "; ".join(_cell(item) for item in value if item is not None)
    return str(value)


def _plain(value):
    return " ".join(unescape(re.sub(r"<[^>]+>", " ", _cell(value))).split())


def _names(items, field="name"):
    return [item.get(field) for item in items or [] if isinstance(item, dict) and item.get(field) not in (None, "")]


def _row(data, url, **values):
    return {key: _cell(value) for key, value in {
        **values, "source_url": url, "record_json": json.dumps(data, ensure_ascii=False),
    }.items()}


def _json(get, client, url, params=None):
    try:
        return get(client, url, params or {}).json()
    except httpx.HTTPStatusError as error:
        if error.response.status_code == 404:
            return None
        raise


def _graphql(client, url, query, variables):
    # Database identifiers are passed as variables, never interpolated into GraphQL source.
    for attempt in range(3):
        response = client.post(url, json={"query": query, "variables": variables})
        if response.status_code in (429, 502, 503, 504) and attempt < 2:
            time.sleep(attempt + 1)
            continue
        if response.is_error:
            try:
                errors = response.json().get("errors") or []
            except (ValueError, AttributeError):
                errors = []
            if errors:
                raise ValueError("; ".join(e.get("message", "Database query failed") for e in errors))
            response.raise_for_status()
        data = response.json()
        if data.get("errors"):
            raise ValueError("; ".join(e.get("message", "Database query failed") for e in data["errors"]))
        return data.get("data") or {}
    return {}


def _pubchem(get, client, key, fields):
    data = _json(get, client, f"https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/{key}/property/Title,MolecularFormula,MolecularWeight,IUPACName,InChIKey,CanonicalSMILES/JSON")
    records = ((data or {}).get("PropertyTable") or {}).get("Properties") or []
    if not records:
        return None
    r = records[0]
    return _row(r, f"https://pubchem.ncbi.nlm.nih.gov/compound/{key}", cid=r.get("CID"), title=r.get("Title"),
                formula=r.get("MolecularFormula"), molecular_weight=r.get("MolecularWeight"),
                iupac_name=r.get("IUPACName"), inchikey=r.get("InChIKey"),
                smiles=r.get("ConnectivitySMILES") or r.get("CanonicalSMILES"))


def _dailymed(get, client, key, fields):
    data = _json(get, client, "https://dailymed.nlm.nih.gov/dailymed/services/v2/spls.json", {"setid": key})
    records = (data or {}).get("data") or []
    if not records:
        return None
    r = next((item for item in records if item.get("setid", "").lower() == key), None)
    if not r:
        return None
    label_text = ""
    if "label_text" in fields:
        xml = get(client, f"https://dailymed.nlm.nih.gov/dailymed/services/v2/spls/{key}.xml", {}).content
        root = ElementTree.fromstring(xml)
        sections = root.findall(".//{urn:hl7-org:v3}section/{urn:hl7-org:v3}text")
        label_text = "\n\n".join(" ".join(" ".join(s.itertext()).split()) for s in sections)
    return _row(r, f"https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid={key}",
                set_id=r.get("setid"), title=r.get("title"), version=r.get("spl_version"),
                published_date=r.get("published_date"), label_text=label_text)


def _openfda(get, client, key, fields):
    data = _json(get, client, "https://api.fda.gov/drug/label.json", {
        "search": f'set_id:"{key}"', "sort": "effective_time:desc", "limit": 1,
    })
    records = (data or {}).get("results") or []
    if not records:
        return None
    r = records[0]
    fda = r.get("openfda") or {}
    return _row(r, f"https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid={key}",
                set_id=r.get("set_id"), document_id=r.get("id"), brand_name=fda.get("brand_name"),
                generic_name=fda.get("generic_name"), manufacturer=fda.get("manufacturer_name"),
                product_type=fda.get("product_type"), route=fda.get("route"), effective_date=r.get("effective_time"),
                indications=_plain(r.get("indications_and_usage")), dosage=_plain(r.get("dosage_and_administration")),
                warnings=_plain(r.get("warnings")), contraindications=_plain(r.get("contraindications")))


def _ensembl(get, client, key, fields):
    try:
        r = _json(get, client, f"https://rest.ensembl.org/lookup/id/{key}", {"content-type": "application/json"})
    except httpx.HTTPStatusError as error:
        if error.response.status_code == 400 and "not found" in error.response.text.lower():
            return None
        raise
    if not r:
        return None
    return _row(r, f"https://www.ensembl.org/id/{key}", ensembl_id=r.get("id"), name=r.get("display_name"),
                description=r.get("description"), species=r.get("species"), biotype=r.get("biotype"),
                assembly=r.get("assembly_name"), chromosome=r.get("seq_region_name"), start=r.get("start"),
                end=r.get("end"), strand=r.get("strand"), object_type=r.get("object_type"), version=r.get("version"))


NCBI = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/"


def _ncbi_summary(get, client, database, key, term, uid=None):
    uid = uid or (key if database == "clinvar" and key.isdigit() else None)
    if not uid:
        data = _json(get, client, NCBI + "esearch.fcgi", {"db": database, "term": term, "retmode": "json", "retmax": 1})
        result = (data or {}).get("esearchresult") or {}
        if any((result.get("errorlist") or {}).values()):
            return None
        ids = result.get("idlist") or []
        if not ids:
            return None
        uid = str(ids[0])
    data = _json(get, client, NCBI + "esummary.fcgi", {"db": database, "id": uid, "retmode": "json"})
    if data and data.get("error"):
        raise ValueError(str(data["error"]))
    r = ((data or {}).get("result") or {}).get(uid)
    return r if r and not r.get("error") else None


def _clinvar(get, client, key, fields):
    # VCV encodes the numeric Variation ID; RCV is a condition-level accession searchable in ClinVar.
    uid = str(int(key[3:].split('.')[0])) if key.startswith("VCV") else None
    r = _ncbi_summary(get, client, "clinvar", key, key, uid=uid)
    if not r:
        return None
    classification = r.get("germline_classification") or r.get("clinical_significance") or {}
    return _row(r, f"https://www.ncbi.nlm.nih.gov/clinvar/variation/{r['uid']}/", variation_id=r.get("uid"),
                accession=r.get("accession_version") or r.get("accession"), title=r.get("title"),
                genes=_names(r.get("genes"), "symbol"), significance=classification.get("description"),
                review_status=classification.get("review_status"), last_evaluated=classification.get("last_evaluated"),
                conditions=_names(classification.get("trait_set") or r.get("trait_set"), "trait_name"),
                protein_change=r.get("protein_change"), variant_type=r.get("obj_type"))


def _gwas(get, client, key, fields):
    r = _json(get, client, f"https://www.ebi.ac.uk/gwas/rest/api/v2/studies/{key}")
    if not r:
        return None
    return _row(r, f"https://www.ebi.ac.uk/gwas/studies/{key}", accession=r.get("accession_id"),
                trait=r.get("disease_trait"), pubmed_id=r.get("pubmed_id"), initial_sample=r.get("initial_sample_size"),
                replication_sample=r.get("replication_sample_size"), snp_count=r.get("snp_count"),
                platforms=r.get("platforms"), efo_traits=_names(r.get("efo_traits"), "efo_trait"),
                efo_ids=_names(r.get("efo_traits"), "efo_id"), summary_stats_available=r.get("full_summary_stats_available"))


def _gnomad(get, client, key, fields):
    try:
        data = _graphql(client, "https://gnomad.broadinstitute.org/api", """
            query($id: String!) { variant(variantId: $id, dataset: gnomad_r4) {
              variant_id chrom pos ref alt exome { ac an af } genome { ac an af }
            } }
        """, {"id": key})
    except ValueError as error:
        if "variant not found" in str(error).lower():
            return None
        raise
    r = data.get("variant")
    if not r:
        return None
    exome, genome = r.get("exome") or {}, r.get("genome") or {}
    return _row(r, f"https://gnomad.broadinstitute.org/variant/{key}?dataset=gnomad_r4", variant_id=r.get("variant_id"),
                assembly="GRCh38", dataset="gnomad_r4", chromosome=r.get("chrom"), position=r.get("pos"),
                ref=r.get("ref"), alt=r.get("alt"), exome_ac=exome.get("ac"), exome_an=exome.get("an"),
                exome_af=exome.get("af"), genome_ac=genome.get("ac"), genome_an=genome.get("an"), genome_af=genome.get("af"))


def _pdb(get, client, key, fields):
    r = _json(get, client, f"https://data.rcsb.org/rest/v1/core/entry/{key}")
    if not r:
        return None
    info, dates = r.get("rcsb_entry_info") or {}, r.get("rcsb_accession_info") or {}
    citation = r.get("rcsb_primary_citation") or {}
    return _row(r, f"https://www.rcsb.org/structure/{key}", pdb_id=r.get("rcsb_id"), title=(r.get("struct") or {}).get("title"),
                methods=_names(r.get("exptl"), "method"), resolution=info.get("resolution_combined"),
                polymer_entities=info.get("polymer_entity_count"), deposited=dates.get("deposit_date"),
                released=dates.get("initial_release_date"), doi=citation.get("pdbx_database_id_DOI"),
                pubmed_id=citation.get("pdbx_database_id_PubMed"), cif_url=f"https://files.rcsb.org/download/{key}.cif")


def _alphafold(get, client, key, fields):
    records = _json(get, client, f"https://alphafold.ebi.ac.uk/api/prediction/{key}")
    if not records:
        return None
    # Some accessions have multiple fragments. Preserve all model links rather than silently taking one.
    return _row(records, f"https://alphafold.ebi.ac.uk/entry/{key}", accession=key,
                protein=list(dict.fromkeys(_names(records, "uniprotDescription"))), gene=list(dict.fromkeys(_names(records, "gene"))),
                organism=list(dict.fromkeys(_names(records, "organismScientificName"))), entry_ids=_names(records, "entryId"),
                model_version=_names(records, "latestVersion"), confidence=_names(records, "globalMetricValue"),
                sequence=records[0].get("uniprotSequence") or records[0].get("sequence"),
                pdb_urls=_names(records, "pdbUrl"), cif_urls=_names(records, "cifUrl"), pae_urls=_names(records, "paeDocUrl"))


def _interpro(get, client, key, fields):
    data = _json(get, client, f"https://www.ebi.ac.uk/interpro/api/entry/interpro/{key}/")
    if not data:
        return None
    r = data.get("metadata") or {}
    name = r.get("name") or {}
    return _row(data, f"https://www.ebi.ac.uk/interpro/entry/InterPro/{key}/", accession=r.get("accession"),
                name=name.get("name") if isinstance(name, dict) else name,
                short_name=name.get("short") if isinstance(name, dict) else "", entry_type=r.get("type"),
                description=_plain(_names(r.get("description"), "text")), go_terms=r.get("go_terms"),
                member_databases=r.get("member_databases"))


def _reactome(get, client, key, fields):
    r = _json(get, client, f"https://reactome.org/ContentService/data/query/{key}")
    if not r:
        return None
    return _row(r, f"https://reactome.org/content/detail/{key}", stable_id=r.get("stId"), name=r.get("displayName"),
                species=r.get("speciesName"), description=_plain(_names(r.get("summation"), "text")),
                entry_type=r.get("schemaClass"), disease_related=r.get("isInDisease"),
                inferred=r.get("isInferred"), release_date=r.get("releaseDate"),
                pubmed_ids=_names(r.get("literatureReference"), "pubMedIdentifier"),
                child_events=_names(r.get("hasEvent"), "displayName"))


def _string(get, client, key, fields):
    records = _json(get, client, "https://string-db.org/api/json/get_string_ids", {
        "identifiers": key, "species": key.split(".", 1)[0], "limit": 1, "caller_identity": "AnnoBio",
    })
    if not records:
        return None
    r = records[0]
    return _row(r, f"https://string-db.org/network/{quote(r.get('stringId', key), safe='.')}",
                string_id=r.get("stringId"), name=r.get("preferredName"), organism=r.get("taxonName"),
                taxon_id=r.get("ncbiTaxonId"), annotation=r.get("annotation"))


def _opentargets(get, client, key, fields):
    if key.startswith("ENSG"):
        entity, argument, projection = "target", "ensemblId", "id approvedSymbol approvedName biotype"
    elif key.startswith("CHEMBL"):
        entity, argument, projection = "drug", "chemblId", "id name description drugType maximumClinicalStage"
    else:
        entity, argument, projection = "disease", "efoId", "id name description"
    data = _graphql(client, "https://api.platform.opentargets.org/api/v4/graphql",
                    f"query($id: String!) {{ {entity}({argument}: $id) {{ {projection} }} }}", {"id": key})
    r = data.get(entity)
    if not r:
        return None
    return _row(r, f"https://platform.opentargets.org/{entity}/{key}", id=r.get("id"), entity_type=entity,
                name=r.get("approvedName") or r.get("name"), symbol=r.get("approvedSymbol"),
                description=r.get("description"), biotype=r.get("biotype"), drug_type=r.get("drugType"),
                clinical_stage=r.get("maximumClinicalStage"))


def _geo(get, client, key, fields):
    # GEO accession search also matches related records. Use its UID encoding and verify identity.
    prefix, number = key[:3], int(key[3:])
    uid = str({"GSE": 200000000, "GPL": 100000000, "GDS": 0}[prefix] + number)
    r = _ncbi_summary(get, client, "gds", key, key, uid=uid)
    if not r or r.get("accession", "").upper() != key:
        return None
    return _row(r, f"https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc={key}", accession=r.get("accession"),
                title=r.get("title"), summary=r.get("summary"), organism=r.get("taxon"), platform=r.get("gpl"),
                entry_type=r.get("entrytype"), sample_count=r.get("n_samples"), pubmed_ids=r.get("pubmedids"),
                publication_date=r.get("pdat"), ftp_link=r.get("ftplink"))


def _pride(get, client, key, fields):
    r = _json(get, client, f"https://www.ebi.ac.uk/pride/ws/archive/v3/projects/{key}")
    if not r:
        return None
    return _row(r, f"https://www.ebi.ac.uk/pride/archive/projects/{key}", accession=r.get("accession"),
                title=r.get("title"), description=r.get("projectDescription"), organisms=_names(r.get("organisms")),
                instruments=_names(r.get("instruments")), keywords=r.get("keywords"),
                sample_protocol=r.get("sampleProcessingProtocol"), processing_protocol=r.get("dataProcessingProtocol"),
                publication_date=r.get("publicationDate"), doi=r.get("doi"), pubmed_ids=_names(r.get("references"), "pubmedID"))


def _encode(get, client, key, fields):
    r = _json(get, client, f"https://www.encodeproject.org/experiments/{key}/", {"format": "json"})
    if not r:
        return None
    biosample = r.get("biosample_ontology") or {}
    target = r.get("target") or {}
    lab = r.get("lab") or {}
    files = r.get("files") or []
    return _row(r, f"https://www.encodeproject.org/experiments/{key}/", accession=r.get("accession"),
                description=r.get("description"), assay=r.get("assay_title") or r.get("assay_term_name"),
                biosample=biosample.get("term_name"), target=target.get("label") if isinstance(target, dict) else target,
                lab=lab.get("title") if isinstance(lab, dict) else lab, status=r.get("status"),
                released=r.get("date_released"), assembly=r.get("assembly"),
                files=[f"https://www.encodeproject.org{item['href']}" for item in files
                       if isinstance(item, dict) and item.get("href") and item.get("status") == "released"])


def _key(pattern, transform=str.upper):
    def normalize(token):
        value = transform(str(token).strip())
        return value if re.fullmatch(pattern, value) else None
    return normalize


def build_database_importers(get):
    """Use the shared, rate-limited HTTP getter while keeping adapters independent of the job runner."""
    definitions = [
        ("pubchem", "PubChem", "PubChem compound CID", _key(r"[1-9]\d*"), _pubchem,
         {"cid": "CID", "title": "Name", "formula": "Molecular Formula", "molecular_weight": "Molecular Weight", "iupac_name": "IUPAC Name", "inchikey": "InChIKey", "smiles": "SMILES"},
         ["cid", "title", "formula", "molecular_weight", "smiles"]),
        ("dailymed", "DailyMed", "SPL set ID (UUID)", _key(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", str.lower), _dailymed,
         {"set_id": "SPL Set ID", "title": "Title", "version": "Label Version", "published_date": "Published Date", "label_text": "Full Label Text"},
         ["set_id", "title", "version", "published_date"]),
        ("openfda", "openFDA", "SPL set ID (UUID)", _key(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", str.lower), _openfda,
         {"set_id": "SPL Set ID", "document_id": "Document ID", "brand_name": "Brand Name", "generic_name": "Generic Name", "manufacturer": "Manufacturer", "product_type": "Product Type", "route": "Route", "effective_date": "Effective Date", "indications": "Indications and Usage", "dosage": "Dosage", "warnings": "Warnings", "contraindications": "Contraindications"},
         ["set_id", "brand_name", "generic_name", "indications", "warnings"]),
        ("ensembl", "Ensembl", "Ensembl stable ID", _key(r"ENS[A-Z]*[GTPRE]\d+(?:\.\d+)?"), _ensembl,
         {"ensembl_id": "Ensembl ID", "name": "Name", "description": "Description", "species": "Species", "biotype": "Biotype", "assembly": "Assembly", "chromosome": "Chromosome", "start": "Start", "end": "End", "strand": "Strand", "object_type": "Record Type", "version": "Version"},
         ["ensembl_id", "name", "description", "species", "assembly"]),
        ("clinvar", "ClinVar", "Variation ID or VCV/RCV accession", _key(r"(?:[1-9]\d*|[VR]CV\d+(?:\.\d+)?)"), _clinvar,
         {"variation_id": "Variation ID", "accession": "Accession", "title": "Variant", "genes": "Genes", "significance": "Germline Classification", "review_status": "Review Status", "last_evaluated": "Last Evaluated", "conditions": "Conditions", "protein_change": "Protein Change", "variant_type": "Variant Type"},
         ["variation_id", "accession", "title", "genes", "significance", "review_status", "conditions"]),
        ("gwas", "GWAS Catalog", "GWAS study accession (GCST…)", _key(r"GCST\d+"), _gwas,
         {"accession": "Study Accession", "trait": "Trait", "pubmed_id": "PMID", "initial_sample": "Initial Sample", "replication_sample": "Replication Sample", "snp_count": "SNP Count", "platforms": "Platforms", "efo_traits": "Ontology Traits", "efo_ids": "Ontology IDs", "summary_stats_available": "Summary Statistics Available"},
         ["accession", "trait", "pubmed_id", "initial_sample", "efo_ids"]),
        ("gnomad", "gnomAD", "GRCh38 variant ID (chromosome-position-ref-alt)", _key(r"(?:[1-9]|1\d|2[0-2]|X|Y)-[1-9]\d*-[ACGT]+-[ACGT]+"), _gnomad,
         {"variant_id": "Variant ID", "assembly": "Assembly", "dataset": "Dataset", "chromosome": "Chromosome", "position": "Position", "ref": "Reference Allele", "alt": "Alternate Allele", "exome_ac": "Exome Allele Count", "exome_an": "Exome Allele Number", "exome_af": "Exome Allele Frequency", "genome_ac": "Genome Allele Count", "genome_an": "Genome Allele Number", "genome_af": "Genome Allele Frequency"},
         ["variant_id", "assembly", "dataset", "exome_af", "genome_af"]),
        ("pdb", "PDB", "PDB entry ID", _key(r"(?:[1-9][A-Z0-9]{3}|PDB_[A-Z0-9]{8})"), _pdb,
         {"pdb_id": "PDB ID", "title": "Title", "methods": "Experimental Methods", "resolution": "Resolution (Å)", "polymer_entities": "Polymer Entity Count", "deposited": "Deposit Date", "released": "Release Date", "doi": "Citation DOI", "pubmed_id": "PMID", "cif_url": "mmCIF Download URL"},
         ["pdb_id", "title", "methods", "resolution", "cif_url"]),
        ("alphafold", "AlphaFold DB", "UniProt accession", _key(r"(?:[OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9](?:[A-Z][A-Z0-9]{2}[0-9]){1,2})"), _alphafold,
         {"accession": "UniProt Accession", "protein": "Protein", "gene": "Gene", "organism": "Organism", "entry_ids": "Model IDs", "model_version": "Model Versions", "confidence": "Global Confidence", "sequence": "Sequence", "pdb_urls": "PDB Download URLs", "cif_urls": "mmCIF Download URLs", "pae_urls": "PAE Download URLs"},
         ["accession", "protein", "gene", "organism", "confidence", "cif_urls"]),
        ("interpro", "InterPro", "InterPro accession (IPR…)", _key(r"IPR\d{6}"), _interpro,
         {"accession": "Accession", "name": "Name", "short_name": "Short Name", "entry_type": "Entry Type", "description": "Description", "go_terms": "GO Terms", "member_databases": "Member Database Entries"},
         ["accession", "name", "entry_type", "description"]),
        ("reactome", "Reactome", "Reactome stable ID (R-HSA-…)", _key(r"R-[A-Z]{3}-\d+(?:\.\d+)?"), _reactome,
         {"stable_id": "Stable ID", "name": "Name", "species": "Species", "description": "Description", "entry_type": "Entry Type", "disease_related": "Disease Related", "inferred": "Inferred", "release_date": "Release Date", "pubmed_ids": "PMIDs", "child_events": "Child Events"},
         ["stable_id", "name", "species", "description", "pubmed_ids"]),
        ("string", "STRING", "Species-prefixed STRING protein ID", _key(r"\d+\.[A-Za-z0-9_-]+", str), _string,
         {"string_id": "STRING ID", "name": "Protein Name", "organism": "Organism", "taxon_id": "Taxon ID", "annotation": "Annotation"},
         ["string_id", "name", "organism", "annotation"]),
        ("opentargets", "Open Targets", "Ensembl gene, disease ontology or ChEMBL ID", _key(r"(?:ENSG\d+|(?:EFO|MONDO|HP|DOID|Orphanet|OTAR)_\d+|CHEMBL\d+)", str), _opentargets,
         {"id": "ID", "entity_type": "Entity Type", "name": "Name", "symbol": "Gene Symbol", "description": "Description", "biotype": "Biotype", "drug_type": "Drug Type", "clinical_stage": "Maximum Clinical Stage"},
         ["id", "entity_type", "name", "symbol", "description"]),
        ("geo", "GEO", "GEO series/dataset/platform accession", _key(r"(?:GSE|GDS|GPL)\d+"), _geo,
         {"accession": "Accession", "title": "Title", "summary": "Summary", "organism": "Organism", "platform": "Platform", "entry_type": "Entry Type", "sample_count": "Sample Count", "pubmed_ids": "PMIDs", "publication_date": "Publication Date", "ftp_link": "FTP Download Link"},
         ["accession", "title", "summary", "organism", "sample_count", "pubmed_ids"]),
        ("pride", "PRIDE", "ProteomeXchange project accession (PXD…)", _key(r"PXD\d{6,}"), _pride,
         {"accession": "Accession", "title": "Title", "description": "Description", "organisms": "Organisms", "instruments": "Instruments", "keywords": "Keywords", "sample_protocol": "Sample Processing Protocol", "processing_protocol": "Data Processing Protocol", "publication_date": "Publication Date", "doi": "DOI", "pubmed_ids": "PMIDs"},
         ["accession", "title", "description", "organisms", "instruments", "pubmed_ids"]),
        ("encode", "ENCODE", "ENCODE experiment accession (ENCSR…)", _key(r"ENCSR[A-Z0-9]{6}"), _encode,
         {"accession": "Accession", "description": "Description", "assay": "Assay", "biosample": "Biosample", "target": "Target", "lab": "Lab", "status": "Status", "released": "Release Date", "assembly": "Assembly", "files": "Released File Download URLs"},
         ["accession", "description", "assay", "biosample", "target", "assembly"]),
    ]
    importers = {}
    for source, label, id_hint, key_fn, fetch, fields, defaults in definitions:
        def batch(client, keys, requested, fetch=fetch):
            found = {}
            for key in keys:
                record = fetch(get, client, key, requested)
                if record is not None:
                    found[key] = record
            return found
        importers[source] = {
            "label": label, "id": id_hint, "key": key_fn, "batch": batch, "batch_size": 1,
            "fields": {**fields, "source_url": "Source URL", "record_json": "Record JSON"},
            "default_fields": [*defaults, "source_url"], "searchable": False,
        }
    return importers
