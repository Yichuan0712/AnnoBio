"""Prepare pickle snapshots as streaming Parquet for servers with limited RAM.

Run once on a machine with sufficient memory; copy the prepared files into the server cache.
Example: python prepare_biomni_data.py --file genebass_pLoF_filtered.pkl
"""
from __future__ import annotations

import argparse
from itertools import chain, islice
import os
from pathlib import Path

from biomni_data_lake import FILES, iter_dataset_rows
from database_importers import _cell
from reference_import import _client


def prepare(filename, destination):
    import pyarrow as pa
    import pyarrow.parquet as pq
    destination.mkdir(parents=True, exist_ok=True)
    target = destination / (filename + '.parquet')
    partial = target.with_suffix('.parquet.part')
    rows = None
    count = 0
    try:
        with _client() as client:
            rows = iter_dataset_rows(client, filename)
            first = next(rows)
            schema = pa.schema([(str(key), pa.string()) for key in first])
            pending = chain([first], rows)
            with pq.ParquetWriter(partial, schema, compression='zstd') as writer:
                while batch := list(islice(pending, 1024)):
                    normalized = [{str(k): _cell(row.get(k)) for k in first} for row in batch]
                    writer.write_table(pa.Table.from_pylist(normalized, schema=schema))
                    count += len(batch)
        partial.replace(target)
        return target, count
    finally:
        if rows is not None: rows.close()
        partial.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--file', choices=[name for name in FILES if name.endswith('.pkl')])
    group.add_argument('--all-pickles', action='store_true')
    parser.add_argument('--output', type=Path, default=Path(os.environ.get('ANNOBIO_BIOMNI_CACHE_DIR') or Path(__file__).parent / 'data' / 'biomni-cache') / 'prepared')
    args = parser.parse_args()
    for filename in ([args.file] if args.file else [name for name in FILES if name.endswith('.pkl')]):
        target, count = prepare(filename, args.output)
        print(f'{filename}: {count:,} rows -> {target}', flush=True)


if __name__ == '__main__':
    main()
