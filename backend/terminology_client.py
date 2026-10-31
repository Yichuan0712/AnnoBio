"""
Thin clients for biomedical terminology services, used by the Score node's
"Medical concept match" flags to normalize free-text terms (drug names, diagnoses) to a
canonical concept id before comparing two values for equivalence:

- RxNorm (drug names -> ingredient-level RxCUI, so a brand name and its generic name
  normalize to the same id): public, free, no API key.
- MeSH (conditions/diagnoses -> canonical MeSH heading): public, free, no API key; reached
  via the same NCBI E-utilities `pubmed_client.py` calls, using PubMed's own automatic
  term-to-MeSH-heading translation.
- HGNC, PubChem, GO, ChEBI and MONDO: exact entity resolution via grounding_sources.py.

(A UMLS Metathesaurus source was tried too, but it needs a free personal NLM UTS API key,
which is more setup friction than the other two -- dropped for now, not because of any
technical limitation. `resolve_concept`/`resolve_concepts_bulk`'s "auto" mode is the natural
place to add it back if that tradeoff changes.)

Lookups are cached to disk (keyed by requested source + lowercased term) since the exact
same term repeats heavily across dataset rows and across runs; nothing here has a batch
endpoint, so `resolve_concepts_bulk` fans cache-misses out across a small thread pool
instead of a single sequential loop.
"""

import json
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

import httpx

from safe_stdio import safe_print as _safe_print

RXNORM_EXACT_URL = "https://rxnav.nlm.nih.gov/REST/rxcui.json"
RXNORM_APPROX_URL = "https://rxnav.nlm.nih.gov/REST/approximateTerm.json"
# Deliberately db=pubmed (not db=mesh): PubMed's own automatic term-to-MeSH-heading
# translation (the same mechanism that maps a lay search term to the right MeSH heading)
# is a far more precise entry-term match than db=mesh's esearch, which is a general
# relevance-ranked search across the whole thesaurus and readily returns an unrelated
# descriptor for a term that isn't actually a registered MeSH synonym.
MESH_ESEARCH_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi"

_MESH_TRANSLATION_RE = re.compile(r'"([^"]+)"\[MeSH Terms\]')

TOOL_NAME = "prompt-studio"
DEFAULT_EMAIL = "prompt-studio@example.com"

MEDICAL_CONCEPT_MATCH_SOURCES = ("auto", "rxnorm", "mesh", "hgnc", "pubchem", "go", "chebi", "mondo")

_TIMEOUT = 15.0

from data_dir import DATA_DIR  # backend/data, or ANNOBIO_DATA_DIR in installed desktop builds
TERMINOLOGY_CACHE_FILE = DATA_DIR / "terminology_cache.json"

_cache_lock = threading.Lock()
_persist_lock = threading.Lock()
_cache: dict[str, dict | None] = {}


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
    raise last_err or RuntimeError("Terminology lookup failed")


def _cache_key(source: str, term: str) -> str:
    return f"v2:{source}:{term.strip().lower()}"


def _load_cache() -> None:
    if not TERMINOLOGY_CACHE_FILE.exists():
        return
    try:
        raw = TERMINOLOGY_CACHE_FILE.read_text(encoding="utf-8")
        data = json.loads(raw) or {}
        with _cache_lock:
            _cache.clear()
            _cache.update(data)
    except (OSError, json.JSONDecodeError) as e:
        _safe_print(f"[Terminology] load cache failed: {e}", file=sys.stderr)


def _persist_cache() -> None:
    with _persist_lock:
        with _cache_lock:
            snapshot = dict(_cache)
        try:
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            temporary = TERMINOLOGY_CACHE_FILE.with_suffix('.tmp')
            temporary.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2), encoding="utf-8")
            temporary.replace(TERMINOLOGY_CACHE_FILE)
        except (OSError, TypeError) as e:
            _safe_print(f"[Terminology] persist cache failed: {e}", file=sys.stderr)


_load_cache()


_RXNORM_APPROX_MIN_LEN = 4  # below this, approximateTerm's fuzzy matching is too likely to hit an unrelated short drug name/abbreviation


def _rxnorm_exact_rxcui(client: httpx.Client, term: str) -> str | None:
    resp = _get_with_retry(client, RXNORM_EXACT_URL, {"name": term})
    ids = (resp.json().get("idGroup") or {}).get("rxnormId") or []
    return ids[0] if ids else None


def _rxnorm_approx_rxcui(client: httpx.Client, term: str) -> str | None:
    resp = _get_with_retry(client, RXNORM_APPROX_URL, {"term": term, "maxEntries": 1})
    candidates = (resp.json().get("approximateGroup") or {}).get("candidate") or []
    if not candidates:
        return None
    rxcui = (candidates[0].get("rxcui") or "").strip()
    return rxcui or None


def _rxnorm_ingredient(client: httpx.Client, rxcui: str) -> tuple[str, str] | None:
    """Normalize a (possibly brand-name) rxcui down to its ingredient-level rxcui/name, e.g. Tylenol -> acetaminophen."""
    resp = _get_with_retry(client, f"https://rxnav.nlm.nih.gov/REST/rxcui/{rxcui}/related.json", {"tty": "IN"})
    groups = (resp.json().get("relatedGroup") or {}).get("conceptGroup") or []
    for group in groups:
        if group.get("tty") == "IN":
            props = group.get("conceptProperties") or []
            if props:
                return props[0].get("rxcui"), props[0].get("name")
    return None


