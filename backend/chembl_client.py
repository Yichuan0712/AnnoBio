"""
Thin client for ChEMBL's REST API (molecule endpoint, filtered by ChEMBL id), used by the
"Import from ChEMBL" dataset feature. Synchronous (httpx.Client) because callers run inside
a plain background thread (see main.py's ChEMBL job worker), not an asyncio event loop.

No API key or authentication is required. There's no documented rate limit, but requests
are still throttled defensively between batches to be a good citizen.
"""

import time
from typing import Any

import httpx

MOLECULES_URL = "https://www.ebi.ac.uk/chembl/api/data/molecule.json"

CHEMBL_BATCH_SIZE = 200  # chunk size for molecule_chembl_id__in; well under any URL-length ceiling.
BATCH_DELAY_SEC = 0.2
_TIMEOUT = 20.0

# Available ChEMBL fields a user can pick as dataset columns, in menu order.
CHEMBL_FIELDS: dict[str, str] = {
    "chembl_id": "ChEMBL ID",
    "pref_name": "Preferred Name",
    "synonyms": "Synonyms",
    "molecule_type": "Molecule Type",
    "max_phase": "Max Phase",
    "first_approval": "First Approval Year",
    "therapeutic_flag": "Therapeutic",
    "oral": "Oral",
    "black_box_warning": "Black Box Warning",
    "natural_product": "Natural Product",
    "atc_classifications": "ATC Classifications",
    "canonical_smiles": "Canonical SMILES",
    "standard_inchi": "Standard InChI",
    "standard_inchi_key": "InChI Key",
    "molecular_formula": "Molecular Formula",
    "molecular_weight": "Molecular Weight",
    "alogp": "AlogP",
}

_YES_NO_FIELDS = ("therapeutic_flag", "oral", "black_box_warning", "natural_product")


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
    raise last_err or RuntimeError("ChEMBL request failed")


def _parse_molecule(m: dict) -> dict[str, str]:
    """Extract our supported fields from one ChEMBL molecule record."""
    structures = m.get("molecule_structures") or {}
    properties = m.get("molecule_properties") or {}

    synonyms = "; ".join(
        s.get("molecule_synonym") or "" for s in (m.get("molecule_synonyms") or []) if s.get("molecule_synonym")
    )
    atc_classifications = "; ".join(c for c in (m.get("atc_classifications") or []) if c)

    row = {
        "chembl_id": m.get("molecule_chembl_id") or "",
        "pref_name": m.get("pref_name") or "",
        "synonyms": synonyms,
        "molecule_type": m.get("molecule_type") or "",
        "max_phase": str(m.get("max_phase") or ""),
        "first_approval": str(m.get("first_approval") or ""),
        "therapeutic_flag": m.get("therapeutic_flag"),
        "oral": m.get("oral"),
        "black_box_warning": m.get("black_box_warning"),
        "natural_product": m.get("natural_product"),
        "atc_classifications": atc_classifications,
        "canonical_smiles": structures.get("canonical_smiles") or "",
        "standard_inchi": structures.get("standard_inchi") or "",
        "standard_inchi_key": structures.get("standard_inchi_key") or "",
        "molecular_formula": properties.get("full_molformula") or "",
        "molecular_weight": str(properties.get("full_mwt") or ""),
        "alogp": str(properties.get("alogp") or ""),
    }
    for f in _YES_NO_FIELDS:
        row[f] = "Yes" if row[f] else "No"
    return row


def _fetch_molecules_batch(chembl_ids: list[str]) -> list[dict[str, str]]:
    """Fetch full record for up to CHEMBL_BATCH_SIZE ChEMBL ids in one call."""
    if not chembl_ids:
        return []
    with httpx.Client() as client:
        params = {
            "molecule_chembl_id__in": ",".join(chembl_ids),
            "limit": 1000,
        }
        resp = _get_with_retry(client, MOLECULES_URL, params)
        data = resp.json()
        return [_parse_molecule(m) for m in data.get("molecules", [])]


def fetch_molecules(
    chembl_ids: list[str],
    fields: list[str],
    on_batch: "callable | None" = None,
) -> list[dict[str, str]]:
    """
    Fetch `fields` for all chembl_ids, batching CHEMBL_BATCH_SIZE at a time with a defensive
    delay. `chembl_ids` must already be trimmed/uppercased by the caller so they match the
    API's canonical uppercase ids. Ids ChEMBL doesn't return (unknown ids) are skipped
    rather than turned into an all-blank row.
    Calls on_batch(batch_rows, not_found_ids, processed_so_far, total) after each batch so
    the caller can report progress (against the requested id count, not the found-row
    count) AND keep already-fetched rows if it decides to stop early (cancellation).
    Returns rows as list of dicts keyed by `fields` (missing/unparsed values are "").
    """
    out: list[dict[str, str]] = []
    total = len(chembl_ids)
    processed = 0
    for start in range(0, total, CHEMBL_BATCH_SIZE):
        batch = chembl_ids[start : start + CHEMBL_BATCH_SIZE]
        molecules = _fetch_molecules_batch(batch)
        by_id = {m["chembl_id"]: m for m in molecules if m.get("chembl_id")}
        batch_out = [{f: by_id[cid].get(f, "") for f in fields} for cid in batch if cid in by_id]
        not_found = [cid for cid in batch if cid not in by_id]
        out.extend(batch_out)
        processed += len(batch)
        if on_batch:
            on_batch(batch_out, not_found, processed, total)
        if start + CHEMBL_BATCH_SIZE < total:
            time.sleep(BATCH_DELAY_SEC)
    return out
