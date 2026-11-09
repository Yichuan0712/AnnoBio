"""Copy the annobio_optimize library into backend/ so the app backend can import it.

The backend ships as the backend/ directory alone (the desktop build copies backend/ into the app's resources; the
hosted image is built with backend/ as its Docker context), so the library cannot be imported from python/src there.
python/src/annobio_optimize stays the only place to edit it; this script replaces backend/annobio_optimize with a copy
and writes backend/annobio_optimize/_PROVENANCE.json (source commit, sha256 per file). backend/test_engine_vendor.py
fails when the copy differs from python/src. Run after every library change:

    python python/sync_to_backend.py
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "python" / "src" / "annobio_optimize"
TARGET = ROOT / "backend" / "annobio_optimize"


def files(root: Path) -> list[Path]:
    return sorted(p for p in root.rglob("*") if p.is_file() and "__pycache__" not in p.parts and p.name != "_PROVENANCE.json")


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes().replace(b"\r\n", b"\n")).hexdigest()  # same on CRLF and LF checkouts


def main() -> int:
    dirty = subprocess.run(["git", "-C", str(ROOT), "status", "--porcelain", "--", "python/src"],
                           capture_output=True, text=True, check=True).stdout.strip()
    if dirty and "--allow-dirty" not in sys.argv:
        print("python/src has uncommitted changes; commit them first (or pass --allow-dirty).")
        return 1
    head = subprocess.run(["git", "-C", str(ROOT), "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
    if TARGET.exists():
        shutil.rmtree(TARGET)
    shutil.copytree(SOURCE, TARGET, ignore=shutil.ignore_patterns("__pycache__"))
    provenance = {"source": "python/src/annobio_optimize", "source_git_head": head, "uncommitted_source": bool(dirty),
                  "files": {p.relative_to(TARGET).as_posix(): digest(p) for p in files(TARGET)}}
    (TARGET / "_PROVENANCE.json").write_text(json.dumps(provenance, indent=2) + "\n", encoding="utf-8")
    print(f"Copied {len(provenance['files'])} files from {head[:12]} into backend/annobio_optimize")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
