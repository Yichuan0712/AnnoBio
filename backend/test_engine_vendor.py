"""backend/annobio_optimize must be an exact copy of python/src/annobio_optimize (python/sync_to_backend.py)."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import unittest

BACKEND = Path(__file__).resolve().parent
VENDOR = BACKEND / "annobio_optimize"
SOURCE = BACKEND.parent / "python" / "src" / "annobio_optimize"


def _files(root: Path) -> dict[str, str]:
    return {p.relative_to(root).as_posix(): hashlib.sha256(p.read_bytes().replace(b"\r\n", b"\n")).hexdigest()
            for p in sorted(root.rglob("*"))
            if p.is_file() and "__pycache__" not in p.parts and p.name != "_PROVENANCE.json"}


class EngineVendorTests(unittest.TestCase):
    def test_copy_matches_its_provenance(self):
        provenance = json.loads((VENDOR / "_PROVENANCE.json").read_text(encoding="utf-8"))
        self.assertEqual(_files(VENDOR), provenance["files"])

    @unittest.skipUnless(SOURCE.exists(), "python/src is not shipped with the backend")
    def test_copy_matches_the_library_source(self):
        self.assertEqual(_files(VENDOR), _files(SOURCE),
                         "backend/annobio_optimize differs from python/src; run python python/sync_to_backend.py")

    def test_engine_imports_from_the_backend(self):
        from annobio_optimize.engine import Session, search_demos  # noqa: F401


if __name__ == "__main__":
    unittest.main()
