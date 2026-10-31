"""Bounded, cached public-web lookups shared by desktop and hosted backends.

Network work runs in a short-lived child process: DNS, a slow search engine, or
an HTML response cannot leave backend worker threads waiting indefinitely.
"""
from collections import OrderedDict
from copy import deepcopy
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time

WORKER_TIMEOUT = 12
CACHE_LIMIT = 64
_cache = OrderedDict()
_lock = threading.Lock()
_slots = threading.BoundedSemaphore(2)
_pending = set()


def _lookup(kind, args):
    key = (kind, json.dumps(args, sort_keys=True, ensure_ascii=True))
    with _lock:
        entry = _cache.get(key)
        if entry and entry[0] > time.monotonic():
            _cache.move_to_end(key)
            return {**deepcopy(entry[1]), "cached": True}
        if key in _pending or not _slots.acquire(blocking=False):
            return {"error": "Web lookup is busy. Continue with available information or try again later.", "code": "busy"}
        _pending.add(key)
    try:
        try:
            completed = subprocess.run(
                [sys.executable, "-m", "agent.web_search_worker"],
                cwd=Path(__file__).resolve().parent.parent,
                input=json.dumps({"kind": kind, **args}), capture_output=True,
                text=True, encoding="utf-8", timeout=WORKER_TIMEOUT,
                env={**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"},
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            )
            if completed.returncode or len(completed.stdout) > 400000:
                result = {"error": "Web lookup could not complete. Continue without it or use a specialist data source.", "code": "unavailable"}
            else:
                result = json.loads(completed.stdout)
                if not isinstance(result, dict):
                    raise ValueError("Invalid worker response")
        except subprocess.TimeoutExpired:
            result = {"error": "Web lookup timed out. Continue with available information instead of repeatedly retrying.", "code": "timeout"}
        except (OSError, ValueError):
            result = {"error": "Web lookup is unavailable in this backend. Check its installed dependencies.", "code": "unavailable"}
        result["fetched_at"] = datetime.now(timezone.utc).isoformat()
        # Briefly cache failures too: a blocked provider must not cause a retry storm.
        ttl = 20 if result.get("error") else 300 if kind == "search" else 600
        with _lock:
            _cache[key] = (time.monotonic() + ttl, deepcopy(result))
            _cache.move_to_end(key)
            while len(_cache) > CACHE_LIMIT:
                _cache.popitem(last=False)
        return {**result, "cached": False}
    finally:
        with _lock:
            _pending.discard(key)
        _slots.release()


def search_web(query, limit=5):
    query = query.strip()
    if not query or len(query) > 500:
        return {"error": "Use a search query of 1–500 characters.", "code": "invalid_query"}
    return _lookup("search", {"query": query, "limit": max(1, min(5, int(limit)))})


def read_webpage(url, offset=0, max_chars=6000):
    result = _lookup("read", {"url": url.strip()})
    if result.get("error"):
        return result
    content = result.get("content", "")
    offset = max(0, int(offset))
    max_chars = max(1, min(12000, int(max_chars)))
    return {**result, "content": content[offset:offset + max_chars], "offset": offset,
        "total_chars": len(content), "truncated": bool(result.get("truncated") or offset + max_chars < len(content))}
