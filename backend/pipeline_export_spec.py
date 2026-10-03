"""Render standalone projects from the shared compiler; no canvas graph interpretation."""
from __future__ import annotations

from copy import deepcopy
import io
import json
from pathlib import PurePosixPath
import zipfile

if __package__:
    from .pipeline_compile import compile_pipeline
    from . import pipeline_export as render
    from .pipeline_export_dag import _dag_main
else:
    from pipeline_compile import compile_pipeline
    import pipeline_export as render
    from pipeline_export_dag import _dag_main


def compile_and_export(*, canvas_state, route, name, credentials=None, default_credential_id="",
                       run_max_tokens=8192, run_concurrency=4, run_max_retries=2,
                       author_name="", generated_at=None, input_dataset_ids=None, force_graph=False):
    # Legacy API callers specified the starting Dataset as their first route entry.
    # New browser requests supply the explicit boundary. This does not infer job order.
    if input_dataset_ids is None:
        first = route[0] if isinstance(route, list) and route and isinstance(route[0], dict) else {}
        input_dataset_ids = [first["dataset_node_id"]] if first.get("type") == "dataset" and first.get("dataset_node_id") else []
    result = compile_pipeline(
        canvas_state=canvas_state, route=route, input_dataset_ids=input_dataset_ids,
        run_defaults={"run_max_tokens": run_max_tokens, "run_concurrency": run_concurrency,
                      "run_max_retries": run_max_retries}, mapping_policy="legacy_export",
    )
    if result["spec"] is None:
        errors = [f'{d["node_name"] or "Pipeline"}: {d["message"]}'
                  for d in result["diagnostics"] if d["severity"] == "error"]
        raise render.PipelineExportError("\n".join(errors))
    # Only model binding needs the original nodes. Renderers receive the spec, not canvas data.
    nodes = {n.get("nodeId"): n for n in canvas_state["nodes"] if isinstance(n, dict)}
    by_id = {c.get("id"): c for c in credentials or [] if isinstance(c, dict)}
    models = {}
    for job in result["spec"]["jobs"]:
        if job["type"] == "llm":
            rid = job["config"]["model_binding"]["run_node_id"]
            models[job["id"]] = render._credential_config(
                nodes[rid], by_id, default_credential_id, job["config"]["settings"]["run_max_tokens"])
            models[job["id"]]["max_retries"] = job["config"]["settings"]["run_max_retries"]
    return export_compiled_pipeline(spec=result["spec"], models=models, name=name,
                                    author_name=author_name, generated_at=generated_at, force_graph=force_graph)


def _is_linear(spec):
    """Choose a rendering style using compiled ports only, never canvas edges."""
    current = spec["inputs"][0]
    for job in spec["jobs"]:
        outputs = [a for group in job["outputs"].values() for a in group]
        if list(job["inputs"].values()) != [current] or len(outputs) != 1:
            return False
        current = outputs[0]
    return spec["outputs"] == [current]


