"""
Shared identifier-based Dataset imports for the database picker and the Agent's import_dataset.
Source adapters declare fields, identifier formats and fetch functions. Routes share the job runner
in main.py (/api/<source>/import). Synchronous: callers run in a background thread.
"""

from __future__ import annotations

import re
import threading
import time
from typing import Any, Callable
from urllib.parse import urlparse

import httpx
from database_availability import require_data_lake, source_enabled

USER_AGENT = "AnnoBio (https://annobio.org)"
BATCH_DELAY_SEC = 0.2
_TIMEOUT = 30.0
_TAG = re.compile(r"<[^>]+>")
# UniProt function text cites its evidence inline, e.g. "(PubMed:10499802, PubMed:10884347)".
_UNIPROT_CITATION = re.compile(r"\s*\((?:PubMed:\d+[,;\s]*)+\)")
# https://www.uniprot.org/help/accession_numbers
_UNIPROT_ACCESSION = re.compile(r"^(?:[OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9](?:[A-Z][A-Z0-9]{2}[0-9]){1,2})$")
_RATE_LOCK = threading.Lock()
_LAST_REQUEST: dict[str, float] = {}


def _pace(url: str) -> None:
    host = urlparse(url).hostname or ""
    interval = {"eutils.ncbi.nlm.nih.gov": 0.36, "pubchem.ncbi.nlm.nih.gov": 0.22,
                "string-db.org": 1.0, "blast.ncbi.nlm.nih.gov": 10.0}.get(host, 0)
    if interval:
        with _RATE_LOCK:
            time.sleep(max(0, interval - (time.monotonic() - _LAST_REQUEST.get(host, 0))))
            _LAST_REQUEST[host] = time.monotonic()


def _client() -> httpx.Client:
    return httpx.Client(timeout=_TIMEOUT, headers={"User-Agent": USER_AGENT}, follow_redirects=True)


def _get(client: httpx.Client, url: str, params: dict[str, Any], max_retries: int = 2, *, headers=None) -> httpx.Response:
    for attempt in range(max_retries + 1):
        try:
            _pace(url)
            resp = client.get(url, params=params, headers=headers)
            if resp.status_code in (429, 502, 503, 504) and attempt < max_retries:
                time.sleep(1.0 * (attempt + 1))
                continue
            resp.raise_for_status()
            return resp
        except (httpx.TimeoutException, httpx.TransportError):
            if attempt < max_retries:
                time.sleep(1.0 * (attempt + 1))
                continue
            raise
    raise RuntimeError("The source did not respond.")


def _text(value: Any) -> str:
    return " ".join(_TAG.sub(" ", str(value or "")).split())


def _join(values) -> str:
    return "; ".join(str(v) for v in values if v not in (None, ""))


def _strip_prefix(value: Any, *prefixes: str) -> str:
    text = str(value or "").strip()
    for prefix in prefixes:
        if text.lower().startswith(prefix.lower()):
            return text[len(prefix):]
    return text


# ---------- Europe PMC ----------

EUROPEPMC_URL = "https://www.ebi.ac.uk/europepmc/webservices/rest/search"
EUROPEPMC_FIELDS = {
    "id": "Europe PMC ID", "source": "Source", "pmid": "PMID", "pmcid": "PMCID", "doi": "DOI",
    "title": "Title", "authors": "Authors", "journal": "Journal", "year": "Year",
    "publication_date": "Publication Date", "abstract": "Abstract", "keywords": "Keywords",
    "mesh_terms": "MeSH Terms", "is_open_access": "Open Access", "cited_by": "Cited By",
}


def _europepmc_key(token: str) -> str | None:
    """A PMID (digits, or MED:/PMID: prefixed), a PMCID or a preprint id (PPR...), as the row's key."""
    value = token.strip().upper()
    value = _strip_prefix(value, "MED:", "PMID:")
    if re.fullmatch(r"\d+", value) or re.fullmatch(r"PMC\d+", value) or re.fullmatch(r"PPR\d+", value):
        return value
    return None


