"""Generation parameters a Generate can send to its model (Settings → Generate, per model).

Only parameters that change how a model generates are listed; the ones the app controls itself
(max_tokens, response_format, tools, stream) are not, and neither is `stop`, which could cut a
structured reply short. Which of these a model takes is found per model (llm.supported_run_params);
a model whose parameters cannot be known (a custom endpoint) gets none.

settings["model_settings"][credential id]["run_params"] holds the values, by these names, as
LiteLLM takes them. A parameter left out uses the model's own default.
"""

from __future__ import annotations

# `probe` is a value used to ask LiteLLM, without a network call, whether the model takes it.
PARAM_SPECS: dict[str, dict] = {
    "temperature": {
        "label": "Temperature", "type": "number", "min": 0, "max": 2, "probe": 0.5,
        "help": "Higher gives more varied replies; lower gives more consistent ones.",
    },
    "top_p": {
        "label": "Top P", "type": "number", "min": 0, "max": 1, "probe": 0.9,
        "help": "Samples only from the most likely tokens whose probabilities add up to this.",
    },
    "top_k": {
        "label": "Top K", "type": "integer", "min": 1, "max": 1000, "probe": 40,
        "help": "Samples only from this many of the most likely tokens.",
    },
    "min_p": {
        "label": "Min P", "type": "number", "min": 0, "max": 1, "probe": 0.05,
        "help": "Leaves out tokens less likely than this fraction of the most likely one.",
    },
    "seed": {
        "label": "Seed", "type": "integer", "min": 0, "max": 2_147_483_647, "probe": 1,
        "help": "Asks for the same reply to the same input; providers do not guarantee it.",
    },
    "presence_penalty": {
        "label": "Presence penalty", "type": "number", "min": -2, "max": 2, "probe": 0.5,
        "help": "Positive values make the model less likely to repeat topics it has mentioned.",
    },
    "frequency_penalty": {
        "label": "Frequency penalty", "type": "number", "min": -2, "max": 2, "probe": 0.5,
        "help": "Positive values make the model less likely to repeat the same words.",
    },
    "repetition_penalty": {
        "label": "Repetition penalty", "type": "number", "min": 0, "max": 2, "probe": 1.1,
        "help": "Above 1 discourages repeating tokens from the input and the reply.",
    },
    "reasoning_effort": {
        "label": "Reasoning effort", "type": "choice", "choices": ["low", "medium", "high"], "probe": "low",
        "help": "How much a reasoning model thinks before it answers; thinking counts toward Max tokens.",
    },
}


def _check_value(name: str, value):
    spec = PARAM_SPECS[name]
    if spec["type"] == "choice":
        if value not in spec["choices"]:
            raise ValueError(f"{name} must be one of {', '.join(spec['choices'])}.")
        return value
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a number.")
    if spec["type"] == "integer":
        if value != int(value):
            raise ValueError(f"{name} must be a whole number.")
        value = int(value)
    if not spec["min"] <= value <= spec["max"]:
        raise ValueError(f"{name} must be in [{spec['min']}, {spec['max']}].")
    return value


def validate_run_params(value) -> dict:
    """{name: value} with known names and values in range; raises ValueError otherwise."""
    if not isinstance(value, dict):
        raise ValueError("run_params must be an object.")
    out = {}
    for name, item in value.items():
        if item is None:
            continue
        if name not in PARAM_SPECS:
            raise ValueError(f"{name} is not a generation parameter that can be set.")
        out[name] = _check_value(name, item)
    return out


def clean_run_params(value) -> dict:
    """Like validate_run_params, but drops whatever is invalid (for reading the settings file)."""
    out = {}
    for name, item in (value.items() if isinstance(value, dict) else []):
        if name in PARAM_SPECS and item is not None:
            try:
                out[name] = _check_value(name, item)
            except ValueError:
                continue
    return out


def param_fields(names: list[str]) -> list[dict]:
    """What the Settings page needs to draw a field for each named parameter, in PARAM_SPECS order."""
    return [
        {"name": name, **{k: v for k, v in spec.items() if k != "probe"}}
        for name, spec in PARAM_SPECS.items() if name in names
    ]
