"""Pure canvas-to-PipelineSpec v1 compiler (no IO, model calls, or user-code execution).

The route is the flat exportRoutePayload from pipelineRouteSelection.js. It selects
membership, not execution order. Diagnostics are returned together; an invalid graph
never exposes a partially executable spec. See docs/design/PIPELINE_SPEC_V1.md.

Steps read each other through `data` connections (docs/design/DATA_FLOW_DESIGN.md §6.2):
a Dataset is only ever an input, `dataset:<id>`; a step's output is `output:<job>:<port>`.
"""
from __future__ import annotations

import ast
from copy import deepcopy
import json
import re
from typing import Any

if __package__:
    from .process_outputs import detect_process_outputs
else:
    from process_outputs import detect_process_outputs


RUN_SETTINGS = {"run_max_tokens": (256, 131072), "run_max_retries": (0, 5), "run_concurrency": (1, 10)}
CELL_TYPES = {"text", "image", "pdf"}
OUTPUT_TYPES = {"str", "float", "list_str", "list_float"}
PLACEHOLDER = re.compile(r"(?<!\{)\{([^{}]+)\}(?!\})")


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def compile_pipeline(*, canvas_state: dict, route: list, input_dataset_ids: list[str] | None = None,
                     run_defaults: dict | None = None, mapping_policy: str = "strict") -> dict:
    """Return {spec, diagnostics}; explicit input IDs cut saved provenance at a boundary.

    run_defaults contains only numeric Run defaults, not credentials. A symbolic
    model_binding identifies the Generate to resolve when a runner/exporter freezes model
    configuration. Missing defaults are explicit runtime requirements, never guesses.
    """
    return _Compiler(canvas_state, route, input_dataset_ids, run_defaults, mapping_policy).compile()


def normalize_process_code(df_code, legacy_code) -> str:
    """Migrate legacy row code without executing it (same adapter as the canvas)."""
    if _text(df_code):
        return df_code
    source = _text(legacy_code)
    pattern = r"^(\s*)def\s+process(\s*\(\s*row\b[^)]*\))"
    if not re.search(pattern, source, re.MULTILINE):
        return source
    renamed = re.sub(pattern, r"\1def _annobio_legacy_row_process\2", source, count=1, flags=re.MULTILINE)
    return ('# Migrated from legacy process(row).\nimport pandas as pd\n\n' + renamed + '\n\n'
            'def process(df):\n'
            '    output = []\n'
            '    records = df.where(pd.notna(df), None).to_dict(orient="records")\n'
            '    for row in records:\n'
            '        try:\n'
            '            result = _annobio_legacy_row_process(dict(row))\n'
            '            if result is None:\n'
            '                continue\n'
            '            output.append(dict(result) if isinstance(result, dict) else {"result": result})\n'
            '        except Exception as exc:\n'
            '            output.append({"error": str(exc)})\n'
            '    return pd.DataFrame(output)\n')


def normalize_output_fields(fields: list[dict]) -> list[dict]:
    """Portable structured keys plus original display names, shared by all consumers."""
    normalized, used = [], set()
    for field in fields:
        display = field["key"]
        base = re.sub(r"\W", "_", display, flags=re.UNICODE).strip("_") or "field"
        if base[0].isdigit():
            base = f"field_{base}"
        key, suffix = base, 1
        while key in used:
            key, suffix = f"{base}_{suffix}", suffix + 1
        used.add(key)
        normalized.append({**field, "key": key, "display": display})
    return normalized


