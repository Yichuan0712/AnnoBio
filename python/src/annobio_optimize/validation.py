"""Checks at public/callback boundaries. Validation never invokes task/model callbacks."""
from __future__ import annotations

from collections.abc import Iterable
import inspect
import json
import math
from typing import Any

from .errors import CallbackContractError, InputTypeError, InputValueError, ValidationError


def type_name(value):
    return type(value).__name__


def string(value, path, *, nonempty=False):
    if not isinstance(value, str):
        raise InputTypeError(f"expected a string, received {type_name(value)}.", path=path)
    if nonempty and not value.strip():
        raise InputValueError("must be a non-empty string.", path=path)
    return value


def boolean(value, path):
    if not isinstance(value, bool):
        raise InputTypeError(f"expected bool, received {type_name(value)}.", path=path,
                             hint="Use True or False, not a string or 0/1.")
    return value


def integer(value, path, *, minimum=0):
    if type(value) is not int:
        raise InputTypeError(f"expected an integer >= {minimum}, received {type_name(value)}.", path=path)
    if value < minimum:
        raise InputValueError(f"must be >= {minimum}; received {value}.", path=path)
    return value


def finite_number(value, path):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise InputTypeError(f"expected a finite number, received {type_name(value)}.", path=path)
    try:
        finite = math.isfinite(value)
    except OverflowError:
        finite = False
    if not finite:
        raise InputValueError("must be a finite, float-representable number; NaN/Inf are not allowed.", path=path)
    return value


def unit_score(value, path):
    finite_number(value, path)
    if not 0 <= value <= 1:
        raise InputValueError(f"must be in [0, 1]; received {value}.", path=path,
                              hint="Normalize your metric so higher is better.")
    return float(value)


def choice(value, options, path):
    if not isinstance(value, str) or value not in options:
        raise InputValueError(f"expected one of {', '.join(repr(item) for item in options)}; received {type_name(value)}.", path=path)
    return value


def instance(value, cls, path, *, allow_none=False):
    if allow_none and value is None:
        return value
    if not isinstance(value, cls):
        raise InputTypeError(f"expected {cls.__name__}, received {type_name(value)}.", path=path,
                             hint=f"Construct {cls.__name__}(...) instead of passing a dict or another config type.")
    return value


def child_path(path, key):
    return f"{path}.{key}" if key.isidentifier() else f"{path}[{json.dumps(key, ensure_ascii=False)}]"


def json_copy(value: Any, path="value", *, _active=None, _depth=0):
    if _depth > 100:
        raise InputValueError("JSON nesting exceeds 100 levels.", path=path)
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        try:
            finite_number(value, path)
        except InputValueError as exc:
            raise InputTypeError("NaN/Inf are not JSON numbers.", path=path, hint="Use a finite number or None.") from exc
        return value
    if not isinstance(value, (list, dict)):
        raise InputTypeError(f"expected a JSON value, received {type_name(value)}.", path=path,
                             hint="Return strings, finite numbers, bool, None, lists, or dicts with string keys; convert SDK/Pydantic objects first.")
    active = set() if _active is None else _active
    if id(value) in active:
        raise InputValueError("circular reference; JSON data cannot contain cycles.", path=path)
    active.add(id(value))
    try:
        if isinstance(value, list):
            return [json_copy(item, f"{path}[{index}]", _active=active, _depth=_depth + 1)
                    for index, item in enumerate(value)]
        result = {}
        for key, item in value.items():
            if not isinstance(key, str):
                raise InputTypeError(f"JSON object keys must be strings, received {type_name(key)}.", path=path)
            result[key] = json_copy(item, child_path(path, key), _active=active, _depth=_depth + 1)
        return result
    finally:
        active.remove(id(value))


def string_tuple(value, path, *, nonempty=False, unique=True):
    if not isinstance(value, (tuple, list)):
        raise InputTypeError(f"expected a list/tuple of strings, received {type_name(value)}.", path=path,
                             hint="For one ID, use ('sample-1',) or ['sample-1'], not 'sample-1'.")
    if nonempty and not value:
        raise InputValueError("must contain at least one ID.", path=path)
    seen = set()
    for index, item in enumerate(value):
        string(item, f"{path}[{index}]", nonempty=True)
        if unique and item in seen:
            raise InputValueError("duplicate ID; IDs must be unique.", path=f"{path}[{index}]")
        seen.add(item)
    return tuple(value)


def callback(fn, name, arity, *, optional=False):
    if fn is None and optional:
        return
    expected = {"predict": "predict(prompt, inputs)", "evaluate": "evaluate(example, prediction)",
                "model": "model(request)", "is_cancelled": "is_cancelled()", "on_event": "on_event(event)"}[name]
    if not callable(fn):
        raise InputTypeError(f"expected callable {expected}, received {type_name(fn)}.", path=name,
                             hint="Pass the function itself, not its result.")
    target = fn if inspect.isfunction(fn) or inspect.ismethod(fn) else getattr(fn, "__call__", fn)
    if any(check(fn) or check(target) for check in (
            inspect.iscoroutinefunction, inspect.isasyncgenfunction, inspect.isgeneratorfunction)):
        raise CallbackContractError(f"expected synchronous {expected}; async/generator functions are unsupported.", path=name,
                                    hint="Provide a synchronous adapter that returns the completed value.")
    try:
        signature = inspect.signature(fn)
    except (TypeError, ValueError):
        return  # Some extension callables expose no signature; validate their result at runtime.
    try:
        signature.bind(*([None] * arity))
    except TypeError as exc:
        raise InputTypeError(f"must accept {arity} positional argument(s) as {expected}: {exc}.", path=name) from None


