"""Keyword search for the Agent's search_source tool.

Importable sources (PubMed, ClinicalTrials.gov, ChEMBL, bioRxiv/medRxiv) are imported by id (see the
/api/<source>/import jobs in main.py); this only finds ids and shows a few matches, so the Agent can propose
an import of exactly the records the user wants. bioRxiv/medRxiv has no keyword search API: preprints are
found through Europe PMC. Europe PMC, OpenAlex, UniProt and Wikipedia are searched in reference_sources.py
and imported by id through reference_import.py.
"""

from __future__ import annotations

from typing import Any

import httpx

from agent.reference_sources import search_europepmc, search_openalex, search_uniprot, search_wikipedia
from chembl_client import CHEMBL_FIELDS, _get_with_retry as _chembl_get
from clinicaltrials_client import CT_FIELDS, STUDIES_URL, _get_with_retry as _ct_get, _parse_study
from preprint_client import PREPRINT_FIELDS
from reference_import import REFERENCE_IMPORTERS
from pubmed_client import PUBMED_FIELDS, _get_with_retry as _pubmed_get, _ncbi_params, efetch_batch

PUBMED_ESEARCH_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi"
CHEMBL_SEARCH_URL = "https://www.ebi.ac.uk/chembl/api/data/molecule/search.json"
MAX_SEARCH_IDS = 500
SAMPLE_COUNT = 5

SOURCES: dict[str, dict[str, Any]] = {
    "pubmed": {"label": "PubMed", "id": "PMID", "fields": PUBMED_FIELDS, "searchable": True},
    "clinicaltrials": {"label": "ClinicalTrials.gov", "id": "NCT id", "fields": CT_FIELDS, "searchable": True},
    "chembl": {"label": "ChEMBL", "id": "ChEMBL id", "fields": CHEMBL_FIELDS, "searchable": True},
    "preprint": {"label": "bioRxiv/medRxiv", "id": "DOI", "fields": PREPRINT_FIELDS, "searchable": False},
    **{key: {"label": s["label"], "id": s["id"], "fields": s["fields"], "searchable": s.get("searchable", True), "option_fields": s.get("option_fields", [])}
       for key, s in REFERENCE_IMPORTERS.items() if s.get("kind") != "snapshot"},
}
LOOKUP_SEARCHES = {"europepmc": search_europepmc, "openalex": search_openalex, "uniprot": search_uniprot, "wikipedia": search_wikipedia}


class SourceSearchError(ValueError):
    pass


def describe_sources() -> dict[str, Any]:
    return {
        key: {"label": s["label"], "id": s["id"], "fields": s["fields"], "searchable": s["searchable"], "option_fields": s.get("option_fields", [])}
        for key, s in SOURCES.items()
    }


def _search_pubmed(query: str, limit: int, api_key: str, email: str) -> dict[str, Any]:
    with httpx.Client(timeout=20.0) as client:
        params = {**_ncbi_params(api_key, email), "db": "pubmed", "term": query, "retmax": limit, "retmode": "json"}
        data = _pubmed_get(client, PUBMED_ESEARCH_URL, params).json().get("esearchresult") or {}
    ids = [str(i) for i in data.get("idlist") or []]
    samples = [
        {"id": a.get("pmid", ""), "title": a.get("title", ""), "year": a.get("year", ""), "journal": a.get("journal", "")}
        for a in efetch_batch(ids[:SAMPLE_COUNT], api_key=api_key, email=email)
    ]
    return {"total": int(data.get("count") or 0), "ids": ids, "samples": samples}


def _search_clinicaltrials(query: str, limit: int) -> dict[str, Any]:
    with httpx.Client(timeout=20.0) as client:
        params = {"query.term": query, "pageSize": min(limit, 1000), "countTotal": "true"}
        data = _ct_get(client, STUDIES_URL, params).json()
    studies = [_parse_study(s) for s in data.get("studies") or []]
    return {
        "total": int(data.get("totalCount") or len(studies)),
        "ids": [s["nct_id"] for s in studies if s.get("nct_id")],
        "samples": [
            {"id": s.get("nct_id", ""), "title": s.get("brief_title", ""), "status": s.get("overall_status", ""), "phase": s.get("phase", "")}
            for s in studies[:SAMPLE_COUNT]
        ],
    }


def _search_chembl(query: str, limit: int) -> dict[str, Any]:
    with httpx.Client(timeout=20.0) as client:
        data = _chembl_get(client, CHEMBL_SEARCH_URL, {"q": query, "limit": min(limit, 1000)}).json()
    molecules = data.get("molecules") or []
    return {
        "total": int((data.get("page_meta") or {}).get("total_count") or len(molecules)),
        "ids": [m.get("molecule_chembl_id") for m in molecules if m.get("molecule_chembl_id")],
        "samples": [
            {"id": m.get("molecule_chembl_id", ""), "name": m.get("pref_name") or "", "max_phase": m.get("max_phase")}
            for m in molecules[:SAMPLE_COUNT]
        ],
    }


def search_source(source: str, query: str, limit: int = 100, ncbi_api_key: str = "", ncbi_email: str = "") -> dict[str, Any]:
    key = (source or "").strip().lower()
    if key not in SOURCES:
        raise SourceSearchError(f"Unknown source. Use one of: {', '.join(SOURCES)}.")
    if not SOURCES[key]["searchable"]:
        if key == "preprint":
            raise SourceSearchError("bioRxiv/medRxiv has no keyword search. Search europepmc with SRC:PPR, then import preprints by DOI.")
        raise SourceSearchError(f"{SOURCES[key]['label']} currently supports import by {SOURCES[key]['id']}, not keyword search.")
    text = (query or "").strip()
    if not text:
        raise SourceSearchError("A search query is required.")
    n = max(1, min(int(limit or 100), MAX_SEARCH_IDS))
    if key == "pubmed":
        result = _search_pubmed(text, n, ncbi_api_key, ncbi_email)
    elif key == "clinicaltrials":
        result = _search_clinicaltrials(text, n)
    elif key == "chembl":
        result = _search_chembl(text, n)
    else:
        result = LOOKUP_SEARCHES[key](text, n, SAMPLE_COUNT)
    return {"source": key, "query": text, "returned": len(result["ids"]), **result}