class _Compiler:
    def __init__(self, state, route, boundaries, defaults, mapping_policy):
        self.state, self.route = state, route
        self.boundaries = boundaries if boundaries is not None else []
        self.defaults = defaults if defaults is not None else {}
        self.mapping_policy = mapping_policy
        self.diagnostics: list[dict] = []
        self.nodes: dict[str, dict] = {}
        self.selected: dict[str, dict] = {}
        self.edges: list[dict] = []
        self.pairs: dict[str, str] = {}
        self.jobs: dict[str, dict] = {}
        self.artifacts: dict[str, dict] = {}
        self.source_map: dict[str, dict] = {}
        # Producer job ID -> port -> consumer node IDs: the step outputs selected jobs read.
        self.uses: dict[str, dict[str, list[str]]] = {}

    def report(self, code, node_id, field, message, severity="error"):
        node = self.nodes.get(node_id, {})
        name = node.get("name") or node.get("runName") or node_id
        if node.get("type") == "run":
            prompt_ids = {_text(edge.get("fromId")) for edge in self.edges
                          if edge.get("type") == "prompt-to-run" and edge.get("toId") == node_id}
            if len(prompt_ids) == 1:
                prompt_name = self.nodes.get(next(iter(prompt_ids)), {}).get("name")
                if prompt_name:
                    name = f"{name} · {prompt_name}"
        self.diagnostics.append({"severity": severity, "code": code, "node_id": node_id,
                                 "node_name": name,
                                 "field": field, "message": message})

    def obj(self, value, node_id, field):
        if value is None or value == "":
            return {}
        try:
            parsed = json.loads(value) if isinstance(value, str) else value
        except (ValueError, TypeError):
            parsed = None
        if not isinstance(parsed, dict):
            self.report("INVALID_OBJECT", node_id, field, f"{field} must be an object or JSON object.")
            return {}
        return parsed

    def source(self, key, *ids):
        self.source_map[key] = {"node_ids": list(ids), "names": [
            self.nodes[i].get("name") or self.nodes[i].get("runName") or i for i in ids]}

    def compile(self):
        if self.mapping_policy not in ("strict", "legacy_export"):
            self.report("INVALID_MAPPING_POLICY", "", "mapping_policy", "Unknown input mapping policy.")
        if not isinstance(self.state, dict) or not isinstance(self.state.get("nodes"), list):
            self.report("INVALID_CANVAS", "", "nodes", "Canvas nodes must be a list.")
            return self.finish()
        for node in self.state["nodes"]:
            if not isinstance(node, dict) or not _text(node.get("nodeId")):
                self.report("INVALID_NODE", "", "nodeId", "Every node must have a string nodeId.")
                continue
            nid = node["nodeId"]
            if nid in self.nodes:
                self.report("DUPLICATE_NODE", nid, "nodeId", "Duplicate canvas node ID.")
            self.nodes[nid] = node
        edges = self.state.get("connections", [])
        if not isinstance(edges, list):
            self.report("INVALID_CONNECTIONS", "", "connections", "Connections must be a list.")
        else:
            self.edges = [e for e in edges if isinstance(e, dict)]
        if not isinstance(self.route, list) or not self.route:
            self.report("EMPTY_SELECTION", "", "route", "Select an executable route.")
            return self.finish()
        for item in self.route:
            if not isinstance(item, dict) or item.get("type") not in ("dataset", "process", "prompt"):
                self.report("INVALID_SELECTION", "", "route", "Expected dataset, process or prompt selection.")
                continue
            kind = item["type"]
            keys = [(kind, f"{kind}_node_id")]
            if kind == "prompt":
                keys.append(("run", "run_node_id"))
            valid = True
            for expected, key in keys:
                nid = _text(item.get(key))
                node = self.nodes.get(nid)
                if not node or node.get("type") != expected:
                    self.report("MISSING_NODE", nid, key, f"Selected {expected} node is missing or has the wrong type.")
                    valid = False
                else:
                    self.selected[nid] = node
            if valid and kind == "prompt":
                rid, pid = item["run_node_id"], item["prompt_node_id"]
                if rid in self.pairs and self.pairs[rid] != pid:
                    self.report("AMBIGUOUS_PROMPT", rid, "prompt_node_id", "A Generate cannot select multiple Prompts.")
                self.pairs[rid] = pid
        if not isinstance(self.boundaries, list) or any(not isinstance(x, str) for x in self.boundaries):
            self.report("INVALID_INPUTS", "", "input_dataset_ids", "Input boundaries must be a list of Dataset IDs.")
            self.boundaries = []
        for nid in self.boundaries:
            if self.selected.get(nid, {}).get("type") != "dataset":
                self.report("INVALID_INPUT", nid, "input_dataset_ids", "An input boundary must be a selected Dataset.")
        if not isinstance(self.defaults, dict):
            self.report("INVALID_DEFAULTS", "", "run_defaults", "Generate defaults must be an object.")
            self.defaults = {}

        for nid, node in sorted(self.selected.items()):
            if node["type"] == "dataset":
                self.add_dataset(nid, node)
        for nid, node in sorted(self.selected.items()):
            if node["type"] == "process":
                self.add_process(nid, node)
        for rid, pid in sorted(self.pairs.items()):
            self.add_llm(rid, pid)
        self.link_outputs()
        order = self.order_jobs()
        for jid in order:
            job = self.jobs[jid]
            if job["type"] == "llm":
                self.validate_llm_inputs(job)
        self.check_connected()
        return self.finish(order)

    def schema(self, nid, node):
        content = self.obj(node.get("datasetContent"), nid, "datasetContent")
        headers, types = content.get("headers", []), content.get("columnTypes", [])
        if not isinstance(headers, list) or any(not isinstance(h, str) or not h.strip() for h in headers):
            self.report("INVALID_COLUMNS", nid, "datasetContent.headers", "Columns must be non-empty strings.")
            headers = []
        if len(headers) != len(set(headers)):
            duplicates = sorted({h for h in headers if headers.count(h) > 1})
            self.report("DUPLICATE_COLUMNS", nid, "datasetContent.headers", "Dataset contains duplicate columns: " + ", ".join(duplicates))
        if not isinstance(types, list):
            self.report("INVALID_COLUMN_TYPES", nid, "datasetContent.columnTypes", "Column types must be a list.")
            types = []
        columns = []
        for index, name in enumerate(headers):
            typ = types[index] if index < len(types) else "text"
            if not isinstance(typ, str) or typ not in CELL_TYPES:
                self.report("INVALID_COLUMN_TYPE", nid, "datasetContent.columnTypes", f"Unsupported type for column {name}.")
                typ = "text"
            columns.append({"name": name, "type": typ})
        return {"status": "known", "columns": columns}

    def add_dataset(self, nid, node):
        aid = f"dataset:{nid}"
        self.artifacts[aid] = {"id": aid, "name": node.get("name") or nid, "producer": None, "schema": self.schema(nid, node)}
        self.source(aid, nid)

    def inputs_to(self, nid, edge_type):
        return sorted({_text(e.get("fromId")) for e in self.edges
                       if e.get("type") == edge_type and e.get("toId") == nid})

    def require_dataset(self, nid, owner, field):
        aid = f"dataset:{nid}"
        if aid not in self.artifacts:
            self.report("MISSING_DEPENDENCY", owner, field, f"Required Dataset {nid or '(none)'} is not selected.")
        return aid

    # Where a Generate or Process reads its data (docs/design/DATA_FLOW_DESIGN.md §3.3): the `data`
    # connections into it. Only these methods know how the canvas stores it. A source is
    # (node ID, port): a Dataset, a Generate's results, or one output branch of a Process.
    def data_inputs(self, nid):
        """[((source node id, port), alias as recorded)] for the `data` connections into a node, sorted."""
        found = {((_text(e.get("fromId")), _text(e.get("fromPort")) or "result"), _text(e.get("alias")))
                 for e in self.edges if e.get("type") == "data" and _text(e.get("toId")) == nid}
        return sorted(found)

    def run_input(self, rid):
        """The source a Generate reads, or ('', 'result') when it has none."""
        sources = self.data_inputs(rid)
        if len(sources) > 1:
            self.report("MULTIPLE_RUN_INPUTS", rid, "inputs", "A Generate reads exactly one input.")
        return sources[0][0] if sources else ("", "result")

    def process_inputs(self, nid, node):
        """(primary, [(source, alias as recorded)]) for a Process, sources in a stable order.
        The primary is the input recorded as df, or the only input."""
        sources = self.data_inputs(nid)
        primaries = [source for source, alias in sources if alias == "df"]
        if not primaries and len(sources) == 1:
            primaries = [sources[0][0]]
        primary = primaries[0] if len(primaries) == 1 else ""
        if not primary:
            self.report("INVALID_PRIMARY_INPUT", nid, "inputs", "Process needs exactly one df input.")
        return primary, [(source, "df" if source == primary else alias) for source, alias in sources]

    def input_artifact(self, consumer, source):
        """The artifact a step reads from `source`: a selected input Dataset, or another step's output."""
        nid, port = source
        kind = self.nodes.get(nid, {}).get("type")
        if kind not in ("run", "process"):
            return self.require_dataset(nid, consumer, "inputs")
        jid = f"{'llm' if kind == 'run' else 'process'}:{nid}"
        self.uses.setdefault(jid, {}).setdefault(port, []).append(consumer)
        return f"output:{jid}:{port}"

    def add_process(self, nid, node):
        jid = f"process:{nid}"
        primary, sources = self.process_inputs(nid, node)
        inputs = {}
        for source, alias in sources:
            aid = self.input_artifact(nid, source)
            if not alias or not alias.isidentifier() or (source != primary and not alias.startswith("df_")):
                self.report("INVALID_ALIAS", nid, "inputs", f"Input {source[0]} needs a valid df_<name> alias.")
                continue
            if alias in inputs:
                self.report("DUPLICATE_ALIAS", nid, "inputs", f"Multiple inputs use alias {alias}.")
            inputs[alias] = aid
        code = normalize_process_code(node.get("dfCode"), node.get("code"))
        tree = None
        if isinstance(code, str):
            try:
                tree = ast.parse(code)
            except (SyntaxError, ValueError) as exc:
                self.report("INVALID_PROCESS_CODE", nid, "dfCode", f"Invalid Python: {exc}")
        functions = [n for n in (tree.body if tree else []) if isinstance(n, ast.FunctionDef) and n.name == "process"]
        function = functions[0] if len(functions) == 1 else None
        args = (function.args.posonlyargs + function.args.args) if function else []
        # df comes first; every other Input dataset is passed by keyword as the parameter named after its alias.
        valid_signature = bool(function and args and args[0].arg == "df" and len(function.args.posonlyargs) <= 1)
        if not valid_signature:
            self.report("INVALID_PROCESS_FUNCTION", nid, "dfCode", "Define one top-level process(df, ...) callable: df first, then one parameter per other Input dataset; reopen legacy row code to migrate it.")
        else:
            required = args[1:len(args) - len(function.args.defaults)] + [
                arg for arg, default in zip(function.args.kwonlyargs, function.args.kw_defaults) if default is None]
            for arg in required:
                if arg.arg not in inputs:
                    self.report("UNBOUND_DATASET_ALIAS", nid, "inputs", f"Process parameter {arg.arg} matches no Input dataset.")
        # Detect referenced aliases without executing arbitrary code. Canvas normally builds
        # these edges already; a stale selection must not silently omit one.
        if tree:
            bound = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Store)}
            bound.update(n.arg for n in ast.walk(tree) if isinstance(n, ast.arg))
            bound.update(n.asname or n.name.split('.')[0] for n in ast.walk(tree) if isinstance(n, ast.alias))
            for alias in sorted({n.id for n in ast.walk(tree) if isinstance(n, ast.Name)
                                 and isinstance(n.ctx, ast.Load) and n.id.startswith("df_")} - bound - set(inputs)):
                self.report("UNBOUND_DATASET_ALIAS", nid, "inputs", f"Referenced Dataset alias {alias} has no selected input binding.")
        self.jobs[jid] = {"id": jid, "type": "process", "inputs": inputs, "outputs": {}, "depends_on": [],
                          "config": {"code": code if isinstance(code, str) else "", "entrypoint": "process",
                                     "output_contract": "dataframe_or_named_dataframes"}}
        self.source(jid, nid)

    def add_llm(self, rid, pid):
        run, prompt = self.selected[rid], self.selected[pid]
        jid = f"llm:{rid}"
        if self.inputs_to(rid, "prompt-to-run") != [pid]:
            self.report("PROMPT_RUN_MISMATCH", rid, "prompt_node_id", "Generate must have exactly the selected Prompt as its upstream Prompt.")
        aid = self.input_artifact(rid, self.run_input(rid))
        text = prompt.get("text", "")
        if not isinstance(text, str):
            self.report("INVALID_PROMPT_TEXT", pid, "text", "Prompt text must be a string.")
            text = ""
        text = text.strip()
        if not text:
            self.report("EMPTY_PROMPT", pid, "text", "Prompt must have text.")
        placeholders = list(dict.fromkeys(PLACEHOLDER.findall(text)))
        raw_format = prompt.get("outputFormat", {})
        if isinstance(raw_format, (str, list)):
            try:
                raw_format = {"fields": json.loads(raw_format) if isinstance(raw_format, str) else raw_format,
                              "returnShape": prompt.get("promptOutputReturnShape", "single")}
            except ValueError:
                raw_format = None
        output = self.obj(raw_format, pid, "outputFormat")
        shape = output.get("returnShape", output.get("return_shape", "single"))
        if shape not in ("single", "table"):
            self.report("INVALID_RETURN_SHAPE", pid, "outputFormat.returnShape", "Return shape must be single or table.")
        fields = output.get("fields", [])
        normalized, used = [], set()
        if not isinstance(fields, list):
            fields = []
        for field in fields:
            if not isinstance(field, dict) or not _text(field.get("key")):
                self.report("INVALID_OUTPUT_FIELD", pid, "outputFormat.fields", "Each output field needs a non-empty key.")
                continue
            key, typ = field["key"].strip(), field.get("type", "str")
            if key in used:
                self.report("DUPLICATE_OUTPUT_FIELD", pid, "outputFormat.fields", f"Duplicate output key {key}.")
            used.add(key)
            if not isinstance(typ, str) or typ not in OUTPUT_TYPES:
                self.report("INVALID_OUTPUT_TYPE", pid, "outputFormat.fields", f"Unsupported output type for {key}.")
            examples = field.get("examples", [])
            if not isinstance(examples, list):
                self.report("INVALID_EXAMPLES", pid, "outputFormat.fields", "Output examples must be a list.")
                examples = []
            normalized.append({"key": key, "type": typ, "description": str(field.get("description") or ""),
                               "examples": deepcopy(examples), "allow_none": field.get("allowNone") is True or field.get("allow_none") is True})
        if not normalized:
            self.report("EMPTY_OUTPUT_SCHEMA", pid, "outputFormat.fields", "Prompt requires at least one output field.")
        overrides = self.obj(run.get("runSettings"), rid, "runSettings")
        settings, unresolved = {}, []
        for key, (low, high) in RUN_SETTINGS.items():
            value = overrides.get(key, self.defaults.get(key))
            if value is None:
                unresolved.append(key)
            elif type(value) is not int or not low <= value <= high:
                self.report("INVALID_RUN_SETTING", rid, f"runSettings.{key}", f"{key} must be an integer in [{low}, {high}].")
            else:
                settings[key] = value
        if unresolved:
            self.report("UNRESOLVED_RUN_DEFAULTS", rid, "runSettings", "Supply Generate defaults before starting an execution.", "warning")
        mapping = self.obj(run.get("runInputToColumn"), rid, "runInputToColumn")
        self.jobs[jid] = {"id": jid, "type": "llm", "inputs": {"data": aid}, "outputs": {}, "depends_on": [],
                          # input_types is filled from the mapped columns in validate_llm_inputs.
                          "config": {"prompt": text, "input_types": {name: "text" for name in placeholders},
                                     "input_mapping": {name: mapping.get(name) for name in placeholders},
                                     "output_schema": {"return_shape": shape, "fields": normalize_output_fields(normalized)},
                                     "mapping_policy": self.mapping_policy,
                                     "model_binding": {"run_node_id": rid}, "settings": settings,
                                     "unresolved_settings": unresolved}}
        self.source(jid, pid, rid)

    def link_outputs(self):
        """The outputs of each job (docs/design/DATA_FLOW_DESIGN.md §6.2). A Generate has its results; a
        Process has the branches its code returns, found without running it (process_outputs.py),
        and every branch a selected step reads. A branch nobody reads is still an output of the
        pipeline. Each output is the artifact output:<job>:<port>."""
        for jid, ports in sorted(self.uses.items()):
            if jid in self.jobs:
                continue
            upstream = jid.split(":", 1)[1]
            name = self.nodes.get(upstream, {}).get("name") or self.nodes.get(upstream, {}).get("runName") or upstream
            for consumer in sorted({c for consumers in ports.values() for c in consumers}):
                self.report("UNSELECTED_UPSTREAM", consumer, "inputs",
                            f'Reads the output of "{name}", which is not in this Pipeline. Select it, or start from a saved Dataset.')
        for jid, job in self.jobs.items():
            used = self.uses.get(jid, {})
            if job["type"] == "llm":
                pid, rid = self.source_map[jid]["node_ids"]
                for port, consumers in sorted(used.items()):
                    if port != "result":
                        for consumer in sorted(set(consumers)):
                            self.report("UNKNOWN_OUTPUT_PORT", consumer, "inputs", f'A Generate has one output, "result"; "{port}" does not exist.')
                ports = ["result"]
                names = {"result": self.nodes[pid].get("name") or "Result"}
            else:
                ports = self.process_ports(jid, job, used)
                process_name = self.nodes[self.source_map[jid]["node_ids"][0]].get("name") or "Result"
                names = {port: process_name if ports == ["result"] else port for port in ports}
            for port in ports:
                aid = f"output:{jid}:{port}"
                job["outputs"][port] = [aid]
                self.artifacts[aid] = {"id": aid, "name": names[port], "producer": {"job_id": jid, "port": port},
                                       "schema": {"status": "runtime", "columns": []}}
                self.source_map[aid] = deepcopy(self.source_map[jid])

    def process_ports(self, jid, job, used):
        """The branches a Process job writes: those its code returns, plus those read downstream."""
        nid = self.source_map[jid]["node_ids"][0]
        detected = detect_process_outputs(job["config"]["code"]) if job["config"]["code"] else {"ok": False}
        known = detected.get("ports") if detected.get("ok") and not detected.get("dynamic") else None
        # A single output can still be a dict built elsewhere (`return out`): then its branches
        # are only known once it runs, as for dynamic outputs.
        if known == ["result"] and any(port != "result" for port in used):
            known = None
        if known is None:
            self.report("RUNTIME_PROCESS_CONTRACT", nid, "outputs",
                        "Its branches are only known when it runs; the branches read downstream are checked then.", "warning")
            return sorted(used) or ["result"]
        for port, consumers in sorted(used.items()):
            if port not in known:
                for consumer in sorted(set(consumers)):
                    self.report("UNKNOWN_OUTPUT_PORT", consumer, "inputs",
                                f'Process "{self.nodes[nid].get("name") or nid}" does not return branch "{port}".')
        self.report("RUNTIME_PROCESS_CONTRACT", nid, "outputs",
                    "Validate the returned branches and their columns after Process execution.", "warning")
        return list(known)

    def order_jobs(self):
        for job in self.jobs.values():
            job["depends_on"] = sorted({self.artifacts[aid]["producer"]["job_id"]
                for aid in job["inputs"].values() if aid in self.artifacts and self.artifacts[aid]["producer"]})
        ordered, remaining = [], set(self.jobs)
        while remaining:
            ready = sorted(jid for jid in remaining if set(self.jobs[jid]["depends_on"]) <= set(ordered))
            if not ready:
                for jid in sorted(remaining):
                    self.report("CYCLIC_DEPENDENCY", self.source_map[jid]["node_ids"][-1], "inputs", "Job is in or depends on a dependency cycle.")
                break
            ordered.extend(ready)
            remaining.difference_update(ready)
        if not self.jobs:
            self.report("NO_JOBS", "", "route", "Selection needs at least one executable job.")
        return ordered

    def validate_llm_inputs(self, job):
        rid = self.source_map[job["id"]]["node_ids"][-1]
        config = job["config"]
        artifact = self.artifacts.get(job["inputs"]["data"])
        if not artifact:
            return
        schema = artifact["schema"]
        columns = {c["name"]: c["type"] for c in schema["columns"]}
        runtime = schema["status"] == "runtime"
        for name, column in config["input_mapping"].items():
            if column is not None and not isinstance(column, str):
                self.report("INVALID_INPUT_MAPPING", rid, f"runInputToColumn.{name}", "A mapped column must be a string.")
                continue
            if not _text(column) and not runtime:
                # Match existing legacy export inference, but only against known columns.
                matches = [c for c in columns if c == name] or [c for c in columns if c.casefold() == name.casefold()]
                if len(matches) == 1:
                    column = config["input_mapping"][name] = matches[0]
            if not _text(column):
                if runtime and self.mapping_policy == "legacy_export":
                    # An exported project resolves it by column name when data arrives, or says to set it.
                    config["input_mapping"][name] = None
                    self.report("RUNTIME_INPUT_MAPPING", rid, f"runInputToColumn.{name}", f"Resolve {{{name}}} by unique column name when the data arrives.", "warning")
                else:
                    title = self.nodes[rid].get("runName") or "Generate"
                    self.report("UNMAPPED_INPUT", rid, f"runInputToColumn.{name}", f'Open "{title}" and map each input; missing {{{name}}}.')
            elif not runtime and column not in columns:
                self.report("MISSING_COLUMN", rid, f"runInputToColumn.{name}", f"Prompt maps inputs to missing columns: {column}.")
            elif not runtime:
                # A Prompt input has no type of its own: it takes its mapped column's, so an image or
                # PDF column's paths are sent as files. A column known only at run time stays text.
                config["input_types"][name] = columns[column]
        if runtime:
            self.report("RUNTIME_INPUT_SCHEMA", rid, "inputs", "Check input columns and types against the actual upstream artifact before making model calls.", "warning")
        # Same display columns as saved Generate results. A dynamic input propagates an
        # unknown contract; known output field names alone do not describe the whole table.
        result_schema = {"status": "runtime", "columns": []}
        # Structured keys and display names are fixed by normalization in the compiler.
        if not runtime:
            result_schema = {"status": "known", "columns": [
                {"name": "Input: #", "type": "text"}] + [
                {"name": f"Input: {c['name'].strip()}", "type": c["type"]} for c in schema["columns"]] + [
                {"name": "Output: #", "type": "text"}] + [
                {"name": f"Output: {f['display']}", "type": "text"} for f in config["output_schema"]["fields"]]}
            names = [c["name"] for c in result_schema["columns"]]
            if len(names) != len(set(names)):
                self.report("MATERIALIZED_COLUMN_COLLISION", rid, "outputs", "Generate's materialized columns collide after adding row indices/prefixes.")
        for aids in job["outputs"].values():
            for aid in aids:
                self.artifacts[aid]["schema"] = deepcopy(result_schema)

    def check_connected(self):
        # The route is one pipeline from the panel, not one table. A Dataset that no job reads
        # or writes is not a second pipeline, and it must not block export or become a required input.
        touched = set()
        for job in self.jobs.values():
            touched.update(job["inputs"].values())
            for group in job["outputs"].values():
                touched.update(group)
        for aid in [aid for aid in self.artifacts if aid not in touched]:
            self.artifacts.pop(aid, None)
            self.source_map.pop(aid, None)
        for aid, artifact in self.artifacts.items():
            if artifact["producer"] is None and not artifact["schema"]["columns"]:
                nid = self.source_map[aid]["node_ids"][0]
                self.report("EMPTY_INPUT_SCHEMA", nid, "datasetContent.headers", "An input Dataset must define at least one column.")

    def finish(self, order=None):
        diagnostics = sorted(self.diagnostics, key=lambda d: (d["node_id"], d["field"], d["code"], d["message"]))
        if any(d["severity"] == "error" for d in diagnostics):
            return {"spec": None, "diagnostics": diagnostics}
        consumed = {aid for job in self.jobs.values() for aid in job["inputs"].values()}
        return {"spec": {"format": "annobio.pipeline-spec", "format_version": 2,
                         "inputs": sorted(a for a, v in self.artifacts.items() if v["producer"] is None),
                         "jobs": [self.jobs[jid] for jid in order or []],
                         "artifacts": [self.artifacts[a] for a in sorted(self.artifacts)],
                         "outputs": sorted(a for a in self.artifacts if a not in consumed),
                         "source_map": dict(sorted(self.source_map.items()))}, "diagnostics": diagnostics}
