"""Bounded table imports from Biomni's exact, pinned public data-lake manifest.

Parquet uses HTTP byte ranges. Text tables/ontologies stream until the requested row limit.
Pickle files are cached on demand and read with a constructor allowlist, never pickle.load.
"""
from __future__ import annotations

import csv
from concurrent.futures import ThreadPoolExecutor
import io
import json
import os
from pathlib import Path
import pickle
import threading

import httpx

from database_importers import _cell
from database_availability import require_data_lake

MANIFEST = json.loads((Path(__file__).parent / "biomni_manifest.json").read_text(encoding="utf-8"))
FILES = MANIFEST["data_lake"]
BASE = "https://biomni-release.s3.amazonaws.com/data_lake/"
PROVENANCE = {"__source_dataset": "Source Dataset", "__source_url": "Source URL"}
_DOWNLOAD_LOCK = threading.Lock()
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


class RangeFile(io.RawIOBase):
    """Seekable read-only S3 object; never treats an ignored Range request as the requested bytes."""
    def __init__(self, client, filename):
        super().__init__()
        self.client, self.url, self.position = client, BASE + filename, 0
        self.size = FILES[filename]["bytes"]
        self.cache = {}

    def readable(self): return True
    def seekable(self): return True
    def tell(self): return self.position

    def seek(self, offset, whence=0):
        target = offset if whence == 0 else self.position + offset if whence == 1 else self.size + offset
        if target < 0:
            raise ValueError("Negative seek")
        self.position = target
        return target

    def read(self, size=-1):
        if self.position >= self.size:
            return b""
        size = self.size - self.position if size < 0 else min(size, self.size - self.position)
        if not size:
            return b""
        start, end = self.position, self.position + size - 1
        key = (start, end)
        if key not in self.cache:
            with self.client.stream('GET', self.url, headers={"Range": f"bytes={start}-{end}"}) as response:
                response.raise_for_status()
                content_range = response.headers.get('content-range', '')
                if response.status_code != 206 or content_range != f'bytes {start}-{end}/{self.size}':
                    raise ValueError("The dataset server did not honor the requested byte range.")
                etag = response.headers.get('etag', '').strip('"')
                if etag and etag != FILES[self.url.rsplit('/', 1)[-1]]['etag']:
                    raise ValueError('The upstream dataset changed. Update the pinned dataset manifest before importing.')
                chunks, received = [], 0
                for chunk in response.iter_bytes(1024 * 1024):
                    received += len(chunk)
                    if received > size:
                        raise ValueError('The dataset server exceeded the requested byte range.')
                    chunks.append(chunk)
                if received != size:
                    raise ValueError('The dataset server returned an incomplete byte range.')
                self.cache[key] = b''.join(chunks)
            # Keep footer metadata, not an unbounded cache of data row groups.
            if sum(len(v) for v in self.cache.values()) > 8 * 1024 * 1024:
                data = self.cache[key]
                self.cache = {key: data}
        data = self.cache[key]
        self.position += size
        return data