def _europepmc_clause(key: str) -> str:
    if key.startswith("PMC"):
        return f"PMCID:{key}"
    if key.startswith("PPR"):
        return f"(EXT_ID:{key} AND SRC:PPR)"
    return f"(EXT_ID:{key} AND SRC:MED)"


def _europepmc_row(r: dict) -> dict[str, str]:
    journal = ((r.get("journalInfo") or {}).get("journal") or {}).get("title") \
        or (r.get("bookOrReportDetails") or {}).get("publisher") or ""
    return {
        "id": r.get("id", ""), "source": r.get("source", ""), "pmid": r.get("pmid") or "", "pmcid": r.get("pmcid") or "",
        "doi": r.get("doi") or "", "title": _text(r.get("title")), "authors": r.get("authorString") or "",
        "journal": journal, "year": str(r.get("pubYear") or ""), "publication_date": r.get("firstPublicationDate") or "",
        "abstract": _text(r.get("abstractText")),
        "keywords": _join((r.get("keywordList") or {}).get("keyword") or []),
        "mesh_terms": _join(h.get("descriptorName") for h in (r.get("meshHeadingList") or {}).get("meshHeading") or []),
        "is_open_access": "Yes" if r.get("isOpenAccess") == "Y" else "No" if r.get("isOpenAccess") == "N" else "",
        "cited_by": str(r.get("citedByCount") if r.get("citedByCount") is not None else ""),
    }


def _europepmc_batch(client: httpx.Client, keys: list[str]) -> dict[str, dict[str, str]]:
    query = " OR ".join(_europepmc_clause(key) for key in keys)
    data = _get(client, EUROPEPMC_URL, {"query": query, "format": "json", "resultType": "core", "pageSize": 1000}).json()
    found: dict[str, dict[str, str]] = {}
    for record in (data.get("resultList") or {}).get("result") or []:
        row = _europepmc_row(record)
        # A PMCID is answered with its PubMed record, so match on every id the record carries.
        for candidate in (row["pmid"] if row["source"] == "MED" else "", row["pmcid"].upper(), row["id"].upper() if row["source"] == "PPR" else ""):
            if candidate and candidate in keys and candidate not in found:
                found[candidate] = row
    return found


# ---------- OpenAlex ----------

OPENALEX_URL = "https://api.openalex.org/works"
OPENALEX_FIELDS = {
    "openalex_id": "OpenAlex ID", "doi": "DOI", "pmid": "PMID", "title": "Title", "year": "Year",
    "publication_date": "Publication Date", "type": "Type", "venue": "Venue", "authors": "Authors",
    "cited_by": "Cited By", "abstract": "Abstract", "is_oa": "Open Access", "oa_url": "Open Access URL", "topics": "Topics",
}


def _openalex_key(token: str) -> str | None:
    """An OpenAlex work id (W...) or a DOI; DOIs are keyed in lower case, as OpenAlex compares them."""
    value = _strip_prefix(token.strip(), "https://openalex.org/", "openalex:")
    if re.fullmatch(r"[Ww]\d+", value):
        return value.upper()
    value = _strip_prefix(value, "https://doi.org/", "http://doi.org/", "doi:")
    return value.lower() if re.fullmatch(r"10\.\d{4,9}/\S+", value) else None


