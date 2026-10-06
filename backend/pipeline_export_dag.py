"""DAG exporter used when a Current Pipeline has branches or multi-Dataset Process inputs."""
from __future__ import annotations

from typing import Any

if __package__:
    from .pipeline_export import ExportMetadata, _python_literal
else:
    from pipeline_export import ExportMetadata, _python_literal


def _dag_main(jobs: list[dict[str, Any]], inputs: list[dict[str, Any]], outputs: list[dict[str, str]], concurrency: int, metadata: ExportMetadata) -> str:
    imports, calls = [], []
    for job in jobs:
        imports.append(f"from {job['package']} import {job['module']} as {job['alias']}")
        if job["type"] == "process":
            frames = ", ".join(f"{alias!r}: frames[{dataset_id!r}]" for dataset_id, alias in job["input_aliases"].items())
            lines = [
                f"    print({'Running Process: ' + job['name']!r}, flush=True)",
                f"    result = run_process(frames[{job['primary_input']!r}], {{{frames}}}, {job['alias']}.process, {job['name']!r})",
            ]
            lines.extend(f"    frames[{item['id']!r}] = branch(result, {item['branch']!r}, {job['name']!r})" for item in job["outputs"])
            calls.append("\n".join(lines))
        else:
            lines = [
                f"    print({'Running Prompt: ' + job['name']!r}, flush=True)",
                f"    result = {job['alias']}.run(frames[{job['inputs'][0]!r}], engine, input_root=input_root, concurrency=args.concurrency, model_override=args.model)",
            ]
            lines.extend(f"    frames[{item['id']!r}] = result.copy()" for item in job['outputs'])
            calls.append("\n".join(lines))
    source = r'''from __future__ import annotations
import argparse
import json
import re
from pathlib import Path
from typing import Any, Callable
import pandas as pd
try:
    from dotenv import load_dotenv
except ImportError:
    def load_dotenv(*_args: Any, **_kwargs: Any) -> bool:
        return False
from engine import create_engine
# IMPORTS

REQUIRED_INPUT_COLUMNS = __ANNOBIO_INPUT_COLUMNS__
INPUT_DATASETS = __ANNOBIO_INPUT_DATASETS__
OUTPUT_DATASETS = __ANNOBIO_OUTPUTS__
PROJECT_ROOT = Path(__file__).resolve().parent

def absolute_asset_cell(value: Any, root: Path) -> Any:
    if value is None or pd.isna(value):
        return value
    raw = str(value).strip()
    if not raw:
        return value
    def absolute(item: Any) -> str:
        path = Path(str(item))
        return str(path if path.is_absolute() else (root / path).resolve())
    if raw.startswith("["):
        try:
            values = json.loads(raw)
        except json.JSONDecodeError:
            values = None
        if isinstance(values, list):
            return json.dumps([absolute(item) for item in values], ensure_ascii=False)
    return absolute(raw)


def load_input(path: Path, sheet: str, required_columns: list[str], asset_columns: list[str]) -> pd.DataFrame:
    if not path.is_file():
        raise FileNotFoundError(f"Input workbook does not exist: {path}")
    frame = pd.read_excel(path, sheet_name=sheet)
    missing = [column for column in required_columns if column not in frame.columns]
    if missing:
        raise ValueError("Input workbook is missing columns: " + ", ".join(missing))
    for column in asset_columns:
        frame[column] = frame[column].map(lambda value: absolute_asset_cell(value, path.parent))
    return frame


def input_paths(values: list[str]) -> dict[str, Path]:
    expected = [item["id"] for item in INPUT_DATASETS]
    if len(expected) == 1 and len(values) == 1 and "=" not in values[0]:
        return {expected[0]: Path(values[0])}
    paths: dict[str, Path] = {}
    for value in values:
        dataset_id, separator, path = value.partition("=")
        if not separator or dataset_id not in expected or not path or dataset_id in paths:
            raise ValueError("Pass each input once as --input DATASET_ID=FILE.xlsx. Expected: " + ", ".join(expected))
        paths[dataset_id] = Path(path)
    missing = [dataset_id for dataset_id in expected if dataset_id not in paths]
    if missing:
        raise ValueError("Missing input Dataset(s): " + ", ".join(missing))
    return paths

def run_process(primary: pd.DataFrame, input_frames: dict[str, pd.DataFrame], process: Callable[[pd.DataFrame], Any], name: str) -> dict[str, pd.DataFrame]:
    # df is one explicit primary Dataset. Other inputs use the readable aliases displayed in the
    # Process editor and remain independent until user code deliberately combines them.
    scoped_inputs = {alias: frame.copy() for alias, frame in input_frames.items()}
    namespace = process.__globals__
    for alias, frame in scoped_inputs.items():
        if alias != "df":
            namespace[alias] = frame
    result = process(primary.copy())
    if isinstance(result, pd.DataFrame):
        return {"result": result}
    if not isinstance(result, dict):
        raise TypeError(f'Process "{name}" must return a DataFrame or named DataFrame branches.')
    if any(not str(key).strip() or not isinstance(value, pd.DataFrame) for key, value in result.items()):
        raise TypeError(f'Every Process branch from "{name}" must have a name and contain a DataFrame.')
    return {str(key): value for key, value in result.items()}

def branch(outputs: dict[str, pd.DataFrame], name: str, process_name: str) -> pd.DataFrame:
    if name not in outputs:
        raise ValueError(f'Process "{process_name}" did not return branch "{name}". Available: {", ".join(sorted(outputs)) or "(none)"}.')
    return outputs[name].copy()

def excel_value(value: Any) -> Any:
    return json.dumps(value, ensure_ascii=False) if isinstance(value, (dict, list, tuple)) else value

def worksheet_name(value: str, used: set[str]) -> str:
    base = re.sub(r"[\\/*?:\[\]]", "_", value).strip()[:31] or "Output"
    candidate, number = base, 2
    while candidate.casefold() in used:
        suffix = f" ({number})"
        candidate, number = base[:31-len(suffix)] + suffix, number + 1
    used.add(candidate.casefold())
    return candidate

def write_outputs(frames: dict[str, pd.DataFrame], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    used: set[str] = set()
    with pd.ExcelWriter(path) as writer:
        for output in OUTPUT_DATASETS:
            frame = frames[output["id"]]
            serializable = frame.map(excel_value) if hasattr(frame, "map") else frame.applymap(excel_value)
            serializable.to_excel(writer, index=False, sheet_name=worksheet_name(output["name"], used))

def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description="Run the Python pipeline exported by AnnoBio.")
    result.add_argument("--input", required=True, action="append", help="Input workbook; use DATASET_ID=FILE.xlsx for multiple inputs.")
    result.add_argument("--output", default=Path("output.xlsx"), type=Path, help="Output workbook.")
    result.add_argument("--sheet", default="Input", help="Input sheet name.")
    result.add_argument("--engine", choices=("litellm", "openrouter"), help="Override ANNOBIO_ENGINE.")
    result.add_argument("--model", help="Override the exported model for every Prompt step.")
    result.add_argument("--concurrency", type=int, default=None, help="Override each step's configured concurrency.")
    result.add_argument("--start-row", type=int, default=0)
    result.add_argument("--limit", type=int)
    return result

def main() -> int:
    load_dotenv(PROJECT_ROOT / ".env")
    args = parser().parse_args()
    if args.start_row < 0 or (args.limit is not None and args.limit < 1) or (args.concurrency is not None and args.concurrency < 1):
        raise ValueError("--start-row must be >= 0, --limit must be >= 1, and --concurrency must be >= 1.")
    paths = {dataset_id: path.expanduser().resolve() for dataset_id, path in input_paths(args.input).items()}
    frames: dict[str, pd.DataFrame] = {}
    for item in INPUT_DATASETS:
        frame = load_input(paths[item["id"]], args.sheet, item["columns"], item["asset_columns"]).iloc[args.start_row:]
        frames[item["id"]] = frame.iloc[:args.limit] if args.limit is not None else frame
    input_root = paths[INPUT_DATASETS[0]["id"]].parent
    engine = create_engine(args.engine)

# CALLS

    output_path = args.output.expanduser().resolve()
    write_outputs(frames, output_path)
    print(f"Wrote {len(OUTPUT_DATASETS)} output worksheet(s) to {output_path}", flush=True)
    return 0
if __name__ == "__main__":
    raise SystemExit(main())
'''
    source = source.replace("# IMPORTS", "\n".join(imports)).replace("__ANNOBIO_INPUT_COLUMNS__", _python_literal(inputs[0]["columns"])).replace("__ANNOBIO_INPUT_DATASETS__", _python_literal(inputs)).replace("__ANNOBIO_OUTPUTS__", _python_literal(outputs)).replace("# CALLS", "\n\n".join(calls))
    return metadata.python_header("Executable entry point for this user-defined AnnoBio pipeline graph.") + "\n" + source


def build_dag_pipeline_archive(**kwargs: Any) -> tuple[str, bytes]:
    """Compatibility entry point; the compiler owns graph interpretation."""
    if __package__:
        from .pipeline_export_spec import compile_and_export
    else:
        from pipeline_export_spec import compile_and_export
    return compile_and_export(force_graph=True, **kwargs)
