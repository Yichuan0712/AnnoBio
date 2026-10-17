"""Keyword search of Europe PMC, OpenAlex, UniProt and Wikipedia for the Agent's search_source tool.

The ids found import through the same sources (reference_import.py). Europe PMC and OpenAlex results also
carry PMIDs and bioRxiv/medRxiv DOIs for the pubmed and preprint sources. All four are free public APIs
that need no key.
"""

from __future__ import annotations

import re
import time
from typing import Any

import httpx

USER_AGENT = "AnnoBio (https://annobio.org)"
EUROPEPMC_SEARCH_URL = "https://www.ebi.ac.uk/europepmc/webservices/rest/search"
OPENALEX_WORKS_URL = "https://api.openalex.org/works"
UNIPROT_SEARCH_URL = "https://rest.uniprot.org/uniprotkb/search"
WIKIPEDIA_API_URL = "https://en.wikipedia.org/w/api.php"
# Samples are read by the model, so their long text is cut to keep a search result small.
TEXT_LIMIT = 1200
OPENALEX_MAX_PAGE = 200
# The preprint source imports from these servers only; Europe PMC also lists Research Square, arXiv and others.
IMPORTABLE_PREPRINT_SERVERS = {"biorxiv", "medrxiv"}
# UniProt function text cites its evidence inline, e.g. "(PubMed:10499802, PubMed:10884347)".
_UNIPROT_CITATION = re.compile(r"\s*\((?:PubMed:\d+[,;\s]*)+\)")


def _client() -> httpx.Client:
    return httpx.Client(timeout=20.0, headers={"User-Agent": USER_AGENT}, follow_redirects=True)


def _get(client: httpx.Client, url: str, params: dict[str, Any], max_retries: int = 2) -> httpx.Response:
    for attempt in range(max_retries + 1):
        try:
            resp = client.get(url, params=params)
            if resp.status_code == 429 and attempt < max_retries:
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


def _cut(text: Any) -> str:
    value = " ".join(str(text or "").split())
    return value if len(value) <= TEXT_LIMIT else value[:TEXT_LIMIT].rstrip() + "…"


def _strip_prefix(value: Any, prefix: str) -> str:
    text = str(value or "")
    return text[len(prefix):] if text.startswith(prefix) else text


def search_europepmc(query: str, limit: int, sample_count: int) -> dict[str, Any]:
    with _client() as client:
        listed = _get(client, EUROPEPMC_SEARCH_URL, {"query": query, "format": "json", "resultType": "lite", "pageSize": min(limit, 1000)}).json()
        detailed = _get(client, EUROPEPMC_SEARCH_URL, {"query": query, "format": "json", "resultType": "core", "pageSize": sample_count}).json()
    records = (listed.get("resultList") or {}).get("result") or []
    samples = [
        {
            "id": r.get("id", ""), "source": r.get("source", ""), "pmid": r.get("pmid") or "", "doi": r.get("doi") or "",
            "title": r.get("title", ""), "year": r.get("pubYear", ""),
            "journal": r.get("journalTitle") or (r.get("bookOrReportDetails") or {}).get("publisher") or "",
            "abstract": _cut(r.get("abstractText")),
        }
        for r in (detailed.get("resultList") or {}).get("result") or []
    ]
    return {
        "total": int(listed.get("hitCount") or 0),
        "ids": [r["id"] for r in records if r.get("id")],
        "pmids": [r["pmid"] for r in records if r.get("pmid")],
        "preprint_dois": [r["doi"] for r in records if r.get("source") == "PPR" and r.get("doi")
                          and str((r.get("bookOrReportDetails") or {}).get("publisher", "")).lower() in IMPORTABLE_PREPRINT_SERVERS],
        "samples": samples,
        "note": "Import ids through europepmc. pmids also import through pubmed and preprint_dois (bioRxiv/medRxiv only) "
                "through preprint. Restrict to preprints with SRC:PPR in the query.",
    }


def _openalex_abstract(inverted: dict[str, list[int]] | None) -> str:
    """OpenAlex stores abstracts as word → positions."""
    if not inverted:
        return ""
    words = sorted((position, word) for word, positions in inverted.items() for position in positions)
    return " ".join(word for _, word in words)


def _openalex_pmid(work: dict[str, Any]) -> str:
    return _strip_prefix((work.get("ids") or {}).get("pmid"), "https://pubmed.ncbi.nlm.nih.gov/")


