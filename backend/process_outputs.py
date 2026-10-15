"""
Finds the output branches a Process's `process(df)` returns by parsing its code, without running it.

Follows process_df_exec.py's runtime contract: returning a DataFrame gives the single `result` output,
and returning a dict gives one output per (stripped, non-empty) string key. Only the return
statements of the last top-level `process` function count; returns inside nested functions,
lambdas and classes belong to helpers.
"""

from __future__ import annotations

import ast

BRANCH_NAME_ERROR = "Process branch names must be non-empty strings"

_NESTED_SCOPES = (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef)


class _BranchNameError(ValueError):
    pass


def _process_function(tree: ast.Module):
    """The `process` function Python would call: the last top-level definition wins."""
    found = None
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == "process":
            found = node
    return found


def _own_returns(function) -> list[ast.Return]:
    """Return statements of `function` itself, in source order."""
    returns = []
    pending = list(ast.iter_child_nodes(function))
    while pending:
        node = pending.pop()
        if isinstance(node, _NESTED_SCOPES):
            continue
        if isinstance(node, ast.Return):
            returns.append(node)
        pending.extend(ast.iter_child_nodes(node))
    return sorted(returns, key=lambda node: (node.lineno, node.col_offset))


def _classify(value) -> tuple[str, list[str]]:
    """('single', []), ('dict', names) or ('dynamic', []) for one returned expression."""
    if value is None:
        return "single", []
    if isinstance(value, ast.Dict):
        names = []
        for key in value.keys:
            if key is None:  # {**other}
                return "dynamic", []
            if not isinstance(key, ast.Constant):
                return "dynamic", []
            if not isinstance(key.value, str) or not key.value.strip():
                raise _BranchNameError(BRANCH_NAME_ERROR)
            names.append(key.value.strip())
        return "dict", names
    if isinstance(value, ast.DictComp):
        return "dynamic", []
    if isinstance(value, ast.IfExp):
        body, orelse = _classify(value.body), _classify(value.orelse)
        if body[0] == orelse[0] and body[0] != "dynamic":
            return body[0], body[1] + orelse[1]
        return "dynamic", []
    return "single", []


def detect_process_outputs(code: str) -> dict:
    """
    Returns {"ok": True, "ports": [...], "dynamic": False} when the branches are known,
    {"ok": True, "ports": [], "dynamic": True} when they depend on what the code computes, or
    {"ok": False, "error": ...} when the code cannot be read or names an invalid branch.
    """
    try:
        tree = ast.parse(str(code or ""))
    except SyntaxError as error:
        return {"ok": False, "error": f"SyntaxError: {error.msg} (line {error.lineno})"}
    function = _process_function(tree)
    if function is None:
        return {"ok": False, "error": "No top-level process() function"}
    try:
        kinds = [_classify(node.value) for node in _own_returns(function)]
    except _BranchNameError as error:
        return {"ok": False, "error": str(error)}
    found = {kind for kind, _ in kinds}
    if not kinds or found == {"single"}:
        return {"ok": True, "ports": ["result"], "dynamic": False}
    if found == {"dict"}:
        ports = []
        for _, names in kinds:
            for name in names:
                if name not in ports:
                    ports.append(name)
        return {"ok": True, "ports": ports, "dynamic": False}
    return {"ok": True, "ports": [], "dynamic": True}