class IteratorReader(io.RawIOBase):
    def __init__(self, chunks):
        self.chunks, self.pending = iter(chunks), b""
    def readable(self): return True
    def readinto(self, buffer):
        data = self.read(len(buffer))
        buffer[:len(data)] = data
        return len(data)
    def read(self, size=-1):
        if size == 0:
            return b""
        if size < 0:
            data, self.pending = self.pending + b"".join(self.chunks), b""
            return data
        while len(self.pending) < size:
            try: self.pending += next(self.chunks)
            except StopIteration: break
        data, self.pending = self.pending[:size], self.pending[size:]
        return data


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
    # User-configured local files can avoid downloads. Filenames always come from the manifest.
    local_dir = os.environ.get("ANNOBIO_BIOMNI_DATA_DIR")
    if local_dir:
        local = Path(local_dir) / filename
        if local.is_file():
            return local
    cache = Path(os.environ.get("ANNOBIO_BIOMNI_CACHE_DIR") or (Path(__file__).parent / "data" / "biomni-cache"))
    cache.mkdir(parents=True, exist_ok=True)
    target = cache / filename
    while not _DOWNLOAD_LOCK.acquire(timeout=1):
        if heartbeat: heartbeat()
    try:
        if target.is_file() and target.stat().st_size == FILES[filename]["bytes"]:
            return target
        partial = cache / (filename + ".part")
        try:
            # Bounded ranges avoid proxies buffering a multi-gigabyte response before sending it.
            chunk_size = 8 * 1024 * 1024
            def download(offset):
                remote = RangeFile(client, filename)
                remote.seek(offset)
                return offset, remote.read(min(chunk_size, remote.size - offset))
            with partial.open('wb') as destination, ThreadPoolExecutor(max_workers=4) as pool:
                for batch_start in range(0, FILES[filename]['bytes'], chunk_size * 4):
                    if heartbeat: heartbeat()
                    offsets = range(batch_start, min(batch_start + chunk_size * 4, FILES[filename]['bytes']), chunk_size)
                    for offset, chunk in pool.map(download, offsets):
                        destination.seek(offset)
                        destination.write(chunk)
                        if heartbeat: heartbeat()
            if partial.stat().st_size != FILES[filename]["bytes"]:
                raise ValueError("Incomplete dataset download; retry to download it again.")
            partial.replace(target)
        except BaseException:
            partial.unlink(missing_ok=True)
            raise
        return target
    finally:
        _DOWNLOAD_LOCK.release()


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
    if filename not in FILES:
        raise ValueError('Choose a file from the pinned dataset manifest.')
    local_dir = os.environ.get("ANNOBIO_BIOMNI_DATA_DIR")
    local = Path(local_dir) / filename if local_dir else None
    prepared = None
    if filename.endswith('.pkl'):
        cache = Path(os.environ.get('ANNOBIO_BIOMNI_CACHE_DIR') or (Path(__file__).parent / 'data' / 'biomni-cache'))
        candidates = ([local.with_name(filename + '.parquet')] if local else []) + [cache / 'prepared' / (filename + '.parquet')]
        prepared = next((candidate for candidate in candidates if candidate.is_file()), None)
    if filename.endswith(".parquet") or prepared:
        import pyarrow.parquet as pq
        handle = str(prepared) if prepared else str(local) if local and local.is_file() else RangeFile(client, filename)
        table = pq.ParquetFile(handle)
        for batch in table.iter_batches(batch_size=256):
            if heartbeat: heartbeat()
            yield from batch.to_pylist()
        return
    if filename.endswith(".pkl"):
        path = _pickle_path(client, filename, heartbeat)
        while not _PICKLE_READ_LOCK.acquire(timeout=1):
            if heartbeat: heartbeat()
        try:
            with path.open("rb") as stream:
                data = RestrictedDatasetUnpickler(stream).load()
            if heartbeat: heartbeat()
            yield from _object_rows(data)
        finally:
            _PICKLE_READ_LOCK.release()
        return
    if local and local.is_file():
        with local.open("rb") as stream:
            yield from _text_rows(filename, stream)
        return
    with client.stream("GET", BASE + filename) as response:
        response.raise_for_status()
        yield from _text_rows(filename, IteratorReader(response.iter_bytes()))


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
    local_dir = os.environ.get("ANNOBIO_BIOMNI_DATA_DIR", "")
    cache_key = (filename, local_dir)
    if cache_key in _SCHEMAS:
        return _SCHEMAS[cache_key]
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
            "bytes": FILES[filename]["bytes"], "filter_columns": list(discovered)}
    _SCHEMAS[cache_key] = result
    return result


def fetch_snapshot_records(source, ids, fields, options, client, on_batch=None):
    filename = resolve_dataset(source, options)
    limit = int(options.get("limit", 100))
    if not 1 <= limit <= 2000:
        raise ValueError("Choose a row limit from 1 to 2,000.")
    column = str(options.get("filter_column") or "")
    wanted = {str(value).strip() for value in ids if str(value).strip()}
    if wanted and not column:
        raise ValueError("Choose a filter column when entering filter values.")
    result, matched, scanned = [], set(), 0
    def heartbeat():
        if on_batch: on_batch([], [], len(matched) if wanted else len(result), len(wanted) or limit)
    rows = iter_dataset_rows(client, filename, heartbeat)
    try:
        for record in rows:
            scanned += 1
            if column and column not in record:
                raise ValueError("The selected filter column does not exist in this dataset.")
            value = _cell(record.get(column)) if column else ""
            if wanted and value not in wanted:
                if scanned % 1000 == 0: heartbeat()
                continue
            if wanted: matched.add(value)
            enriched = {**record, "__source_dataset": filename, "__source_url": BASE + filename}
            row = {field: _cell(enriched.get(field)) for field in fields}
            result.append(row)
            if on_batch: on_batch([row], [], len(matched) if wanted else len(result), len(wanted) or limit)
            if len(result) >= limit:
                break
        else:
            if on_batch and wanted:
                on_batch([], sorted(wanted - matched), len(wanted), len(wanted))
    finally:
        rows.close()
    if on_batch and not wanted:
        on_batch([], [], len(result), len(result))
    return result


def build_data_lake_importers():
    return {source: {"label": group["label"], "id": "Optional values in a selected dataset column", "fields": {},
        "default_fields": [], "kind": "snapshot", "searchable": False, "datasets": [
            {"name": name, **FILES[name]} for name in group["files"]], "category": "Data snapshots",
        "example": "", "option_fields": []} for source, group in GROUPS.items()}
