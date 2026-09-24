"""DAG exporter used when a Current Pipeline has branches or multi-Dataset Process inputs."""
from __future__ import annotations

import io
import json
import zipfile
from pathlib import PurePosixPath
from typing import Any

try:  # main.py imports pipeline_export as a top-level module; tests import backend.pipeline_export.
    from pipeline_export import (
    ExportedFile, ExportMetadata, PipelineExportError, _credential_config, _data_markdown,
    _dataset_schema, _engine_base_module, _engine_init_module, _env_example, _identifier,
    _litellm_engine_module, _openrouter_engine_module, _package_init, _processor_module,
    _prompt_module, _python_literal, _readme, _requirements, _slug, _text,
)
except ImportError:  # Package import used by tests and external callers.
    from .pipeline_export import (
        ExportedFile, ExportMetadata, PipelineExportError, _credential_config, _data_markdown,
        _dataset_schema, _engine_base_module, _engine_init_module, _env_example, _identifier,
        _litellm_engine_module, _openrouter_engine_module, _package_init, _processor_module,
        _prompt_module, _python_literal, _readme, _requirements, _slug, _text,
    )


def _contract(node: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    name = _text(node.get("name")) or "Dataset"
    schema = _dataset_schema(node)
    columns = [column["name"] for column in schema["columns"]]
    if any(not _text(column) for column in columns):
        raise PipelineExportError(f'Dataset "{name}" contains an empty column name.')
    duplicates = sorted({column for column in columns if columns.count(column) > 1})
    if duplicates:
        raise PipelineExportError(f'Dataset "{name}" contains duplicate columns: {", ".join(duplicates)}.')
    return name, schema


def _dag_main(jobs: list[dict[str, Any]], input_id: str, input_columns: list[str], outputs: list[dict[str, str]], concurrency: int, metadata: ExportMetadata) -> str:
    imports, calls = [], []
    for job in jobs:
        imports.append(f"from {job['package']} import {job['module']} as {job['alias']}")
        if job["type"] == "process":
            frames = ", ".join(f"{key!r}: frames[{key!r}]" for key in job["inputs"])
            lines = [
                f'    print("Running Process: {job["name"]}", flush=True)',
                f"    result = run_process(frames[{job['primary_input']!r}], {{{frames}}}, {job['alias']}.process, {job['name']!r})",
            ]
            lines.extend(f"    frames[{item['id']!r}] = branch(result, {item['branch']!r}, {job['name']!r})" for item in job["outputs"])
            calls.append("\n".join(lines))
        else:
            calls.append(
                f'    print("Running Prompt: {job["name"]}", flush=True)\n'
                f"    frames[{job['outputs'][0]['id']!r}] = {job['alias']}.run(frames[{job['inputs'][0]!r}], engine, input_root=input_root, concurrency=args.concurrency, model_override=args.model)"
            )
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
OUTPUT_DATASETS = __ANNOBIO_OUTPUTS__
PROJECT_ROOT = Path(__file__).resolve().parent

def load_input(path: Path, sheet: str) -> pd.DataFrame:
    if not path.is_file():
        raise FileNotFoundError(f"Input workbook does not exist: {path}")
    frame = pd.read_excel(path, sheet_name=sheet)
    missing = [column for column in REQUIRED_INPUT_COLUMNS if column not in frame.columns]
    if missing:
        raise ValueError("Input workbook is missing columns: " + ", ".join(missing))
    return frame

def input_variable_name(dataset_id: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9_]", "_", dataset_id)
    if safe and safe[0].isdigit():
        safe = "_" + safe
    return "df_" + (safe or "dataset")

def run_process(primary: pd.DataFrame, input_frames: dict[str, pd.DataFrame], process: Callable[[pd.DataFrame], Any], name: str) -> dict[str, pd.DataFrame]:
    # df is one explicit primary Dataset. Other input Datasets stay independent until the user
    # deliberately joins them in Process code, e.g. pd.concat([df, inputs["dataset-id"]]).
    scoped_inputs = {dataset_id: frame.copy() for dataset_id, frame in input_frames.items()}
    namespace = process.__globals__
    namespace["inputs"] = scoped_inputs
    for dataset_id, frame in scoped_inputs.items():
        namespace[input_variable_name(dataset_id)] = frame
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
    result.add_argument("--input", required=True, type=Path, help="Input Excel workbook.")
    result.add_argument("--output", default=Path("output.xlsx"), type=Path, help="Output workbook.")
    result.add_argument("--sheet", default="Input", help="Input sheet name.")
    result.add_argument("--engine", choices=("litellm", "openrouter"), help="Override ANNOBIO_ENGINE.")
    result.add_argument("--model", help="Override the exported model for every Prompt step.")
    result.add_argument("--concurrency", type=int, default=__ANNOBIO_CONCURRENCY__)
    result.add_argument("--start-row", type=int, default=0)
    result.add_argument("--limit", type=int)
    return result

def main() -> int:
    load_dotenv(PROJECT_ROOT / ".env")
    args = parser().parse_args()
    if args.start_row < 0 or (args.limit is not None and args.limit < 1) or args.concurrency < 1:
        raise ValueError("--start-row must be >= 0, --limit must be >= 1, and --concurrency must be >= 1.")
    input_path = args.input.expanduser().resolve()
    frames: dict[str, pd.DataFrame] = {__ANNOBIO_INPUT_DATASET__: load_input(input_path, args.sheet).iloc[args.start_row:]}
    if args.limit is not None:
        frames[__ANNOBIO_INPUT_DATASET__] = frames[__ANNOBIO_INPUT_DATASET__].iloc[:args.limit]
    input_root = input_path.parent
    engine = create_engine(args.engine)

# CALLS

    output_path = args.output.expanduser().resolve()
    write_outputs(frames, output_path)
    print(f"Wrote {len(OUTPUT_DATASETS)} output worksheet(s) to {output_path}", flush=True)
    return 0
if __name__ == "__main__":
    raise SystemExit(main())
'''
    source = source.replace("# IMPORTS", "\n".join(imports)).replace("__ANNOBIO_INPUT_COLUMNS__", _python_literal(input_columns)).replace("__ANNOBIO_OUTPUTS__", _python_literal(outputs)).replace("__ANNOBIO_CONCURRENCY__", str(max(1, min(32, int(concurrency or 1))))).replace("__ANNOBIO_INPUT_DATASET__", _python_literal(input_id)).replace("# CALLS", "\n\n".join(calls))
    return metadata.python_header("Executable entry point for this user-defined AnnoBio pipeline graph.") + "\n" + source


def build_dag_pipeline_archive(*, canvas_state: dict[str, Any], route: list[dict[str, Any]], name: str, credentials: list[dict[str, Any]] | None = None, default_credential_id: str = "", run_max_tokens: int = 8192, run_concurrency: int = 4, author_name: str = "", generated_at: str | None = None) -> tuple[str, bytes]:
    metadata = ExportMetadata.create(author_name, generated_at)
    selected = {str(value) for item in route if isinstance(item, dict) for value in (item.get("dataset_node_id"), item.get("process_node_id"), item.get("prompt_node_id"), item.get("run_node_id")) if _text(value)}
    nodes = {str(node.get("nodeId") or node.get("id")): node for node in canvas_state.get("nodes", []) if isinstance(node, dict) and str(node.get("nodeId") or node.get("id")) in selected}
    edges = [edge for edge in canvas_state.get("connections", []) if isinstance(edge, dict) and _text(edge.get("fromId")) in nodes and _text(edge.get("toId")) in nodes]
    datasets = {key: value for key, value in nodes.items() if value.get("type") == "dataset"}
    processes = {key: value for key, value in nodes.items() if value.get("type") == "process"}
    prompts = {key: value for key, value in nodes.items() if value.get("type") == "prompt"}
    runs = {key: value for key, value in nodes.items() if value.get("type") == "run"}
    if not datasets or not runs:
        raise PipelineExportError("The exported graph must contain a Dataset and at least one Prompt Run.")
    names, schemas = {}, {}
    for key, node in datasets.items():
        names[key], schemas[key] = _contract(node)
    process_inputs = {key: [_text(edge.get("fromId")) for edge in edges if edge.get("type") == "dataset-to-process" and _text(edge.get("toId")) == key] for key in processes}
    process_outputs = {key: [_text(edge.get("toId")) for edge in edges if edge.get("type") == "process-to-dataset" and _text(edge.get("fromId")) == key] for key in processes}
    run_prompt = {_text(edge.get("toId")): _text(edge.get("fromId")) for edge in edges if edge.get("type") == "prompt-to-run" and _text(edge.get("fromId")) in prompts and _text(edge.get("toId")) in runs}
    run_outputs = {key: [dataset_id for dataset_id, node in datasets.items() if _text(node.get("sourceRunNodeId")) == key] for key in runs}
    produced = {item for group in process_outputs.values() for item in group} | {item for group in run_outputs.values() for item in group}
    inputs = [key for key in datasets if key not in produced]
    if len(inputs) != 1:
        raise PipelineExportError("A Python project currently needs exactly one starting Dataset. Join source data before exporting.")
    input_id = inputs[0]
    if not schemas[input_id]["columns"]:
        raise PipelineExportError(f'Dataset "{names[input_id]}" must define at least one column.')
    credentials_by_id = {_text(item.get("id")): item for item in credentials or [] if isinstance(item, dict)}
    files, steps, jobs = [], [], {}
    process_number = prompt_number = 0
    default_engine, default_model, default_url = "litellm", "", ""
    for key, node in processes.items():
        if not process_inputs[key] or not process_outputs[key]:
            raise PipelineExportError(f'Process "{_text(node.get("name")) or "Process"}" needs connected input and saved output Datasets.')
        process_number += 1
        process_name, mode, generated = _processor_module(node, metadata)
        module = f"processor_{process_number:02d}_{_identifier(process_name, 'process')}"
        primary_input = _text(node.get("primaryDatasetId"))
        if primary_input not in process_inputs[key]:
            primary_input = process_inputs[key][0]
        outputs = []
        for dataset_id in process_outputs[key]:
            branch_name = _text(datasets[dataset_id].get("processOutputName")) or ("result" if len(process_outputs[key]) == 1 else "")
            if not branch_name:
                raise PipelineExportError(f'Output Dataset "{names[dataset_id]}" needs a Process branch name.')
            outputs.append({"id": dataset_id, "name": names[dataset_id], "branch": branch_name})
        files.append(ExportedFile(f"processor/{module}.py", generated["module"]))
        steps.append({"type": "process", "id": key, "name": process_name, "mode": mode, "source": f"processor/{module}.py", "inputs": process_inputs[key], "outputs": outputs})
        jobs[f"process:{key}"] = {"id": f"process:{key}", "type": "process", "name": process_name, "inputs": process_inputs[key], "primary_input": primary_input, "outputs": outputs, "package": "processor", "module": module, "alias": f"processor_step_{process_number:02d}"}
    for key, run in runs.items():
        prompt_id, working_set, outputs = run_prompt.get(key), _text(run.get("runWorkingSetId")), run_outputs[key]
        if not prompt_id or working_set not in datasets or len(outputs) != 1:
            raise PipelineExportError(f'Run "{_text(run.get("runName")) or "Run"}" needs one connected Prompt, working Dataset, and saved output Dataset.')
        prompt_number += 1
        config = _credential_config(run, credentials_by_id, default_credential_id, run_max_tokens)
        prompt_name, prompt_config, module_source = _prompt_module(prompts[prompt_id], run, config, [column["name"] for column in schemas[working_set]["columns"]], metadata)
        unknown = sorted({value for value in prompt_config["input_mapping"].values() if value not in {column["name"] for column in schemas[working_set]["columns"]}})
        if unknown:
            raise PipelineExportError(f'Prompt "{prompt_name}" maps inputs to missing columns: {", ".join(unknown)}.')
        available_types = {column["name"]: column.get("type", "text") for column in schemas[working_set]["columns"]}
        type_errors = []
        for input_name, column_name in prompt_config["input_mapping"].items():
            expected, actual = prompt_config["input_types"].get(input_name), available_types.get(column_name, "text")
            if expected in ("image", "pdf") and actual != expected:
                type_errors.append(f'{{{input_name}}} requires {expected}, but "{column_name}" is {actual}')
            elif expected == "text" and actual in ("image", "pdf"):
                type_errors.append(f'{{{input_name}}} requires text, but "{column_name}" is {actual}')
        if type_errors:
            raise PipelineExportError(f'Prompt "{prompt_name}" has incompatible input mappings: ' + "; ".join(type_errors) + ".")
        module = f"prompt_{prompt_number:02d}_{_identifier(prompt_name, 'prompt')}"
        files.append(ExportedFile(f"prompt/{module}.py", module_source))
        steps.append({"type": "prompt", "id": prompt_id, "run_id": key, "name": prompt_name, "source": f"prompt/{module}.py", "input": working_set, "output": outputs[0], **prompt_config})
        jobs[f"run:{key}"] = {"id": f"run:{key}", "type": "prompt", "name": prompt_name, "inputs": [working_set], "outputs": [{"id": outputs[0], "name": names[outputs[0]]}], "package": "prompt", "module": module, "alias": f"prompt_step_{prompt_number:02d}"}
        if prompt_number == 1:
            default_engine, default_model, default_url = config["engine"], config["model"], config["base_url"]
    available, ordered, pending = {input_id}, [], dict(jobs)
    while pending:
        ready = [job for job in pending.values() if set(job["inputs"]).issubset(available)]
        if not ready:
            raise PipelineExportError("The selected graph has an unresolved dependency or cycle.")
        for job in sorted(ready, key=lambda item: item["id"]):
            ordered.append(job); available.update(output["id"] for output in job["outputs"]); pending.pop(job["id"])
    consumed = {item for job in ordered for item in job["inputs"]}
    outputs = [{"id": key, "name": names[key]} for key in sorted(available - consumed - {input_id})]
    if not outputs:
        raise PipelineExportError("The exported graph has no final Dataset to write.")
    root = _slug(name, "pipeline")
    manifest = {"format": "annobio.pipeline", "format_version": 1, "name": root, "entrypoint": "main.py", "generated_at": metadata.generated_at, "authors": {"workflow": metadata.workflow_author, "exported_project": "AnnoBio"}, "input": {"format": "xlsx", "sheet": schemas[input_id]["sheet"], "columns": schemas[input_id]["columns"]}, "graph": {"steps": steps, "terminal_datasets": outputs}, "engines": ["litellm", "openrouter"], "default_engine": default_engine, "output": {"format": "xlsx", "worksheets": outputs}}
    files += [ExportedFile("pipeline.json", json.dumps(manifest, ensure_ascii=False, indent=2)+"\n"), ExportedFile("DATA.md", _data_markdown(names[input_id], schemas[input_id])), ExportedFile("README.md", _readme(root, default_engine, metadata)), ExportedFile("requirements.txt", _requirements()), ExportedFile(".env.example", _env_example(default_engine, default_model, default_url)), ExportedFile("processor/__init__.py", _package_init("User-authored Process modules exported by AnnoBio.", metadata)), ExportedFile("prompt/__init__.py", _package_init("User-authored Prompt modules exported by AnnoBio.", metadata)), ExportedFile("engine/__init__.py", _engine_init_module(default_engine, metadata)), ExportedFile("engine/base.py", _engine_base_module(metadata)), ExportedFile("engine/litellm_engine.py", _litellm_engine_module(metadata)), ExportedFile("engine/openrouter_engine.py", _openrouter_engine_module(metadata)), ExportedFile("main.py", _dag_main(ordered, input_id, [column["name"] for column in schemas[input_id]["columns"]], outputs, run_concurrency, metadata))]
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as bundle:
        for file in sorted(files, key=lambda item: item.path):
            info = zipfile.ZipInfo(PurePosixPath(root, file.path).as_posix(), date_time=(2020,1,1,0,0,0)); info.compress_type = zipfile.ZIP_DEFLATED; info.external_attr = 0o644 << 16
            bundle.writestr(info, file.content.encode("utf-8"))
    return f"{root}.zip", archive.getvalue()
