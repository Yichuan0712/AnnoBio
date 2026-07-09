"""
Thin client for NCBI's PubMed E-utilities (efetch by PMID), used by the "Import from
PubMed" dataset feature. Synchronous (httpx.Client) because callers run inside a plain
background thread (see main.py's PubMed job worker), not an asyncio event loop.

Rate limits (per NCBI's usage policy): 3 requests/sec without an API key, 10/sec with one.
Every request should identify the app via `tool`/`email` -- see
https://www.ncbi.nlm.nih.gov/books/NBK25497/
"""

import time
import xml.etree.ElementTree as ET
from typing import Any

import httpx

EFETCH_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi"

TOOL_NAME = "prompt-studio"
DEFAULT_EMAIL = "prompt-studio@example.com"  # NCBI requires *some* contact value; user's own email (if set) overrides this.

BATCH_SIZE = 200  # NCBI recommends <=200 ids per efetch/esummary call.
_TIMEOUT = 20.0

# Available PubMed fields a user can pick as dataset columns, in menu order.
PUBMED_FIELDS: dict[str, str] = {
    "pmid": "PMID",
    "title": "Title",
    "abstract": "Abstract",
    "authors": "Authors",
    "journal": "Journal",
    "year": "Year",
    "doi": "DOI",
    "mesh_terms": "MeSH Terms",
    "publication_type": "Publication Type",
}


def _rate_limit_delay(has_api_key: bool) -> float:
    return 0.11 if has_api_key else 0.34


def _ncbi_params(api_key: str, email: str) -> dict[str, str]:
    params = {"tool": TOOL_NAME, "email": (email or "").strip() or DEFAULT_EMAIL}
    if api_key:
        params["api_key"] = api_key
    return params


def _get_with_retry(client: httpx.Client, url: str, params: dict[str, Any], max_retries: int = 2) -> httpx.Response:
    last_err: Exception | None = None
    for attempt in range(max_retries + 1):
        try:
            resp = client.get(url, params=params, timeout=_TIMEOUT)
            if resp.status_code == 429 and attempt < max_retries:
                time.sleep(1.0 * (attempt + 1))
                continue
            resp.raise_for_status()
            return resp
        except (httpx.TimeoutException, httpx.TransportError) as e:
            last_err = e
            if attempt < max_retries:
                time.sleep(1.0 * (attempt + 1))
                continue
            raise
    raise last_err or RuntimeError("PubMed request failed")


def _text(el: ET.Element | None) -> str:
    if el is None:
        return ""
    return "".join(el.itertext()).strip()


def _parse_article(article_el: ET.Element) -> dict[str, str]:
    """Extract our supported fields from one <PubmedArticle> element."""
    medline = article_el.find("MedlineCitation")
    article = medline.find("Article") if medline is not None else None

    pmid = _text(medline.find("PMID")) if medline is not None else ""

    title = _text(article.find("ArticleTitle")) if article is not None else ""

    abstract_parts = []
    if article is not None:
        for ab in article.findall("Abstract/AbstractText"):
            label = ab.get("Label")
            text = _text(ab)
            abstract_parts.append(f"{label}: {text}" if label else text)
    abstract = "\n".join(p for p in abstract_parts if p)

    authors = []
    if article is not None:
        for author in article.findall("AuthorList/Author"):
            last = _text(author.find("LastName"))
            initials = _text(author.find("Initials"))
            collective = _text(author.find("CollectiveName"))
            if last:
                authors.append(f"{last} {initials}".strip())
            elif collective:
                authors.append(collective)
    authors_str = "; ".join(authors)

    journal = ""
    year = ""
    if article is not None:
        journal = _text(article.find("Journal/Title")) or _text(article.find("Journal/ISOAbbreviation"))
        year = _text(article.find("Journal/JournalIssue/PubDate/Year"))
        if not year:
            medline_date = _text(article.find("Journal/JournalIssue/PubDate/MedlineDate"))
            year = medline_date[:4] if medline_date else ""

    doi = ""
    for eloc in (article.findall("ELocationID") if article is not None else []):
        if eloc.get("EIdType") == "doi":
            doi = _text(eloc)
            break
    if not doi and medline is not None:
        for aid in article_el.findall("PubmedData/ArticleIdList/ArticleId"):
            if aid.get("IdType") == "doi":
                doi = _text(aid)
                break

    mesh_terms = []
    if medline is not None:
        for heading in medline.findall("MeshHeadingList/MeshHeading/DescriptorName"):
            t = _text(heading)
            if t:
                mesh_terms.append(t)
    mesh_str = "; ".join(mesh_terms)

    pub_types = []
    if article is not None:
        for pt in article.findall("PublicationTypeList/PublicationType"):
            t = _text(pt)
            if t:
                pub_types.append(t)
    pub_type_str = "; ".join(pub_types)

    return {
        "pmid": pmid,
        "title": title,
        "abstract": abstract,
        "authors": authors_str,
        "journal": journal,
        "year": year,
        "doi": doi,
        "mesh_terms": mesh_str,
        "publication_type": pub_type_str,
    }


def efetch_batch(pmids: list[str], api_key: str = "", email: str = "") -> list[dict[str, str]]:
    """Fetch full record (title/abstract/authors/...) for up to BATCH_SIZE PMIDs in one call."""
    if not pmids:
        return []
    with httpx.Client() as client:
        params = {
            **_ncbi_params(api_key, email),
            "db": "pubmed",
            "id": ",".join(pmids),
            "rettype": "abstract",
            "retmode": "xml",
        }
        resp = _get_with_retry(client, EFETCH_URL, params)
        root = ET.fromstring(resp.content)
        return [_parse_article(a) for a in root.findall("PubmedArticle")]


def fetch_articles(
    pmids: list[str],
    fields: list[str],
    api_key: str = "",
    email: str = "",
    on_batch: "callable | None" = None,
) -> list[dict[str, str]]:
    """
    Fetch `fields` for all pmids, batching BATCH_SIZE at a time with rate-limit delays.
    PMIDs that PubMed doesn't actually return (invalid/withdrawn ids) are skipped rather than
    turned into an all-blank row.
    Calls on_batch(batch_rows, not_found_ids, processed_so_far, total) after each batch so the
    caller can report progress (against the requested id count, not the found-row count) AND
    keep already-fetched rows if it decides to stop early (cancellation).
    Returns rows as list of dicts keyed by `fields` (missing/unparsed values are "").
    """
    delay = _rate_limit_delay(bool(api_key))
    out: list[dict[str, str]] = []
    total = len(pmids)
    processed = 0
    for start in range(0, total, BATCH_SIZE):
        batch = pmids[start : start + BATCH_SIZE]
        articles = efetch_batch(batch, api_key=api_key, email=email)
        by_pmid = {a["pmid"]: a for a in articles if a.get("pmid")}
        batch_out = [{f: by_pmid[pmid].get(f, "") for f in fields} for pmid in batch if pmid in by_pmid]
        not_found = [pmid for pmid in batch if pmid not in by_pmid]
        out.extend(batch_out)
        processed += len(batch)
        if on_batch:
            on_batch(batch_out, not_found, processed, total)
        if start + BATCH_SIZE < total:
            time.sleep(delay)
    return out