def export_compiled_pipeline(*, spec, models, name, author_name="", generated_at=None, force_graph=False):
    """Consume compiler output and non-secret resolved models; no canvas is needed.

    This is an internal API for trusted compiler output, not an arbitrary spec upload endpoint.
    Capability restrictions here do not change compiler validity (e.g. multi-input graphs).
    """
    if spec.get("format") != "annobio.pipeline-spec" or spec.get("format_version") != 1:
        raise render.PipelineExportError("Unsupported compiled PipelineSpec version.")
    if len(spec["inputs"]) != 1:
        raise render.PipelineExportError("Python export currently needs exactly one starting Dataset. The compiled graph is valid, but multi-input export is not yet supported.")
    if not spec["jobs"]:
        raise render.PipelineExportError("Python export needs at least one Process or Prompt Run.")
    uses_llm = any(j["type"] == "llm" for j in spec["jobs"])
    metadata = render.ExportMetadata.create(author_name, generated_at)
    root = render._slug(name, "pipeline")
    artifacts = {a["id"]: a for a in spec["artifacts"]}
    # Preserve existing Dataset IDs in the generated frames/manifest for traceability.
    data_id = {a: a.removeprefix("dataset:") if a.startswith("dataset:") else a for a in artifacts}
    source = spec["source_map"]
    first = artifacts[spec["inputs"][0]]
    input_schema = {"sheet": "Input", "columns": first["schema"]["columns"]}
    linear = not force_graph and _is_linear(spec)
    files, steps, executable = [], [], []
    counters = {"process": 0, "llm": 0}
    portable = deepcopy(spec)
    portable.pop("source_map")

    def dataset_step(aid):
        a = artifacts[aid]
        return {"type": "dataset", "id": data_id[aid], "name": a["name"],
                "columns": a["schema"]["columns"], "schema_status": a["schema"]["status"]}

    route_steps = [dataset_step(first["id"])]
    for job, portable_job in zip(spec["jobs"], portable["jobs"]):
        jid, kind, cfg = job["id"], job["type"], job["config"]
        counters[kind] += 1
        number = counters[kind]
        title = source[jid]["names"][0]
        outputs = [{"id": data_id[aid], "name": artifacts[aid]["name"], "branch": port}
                   for port, group in job["outputs"].items() for aid in group]
        if kind == "process":
            title, mode, generated = render._processor_module({"name": title, "dfCode": cfg["code"]}, metadata)
            module = f"processor_{number:02d}_{render._identifier(title, 'process')}"
            step = {"type": "process", "id": source[jid]["node_ids"][0], "name": title,
                    "mode": mode, "source": f"processor/{module}.py",
                    "inputs": [data_id[a] for a in job["inputs"].values()], "outputs": outputs}
            output_name = next(iter(job["outputs"]))
            if linear:
                step["output_name"] = output_name
            files.append(render.ExportedFile(step["source"], generated["module"]))
            executable.append({"type": "process", "name": title, "package": "processor",
                "module": module, "module_name": module, "alias": f"processor_step_{number:02d}",
                "output_name": output_name, "inputs": step["inputs"],
                "primary_input": data_id[job["inputs"]["df"]],
                "input_aliases": {data_id[aid]: alias for alias, aid in job["inputs"].items()}, "outputs": outputs})
        else:
            if cfg["unresolved_settings"] or jid not in models:
                raise render.PipelineExportError(f'Prompt "{title}" needs resolved model configuration and Run settings.')
            # A whitelist protects the archive even if an internal caller hands us credentials.
            model = {key: models[jid].get(key) for key in ("engine", "provider", "model", "base_url", "max_tokens", "max_retries")}
            title, prompt_config, module_source = render._prompt_module(title, cfg, model, metadata)
            module = f"prompt_{number:02d}_{render._identifier(title, 'prompt')}"
            step = {"type": "prompt", "id": source[jid]["node_ids"][0], "run_id": source[jid]["node_ids"][1],
                    "name": title, "source": f"prompt/{module}.py", "input": data_id[job["inputs"]["data"]],
                    "output": outputs[0]["id"], "settings": cfg["settings"], **prompt_config}
            files.append(render.ExportedFile(step["source"], module_source))
            executable.append({"type": "prompt", "name": title, "package": "prompt",
                "module": module, "module_name": module, "alias": f"prompt_step_{number:02d}",
                "inputs": [step["input"]], "outputs": outputs})
            portable_job["config"].pop("model_binding")
            portable_job["config"]["model"] = model
        steps.append(step)
        route_steps.append(step)
        route_steps.extend(dataset_step(aid) for group in job["outputs"].values() for aid in group)

    outputs = [{"id": data_id[aid], "name": artifacts[aid]["name"]} for aid in spec["outputs"]]
    first_model = next((j["config"]["model"] for j in portable["jobs"] if j["type"] == "llm"), None)
    engine = first_model["engine"] if first_model else None
    columns = [c["name"] for c in input_schema["columns"]]
    manifest = {"format": render.FORMAT_NAME, "format_version": render.FORMAT_VERSION,
        "name": root, "entrypoint": "main.py", "generated_at": metadata.generated_at,
        "authors": {"workflow": metadata.workflow_author, "exported_project": "AnnoBio"},
        "input": {"format": "xlsx", **input_schema}, "engines": ["litellm", "openrouter"] if uses_llm else [],
        "default_engine": engine, "output": {"format": "xlsx"}, "execution": portable}
    if linear:
        manifest["route"] = route_steps
        main = render._main_module(executable, columns, 4, metadata)
    else:
        manifest["graph"] = {"steps": steps, "terminal_datasets": outputs}
        manifest["output"]["worksheets"] = outputs
        main = _dag_main(executable, data_id[first["id"]], columns, outputs, 4, metadata)
    if not uses_llm:
        main = render._without_llm(main)
    files.extend([
        render.ExportedFile("pipeline.json", json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"),
        render.ExportedFile("main.py", main),
        render.ExportedFile("DATA.md", render._data_markdown(first["name"], input_schema)),
        render.ExportedFile("requirements.txt", render._requirements(uses_llm)),
        render.ExportedFile("processor/__init__.py", render._package_init("User-authored Process modules.", metadata)),
    ])
    if uses_llm:
        files.extend([
            render.ExportedFile("README.md", render._readme(root, engine, metadata)),
            render.ExportedFile(".env.example", render._env_example(engine, first_model["model"], first_model["base_url"])),
            render.ExportedFile("prompt/__init__.py", render._package_init("User-authored Prompt modules.", metadata)),
            render.ExportedFile("engine/__init__.py", render._engine_init_module(engine, metadata)),
            render.ExportedFile("engine/base.py", render._engine_base_module(metadata)),
            render.ExportedFile("engine/litellm_engine.py", render._litellm_engine_module(metadata)),
            render.ExportedFile("engine/openrouter_engine.py", render._openrouter_engine_module(metadata)),
        ])
    else:
        files.append(render.ExportedFile("README.md", render._process_only_readme(root, metadata)))
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as bundle:
        for file in sorted(files, key=lambda f: f.path):
            info = zipfile.ZipInfo(PurePosixPath(root, file.path).as_posix(), date_time=(2020, 1, 1, 0, 0, 0))
            info.compress_type, info.external_attr = zipfile.ZIP_DEFLATED, 0o644 << 16
            bundle.writestr(info, file.content.encode("utf-8"))
    return f"{root}.zip", archive.getvalue()