def _openalex_row(w: dict) -> dict[str, str]:
    inverted = w.get("abstract_inverted_index") or {}
    words = sorted((position, word) for word, positions in inverted.items() for position in positions)
    location = w.get("primary_location") or {}
    open_access = w.get("open_access") or {}
    return {
        "openalex_id": _strip_prefix(w.get("id"), "https://openalex.org/"),
        "doi": _strip_prefix(w.get("doi"), "https://doi.org/"),
        "pmid": _strip_prefix((w.get("ids") or {}).get("pmid"), "https://pubmed.ncbi.nlm.nih.gov/"),
        "title": w.get("display_name") or "", "year": str(w.get("publication_year") or ""),
        "publication_date": w.get("publication_date") or "", "type": w.get("type") or "",
        "venue": (location.get("source") or {}).get("display_name") or "",
        "authors": _join((a.get("author") or {}).get("display_name") for a in w.get("authorships") or []),
        "cited_by": str(w.get("cited_by_count") if w.get("cited_by_count") is not None else ""),
        "abstract": " ".join(word for _, word in words),
        "is_oa": "Yes" if open_access.get("is_oa") else "No" if "is_oa" in open_access else "",
        "oa_url": open_access.get("oa_url") or "",
        "topics": _join(t.get("display_name") for t in w.get("topics") or []),
    }


def _openalex_batch(client: httpx.Client, keys: list[str]) -> dict[str, dict[str, str]]:
    found: dict[str, dict[str, str]] = {}
    work_ids = [key for key in keys if key.startswith("W")]
    dois = [key for key in keys if not key.startswith("W")]
    for name, values in (("openalex", work_ids), ("doi", dois)):
        if not values:
            continue
        data = _get(client, OPENALEX_URL, {"filter": f"{name}:{'|'.join(values)}", "per-page": 200}).json()
        for work in data.get("results") or []:
            row = _openalex_row(work)
            key = row["openalex_id"].upper() if name == "openalex" else row["doi"].lower()
            if key in values:
                found[key] = row
    return found


# ---------- UniProt ----------

UNIPROT_URL = "https://rest.uniprot.org/uniprotkb/accessions"
UNIPROT_FIELDS = {
    "accession": "Accession", "entry_name": "Entry Name", "reviewed": "Reviewed", "protein": "Protein Name",
    "genes": "Gene Names", "organism": "Organism", "organism_id": "Organism ID", "length": "Length",
    "function": "Function", "subcellular_location": "Subcellular Location", "ec_number": "EC Number",
    "keywords": "Keywords", "go_terms": "GO Terms", "sequence": "Sequence",
}
_UNIPROT_RETURN_FIELDS = ("accession,id,protein_name,gene_names,organism_name,organism_id,length,cc_function,"
                          "cc_subcellular_location,ec,keyword,go,sequence")


def _uniprot_key(token: str) -> str | None:
    value = token.strip().upper()
    return value if _UNIPROT_ACCESSION.match(value) else None


def _uniprot_row(e: dict) -> dict[str, str]:
    names = e.get("proteinDescription") or {}
    recommended = names.get("recommendedName") or {}
    full_name = (recommended.get("fullName") or {}).get("value") \
        or (((names.get("submissionNames") or [{}])[0]).get("fullName") or {}).get("value") or ""
    comments = e.get("comments") or []
    function = " ".join(t.get("value", "") for c in comments if c.get("commentType") == "FUNCTION" for t in c.get("texts") or [])
    locations = [loc.get("location", {}).get("value") for c in comments if c.get("commentType") == "SUBCELLULAR LOCATION"
                 for loc in c.get("subcellularLocations") or []]
    go_terms = [next((p.get("value") for p in ref.get("properties") or [] if p.get("key") == "GoTerm"), "")
                for ref in e.get("uniProtKBCrossReferences") or [] if ref.get("database") == "GO"]
    organism = e.get("organism") or {}
    sequence = e.get("sequence") or {}
    return {
        "accession": e.get("primaryAccession", ""), "entry_name": e.get("uniProtkbId", ""),
        "reviewed": "Yes" if "Swiss-Prot" in str(e.get("entryType", "")) else "No",
        "protein": full_name,
        "genes": _join(g["geneName"]["value"] for g in e.get("genes") or [] if (g.get("geneName") or {}).get("value")),
        "organism": organism.get("scientificName", ""), "organism_id": str(organism.get("taxonId") or ""),
        "length": str(sequence.get("length") or ""),
        "function": _UNIPROT_CITATION.sub("", function).strip(),
        "subcellular_location": _join(dict.fromkeys(locations)),
        "ec_number": _join(n.get("value") for n in recommended.get("ecNumbers") or []),
        "keywords": _join(k.get("name") for k in e.get("keywords") or []),
        "go_terms": _join(go_terms), "sequence": sequence.get("value", ""),
    }


