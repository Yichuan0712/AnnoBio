"""Unified, user-managed local downloads for desktop Dataset sources."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import threading

from database_availability import require_data_lake

MANIFEST = json.loads((Path(__file__).parent / "biomni_manifest.json").read_text(encoding="utf-8"))
FILES = MANIFEST["data_lake"]
BASE = "https://biomni-release.s3.amazonaws.com/data_lake/"
_DOWNLOAD_LOCK = threading.Lock()
_STATE_LOCK = threading.Lock()
_FILE_LOCKS = {}
_ACTIVE = {}


def cache_directory():
    return Path(os.environ.get("ANNOBIO_BIOMNI_CACHE_DIR") or Path(__file__).parent / "data" / "biomni-cache").resolve()


def _filename(filename):
    if filename not in FILES:
        raise ValueError("Choose a file from the dataset manifest.")
    return filename


def _managed_paths(filename):
    _filename(filename)
    root = cache_directory()
    paths = [root / filename, root / (filename + '.part'), root / 'prepared' / (filename + '.parquet'), root / 'prepared' / (filename + '.parquet.part')]
    if any(not path.resolve().is_relative_to(root) for path in paths):
        raise ValueError('A dataset cache path points outside the download directory.')
    return paths


def _file_lock(filename):
    _filename(filename)
    with _STATE_LOCK:
        return _FILE_LOCKS.setdefault((str(cache_directory()), filename), threading.RLock())


@contextmanager
def dataset_lock(filename, heartbeat=None):
    lock = _file_lock(filename)
    while not lock.acquire(timeout=0.5):
        if heartbeat: heartbeat()
    try:
        yield
    finally:
        lock.release()


def local_dataset_path(filename):
    _filename(filename)
    paths = _managed_paths(filename)
    local_dir = os.environ.get('ANNOBIO_BIOMNI_DATA_DIR')
    candidates = []
    if local_dir:
        local = Path(local_dir).resolve() / filename
        if filename.endswith('.pkl'): candidates.append((local.with_name(filename + '.parquet'), False))
        candidates.append((local, False))
    if filename.endswith('.pkl'): candidates.append((paths[2], False))
    candidates.append((paths[0], True))
    for path, check_size in candidates:
        try:
            size = path.stat().st_size
            if path.is_file() and size > 0 and (not check_size or size == FILES[filename]['bytes']):
                return path
        except FileNotFoundError:
            pass
    return None


def dataset_status(filename):
    require_data_lake()
    _filename(filename)
    root = cache_directory()
    with _STATE_LOCK:
        progress = _ACTIVE.get((str(root), filename))
        progress = dict(progress) if progress else None
    paths = _managed_paths(filename)
    stored = 0
    for candidate in paths:
        try:
            if candidate.is_file(): stored += candidate.stat().st_size
        except FileNotFoundError:
            pass  # A user may remove files in their file manager while this check runs.
    base = {'name': filename, 'bytes': FILES[filename]['bytes'], 'stored_bytes': stored, 'managed': stored > 0}
    if progress:
        return {**base, **progress, 'status': 'downloading', 'fingerprint': None}
    path = local_dataset_path(filename)
    if path:
        try:
            stat = path.stat()
        except FileNotFoundError:
            return {**base, 'status': 'missing', 'downloaded_bytes': 0, 'fingerprint': None}
        fingerprint = hashlib.sha256(f'{path.resolve()}|{stat.st_ino}|{stat.st_size}|{stat.st_mtime_ns}'.encode()).hexdigest()
        return {**base, 'status': 'downloaded', 'downloaded_bytes': FILES[filename]['bytes'],
                'fingerprint': fingerprint, 'path': str(path.resolve()), 'prepared': path.name != filename,
                'managed': path.resolve() in {paths[0].resolve(), paths[2].resolve()}}
    return {**base, 'status': 'incomplete' if stored else 'missing', 'downloaded_bytes': 0, 'fingerprint': None}


def require_local_dataset(filename):
    require_data_lake()
    path = local_dataset_path(filename)
    if path is None:
        raise FileNotFoundError('The dataset file is missing or incomplete. Click Download to get it again.')
    return path


def delete_download(filename):
    require_data_lake()
    lock = _file_lock(filename)
    if not lock.acquire(blocking=False):
        raise RuntimeError('This dataset is in use. Cancel its download or import before deleting it.')
    try:
        # Only our manifest-named cache files are removed, never external data directories.
        removed = 0
        for path in _managed_paths(filename):
            if path.is_file():
                removed += path.stat().st_size
                path.unlink()
        return {'removed_bytes': removed, 'download': dataset_status(filename)}
    finally:
        lock.release()


def download_dataset(client, filename, heartbeat=None, on_progress=None):
    """The only operation allowed to fetch an entire snapshot; readers never redownload it."""
    require_data_lake()
    _filename(filename)
    with dataset_lock(filename, heartbeat):
        existing = local_dataset_path(filename)
        if existing:
            if on_progress: on_progress(FILES[filename]['bytes'], FILES[filename]['bytes'])
            return existing
        root = cache_directory()
        root.mkdir(parents=True, exist_ok=True)
        total = FILES[filename]['bytes']
        if shutil.disk_usage(root).free < total + 16 * 1024 * 1024:
            raise OSError('There is not enough free disk space to download this dataset.')
        target, partial, *_ = _managed_paths(filename)
        while not _DOWNLOAD_LOCK.acquire(timeout=0.5):
            if heartbeat: heartbeat()
        state_key = (str(root), filename)
        try:
            downloaded = 0
            with _STATE_LOCK:
                _ACTIVE[state_key] = {'downloaded_bytes': 0}
            chunk_size = 8 * 1024 * 1024
            def chunk(offset):
                remote = RangeFile(client, filename)
                remote.seek(offset)
                return offset, remote.read(min(chunk_size, total - offset))
            with partial.open('wb') as destination, ThreadPoolExecutor(max_workers=4) as pool:
                for start in range(0, total, chunk_size * 4):
                    if heartbeat: heartbeat()
                    offsets = range(start, min(start + chunk_size * 4, total), chunk_size)
                    for offset, data in pool.map(chunk, offsets):
                        destination.seek(offset)
                        destination.write(data)
                        downloaded += len(data)
                        with _STATE_LOCK:
                            _ACTIVE[state_key] = {'downloaded_bytes': downloaded}
                        if on_progress: on_progress(downloaded, total)
                        if heartbeat: heartbeat()
            if partial.stat().st_size != total or downloaded != total:
                raise ValueError('Incomplete dataset download. Click Download to retry.')
            partial.replace(target)
            return target
        except BaseException:
            partial.unlink(missing_ok=True)
            raise
        finally:
            with _STATE_LOCK:
                _ACTIVE.pop(state_key, None)
            _DOWNLOAD_LOCK.release()


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

