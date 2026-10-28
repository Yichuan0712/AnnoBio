"""Additional database adapters covering Biomni's pinned online database registry."""
from __future__ import annotations

import json
import os
import re
import time
from urllib.parse import quote
from xml.etree import ElementTree
import httpx

from database_importers import _cell, _json, _key, _names, _plain, _row


def _request(get, client, url, params=None, *, headers=None):
    try:
        response = get(client, url, params or {}, headers={"Accept": "application/json", **(headers or {})})
    except httpx.HTTPStatusError as error:
        if error.response.status_code == 404:
            return None
        raise
    if response.status_code == 204:
        return None
    if "json" not in response.headers.get("content-type", "").lower():
        raise ValueError("The database returned a web page instead of data. Please try again later.")
    return response.json()


def _auth(options, source, env, *, required=True):
    token = str(options.get("api_key") or os.environ.get(env) or "").strip()
    if required and not token:
        raise ValueError(f"{source} requires an API key. Enter your key in the import form.")
    return token


def _region(key, default="hg38"):
    match = re.fullmatch(r"(?:(hg38|hg19|mm10|mm39)/)?(chr[\w]+):(\d+)-(\d+)", key)
    if not match:
        raise ValueError("Use assembly/chr:start-end, for example hg38/chr1:100000-101000.")
    assembly, chrom, start, end = match.groups()
    start, end = int(start), int(end)
    if end <= start or end - start > 100000:
        raise ValueError("Choose a region of 1–100,000 bases using zero-based start coordinates.")
    return assembly or default, chrom, start, end


def _kegg(get, client, key, fields, options):
    response = get(client, "https://rest.kegg.jp/get/" + quote(key, safe=":"), {})
    if not response.text.strip():
        return None
    parsed = {}
    current = ""
    for line in response.text.splitlines():
        field, value = line[:12].strip(), line[12:].strip()
        if field:
            current = field
        if current and value:
            parsed.setdefault(current, []).append(value)
    return _row(parsed, f"https://www.kegg.jp/entry/{quote(key, safe=':')}", id=key,
                name="; ".join(parsed.get("NAME") or parsed.get("SYMBOL") or []),
                description=" ".join(parsed.get("DEFINITION") or parsed.get("NAME") or []),
                organism="; ".join(parsed.get("ORGANISM") or []),
                pathways="; ".join(parsed.get("PATHWAY") or []), raw_text=response.text)


def _iucn(get, client, key, fields, options):
    token = _auth(options, "IUCN Red List", "IUCN_API_TOKEN")
    data = _request(get, client, f"https://api.iucnredlist.org/api/v4/taxa/sis/{key}", headers={"Authorization": token})
    if not data:
        return None
    taxon = data.get("taxon") or data
    return _row(data, f"https://www.iucnredlist.org/species/{key}", id=key,
                name=taxon.get("scientific_name") or taxon.get("scientificName"),
                description=taxon.get("authority"), assessments=data.get("assessments"))


def _paleobiology(get, client, key, fields, options):
    data = _json(get, client, "https://paleobiodb.org/data1.2/taxa/single.json", {"id": key, "show": "attr,app"})
    records = (data or {}).get("records") or []
    if not records:
        return None
    r = records[0]
    return _row(r, f"https://paleobiodb.org/classic/basicTaxonInfo?taxon_no={key.split(':')[-1]}",
                id=r.get("oid"), name=r.get("nam"), description=r.get("att"), rank=r.get("rnk"), parent=r.get("par"))


def _jaspar(get, client, key, fields, options):
    r = _json(get, client, f"https://jaspar.elixir.no/api/v1/matrix/{key}/")
    if not r:
        return None
    return _row(r, f"https://jaspar.elixir.no/matrix/{key}/", id=r.get("matrix_id"), name=r.get("name"),
                description=r.get("collection"), species=_names(r.get("species")),
                matrix=r.get("pfm"), transcription_factor_class=r.get("class"), family=r.get("family"))


def _worms(get, client, key, fields, options):
    r = _json(get, client, f"https://www.marinespecies.org/rest/AphiaRecordByAphiaID/{key}")
    if not r:
        return None
    return _row(r, r.get("url") or f"https://www.marinespecies.org/aphia.php?p=taxdetails&id={key}",
                id=r.get("AphiaID"), name=r.get("scientificname"), description=r.get("authority"),
                rank=r.get("rank"), status=r.get("status"), accepted_name=r.get("valid_name"), kingdom=r.get("kingdom"))


