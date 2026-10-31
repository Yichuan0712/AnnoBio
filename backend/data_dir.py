"""Where the backend keeps user data: credentials, settings, projects, run history and caches.

Installed desktop builds set ANNOBIO_DATA_DIR to the OS per-user app-data folder (see
app/src/main.js), so data survives upgrades and is never written inside the installed app.
Development and the hosted per-user containers leave it unset and use backend/data, where the
Hub mounts each user's volume.
"""
import os
from pathlib import Path

DATA_DIR = Path(os.environ.get("ANNOBIO_DATA_DIR") or Path(__file__).resolve().parent / "data").resolve()
