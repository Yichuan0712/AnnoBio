"""Validate saved JSON recursively before constructing typed result records."""
from __future__ import annotations

from dataclasses import MISSING, fields, is_dataclass
from difflib import get_close_matches
from functools import lru_cache
import json
from types import UnionType
from typing import Any, Literal, Union, get_args, get_origin, get_type_hints

from . import validation as check
from .errors import InputTypeError, InputValueError, ValidationError

_JSON_FIELDS = {"inputs", "reference", "metadata", "prediction", "details", "payload", "response_schema", "response"}
_OBJECT_FIELDS = {"metadata", "payload", "response_schema"}


def dump_result(result, format, indent):
    root = type(result).__name__
    if indent is not None:
        check.integer(indent, root + ".to_json.indent")

    def encode(value, path):
        if is_dataclass(value):
            return {field.name: (check.json_copy(getattr(value, field.name), f"{path}.{field.name}")
                if field.name in _JSON_FIELDS else encode(getattr(value, field.name), f"{path}.{field.name}"))
                for field in fields(value)}
        if isinstance(value, (list, tuple)):
            return [encode(item, f"{path}[{index}]") for index, item in enumerate(value)]
        return check.json_copy(value, path)

    return json.dumps({"format": format, "format_version": 1, **encode(result, root)},
                      ensure_ascii=False, allow_nan=False, indent=indent)


def parse_json(text, path):
    check.string(text, path)
    try:
        return json.loads(text)
    except RecursionError as exc:
        raise InputValueError("JSON is nested too deeply to decode.", path=path,
                              hint="Reduce nesting before loading this record.") from exc
    except json.JSONDecodeError as exc:
        raise InputValueError(f"invalid JSON at line {exc.lineno}, column {exc.colno}: {exc.msg}.", path=path,
            hint="Pass JSON text, not a filename; use Path(...).read_text(encoding='utf-8') to load a file.") from exc


@lru_cache(maxsize=None)
def _hints(cls):
    return get_type_hints(cls)


def _decode(annotation, value, path):
    origin, args = get_origin(annotation), get_args(annotation)
    if annotation is Any:
        return check.json_copy(value, path)
    if is_dataclass(annotation):
        return _record(annotation, value, path)
    if origin in (Union, UnionType):
        if value is None and type(None) in args:
            return None
        # Keep the useful nested error for optional records/containers.
        candidates = [item for item in args if item is not type(None)]
        if len(candidates) == 1:
            return _decode(candidates[0], value, path)
        for option in candidates:
            try:
                return _decode(option, value, path)
            except ValidationError:
                pass
        raise InputTypeError("value does not match the saved field's type.", path=path)
    if origin is Literal:
        if not any(type(value) is type(option) and value == option for option in args):
            raise InputValueError(f"expected one of {args}.", path=path)
        return value
    if origin in (tuple, list):
        if not isinstance(value, (list, tuple)):
            raise InputTypeError(f"expected an array, received {check.type_name(value)}.", path=path)
        if len(args) == 2 and args[1] is Ellipsis:
            items = [_decode(args[0], item, f"{path}[{index}]") for index, item in enumerate(value)]
        elif origin is list and args:
            items = [_decode(args[0], item, f"{path}[{index}]") for index, item in enumerate(value)]
        else:
            if len(value) != len(args):
                raise InputValueError(f"expected {len(args)} items.", path=path)
            items = [_decode(kind, item, f"{path}[{index}]") for index, (kind, item) in enumerate(zip(args, value))]
        return tuple(items) if origin is tuple else items
    if origin is dict:
        if not isinstance(value, dict):
            raise InputTypeError("expected an object.", path=path)
        return {_decode(args[0], key, path + " key"): _decode(args[1], item, check.child_path(path, key))
                for key, item in value.items()}
    if annotation is str:
        return check.string(value, path)
    if annotation is bool:
        return check.boolean(value, path)
    if annotation is int:
        if type(value) is not int:
            raise InputTypeError("expected an integer.", path=path)
        return value
    if annotation is float:
        return float(check.finite_number(value, path))
    if annotation is type(None) and value is None:
        return None
    raise InputTypeError("unsupported or invalid saved field type.", path=path)