def _cbioportal(get, client, key, fields, options):
    r = _json(get, client, f"https://www.cbioportal.org/api/studies/{key}")
    if not r:
        return None
    return _row(r, f"https://www.cbioportal.org/study/summary?id={key}", id=r.get("studyId"), name=r.get("name"),
                description=_plain(r.get("description")), cancer_type=r.get("cancerTypeId"),
                sample_count=r.get("allSampleCount"), pubmed_id=r.get("pmid"), citation=r.get("citation"))


def _dbsnp(get, client, key, fields, options):
    r = _json(get, client, f"https://api.ncbi.nlm.nih.gov/variation/v0/refsnp/{key.removeprefix('rs')}")
    if not r:
        return None
    primary = r.get("primary_snapshot_data") or {}
    placements = primary.get("placements_with_allele") or []
    hgvs = [a.get("hgvs") for p in placements if p.get("is_ptlp") for a in p.get("alleles") or []]
    return _row(r, f"https://www.ncbi.nlm.nih.gov/snp/{key}", id="rs" + str(r.get("refsnp_id", "")),
                name=key, description=primary.get("variant_type"), variant_type=primary.get("variant_type"),
                alleles=hgvs, last_updated=r.get("last_update_date"), build=r.get("last_update_build_id"))


def _ucsc(get, client, key, fields, options):
    assembly, chrom, start, end = _region(key)
    r = _json(get, client, "https://api.genome.ucsc.edu/getData/sequence",
              {"genome": assembly, "chrom": chrom, "start": start, "end": end})
    if not r:
        return None
    return _row(r, f"https://genome.ucsc.edu/cgi-bin/hgTracks?db={assembly}&position={chrom}:{start + 1}-{end}",
                id=key, name=f"{assembly} {chrom}:{start}-{end}", description="Genomic sequence (zero-based start)",
                assembly=assembly, chromosome=chrom, start=start, end=end, sequence=r.get("dna"))


def _monarch(get, client, key, fields, options):
    r = _json(get, client, "https://api.monarchinitiative.org/v3/api/entity/" + quote(key, safe=":"))
    if not r:
        return None
    return _row(r, f"https://monarchinitiative.org/{quote(key, safe=':')}", id=r.get("id"), name=r.get("name"),
                description=r.get("description"), category=r.get("category"), synonyms=r.get("synonym"))


def _regulomedb(get, client, key, fields, options):
    r = _request(get, client, "https://api.regulomedb.org/search", {"regions": key, "genome": "GRCh38"})
    if not r:
        return None
    return _row(r, f"https://regulomedb.org/summary?regions={quote(key)}&genome=GRCh38", id=key,
                name=key, description="RegulomeDB GRCh38 regulatory evidence", results=r)


def _gtopdb(get, client, key, fields, options):
    token = _auth(options, "Guide to PHARMACOLOGY", "GTOPDB_API_KEY")
    kind, identifier = key.split(":", 1)
    data = _request(get, client, f"https://www.guidetopharmacology.org/services/{kind}/{identifier}",
                    headers={"GTP-API-Key": token})
    if not data:
        return None
    return _row(data, f"https://www.guidetopharmacology.org/GRAC/{'Object' if kind == 'targets' else 'Ligand'}DisplayForward?{('objectId' if kind == 'targets' else 'ligandId')}={identifier}",
                id=key, name=data.get("name"), description=_plain(data.get("description")), entity_type=kind)


def _remap(get, client, key, fields, options):
    assembly, chrom, start, end = _region(key)
    if assembly not in ('hg38', 'hg19', 'mm10'):
        raise ValueError('ReMap 2022 supports hg38, hg19 and mm10 in this importer.')
    url = f"https://remap-rest.univ-amu.fr/api/V1/get_peaks/2022/{assembly}/all/{chrom}:{start}-{end}"
    data = _request(get, client, url)
    if not data:
        return None
    return _row(data, url, id=key, name=key, description="ReMap 2022 transcriptional regulator peaks", peaks=data)


def _mpd(get, client, key, fields, options):
    data = _json(get, client, f"https://phenome.jax.org/api/pheno/measureinfo/{key}")
    records = (data or {}).get("measures_info") or []
    if not records:
        return None
    r = records[0]
    return _row(r, f"https://phenome.jax.org/measures/{key}", id=key, name=r.get("varname"),
                description=r.get("descrip"), units=r.get("units"), project=r.get("projname"), age=r.get("ageweeks"))


