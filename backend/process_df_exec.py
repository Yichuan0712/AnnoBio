"""
Runs AnnoBio's single Process-node contract: a user-authored `process(df)` function over the whole
dataset. It uses whichever Python interpreter (system install or a venv) the user points at in
Settings. `df` is a pandas DataFrame built from the primary Dataset; other connected Datasets are
available independently. A Process can return either a
DataFrame or a dictionary mapping branch names to DataFrames. The subprocess is handed back to the
caller so it can be killed on cancel.
"""

import json
import os
import subprocess
import tempfile

RUN_TIMEOUT_SEC = 120

_WRAPPER_HEADER = """import sys, json, re

try:
    import pandas as pd
except ImportError:
    sys.stdout.write(json.dumps({
        "ok": False,
        "error": "pandas is not installed in this Python interpreter. Run `pip install pandas` in it (see Settings \\u2192 Python), then try again.",
    }) + "\\n")
    sys.stdout.flush()
    sys.exit(0)

"""

_WRAPPER_FOOTER = """

try:
    _input = json.loads(sys.stdin.read())
    _raw_inputs = _input.get("input_datasets") or {"input": {"headers": _input.get("headers") or [], "rows": _input.get("rows") or []}}
    inputs = {}
    for _dataset_id, _dataset in _raw_inputs.items():
        if not isinstance(_dataset, dict):
            raise TypeError("Each Process input Dataset must contain headers and rows")
        _headers = _dataset.get("headers") or []
        _rows = _dataset.get("rows") or []
        inputs[str(_dataset_id)] = pd.DataFrame(_rows, columns=_headers)
    _primary_dataset_id = str(_input.get("primary_dataset_id") or "")
    if _primary_dataset_id not in inputs:
        _primary_dataset_id = next(iter(inputs), "")
    if not _primary_dataset_id:
        raise ValueError("A Process needs one primary Dataset")
    # `df` is the primary Dataset. Secondary inputs remain independent and are deliberately not
    # concatenated. User code can use inputs["node-id"] or df_<safe_node_id>.
    for _dataset_id, _dataset_frame in inputs.items():
        _safe_id = re.sub(r"[^A-Za-z0-9_]", "_", _dataset_id)
        if _safe_id and _safe_id[0].isdigit():
            _safe_id = "_" + _safe_id
        globals()["df_" + (_safe_id or "dataset")] = _dataset_frame
    _df = inputs[_primary_dataset_id]
    _result = process(_df)
    if isinstance(_result, pd.DataFrame):
        _outputs = {"result": _result}
    elif isinstance(_result, dict):
        _outputs = {}
        for _branch_name, _branch_frame in _result.items():
            if not isinstance(_branch_name, str) or not _branch_name.strip():
                raise TypeError("Process branch names must be non-empty strings")
            if not isinstance(_branch_frame, pd.DataFrame):
                raise TypeError(f'Process branch "{_branch_name}" must be a pandas DataFrame')
            _normalized_name = _branch_name.strip()
            if _normalized_name in _outputs:
                raise ValueError(f'Duplicate Process branch name: "{_normalized_name}"')
            _outputs[_normalized_name] = _branch_frame
    else:
        raise TypeError("process(df) must return a pandas DataFrame or {branch_name: DataFrame}")
    _out_rows = {name: json.loads(frame.to_json(orient="records")) for name, frame in _outputs.items()}
    sys.stdout.write(json.dumps({"ok": True, "outputs": _out_rows}) + "\\n")
except Exception as _e:
    sys.stdout.write(json.dumps({"ok": False, "error": str(_e)}) + "\\n")
sys.stdout.flush()
"""


def _build_wrapper(code: str) -> str:
    return _WRAPPER_HEADER + code + _WRAPPER_FOOTER


def run_process_df_code(python_path: str, code: str, headers: list, rows: list, input_datasets: dict | None = None, primary_dataset_id: str = "", register_proc=None, timeout_sec: int = RUN_TIMEOUT_SEC) -> dict:
    """
    Runs `code`'s process(df) once on the primary Dataset. Additional input Datasets are exposed
    independently through `inputs[dataset_id]` and `df_<safe_dataset_id>` globals.
    `register_proc(proc)`, if given, is called with the subprocess.Popen as soon as it's spawned,
    so the caller can kill it to cancel a run in progress. Returns {"ok": True, "outputs":
    {branch_name: [...]}} or {"ok": False, "error": ...}. Never raises.
    """
    fd, path = tempfile.mkstemp(suffix=".py", prefix="process_df_")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(_build_wrapper(code))

    try:
        normalized_inputs = input_datasets or {primary_dataset_id or "input": {"headers": headers, "rows": rows}}
        payload_inputs = {}
        for dataset_id, content in normalized_inputs.items():
            source_headers = list((content or {}).get("headers") or [])
            source_rows = list((content or {}).get("rows") or [])
            payload_inputs[str(dataset_id)] = {
                "headers": source_headers,
                "rows": [
                    {header: (row[index] if index < len(row) else "") for index, header in enumerate(source_headers)}
                    for row in source_rows
                ],
            }
        payload = json.dumps({"input_datasets": payload_inputs, "primary_dataset_id": primary_dataset_id})

        try:
            proc = subprocess.Popen(
                [python_path, "-u", path],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
            )
        except OSError as e:
            return {"ok": False, "error": str(e)}

        if register_proc:
            register_proc(proc)

        try:
            out, err = proc.communicate(input=payload, timeout=timeout_sec)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.communicate()
            return {"ok": False, "error": f"Timed out after {timeout_sec}s"}

        out = out or ""
        err = err or ""
        line = out.strip().splitlines()[-1] if out.strip() else ""
        if not line:
            if proc.returncode is not None and proc.returncode < 0:
                return {"ok": False, "error": "Cancelled"}
            return {"ok": False, "error": err.strip() or f"No output from interpreter (exit code {proc.returncode})"}
        try:
            outcome = json.loads(line)
        except json.JSONDecodeError:
            return {"ok": False, "error": f"Malformed output: {line[:200]}"}
        if not isinstance(outcome, dict) or "ok" not in outcome:
            return {"ok": False, "error": f"Malformed output: {line[:200]}"}
        return outcome
    finally:
        try:
            os.remove(path)
        except OSError:
            pass