def _record(cls, data, path):
    if not isinstance(data, dict):
        raise InputTypeError(f"expected an object describing {cls.__name__}, received {check.type_name(data)}.", path=path)
    known = {item.name: item for item in fields(cls)}
    for key in data:
        if key not in known:
            close = get_close_matches(key, known, n=1)
            raise InputValueError("unknown field.", path=check.child_path(path, key),
                                  hint=f"Did you mean {close[0]!r}?" if close else "Check the result format and library version.")
    values = {}
    for name, field in known.items():
        location = f"{path}.{name}"
        if name not in data:
            if field.default is MISSING and field.default_factory is MISSING:
                raise InputValueError("required field is missing.", path=location)
            continue
        if name in _JSON_FIELDS:
            if name in _OBJECT_FIELDS and not isinstance(data[name], dict):
                raise InputTypeError("expected a JSON object.", path=location)
            values[name] = check.json_copy(data[name], location)
        else:
            values[name] = _decode(_hints(cls)[name], data[name], location)
    try:
        return cls(**values)
    except ValidationError as exc:
        suffix = (exc.path or "").removeprefix(cls.__name__)
        raise exc.at(path + suffix) from exc


def load_result(cls, data, expected_format):
    path = cls.__name__
    if not isinstance(data, dict):
        raise InputTypeError("expected a JSON object from to_dict().", path=path + ".from_dict")
    data = check.json_copy(data, path)
    if data.pop("format", None) != expected_format:
        raise InputValueError(f"expected format {expected_format!r}.", path=path + ".format")
    version = data.pop("format_version", None)
    if type(version) is not int or version != 1:
        raise InputValueError("unsupported format version; expected integer 1.", path=path + ".format_version")
    result = _record(cls, data, path)
    _links(result)
    return result


def _links(result):
    """Reject broken IDs before properties like score/candidate lineage can fail later."""
    root = type(result).__name__

    def ids(records, path, *, unique=True):
        found = set()
        for index, item in enumerate(records):
            check.string(item.id, f"{path}[{index}].id", nonempty=True)
            if unique and item.id in found:
                raise InputValueError("duplicate record ID.", path=f"{path}[{index}].id")
            found.add(item.id)
        return found

    def ref(value, available, path, *, optional=False):
        if value is None and optional:
            return
        if value not in available:
            raise InputValueError("references an unknown record ID.", path=path)

    examples = ids(result.examples, root + ".examples")
    if not examples:
        raise InputValueError("must contain at least one Example.", path=root + ".examples")
    evaluations = ids(result.evaluations, root + ".evaluations")
    for i, batch in enumerate(result.evaluations):
        check.unit_score(batch.score, f"{root}.evaluations[{i}].score")
        seen = set()
        for j, obs in enumerate(batch.observations):
            path = f"{root}.evaluations[{i}].observations[{j}].example_id"
            ref(obs.example_id, examples, path)
            if obs.example_id in seen:
                raise InputValueError("duplicate observation for an Example ID.", path=path)
            seen.add(obs.example_id)
    for i, issue in enumerate(result.issues):
        ref(issue.example_id, examples, f"{root}.issues[{i}].example_id")
        ref(issue.evaluation_id, evaluations, f"{root}.issues[{i}].evaluation_id")
    for field in fields(result.stats):
        check.integer(getattr(result.stats, field.name), f"{root}.stats.{field.name}")
    if hasattr(result, "suggestions"):
        suggestions = ids(result.suggestions, root + ".suggestions")
        ref(result.baseline_id, evaluations, root + ".baseline_id", optional=True)
        for i, item in enumerate(result.suggestions):
            ref(item.optimized_from_id, suggestions, f"{root}.suggestions[{i}].optimized_from_id", optional=True)
        for i, item in enumerate(result.applied_ids):
            ref(item, suggestions, f"{root}.applied_ids[{i}]")
        for i, item in enumerate(result.verifications):
            ref(item.suggestion_id, suggestions, f"{root}.verifications[{i}].suggestion_id")
            ref(item.evaluation_id, evaluations, f"{root}.verifications[{i}].evaluation_id", optional=True)
    else:
        trials = ids(result.trials, root + ".trials")
        versions = ids(result.versions, root + ".versions", unique=False)
        for i, item in enumerate(result.versions):
            ref(item.evaluation_id, evaluations, f"{root}.versions[{i}].evaluation_id")
            ref(item.accepted_trial_id, trials, f"{root}.versions[{i}].accepted_trial_id", optional=True)
            ref(item.parent_id, versions, f"{root}.versions[{i}].parent_id", optional=True)
        for i, item in enumerate(result.trials):
            ref(item.evaluation_id, evaluations, f"{root}.trials[{i}].evaluation_id")
