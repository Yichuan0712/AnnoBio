"""Bounded table imports from Biomni's exact, pinned public data-lake manifest.

Downloads are explicit and shared across projects. Readers only use complete local files.
Pickle files are read with a constructor allowlist, never pickle.load.
"""
from __future__ import annotations

import csv
import io
import pickle
import threading


from database_importers import _cell
from database_availability import require_data_lake

from biomni_downloads import (
    BASE, FILES, MANIFEST, RangeFile, _DOWNLOAD_LOCK, dataset_lock,
    dataset_status, download_dataset, require_local_dataset,
)

PROVENANCE = {"__source_dataset": "Source Dataset", "__source_url": "Source URL"}
_PICKLE_READ_LOCK = threading.Lock()
_SCHEMAS = {}
csv.field_size_limit(16 * 1024 * 1024)


def _group(name):
    rules = [
        ("BindingDB", "bindingdb", "BindingDB"), ("broad_repurposing", "repurposing", "Drug Repurposing Hub"),
        ("czi_", "cellxgene", "CELLxGENE Census"), ("DepMap_", "depmap", "DepMap"),
        ("ddinter_", "ddinter", "DDInter"), ("DisGeNET", "disgenet", "DisGeNET"),
        ("enamine_", "enamine", "Enamine REAL"), ("evebio_", "evebio", "EveBio"),
        ("genebass_", "genebass", "GeneBass"), ("gene_info", "ncbi_gene", "NCBI Gene annotations"),
        ("go-plus", "go", "Gene Ontology"), ("gtex_", "gtex", "GTEx"),
        ("gwas_catalog", "gwas", "GWAS Catalog snapshot"), ("hp.obo", "hpo", "Human Phenotype Ontology"),
        ("kg.csv", "primekg", "PrimeKG"), ("marker_celltype", "cell_markers", "Cell type markers"),
        ("McPAS", "mcpas", "McPAS-TCR"), ("miRDB", "mirdb", "miRDB"),
        ("miRTarBase", "mirtarbase", "miRTarBase"), ("mousemine_", "mousemine", "MouseMine"),
        ("msigdb_", "msigdb", "MSigDB"), ("omim", "omim", "OMIM"),
        ("proteinatlas", "protein_atlas", "Human Protein Atlas"), ("sgRNA_", "sgrna", "Human / mouse sgRNA library"),
        ("variant_table", "variants", "Annotated variants"), ("Virus-Host", "phipster", "P-HIPSTER"),
        ("txgnn_", "txgnn", "TxGNN"),
    ]
    for prefix, key, label in rules:
        if name.startswith(prefix):
            return "lake_" + key, label
    return "lake_interactions", "Molecular interaction datasets"


GROUPS = {}
for _filename, _info in FILES.items():
    _source, _label = _group(_filename)
    GROUPS.setdefault(_source, {"label": _label, "files": []})["files"].append(_filename)


def resolve_dataset(source, options):
    if source not in GROUPS:
        raise ValueError("Unknown data-lake source.")
    filename = options.get("dataset") or GROUPS[source]["files"][0]
    if filename not in GROUPS[source]["files"]:
        raise ValueError("Choose one of the listed dataset files for this source.")
    return filename






class RestrictedDatasetUnpickler(pickle.Unpickler):
    """Allow only the primitive/numpy/pandas constructors used by the pinned dataset files."""
    ALLOWED = {
        ("builtins", "slice"), ("builtins", "set"), ("builtins", "frozenset"), ("builtins", "complex"),
        ("collections", "OrderedDict"),
        ("numpy", "ndarray"), ("numpy", "dtype"),
        ("numpy.core.multiarray", "_reconstruct"), ("numpy.core.multiarray", "scalar"),
        ("numpy._core.multiarray", "_reconstruct"), ("numpy._core.multiarray", "scalar"),
        ("numpy.core.numeric", "_frombuffer"), ("numpy._core.numeric", "_frombuffer"),
        ("pandas.core.frame", "DataFrame"), ("pandas.core.series", "Series"),
        ("pandas", "DataFrame"), ("pandas", "Series"), ("pandas", "Index"),
        ("pandas.core.internals.managers", "BlockManager"), ("pandas._libs.internals", "_unpickle_block"),
        ("pandas.core.indexes.base", "_new_Index"), ("pandas.core.indexes.base", "Index"),
        ("pandas.core.indexes.range", "RangeIndex"), ("pandas.core.indexes.numeric", "Int64Index"),
        ("pandas.core.indexes.multi", "MultiIndex"), ("pandas.core.arrays.categorical", "Categorical"),
        ("pandas.core.dtypes.dtypes", "CategoricalDtype"), ("pandas._libs.arrays", "__pyx_unpickle_NDArrayBacked"),
    }

    def find_class(self, module, name):
        if (module, name) not in self.ALLOWED:
            raise pickle.UnpicklingError(f"Unsupported dataset constructor: {module}.{name}")
        if (module, name) == ("pandas.core.indexes.numeric", "Int64Index"):
            from pandas import Index
            return Index
        return super().find_class(module, name)


