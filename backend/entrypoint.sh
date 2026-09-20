#!/bin/sh
# Seeds a fixed in-container Python interpreter into settings.json on first boot, so Process/
# Match/ProcessDF requests (which require python_path to already be set — there's no implicit
# default, see process_exec.py) work without the desktop's "browse for a local interpreter" UI,
# which has nothing to browse inside a container. _load_settings() in main.py merges whatever
# is here over DEFAULT_SETTINGS, so this file only ever needs the one key that differs from
# a fresh desktop install.
set -e
mkdir -p /app/backend/data
if [ ! -f /app/backend/data/settings.json ]; then
  python3 -c "import json, sys; json.dump({'python_path': sys.executable}, open('/app/backend/data/settings.json', 'w'))"
fi
exec "$@"
