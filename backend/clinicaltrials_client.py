"""
Thin client for ClinicalTrials.gov's REST API v2 (studies endpoint, filtered by NCT id),
used by the "Import from ClinicalTrials.gov" dataset feature. Synchronous (httpx.Client)
because callers run inside a plain background thread (see main.py's ClinicalTrials job
worker), not an asyncio event loop.

No API key or authentication is required. There's no documented rate limit, but requests
are still throttled defensively between batches to be a good citizen.
"""

import time
from typing import Any

import httpx

STUDIES_URL = "https://clinicaltrials.gov/api/v2/studies"

CT_BATCH_SIZE = 200  # chunk size for filter.ids; well under the ~8KB URL-length ceiling.
BATCH_DELAY_SEC = 0.2
_TIMEOUT = 20.0

# Available ClinicalTrials.gov fields a user can pick as dataset columns, in menu order.
CT_FIELDS: dict[str, str] = {
    "nct_id": "NCT ID",
    "brief_title": "Brief Title",
    "official_title": "Official Title",
    "brief_summary": "Brief Summary",
    "detailed_description": "Detailed Description",
    "conditions": "Conditions",
    "interventions": "Interventions",
    "phase": "Phase",
    "study_type": "Study Type",
    "overall_status": "Overall Status",
    "start_date": "Start Date",
    "completion_date": "Completion Date",
    "sponsor": "Sponsor",
    "eligibility_criteria": "Eligibility Criteria",
    "sex": "Sex",
    "minimum_age": "Minimum Age",
    "maximum_age": "Maximum Age",
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
    raise last_err or RuntimeError("ClinicalTrials.gov request failed")


def _parse_study(study: dict) -> dict[str, str]:
    """Extract our supported fields from one study's `protocolSection`."""
    section = study.get("protocolSection") or {}

    identification = section.get("identificationModule") or {}
    nct_id = identification.get("nctId") or ""
    brief_title = identification.get("briefTitle") or ""
    official_title = identification.get("officialTitle") or ""

    description = section.get("descriptionModule") or {}
    brief_summary = description.get("briefSummary") or ""
    detailed_description = description.get("detailedDescription") or ""

    conditions_module = section.get("conditionsModule") or {}
    conditions = "; ".join(c for c in (conditions_module.get("conditions") or []) if c)

    interventions_module = section.get("armsInterventionsModule") or {}
    intervention_parts = []
    for iv in interventions_module.get("interventions") or []:
        name = iv.get("name") or ""
        itype = iv.get("type") or ""
        if name:
            intervention_parts.append(f"{itype}: {name}" if itype else name)
    interventions = "; ".join(intervention_parts)

    design = section.get("designModule") or {}
    study_type = design.get("studyType") or ""
    phase = "; ".join(p for p in (design.get("phases") or []) if p)

    status = section.get("statusModule") or {}
    overall_status = status.get("overallStatus") or ""
    start_date = (status.get("startDateStruct") or {}).get("date") or ""
    completion_date = (status.get("completionDateStruct") or {}).get("date") or ""

    sponsor_module = section.get("sponsorCollaboratorsModule") or {}
    sponsor = (sponsor_module.get("leadSponsor") or {}).get("name") or ""

    eligibility = section.get("eligibilityModule") or {}
    eligibility_criteria = eligibility.get("eligibilityCriteria") or ""
    sex = eligibility.get("sex") or ""
    minimum_age = eligibility.get("minimumAge") or ""
    maximum_age = eligibility.get("maximumAge") or ""

    return {
        "nct_id": nct_id,
        "brief_title": brief_title,
        "official_title": official_title,
        "brief_summary": brief_summary,
        "detailed_description": detailed_description,
        "conditions": conditions,
        "interventions": interventions,
        "phase": phase,
        "study_type": study_type,
        "overall_status": overall_status,
        "start_date": start_date,
        "completion_date": completion_date,
        "sponsor": sponsor,
        "eligibility_criteria": eligibility_criteria,
        "sex": sex,
        "minimum_age": minimum_age,
        "maximum_age": maximum_age,
    }


def _fetch_studies_batch(nct_ids: list[str]) -> list[dict[str, str]]:
    """Fetch full record for up to CT_BATCH_SIZE NCT ids in one call."""
    if not nct_ids:
        return []
    with httpx.Client() as client:
        params = {
            "filter.ids": ",".join(nct_ids),
            "pageSize": 1000,
        }
        resp = _get_with_retry(client, STUDIES_URL, params)
        data = resp.json()
        return [_parse_study(s) for s in data.get("studies", [])]


def fetch_studies(
    nct_ids: list[str],
    fields: list[str],
    on_batch: "callable | None" = None,
) -> list[dict[str, str]]:
    """
    Fetch `fields` for all nct_ids, batching CT_BATCH_SIZE at a time with a defensive delay.
    `nct_ids` must already be trimmed/uppercased by the caller so they match the API's
    canonical uppercase NCT ids. Ids ClinicalTrials.gov doesn't return (unknown/retired
    ids) are skipped rather than turned into an all-blank row.
    Calls on_batch(batch_rows, not_found_ids, processed_so_far, total) after each batch so
    the caller can report progress (against the requested id count, not the found-row
    count) AND keep already-fetched rows if it decides to stop early (cancellation).
    Returns rows as list of dicts keyed by `fields` (missing/unparsed values are "").
    """
    out: list[dict[str, str]] = []
    total = len(nct_ids)
    processed = 0
    for start in range(0, total, CT_BATCH_SIZE):
        batch = nct_ids[start : start + CT_BATCH_SIZE]
        studies = _fetch_studies_batch(batch)
        by_id = {s["nct_id"]: s for s in studies if s.get("nct_id")}
        batch_out = [{f: by_id[nct_id].get(f, "") for f in fields} for nct_id in batch if nct_id in by_id]
        not_found = [nct_id for nct_id in batch if nct_id not in by_id]
        out.extend(batch_out)
        processed += len(batch)
        if on_batch:
            on_batch(batch_out, not_found, processed, total)
        if start + CT_BATCH_SIZE < total:
            time.sleep(BATCH_DELAY_SEC)
    return out
