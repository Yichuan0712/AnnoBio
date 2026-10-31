"""ANNOBIO_DATA_DIR moves every data path; unset, data stays in backend/data."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

BACKEND = Path(__file__).resolve().parent
PROBE = (
    "import biomni_downloads, main, project_store, terminology_client; "
    "print(main.CREDENTIALS_FILE.parent); print(project_store.PROJECTS_DIR.parent); "
    "print(terminology_client.TERMINOLOGY_CACHE_FILE.parent); "
    "print(biomni_downloads.cache_directory().parent)"
)


def data_dirs(**env):
    environment = {k: v for k, v in os.environ.items()
                   if k not in ("ANNOBIO_DATA_DIR", "ANNOBIO_BIOMNI_CACHE_DIR")}
    environment.update(env)
    result = subprocess.run([sys.executable, "-c", PROBE], cwd=BACKEND, env=environment,
                            capture_output=True, text=True, check=True)
    return [Path(line) for line in result.stdout.splitlines()[-4:]]


class DataDirTests(unittest.TestCase):
    def test_env_moves_all_data_paths(self):
        with tempfile.TemporaryDirectory() as root:
            self.assertEqual(data_dirs(ANNOBIO_DATA_DIR=root), [Path(root).resolve()] * 4)

    def test_unset_keeps_backend_data(self):
        self.assertEqual(data_dirs(), [BACKEND / "data"] * 4)


if __name__ == "__main__":
    unittest.main()
