"""Keyword search over the external sources AnnoBio imports from, for the Agent's search_source tool.

Imports themselves stay id-based (see the /api/<source>/import jobs in main.py); this only finds ids and
shows a few matches, so the Agent can propose an import of exactly the records the user wants.
bioRxiv/medRxiv has no keyword search API, so preprints can only be imported by DOI.
"""

from __future__ import annotations

from typing import Any

import httpx

from chembl_client import CHEMBL_FIELDS, _get_with_retry as _chembl_get
from clinicaltrials_client import CT_FIELDS, STUDIES_URL, _get_with_retry as _ct_get, _parse_study
from preprint_client import PREPRINT_FIELDS
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
}


class SourceSearchError(ValueError):
    pass


def describe_sources() -> dict[str, Any]:
    return {
        key: {"label": s["label"], "id": s["id"], "fields": s["fields"], "searchable": s["searchable"]}
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
        raise SourceSearchError(f"{SOURCES[key]['label']} has no keyword search. Import preprints by DOI instead.")
    text = (query or "").strip()
    if not text:
        raise SourceSearchError("A search query is required.")
    n = max(1, min(int(limit or 100), MAX_SEARCH_IDS))
    if key == "pubmed":
        result = _search_pubmed(text, n, ncbi_api_key, ncbi_email)
    elif key == "clinicaltrials":
        result = _search_clinicaltrials(text, n)
    else:
        result = _search_chembl(text, n)
    return {"source": key, "query": text, "returned": len(result["ids"]), **result}