def callbacks(*, model, predict, evaluate, is_cancelled=None, on_event=None):
    for name, fn, arity in (("model", model, 1), ("predict", predict, 2), ("evaluate", evaluate, 2)):
        callback(fn, name, arity)
    callback(is_cancelled, "is_cancelled", 0, optional=True)
    callback(on_event, "on_event", 1, optional=True)


def invoke(fn, *args, name, context=""):
    path = f"{name}({context})" if context else name
    try:
        result = fn(*args)
    except ValidationError as exc:
        raise CallbackContractError(exc.message, path=f"{path}.{exc.path}" if exc.path else path, hint=exc.hint) from exc
    except Exception as exc:
        note = f"annobio_optimize: callback {path} raised {type_name(exc)}."
        if hasattr(exc, "add_note"):
            exc.add_note(note)
        else:  # Python 3.10 preserves the original exception type and traceback too.
            exc.args = (f"{note} {exc}", *exc.args[1:])
        raise
    if inspect.isawaitable(result) or inspect.isgenerator(result) or inspect.isasyncgen(result):
        if inspect.iscoroutine(result) or inspect.isgenerator(result):
            result.close()
        raise CallbackContractError("returned an awaitable/generator instead of a completed value.", path=path,
                                    hint="Use synchronous callbacks; resolve async work inside your adapter.")
    return result


def prediction_result(value, example_id):
    path = f"predict.return[example_id={example_id!r}]"
    try:
        return json_copy(value, path)
    except ValidationError as exc:
        raise CallbackContractError(exc.message, path=exc.path, hint=exc.hint) from exc


def evaluation_result(value, example_id):
    from .types import Evaluation
    path = f"evaluate.return[example_id={example_id!r}]"
    try:
        if isinstance(value, Evaluation):
            return Evaluation(**{name: getattr(value, name) for name in value.__dataclass_fields__})
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise InputTypeError(f"expected Evaluation or a numeric score in [0, 1], received {type_name(value)}.", path=path,
                                 hint="Use Evaluation(score=..., feedback=...) for structured feedback; bool scores need float(...).")
        return Evaluation(unit_score(value, path))
    except ValidationError as exc:
        field = exc.path or ""
        if field.startswith("Evaluation."):
            field = path + field[len("Evaluation"):]
        raise CallbackContractError(exc.message, path=field or path, hint=exc.hint) from exc


def examples(value, *, path="examples"):
    from .types import Example
    if isinstance(value, (str, bytes, dict)) or not isinstance(value, Iterable):
        raise InputTypeError(f"expected an iterable of Example records, received {type_name(value)}.", path=path,
                             hint="Use [Example(id='sample-1', inputs=..., reference=...), ...].")
    result, seen = [], {}
    for index, item in enumerate(value):
        location = f"{path}[{index}]"
        instance(item, Example, location)
        try:
            normalized = Example(item.id, item.inputs, item.reference, item.weight, item.metadata)
        except ValidationError as exc:
            suffix = (exc.path or "").removeprefix("Example")
            raise exc.at(location + suffix) from exc
        if normalized.id in seen:
            raise InputValueError(f"duplicate ID {normalized.id!r}; first used at {path}[{seen[normalized.id]}].id.",
                                  path=location + ".id", hint="Each Example needs a unique ID.")
        seen[normalized.id] = index
        result.append(normalized)
    if not result:
        raise InputValueError("must contain at least one Example.", path=path)
    return tuple(result)


def observations(value, expected_ids):
    from .types import Observation
    if isinstance(value, (str, bytes, dict)) or not isinstance(value, Iterable):
        raise InputTypeError("expected an iterable of Observation records.", path="observations")
    normalized, seen = [], set()
    for index, item in enumerate(value):
        path = f"observations[{index}]"
        instance(item, Observation, path)
        try:
            obs = Observation(item.example_id, item.prediction, item.evaluation)
        except ValidationError as exc:
            raise exc.at(path + (exc.path or "").removeprefix("Observation")) from exc
        if obs.example_id in seen:
            raise InputValueError("duplicate observation for this Example ID.", path=path + ".example_id")
        if obs.example_id not in expected_ids:
            raise InputValueError("unknown Example ID; it does not belong to this dataset.", path=path + ".example_id")
        normalized.append(obs)
        seen.add(obs.example_id)
    missing = set(expected_ids) - seen
    if missing:
        raise InputValueError(f"missing observations for {', '.join(repr(id) for id in sorted(missing))}.",
                              path="observations", hint="Provide exactly one Observation per Example.")
    return tuple(normalized)