def _emdb(get, client, key, fields, options):
    r = _json(get, client, f"https://www.ebi.ac.uk/emdb/api/entry/{key}")
    if not r:
        return None
    sample = r.get("sample") or {}
    structure = r.get("structure_determination_list") or {}
    return _row(r, f"https://www.ebi.ac.uk/emdb/{key}", id=key, name=(r.get("admin") or {}).get("title"),
                description=_plain(sample.get("name")), structure_determination=structure,
                map_url=f"https://ftp.ebi.ac.uk/pub/databases/emdb/structures/{key}/map/emd_{key.split('-')[-1]}.map.gz")


def _synapse(get, client, key, fields, options):
    token = _auth(options, "Synapse", "SYNAPSE_AUTH_TOKEN", required=False)
    headers = {"Authorization": f"Bearer {token}"} if token else None
    r = _request(get, client, f"https://repo-prod.prod.sagebase.org/repo/v1/entity/{key}", headers=headers)
    if not r:
        return None
    return _row(r, f"https://www.synapse.org/Synapse:{key}", id=r.get("id"), name=r.get("name"),
                description=r.get("description"), entity_type=r.get("concreteType"),
                parent=r.get("parentId"), created=r.get("createdOn"), modified=r.get("modifiedOn"))


def _unichem(get, client, key, fields, options):
    response = client.post("https://www.ebi.ac.uk/unichem/api/v1/compounds", json={"type": "inchikey", "compound": key})
    response.raise_for_status()
    records = response.json().get("compounds") or []
    if not records:
        return None
    r = records[0]
    return _row(r, "https://www.ebi.ac.uk/unichem/", id=key, name=key, description="Cross-database compound identifiers",
                inchi=(r.get("inchi") or {}).get("inchi"), cross_references=r.get("sources"))


def _quickgo(get, client, key, fields, options):
    data = _json(get, client, "https://www.ebi.ac.uk/QuickGO/services/ontology/go/terms/" + quote(key, safe=":"))
    records = (data or {}).get("results") or []
    if not records:
        return None
    r = records[0]
    return _row(r, f"https://www.ebi.ac.uk/QuickGO/term/{key}", id=r.get("id"), name=r.get("name"),
                description=(r.get("definition") or {}).get("text"), aspect=r.get("aspect"), obsolete=r.get("isObsolete"),
                synonyms=_names(r.get("synonyms")))


def _screen(get, client, key, fields, options):
    token = _auth(options, "ENCODE SCREEN", "SCREEN_API_KEY")
    variables = {"assembly": "grch38", "coordinates": None, "accession": None}
    if key.startswith("EH"):
        variables["accession"] = [key.split("/", 1)[0]]
    else:
        assembly, chrom, start, end = _region(key)
        if assembly not in ("hg38", "mm10"):
            raise ValueError("SCREEN supports hg38 and mm10.")
        variables.update(assembly="grch38" if assembly == "hg38" else "mm10",
                         coordinates=[{"chromosome": chrom, "start": start, "end": end}])
    query = """query($assembly:String!,$coordinates:[GenomicRangeInput!],$accession:[String!]) {
      cCREQuery(assembly:$assembly,coordinates:$coordinates,accession:$accession,limit:100) {
        accession assembly rDHS coordinates { chromosome start end }
        nearby_genes { intersecting_genes { id name } }
      }
    }"""
    response = client.post("https://screen.api.wenglab.org/graphql", json={"query": query, "variables": variables},
                           headers={"Authorization": f"Bearer {token}"})
    response.raise_for_status()
    data = response.json()
    if data.get("errors"):
        raise ValueError("; ".join(str(e.get("message", e)) for e in data["errors"]))
    records = (data.get("data") or {}).get("cCREQuery") or []
    if not records:
        return None
    return _row(records, "https://screen.wenglab.org/", id=key, name=key,
                description="SCREEN cCREs and nearby genes (up to 100 elements per query)", results=records)