def _uniprot_batch(client: httpx.Client, keys: list[str]) -> dict[str, dict[str, str]]:
    data = _get(client, UNIPROT_URL, {"accessions": ",".join(keys), "format": "json", "fields": _UNIPROT_RETURN_FIELDS}).json()
    rows = [_uniprot_row(entry) for entry in data.get("results") or []]
    return {row["accession"]: row for row in rows if row["accession"] in keys}


# ---------- Wikipedia ----------

WIKIPEDIA_URL = "https://en.wikipedia.org/w/api.php"
WIKIPEDIA_FIELDS = {
    "title": "Title", "url": "URL", "description": "Short Description", "summary": "Introduction",
    "full_text": "Full Text", "page_id": "Page ID",
}


def _wikipedia_key(token: str) -> str | None:
    value = _strip_prefix(token.strip(), "https://en.wikipedia.org/wiki/").replace("_", " ").strip()
    return value or None


def _wikipedia_batch(client: httpx.Client, keys: list[str], fields: list[str]) -> dict[str, dict[str, str]]:
    query = _get(client, WIKIPEDIA_URL, {
        "action": "query", "prop": "extracts|info|description", "exintro": 1, "explaintext": 1, "exlimit": "max",
        "inprop": "url", "titles": "|".join(keys), "redirects": 1, "format": "json", "formatversion": 2,
    }).json().get("query") or {}
    # A title the user typed may be normalized ("cdk2" → "CDK2") and then redirected.
    renamed = {item["from"]: item["to"] for item in (query.get("normalized") or []) + (query.get("redirects") or [])}
    pages = {page.get("title"): page for page in query.get("pages") or [] if not page.get("missing") and not page.get("invalid")}
    found: dict[str, dict[str, str]] = {}
    for key in keys:
        title = key
        for _ in range(3):
            if title in pages or title not in renamed:
                break
            title = renamed[title]
        page = pages.get(title)
        if not page:
            continue
        found[key] = {
            "title": page.get("title", ""), "url": page.get("fullurl", ""), "description": page.get("description") or "",
            "summary": (page.get("extract") or "").strip(), "full_text": "", "page_id": str(page.get("pageid") or ""),
        }
    if "full_text" in fields:
        # Whole-article text comes one page per request.
        for row in found.values():
            full = _get(client, WIKIPEDIA_URL, {
                "action": "query", "prop": "extracts", "explaintext": 1, "pageids": row["page_id"], "format": "json", "formatversion": 2,
            }).json()
            row["full_text"] = ((full.get("query") or {}).get("pages") or [{}])[0].get("extract", "").strip()
    return found


# ---------- shared ----------

REFERENCE_IMPORTERS: dict[str, dict[str, Any]] = {
    "europepmc": {"label": "Europe PMC", "id": "PMID, PMCID or preprint id (PPR...)", "fields": EUROPEPMC_FIELDS,
                  "default_fields": ["id", "pmid", "doi", "title", "authors", "journal", "year", "abstract"],
                  "key": _europepmc_key, "batch": lambda client, keys, fields: _europepmc_batch(client, keys), "batch_size": 20},
    "openalex": {"label": "OpenAlex", "id": "OpenAlex work id (W...) or DOI", "fields": OPENALEX_FIELDS,
                 "default_fields": ["openalex_id", "doi", "title", "year", "venue", "authors", "cited_by", "abstract"],
                 "key": _openalex_key, "batch": lambda client, keys, fields: _openalex_batch(client, keys), "batch_size": 50},
    "uniprot": {"label": "UniProt", "id": "UniProt accession", "fields": UNIPROT_FIELDS,
                "default_fields": ["accession", "entry_name", "protein", "genes", "organism", "length", "function"],
                "key": _uniprot_key, "batch": lambda client, keys, fields: _uniprot_batch(client, keys), "batch_size": 100},
    "wikipedia": {"label": "Wikipedia", "id": "English Wikipedia article title", "fields": WIKIPEDIA_FIELDS,
                  "default_fields": ["title", "url", "summary"],
                  "key": _wikipedia_key, "batch": _wikipedia_batch, "batch_size": 20},
}