def _rxnorm_lookup(term: str) -> dict[str, str] | None:
    """
    Resolve `term` to an ingredient-level RxCUI, so a brand name and its generic name
    normalize to the same id (e.g. "Tylenol" and "acetaminophen" both -> rxcui 161). Tries
    an exact name match first; only falls back to fuzzy approximateTerm for longer terms,
    since that matcher readily returns an unrelated drug for a short/ambiguous string.
    """
    with httpx.Client() as client:
        rxcui = _rxnorm_exact_rxcui(client, term)
        if not rxcui and len(term) >= _RXNORM_APPROX_MIN_LEN:
            rxcui = _rxnorm_approx_rxcui(client, term)
        if not rxcui:
            return None
        ingredient = _rxnorm_ingredient(client, rxcui)
    if ingredient and ingredient[0]:
        return {"concept_id": ingredient[0], "canonical_name": ingredient[1] or term, "source": "rxnorm"}
    return {"concept_id": rxcui, "canonical_name": term, "source": "rxnorm"}


def _mesh_lookup(term: str, api_key: str, email: str) -> dict[str, str] | None:
    """
    Resolve `term` to its canonical MeSH heading via PubMed's own automatic term-mapping
    (querytranslation), e.g. "heart attack"[MeSH Terms] and "myocardial infarction"[MeSH
    Terms] both translate to the same quoted heading -- exactly the synonym-collapsing this
    feature needs. An untranslated (unquoted) echo back means PubMed found no MeSH mapping.
    """
    params = {
        **_ncbi_params(api_key, email),
        "db": "pubmed",
        "term": f"{term}[MeSH Terms]",
        "retmode": "json",
        "retmax": "0",
    }
    with httpx.Client() as client:
        resp = _get_with_retry(client, MESH_ESEARCH_URL, params)
    translation = ((resp.json().get("esearchresult") or {}).get("querytranslation")) or ""
    match = _MESH_TRANSLATION_RE.search(translation)
    if not match:
        return None
    heading = match.group(1)
    return {"concept_id": f"mesh:{heading.lower()}", "canonical_name": heading, "source": "mesh"}


def resolve_concept(
    term: str,
    source: str = "auto",
    ncbi_api_key: str = "",
    ncbi_email: str = "",
) -> dict[str, Any] | None:
    """Resolve one free-text term to a canonical concept id, or None if unresolved on the requested source(s)."""
    term = (term or "").strip()
    if not term:
        return None
    if source in ("hgnc", "pubchem", "go", "chebi", "mondo"):
        from grounding_sources import resolve_entity
        return resolve_entity(term, source)
    if source == "rxnorm":
        return _rxnorm_lookup(term)
    if source == "mesh":
        return _mesh_lookup(term, ncbi_api_key, ncbi_email)
    # auto: try MeSH (conditions) then RxNorm (drugs) -- first hit wins.
    return _mesh_lookup(term, ncbi_api_key, ncbi_email) or _rxnorm_lookup(term)


SETTINGS_FILE = DATA_DIR / "settings.json"


def _load_settings_credentials() -> tuple[str, str]:
    """
    Small standalone read of the optional NCBI credentials from backend/data/settings.json,
    for callers that don't already have settings loaded (e.g. Review's optimizer methods,
    which run outside main.py's request-handling context and would otherwise need these
    params threaded through several constructors just to reach here).
    """
    try:
        data = json.loads(SETTINGS_FILE.read_text(encoding="utf-8")) or {}
    except (OSError, json.JSONDecodeError):
        data = {}
    return (
        (data.get("ncbi_api_key") or "").strip(),
        (data.get("ncbi_email") or "").strip(),
    )


def resolve_concepts_bulk(
    terms: list[str],
    source: str = "auto",
    ncbi_api_key: str | None = None,
    ncbi_email: str | None = None,
    on_progress=None,
    cancelled=None,
) -> dict[str, dict | None]:
    """
    Resolve every (deduplicated) term to a concept id, using the on-disk cache first and
    fanning cache-misses out across a small thread pool. Workers are capped lower for
    'auto'/'mesh' since those hit NCBI E-utilities, which has its own courtesy rate limit.
    Either credential param left as None (rather than "") is loaded from
    backend/data/settings.json instead.
    """
    if ncbi_api_key is None or ncbi_email is None:
        default_ncbi_key, default_ncbi_email = _load_settings_credentials()
        ncbi_api_key = default_ncbi_key if ncbi_api_key is None else ncbi_api_key
        ncbi_email = default_ncbi_email if ncbi_email is None else ncbi_email

    unique_terms: list[str] = []
    seen: set[str] = set()
    for t in terms:
        # Keep request keys intact (including whitespace); only lookup/cache normalization trims.
        t = t or ""
        if t.strip() and t not in seen:
            seen.add(t)
            unique_terms.append(t)

    results: dict[str, dict | None] = {}
    to_fetch: list[str] = []
    with _cache_lock:
        for t in unique_terms:
            key = _cache_key(source, t)
            if key in _cache:
                results[t] = _cache[key]
            else:
                to_fetch.append(t)

    if on_progress:
        for term, result in results.items():
            on_progress(term, result)
    if not to_fetch or (cancelled and cancelled()):
        return results

    max_workers = 3 if source in ("auto", "mesh") else 6

    def _work(term: str) -> tuple[str, dict | None]:
        if cancelled and cancelled():
            return term, None
        # A transport/service failure must fail evaluation, never become a cached no-match.
        return term, resolve_concept(term, source, ncbi_api_key, ncbi_email)

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [executor.submit(_work, t) for t in to_fetch]
        for future in as_completed(futures):
            if cancelled and cancelled():
                for pending in futures:
                    pending.cancel()
                break
            term, result = future.result()
            results[term] = result
            with _cache_lock:
                _cache[_cache_key(source, term)] = result
            if on_progress:
                on_progress(term, result)
    _persist_cache()

    return results