def _pickle_path(client, filename, heartbeat):
    return download_dataset(client, filename, heartbeat)


def _object_rows(data):
    import numpy as np
    import pandas as pd
    if isinstance(data, pd.DataFrame):
        # Preserve named/nontrivial row identifiers such as genes and cell lines.
        frame = data if isinstance(data.index, pd.RangeIndex) else data.reset_index()
        for row in frame.itertuples(index=False, name=None):
            yield dict(zip(map(str, frame.columns), row))
    elif isinstance(data, pd.Series):
        for key, value in data.items(): yield {"id": key, "value": value}
    elif isinstance(data, dict):
        for key, value in data.items():
            if isinstance(value, dict):
                for nested_key, nested_value in value.items():
                    yield {"group": key, "id": nested_key, "value": nested_value}
            else: yield {"id": key, "value": value}
    elif isinstance(data, (list, tuple, np.ndarray)):
        for number, value in enumerate(data):
            yield value if isinstance(value, dict) else {"row": number, "value": value}
    else:
        raise ValueError("Unsupported dataset object layout.")


def iter_dataset_rows(client, filename, heartbeat=None):
    require_data_lake()
    with dataset_lock(filename, heartbeat):
        path = require_local_dataset(filename)
        if path.suffix == '.parquet':
            import pyarrow.parquet as pq
            with pq.ParquetFile(path) as table:
                for batch in table.iter_batches(batch_size=256):
                    if heartbeat: heartbeat()
                    yield from batch.to_pylist()
        elif filename.endswith('.pkl'):
            while not _PICKLE_READ_LOCK.acquire(timeout=1):
                if heartbeat: heartbeat()
            try:
                with path.open('rb') as stream:
                    data = RestrictedDatasetUnpickler(stream).load()
                if heartbeat: heartbeat()
                yield from _object_rows(data)
            finally:
                _PICKLE_READ_LOCK.release()
        else:
            with path.open('rb') as stream:
                yield from _text_rows(filename, stream)


def _text_rows(filename, stream):
    if filename.endswith(".json"):
        import ijson
        yield from ijson.items(stream, "graphs.item.nodes.item", use_float=True)
        return
    with io.TextIOWrapper(io.BufferedReader(stream), encoding="utf-8-sig", errors="replace", newline="") as text:
        if filename.endswith(".obo"):
            record = None
            for line in text:
                line = line.strip()
                if line.startswith("["):
                    if record: yield record
                    record = {} if line == "[Term]" else None
                elif record is not None and ": " in line:
                    key, value = line.split(": ", 1)
                    if key in record:
                        record[key] = _cell(record[key]) + "; " + value
                    else: record[key] = value
            if record: yield record
            return
        if filename == "miRTarBase_microRNA_target_interaction_pubmed_abtract.txt":
            for number, line in enumerate(text, 1):
                if line.strip(): yield {"line": number, "text": line.rstrip("\r\n")}
            return
        delimiter = "," if filename.endswith(".csv") else "\t"
        reader = csv.reader(text, delimiter=delimiter)
        header = next(reader, [])
        if not header:
            return
        # Most curated parquet tables have stable IDs; text tables may have duplicate/empty headers.
        seen = {}
        columns = []
        for position, name in enumerate(header):
            name = name.strip() or f"Column {position + 1}"
            seen[name] = seen.get(name, 0) + 1
            columns.append(name if seen[name] == 1 else f"{name} ({seen[name]})")
        for values in reader:
            if values:
                yield {name: values[i] if i < len(values) else "" for i, name in enumerate(columns)}