from database_importers import build_database_importers

REFERENCE_IMPORTERS.update(build_database_importers(_get))
from biomni_database_importers import build_biomni_database_importers

REFERENCE_IMPORTERS.update(build_biomni_database_importers(_get))
from biomni_data_lake import build_data_lake_importers

REFERENCE_IMPORTERS.update(build_data_lake_importers())
MAX_IDS = 2000


def describe_importers() -> dict[str, Any]:
    return {key: {"label": s["label"], "id": s["id"], "fields": s["fields"], "default_fields": s["default_fields"],
                  **{name: s[name] for name in ("kind", "option_fields", "example", "category", "datasets", "help_url") if name in s}}
            for key, s in REFERENCE_IMPORTERS.items() if source_enabled(s)}


def fetch_records(
    source: str,
    ids: list[str],
    fields: list[str],
    on_batch: Callable[[list[dict[str, str]], list[str], int, int], None] | None = None,
    options: dict[str, Any] | None = None,
    on_metadata: Callable[[dict[str, Any]], None] | None = None,
) -> list[dict[str, str]]:
    """
    Fetch `fields` for `ids` from `source`, in the requested order and without duplicates. Ids that are
    malformed or not found are reported as not found rather than becoming blank rows. Calls
    on_batch(rows, not_found, processed, total) after each batch, like chembl_client.fetch_molecules,
    so the job can show progress and keep what it has if it is stopped.
    """
    importer = REFERENCE_IMPORTERS[source]
    if importer.get("kind") == "snapshot":
        require_data_lake()
        from biomni_data_lake import fetch_snapshot_records
        with _client() as client:
            return fetch_snapshot_records(source, ids, fields, options or {}, client, on_batch, on_metadata)
    from record_filters import compile_filters
    filters = (options or {}).get('filters')
    matches_filters = compile_filters(filters, importer['fields'])
    fetch_fields = list(dict.fromkeys([*fields, *(rule['column'] for rule in filters or [])]))
    keyed = [(token, importer["key"](token)) for token in ids if str(token).strip()]
    keys = list(dict.fromkeys(key for _, key in keyed if key))[:MAX_IDS]
    invalid = list(dict.fromkeys(token.strip() for token, key in keyed if not key))
    total = len(keys) + len(invalid)
    out: list[dict[str, str]] = []
    if on_batch and invalid:
        on_batch([], invalid, len(invalid), total)
    processed = len(invalid)
    size = importer["batch_size"]
    with _client() as client:
        for start in range(0, len(keys), size):
            batch = keys[start:start + size]
            if "batch_options" in importer:
                batch_options = {**(options or {})}
                if on_batch:
                    batch_options['_heartbeat'] = lambda: on_batch([], [], processed, total)
                found = importer["batch_options"](client, batch, fetch_fields, batch_options)
            else:
                found = importer["batch"](client, batch, fetch_fields)
            rows = [{f: found[key].get(f, "") for f in fields} for key in batch if key in found and matches_filters(found[key])]
            out.extend(rows)
            processed += len(batch)
            if on_batch:
                on_batch(rows, [key for key in batch if key not in found], processed, total)
            if start + size < len(keys):
                time.sleep(max(BATCH_DELAY_SEC, 1.0 if source == "gnomad" else 0))
    return out