def search_openalex(query: str, limit: int, sample_count: int) -> dict[str, Any]:
    with _client() as client:
        listed = _get(client, OPENALEX_WORKS_URL, {"search": query, "per-page": min(limit, OPENALEX_MAX_PAGE), "select": "id,ids"}).json()
        detailed = _get(client, OPENALEX_WORKS_URL, {
            "search": query, "per-page": sample_count,
            "select": "id,ids,doi,display_name,publication_year,cited_by_count,primary_location,abstract_inverted_index",
        }).json()
    works = listed.get("results") or []
    samples = [
        {
            "id": _strip_prefix(w.get("id"), "https://openalex.org/"), "pmid": _openalex_pmid(w),
            "doi": _strip_prefix(w.get("doi"), "https://doi.org/"), "title": w.get("display_name") or "",
            "year": w.get("publication_year"), "cited_by": w.get("cited_by_count"),
            "venue": ((w.get("primary_location") or {}).get("source") or {}).get("display_name") or "",
            "abstract": _cut(_openalex_abstract(w.get("abstract_inverted_index"))),
        }
        for w in detailed.get("results") or []
    ]
    return {
        "total": int((listed.get("meta") or {}).get("count") or 0),
        "ids": [_strip_prefix(w.get("id"), "https://openalex.org/") for w in works if w.get("id")],
        "pmids": [pmid for pmid in (_openalex_pmid(w) for w in works) if pmid],
        "samples": samples,
        "note": f"At most {OPENALEX_MAX_PAGE} ids. Import ids through openalex; pmids also import through pubmed.",
    }


def _uniprot_sample(entry: dict[str, Any]) -> dict[str, Any]:
    names = entry.get("proteinDescription") or {}
    full_name = ((names.get("recommendedName") or {}).get("fullName") or {}).get("value") \
        or (((names.get("submissionNames") or [{}])[0]).get("fullName") or {}).get("value") or ""
    function = " ".join(
        text.get("value", "")
        for comment in entry.get("comments") or [] if comment.get("commentType") == "FUNCTION"
        for text in comment.get("texts") or []
    )
    return {
        "id": entry.get("primaryAccession", ""), "entry_name": entry.get("uniProtkbId", ""),
        "reviewed": "Swiss-Prot" in str(entry.get("entryType", "")),
        "protein": full_name,
        "genes": [g["geneName"]["value"] for g in entry.get("genes") or [] if (g.get("geneName") or {}).get("value")],
        "organism": (entry.get("organism") or {}).get("scientificName", ""),
        "length": (entry.get("sequence") or {}).get("length"),
        "function": _cut(_UNIPROT_CITATION.sub("", function)),
    }


def search_uniprot(query: str, limit: int, sample_count: int) -> dict[str, Any]:
    with _client() as client:
        listed = _get(client, UNIPROT_SEARCH_URL, {"query": query, "format": "json", "size": min(limit, 500), "fields": "accession"})
        detailed = _get(client, UNIPROT_SEARCH_URL, {
            "query": query, "format": "json", "size": sample_count,
            "fields": "accession,id,protein_name,gene_names,organism_name,cc_function,length",
        }).json()
    entries = listed.json().get("results") or []
    return {
        "total": int(listed.headers.get("x-total-results") or len(entries)),
        "ids": [e["primaryAccession"] for e in entries if e.get("primaryAccession")],
        "samples": [_uniprot_sample(e) for e in detailed.get("results") or []],
        "note": "Import ids through uniprot. UniProt query syntax works, e.g. gene:CDK2 AND organism_id:9606 AND reviewed:true.",
    }


def search_wikipedia(query: str, limit: int, sample_count: int) -> dict[str, Any]:
    with _client() as client:
        found = _get(client, WIKIPEDIA_API_URL, {
            "action": "query", "list": "search", "srsearch": query, "srlimit": min(limit, 500), "format": "json",
        }).json().get("query") or {}
        titles = [item["title"] for item in found.get("search") or [] if item.get("title")]
        pages = {}
        if titles:
            pages = (_get(client, WIKIPEDIA_API_URL, {
                "action": "query", "prop": "extracts|info", "exintro": 1, "explaintext": 1, "inprop": "url",
                "titles": "|".join(titles[:sample_count]), "format": "json",
            }).json().get("query") or {}).get("pages") or {}
    by_title = {page.get("title"): page for page in pages.values()}
    samples = [
        {"id": title, "url": by_title[title].get("fullurl", ""), "summary": _cut(by_title[title].get("extract"))}
        for title in titles[:sample_count] if title in by_title
    ]
    return {
        "total": int((found.get("searchinfo") or {}).get("totalhits") or len(titles)),
        "ids": titles,
        "samples": samples,
        "note": "English Wikipedia; each sample is the article's introduction. Import titles through wikipedia.",
    }
