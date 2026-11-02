"""Cached public release metadata; never infer an installer version from source metadata."""
from dataclasses import dataclass
from threading import Lock
from time import monotonic

import httpx

REPOSITORY_URL = "https://github.com/Yichuan0712/AnnoBio"
LATEST_RELEASE_URL = REPOSITORY_URL + "/releases/latest"
LATEST_API_URL = "https://api.github.com/repos/Yichuan0712/AnnoBio/releases/latest"
WINDOWS_ASSET = "AnnoBio-Setup-x64.exe"
MAC_ASSET = "AnnoBio-arm64.dmg"


@dataclass(frozen=True)
class ReleaseInfo:
    version: str = ""
    url: str = LATEST_RELEASE_URL
    windows_url: str = LATEST_RELEASE_URL + "/download/" + WINDOWS_ASSET
    mac_url: str = LATEST_RELEASE_URL + "/download/" + MAC_ASSET


_cached = ReleaseInfo()
_expires = 0.0
_lock = Lock()


def latest_release() -> ReleaseInfo:
    """Keep the last valid release during outages and retry failures after 30 seconds."""
    global _cached, _expires
    with _lock:
        now = monotonic()
        if now < _expires:
            return _cached
        try:
            response = httpx.get(LATEST_API_URL, timeout=3.0, headers={
                "Accept": "application/vnd.github+json", "User-Agent": "AnnoBio",
            })
            response.raise_for_status()
            data = response.json()
            version = data.get("tag_name")
            url = data.get("html_url")
            if not isinstance(version, str) or not version.strip() or data.get("draft") or data.get("prerelease"):
                raise ValueError("No published latest release")
            if not isinstance(url, str) or not url.startswith(REPOSITORY_URL + "/releases/tag/"):
                raise ValueError("Unexpected release URL")
            assets = {asset.get("name"): asset.get("browser_download_url") for asset in data.get("assets", [])}
            downloads = [assets.get(name) for name in (WINDOWS_ASSET, MAC_ASSET)]
            if not all(isinstance(link, str) and link.startswith(REPOSITORY_URL + "/releases/download/") for link in downloads):
                raise ValueError("Latest release is missing an installer")
            _cached = ReleaseInfo(version.strip(), url, *downloads)
            _expires = now + 300
        except (httpx.HTTPError, ValueError, TypeError, AttributeError):
            _expires = now + 30
        return _cached