def describe_snapshot_fields(source, options, client, heartbeat=None):
    require_data_lake()
    filename = resolve_dataset(source, options)
    status = dataset_status(filename)
    require_local_dataset(filename)
    cache_key = (filename, status['fingerprint'])
    if cache_key in _SCHEMAS:
        return _SCHEMAS[cache_key]
    # Discard columns learned from an older/deleted copy of the same file.
    for key in list(_SCHEMAS):
        if key[0] == filename: _SCHEMAS.pop(key, None)
    rows = iter_dataset_rows(client, filename, heartbeat)
    discovered = {}
    try:
        first = next(rows, None)
        if first is not None:
            discovered.update({str(key): str(key) for key in first})
        # OBO stanzas have optional tags absent from the first term (is_a, synonym, xref, etc.).
        if filename.endswith('.obo'):
            for number, record in enumerate(rows):
                discovered.update({str(key): str(key) for key in record})
                if heartbeat and number % 1000 == 0: heartbeat()
    finally:
        rows.close()
    if first is None:
        raise ValueError("This dataset is empty.")
    fields = dict(discovered)
    if set(fields) & set(PROVENANCE):
        raise ValueError("Dataset columns collide with reserved provenance fields.")
    fields.update(PROVENANCE)
    result = {"fields": fields, "default_fields": [*list(discovered)[:10], *PROVENANCE], "dataset": filename,
            "bytes": FILES[filename]["bytes"], "filter_columns": list(discovered), "fingerprint": status["fingerprint"]}
    _SCHEMAS[cache_key] = result
    return result


SNAPSHOT_ROW_LIMIT = 5000


def fetch_snapshot_records(source, ids, fields, options, client, on_batch=None, on_metadata=None):
    filename = resolve_dataset(source, options)
    from record_filters import compile_filters
    schema = describe_snapshot_fields(source, options, client) if options.get('filters') else {'fields': fields}
    matches_filters = compile_filters(options.get('filters'), schema['fields'])
    limit = int(options.get("limit", SNAPSHOT_ROW_LIMIT))
    if not 1 <= limit <= SNAPSHOT_ROW_LIMIT:
        raise ValueError(f"Choose a row limit from 1 to {SNAPSHOT_ROW_LIMIT:,}.")
    column = str(options.get("filter_column") or "")
    wanted = {str(value).strip() for value in ids if str(value).strip()}
    if wanted and not column:
        raise ValueError("Choose a filter column when entering filter values.")
    result, matched, scanned = [], set(), 0
    truncated = False
    def heartbeat():
        if on_batch: on_batch([], [], len(matched) if wanted else len(result), len(wanted) or limit)
    rows = iter_dataset_rows(client, filename, heartbeat)
    try:
        for record in rows:
            scanned += 1
            if column and column not in record:
                raise ValueError("The selected filter column does not exist in this dataset.")
            value = _cell(record.get(column)) if column else ""
            enriched = {**record, "__source_dataset": filename, "__source_url": BASE + filename}
            if (wanted and value not in wanted) or not matches_filters(enriched):
                if scanned % 1000 == 0: heartbeat()
                continue
            # Read one extra matching row to distinguish exactly-at-limit from truncation.
            if len(result) >= limit:
                truncated = True
                break
            if wanted: matched.add(value)
            row = {field: _cell(enriched.get(field)) for field in fields}
            result.append(row)
            if on_batch: on_batch([row], [], len(matched) if wanted else len(result), len(wanted) or limit)
        else:
            if on_batch and wanted:
                on_batch([], sorted(wanted - matched), len(wanted), len(wanted))
    finally:
        rows.close()
    if on_batch and not wanted:
        on_batch([], [], len(result), len(result))
    if on_metadata:
        on_metadata({'truncated': truncated, 'row_limit': limit})
    return result


def build_data_lake_importers():
    return {source: {"label": group["label"], "id": "Optional values in a selected dataset column", "fields": {},
        "default_fields": [], "kind": "snapshot", "searchable": False, "datasets": [
            {"name": name, **FILES[name]} for name in group["files"]], "category": "Data snapshots",
        "example": "", "option_fields": []} for source, group in GROUPS.items()}
