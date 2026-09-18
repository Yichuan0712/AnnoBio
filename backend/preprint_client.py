"""
Thin client for the bioRxiv/medRxiv public API (details-by-DOI), used by the "Import from
bioRxiv / medRxiv" dataset feature. Synchronous (httpx.Client) because callers run inside a
plain background thread (see main.py's preprint job worker), not an asyncio event loop.

Unlike PubMed/ClinicalTrials.gov, this API has no batch-by-many-ids endpoint: one DOI is
fetched per request. A DOI can live on either server (both share the 10.1101 prefix), so
each lookup tries `biorxiv` first, then falls back to `medrxiv`. No API key or
authentication is required; there's no documented rate limit, but requests are still
throttled defensively between lookups to be a good citizen.
"""

import time
from typing import Any

import httpx

DETAILS_URL_TMPL = "https://api.biorxiv.org/details/{server}/{doi}"
SERVERS = ("biorxiv", "medrxiv")

BATCH_DELAY_SEC = 0.2
_TIMEOUT = 20.0

# Available bioRxiv/medRxiv fields a user can pick as dataset columns, in menu order.
PREPRINT_FIELDS: dict[str, str] = {
    "doi": "DOI",
    "title": "Title",
    "abstract": "Abstract",
    "authors": "Authors",
    "corresponding_author": "Corresponding Author",
    "corresponding_institution": "Corresponding Institution",
    "date": "Date",
    "category": "Category",
    "server": "Server",
    "version": "Version",
    "license": "License",
    "published": "Published DOI",
}


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
    raise last_err or RuntimeError("bioRxiv/medRxiv request failed")


def _parse_entry(entry: dict) -> dict[str, str]:
    """Extract our supported fields from one `collection[]` entry."""
    return {
        "doi": entry.get("doi") or "",
        "title": entry.get("title") or "",
        "abstract": entry.get("abstract") or "",
        "authors": entry.get("authors") or "",
        "corresponding_author": entry.get("author_corresponding") or "",
        "corresponding_institution": entry.get("author_corresponding_institution") or "",
        "date": entry.get("date") or "",
        "category": entry.get("category") or "",
        "server": entry.get("server") or "",
        "version": entry.get("version") or "",
        "license": entry.get("license") or "",
        "published": entry.get("published") or "",
    }


def _fetch_one_doi(client: httpx.Client, doi: str) -> dict[str, str] | None:
    """Try each server in turn; return the most recent version's parsed row, or None if not found on any server."""
    for server in SERVERS:
        url = DETAILS_URL_TMPL.format(server=server, doi=doi)
        resp = _get_with_retry(client, url, {})
        data = resp.json()
        collection = data.get("collection") or []
        if collection:
            return _parse_entry(collection[-1])
    return None


def fetch_preprints(
    dois: list[str],
    fields: list[str],
    on_batch: "callable | None" = None,
) -> list[dict[str, str]]:
    """
    Fetch `fields` for all dois, one at a time (no batch endpoint exists), with a defensive
    delay between lookups. DOIs not found on either server are skipped rather than turned
    into an all-blank row.
    Calls on_batch(batch_rows, not_found_ids, processed_so_far, total) after each DOI so the
    caller can report progress and keep already-fetched rows if it decides to stop early
    (cancellation). Returns rows as list of dicts keyed by `fields` (missing values are "").
    """
    out: list[dict[str, str]] = []
    total = len(dois)
    with httpx.Client() as client:
        for i, doi in enumerate(dois):
            row = _fetch_one_doi(client, doi)
            batch_out = [{f: row.get(f, "") for f in fields}] if row else []
            not_found = [] if row else [doi]
            out.extend(batch_out)
            if on_batch:
                on_batch(batch_out, not_found, i + 1, total)
            if i + 1 < total:
                time.sleep(BATCH_DELAY_SEC)
    return out