def _blast(get, client, key, fields, options):
    program = str(options.get("program") or "blastn")
    if program not in ("blastn", "blastp"):
        raise ValueError("Choose blastn or blastp.")
    resumed = key.startswith('RID:')
    sequence = re.sub(r"\s+", "", key).upper()
    if not resumed and (not re.fullmatch(r"[A-Z*]+", sequence) or not 20 <= len(sequence) <= 10000):
        raise ValueError("Enter one sequence of 20–10,000 letters per line.")
    database = '' if resumed else "core_nt" if program == "blastn" else "nr"
    url = "https://blast.ncbi.nlm.nih.gov/Blast.cgi"
    if resumed:
        rid = key.removeprefix('RID:')
    else:
        from reference_import import _pace
        _pace(url)
        response = client.post(url, data={"CMD": "Put", "PROGRAM": program, "DATABASE": database, "QUERY": sequence,
                                          "HITLIST_SIZE": 10, "TOOL": "AnnoBio"})
        response.raise_for_status()
        match = re.search(r"RID\s*=\s*([A-Z0-9-]+)", response.text)
        if not match:
            raise ValueError("NCBI BLAST did not accept the sequence. Please try again later.")
        rid = match[1]
    # NCBI asks clients to wait at least 60 seconds between polls for the same RID.
    heartbeat = options.get('_heartbeat')
    for attempt in range(10):
        for second in range(60):
            time.sleep(1)
            if heartbeat: heartbeat()
        info = get(client, url, {"CMD": "Get", "RID": rid, "FORMAT_OBJECT": "SearchInfo"}).text
        if "Status=FAILED" in info or "Status=UNKNOWN" in info:
            raise ValueError(f"NCBI BLAST job {rid} failed or expired.")
        if "Status=READY" not in info:
            continue
        # Respect NCBI's minimum interval between all requests, including the result download.
        for second in range(10):
            time.sleep(1)
            if heartbeat: heartbeat()
        xml = get(client, url, {"CMD": "Get", "RID": rid, "FORMAT_TYPE": "XML"}).content
        root = ElementTree.fromstring(xml)
        hits = [{"accession": h.findtext("Hit_accession"), "description": h.findtext("Hit_def"),
                 "evalue": h.findtext(".//Hsp_evalue"), "identity": h.findtext(".//Hsp_identity"),
                 "alignment_length": h.findtext(".//Hsp_align-len")} for h in root.findall(".//Hit")]
        return _row(hits, f"https://blast.ncbi.nlm.nih.gov/Blast.cgi?CMD=Get&RID={rid}",
                    id=rid, name=root.findtext('BlastOutput_program') or ('' if resumed else program),
                    description="NCBI BLAST sequence matches", status='ready',
                    database=root.findtext('BlastOutput_db') or database, hits=hits)
    return _row({'rid': rid, 'status': 'running'}, f"{url}?CMD=Get&RID={rid}", id=rid,
                name='' if resumed else program, status='running', database=database, hits=[],
                description=f"NCBI is still processing this query. Import RID:{rid} later to retrieve its results.")


