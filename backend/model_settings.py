"""Settings a model can have of its own (Settings → Generate / Optimize / Agent: the fields that show
the values of the model chosen at the top of the tab).

settings["model_settings"] maps a credential id to some of the keys below. A key a model leaves out
uses the shared setting of the same name (what the fields show with None chosen). A request's
settings_overrides (per-node settings that older projects saved) still win over both.
"""

MODEL_SETTING_RANGES = {
    "run_max_tokens": (256, 131072),
    "run_concurrency": (1, 10),
    "review_max_tokens": (256, 131072),
    "agent_context_tokens": (0, 2_000_000),  # 0 = Auto, the model's own window
}


def validate_model_settings(value) -> dict:
    """{credential id: {key: int}} with known keys in range; models left with no keys are dropped."""
    if not isinstance(value, dict):
        raise ValueError("model_settings must be an object.")
    out = {}
    for credential_id, entry in value.items():
        credential_id = str(credential_id).strip()
        if not credential_id or not isinstance(entry, dict):
            raise ValueError("model_settings maps a credential id to an object of settings.")
        kept = {}
        for key, number in entry.items():
            if number is None:
                continue
            if key not in MODEL_SETTING_RANGES:
                raise ValueError(f"{key} cannot be set per model.")
            low, high = MODEL_SETTING_RANGES[key]
            if type(number) is not int or not low <= number <= high:
                raise ValueError(f"{key} must be an integer in [{low}, {high}].")
            kept[key] = number
        if kept:
            out[credential_id] = kept
    return out


def clean_model_settings(value) -> dict:
    """Like validate_model_settings, but drops whatever is invalid (for reading the settings file)."""
    out = {}
    for credential_id, entry in (value.items() if isinstance(value, dict) else []):
        if not isinstance(entry, dict):
            continue
        kept = {}
        for key, number in entry.items():
            low, high = MODEL_SETTING_RANGES.get(key, (None, None))
            if low is not None and type(number) is int and low <= number <= high:
                kept[key] = number
        if str(credential_id).strip() and kept:
            out[str(credential_id).strip()] = kept
    return out


def settings_for_model(settings: dict, credential_id) -> dict:
    """The shared settings with the model's own values on top."""
    own = (settings.get("model_settings") or {}).get(str(credential_id or "").strip()) or {}
    return {**settings, **{key: own[key] for key in MODEL_SETTING_RANGES if key in own}}
