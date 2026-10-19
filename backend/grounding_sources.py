"""Small HTTP-only entity resolvers for Evaluate. Never select a ranked first hit."""
import re
import threading
import time
from urllib.parse import quote

import httpx

SOURCES = ("hgnc", "pubchem", "go", "chebi", "mondo")
_locks = {source: threading.Lock() for source in SOURCES}
_last_request = {}


def _get(client, source, url, **kwargs):
    # Bound request starts across all resolver threads, including retries.
    for attempt in range(3):
        with _locks[source]:
            interval = 0.21 if source == "pubchem" else 0.12
            delay = interval - (time.monotonic() - _last_request.get(source, 0))
            if delay > 0:
                time.sleep(delay)
            _last_request[source] = time.monotonic()
        response = client.get(url, timeout=20, **kwargs)
        if response.status_code == 404:
            return None
        if response.status_code in (429, 503) and attempt < 2:
            time.sleep(attempt + 1)
            continue
        response.raise_for_status()
        return response.json()


def _result(source, candidates):
    unique = {candidate["concept_id"]: candidate for candidate in candidates}
    if not unique:
        return None
    if len(unique) == 1:
        return {**next(iter(unique.values())), "source": source, "status": "resolved"}
    return {"concept_id": "", "source": source, "status": "ambiguous", "candidates": list(unique.values())}


def _hgnc(client, term):
    fields = ("symbol", "name", "alias_symbol", "prev_symbol", "alias_name", "prev_name")
    identifier = re.fullmatch(r"HGNC\s*:\s*(\d+)", term, re.I)
    field = "hgnc_id" if identifier else "symbol"
    value = f"HGNC:{identifier[1]}" if identifier else term.upper()
    data = _get(client, "hgnc", f"https://rest.genenames.org/fetch/{field}/{quote(value, safe='')}",
                headers={"Accept": "application/json"}) or {}
    docs = (data.get("response") or {}).get("docs") or []
    approved = [doc for doc in docs if doc.get("status") == "Approved" and
                str(doc.get(field, "")).casefold() == value.casefold()]
    if not identifier and not approved:
        # HGNC search is token based, even for quoted phrases. Fetch each exact field
        # instead, then check the returned literal names to avoid broad search false hits.
        query = f'"{term}"' if any(char.isspace() for char in term) else term
        for key in fields[1:]:
            detail = _get(client, "hgnc", f"https://rest.genenames.org/fetch/{key}/{quote(query, safe='')}",
                          headers={"Accept": "application/json"}) or {}
            for doc in (detail.get("response") or {}).get("docs") or []:
                values = [value for name in fields for value in
                          (doc.get(name, []) if isinstance(doc.get(name), list) else [doc.get(name, "")])]
                if doc.get("status") == "Approved" and any(str(value).casefold() == term.casefold() for value in values):
                    approved.append(doc)
    return _result("hgnc", [{"concept_id": doc["hgnc_id"], "canonical_name": doc["symbol"]}
                            for doc in approved if doc.get("hgnc_id")])


def _pubchem(client, term):
    identifier = re.fullmatch(r"(?:PUBCHEM(?:\.COMPOUND)?\s*:\s*)?(?:CID\s*:?\s*)?(\d+)", term, re.I)
    if identifier:
        cid = identifier[1]
        data = _get(client, "pubchem", f"https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/{cid}/cids/JSON")
    else:
        data = _get(client, "pubchem", "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/"
                    f"{quote(term, safe='')}/cids/JSON", params={"name_type": "complete"})
    cids = ((data or {}).get("IdentifierList") or {}).get("CID") or []
    return _result("pubchem", [{"concept_id": f"PUBCHEM.COMPOUND:{cid}", "canonical_name": term} for cid in cids])


def _ontology(client, term, source):
    data = _get(client, source, "https://www.ebi.ac.uk/ols4/api/search", params={
        "q": term, "ontology": source, "exact": "true", "obsoletes": "false",
        "queryFields": "label,synonym,obo_id,short_form,iri", "rows": 100,
    }) or {}
    response = data.get("response") or {}
    docs = response.get("docs") or []
    if response.get("numFound", len(docs)) > len(docs):
        return {"concept_id": "", "source": source, "status": "ambiguous"}
    candidates = []
    for doc in docs:
        if str(doc.get("is_obsolete", False)).lower() == "true" or doc.get("ontology_name", "").lower() != source:
            continue
        key = str(doc.get("obo_id") or "")
        if not key.upper().startswith(source.upper() + ":"):
            continue
        synonyms = doc.get("synonym") or []
        if isinstance(synonyms, str):
            synonyms = [synonyms]
        names = [doc.get("label", ""), key, doc.get("short_form", ""), doc.get("iri", ""), *synonyms]
        if any(str(name).strip().casefold() == term.casefold() for name in names):
            candidates.append({"concept_id": key.upper(), "canonical_name": doc.get("label") or key})
    return _result(source, candidates)


def resolve_entity(term, source):
    with httpx.Client(follow_redirects=True) as client:
        if source == "hgnc":
            return _hgnc(client, term)
        if source == "pubchem":
            return _pubchem(client, term)
        if source in ("go", "chebi", "mondo"):
            return _ontology(client, term, source)
    raise ValueError(f"Unsupported entity source: {source}")