def build_biomni_database_importers(get):
    definitions = [
        ("kegg", "KEGG", "KEGG entry ID", r"[A-Za-z0-9_]+(?::[A-Za-z0-9_.-]+)?", _kegg, "hsa:7157", "Pathways and associations", ["organism", "pathways", "raw_text"]),
        ("iucn", "IUCN Red List", "IUCN SIS taxon ID", r"\d+", _iucn, "15951", "Species and phenotypes", ["assessments"]),
        ("paleobiology", "Paleobiology Database", "PBDB taxon ID", r"(?:txn:)?\d+", _paleobiology, "txn:54585", "Species and phenotypes", ["rank", "parent"]),
        ("jaspar", "JASPAR", "JASPAR matrix ID", r"MA\d{4}(?:\.\d+)?", _jaspar, "MA0139.1", "Pathways and associations", ["species", "matrix", "transcription_factor_class", "family"]),
        ("worms", "WoRMS", "AphiaID", r"\d+", _worms, "1371", "Species and phenotypes", ["rank", "status", "accepted_name", "kingdom"]),
        ("cbioportal", "cBioPortal", "Cancer study ID", r"[a-zA-Z0-9_-]+", _cbioportal, "brca_tcga", "Clinical research", ["cancer_type", "sample_count", "pubmed_id", "citation"]),
        ("dbsnp", "dbSNP", "RefSNP ID (rs…)", r"rs\d+", _dbsnp, "rs328", "Genes and variants", ["variant_type", "alleles", "last_updated", "build"]),
        ("ucsc", "UCSC Genome Browser", "assembly/chr:start-end (zero-based start)", r"(?:(?:hg38|hg19|mm10|mm39)/)?chr\w+:\d+-\d+", _ucsc, "hg38/chrM:0-50", "Genes and variants", ["assembly", "chromosome", "start", "end", "sequence"]),
        ("monarch", "Monarch Initiative", "Ontology or gene identifier", r"[A-Za-z][A-Za-z0-9_.-]*:[A-Za-z0-9_.-]+", _monarch, "MONDO:0007947", "Genes and variants", ["category", "synonyms"]),
        ("regulomedb", "RegulomeDB", "rsID or chr:start-end (GRCh38)", r"(?:rs\d+|chr\w+:\d+-\d+)", _regulomedb, "rs190509934", "Pathways and associations", ["results"]),
        ("gtopdb", "Guide to PHARMACOLOGY", "targets:ID or ligands:ID", r"(?:targets|ligands):\d+", _gtopdb, "targets:214", "Compounds and drugs", ["entity_type"]),
        ("remap", "ReMap", "assembly/chr:start-end (zero-based start)", r"(?:(?:hg38|hg19|mm10|mm39)/)?chr\w+:\d+-\d+", _remap, "hg38/chr1:100000-101000", "Pathways and associations", ["peaks"]),
        ("mpd", "Mouse Phenome Database", "MPD measurement ID", r"\d+", _mpd, "1501", "Species and phenotypes", ["units", "project", "age"]),
        ("emdb", "EMDB", "EMDB accession", r"EMD-\d+", _emdb, "EMD-1001", "Proteins and structures", ["structure_determination", "map_url"]),
        ("synapse", "Synapse", "Synapse entity ID", r"syn\d+", _synapse, "syn9702085", "Experimental data", ["entity_type", "parent", "created", "modified"]),
        ("unichem", "UniChem", "InChIKey", r"[A-Z]{14}-[A-Z]{10}-[A-Z]", _unichem, "BSYNRYMUTXBXSQ-UHFFFAOYSA-N", "Compounds and drugs", ["inchi", "cross_references"]),
        ("quickgo", "QuickGO / GO", "GO term ID", r"GO:\d{7}", _quickgo, "GO:0006915", "Pathways and associations", ["aspect", "obsolete", "synonyms"]),
        ("screen", "ENCODE SCREEN", "hg38/chr:start-end or cCRE/chr", r"(?:(?:(?:hg38|mm10)/)?chr\w+:\d+-\d+|EH38E\d+/chr\w+)", _screen, "hg38/chr12:53900000-53901000", "Pathways and associations", ["results"]),
        ("blast", "NCBI BLAST", "One sequence or RID:job-ID per line", r"(?:[A-Za-z*]{20,10000}|RID:[A-Z0-9-]+)", _blast, "ATGCGTACGTAGCTAGCTAGCTAGCTAGCTA", "Sequences", ["status", "hits", "database"]),
    ]
    importers = {}
    for source, label, id_hint, pattern, fetch, example, category, extra in definitions:
        fields = {"id": "ID", "name": "Name", "description": "Description", **{k: k.replace('_', ' ').title() for k in extra},
                  "source_url": "Source URL", "record_json": "Record JSON"}
        def batch(client, keys, requested, options, fetch=fetch):
            found = {}
            for key in keys:
                r = fetch(get, client, key, requested, options)
                if r is not None:
                    found[key] = r
            return found
        importers[source] = {"label": label, "id": id_hint, "fields": fields,
            "default_fields": ["id", "name", "description", *extra[:2], "source_url"],
            "key": _key(pattern, str), "batch_options": batch, "batch_size": 1, "searchable": False,
            "example": example, "category": category, "kind": "online", "option_fields": []}
    for source in ("iucn", "gtopdb", "synapse", "screen"):
        importers[source]["option_fields"] = [{"key": "api_key", "label": "API key" if source != "synapse" else "Access token (optional for public records)",
            "type": "password", "required": source != "synapse"}]
    for source, url in {"iucn": "https://api.iucnredlist.org/", "gtopdb": "https://www.guidetopharmacology.org/webServices.jsp",
                        "screen": "https://console.wenglab.org/docs/getting-started/auth",
                        "synapse": "https://www.synapse.org/PersonalAccessTokens"}.items():
        importers[source]["help_url"] = url
    importers["blast"]["option_fields"] = [{"key": "program", "label": "Search program", "type": "select", "default": "blastn",
        "choices": [{"value": "blastn", "label": "DNA (blastn / core_nt)"}, {"value": "blastp", "label": "Protein (blastp / nr)"}]}]
    return importers
