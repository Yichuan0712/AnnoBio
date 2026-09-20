"""Container lifecycle: one backend container per user, named promptstudio-user-<id>, with a
named volume at /app/backend/data so credentials/projects/run-history survive restarts — the
same data/ layout the desktop app uses locally, just one instance per invited researcher
instead of one per desktop install. Lazily started on first request and reused by container
name thereafter; idle ones are `docker stop`ped (not removed) by reap_idle, so a later request
just restarts the same container and volume rather than recreating anything.
"""
import os
import socket
import time

import docker
from docker.errors import DockerException, NotFound

import db

BACKEND_IMAGE = os.environ.get("PROMPT_STUDIO_BACKEND_IMAGE", "prompt-studio-backend:latest")
NETWORK_NAME = os.environ.get("PROMPT_STUDIO_NETWORK", "prompt-studio-net")
IDLE_TIMEOUT_SEC = int(os.environ.get("PROMPT_STUDIO_IDLE_TIMEOUT_SEC", "1800"))
# Passed through to every spawned container so its OpenRouter OAuth callback URL (see
# backend/oauth_openrouter.py) points at the Hub's own public domain instead of the container's
# own unreachable-from-outside address. Unset in local/dev use (OAuth login just won't work
# there; manually pasting an API key still does).
PUBLIC_BASE_URL = os.environ.get("PROMPT_STUDIO_PUBLIC_BASE_URL", "")
BACKEND_PORT = 8000

_client = None


class BackendUnavailable(Exception):
    """Raised when Docker itself, or this user's container, can't be reached/started."""


def client():
    global _client
    if _client is None:
        try:
            _client = docker.from_env()
        except DockerException as e:
            raise BackendUnavailable(f"Docker is not reachable: {e}") from e
    return _client


def container_name(user_id: int) -> str:
    return f"promptstudio-user-{user_id}"


def volume_name(user_id: int) -> str:
    return f"promptstudio-data-{user_id}"


def _wait_until_ready(name: str, timeout: float = 20.0, interval: float = 0.3) -> None:
    """Blocks until `name` accepts TCP connections on BACKEND_PORT. Uvicorn inside a freshly
    started/created container takes a couple seconds to come up; without this, the request that
    triggered the cold start races the container and gets a connection-refused 502 from proxy.py."""
    deadline = time.time() + timeout
    last_error: OSError | None = None
    while time.time() < deadline:
        try:
            with socket.create_connection((name, BACKEND_PORT), timeout=1.0):
                return
        except OSError as e:
            last_error = e
            time.sleep(interval)
    raise BackendUnavailable(f"Your workspace container did not become ready in time: {last_error}")


def ensure_running(user_id: int) -> str:
    """Starts (or reuses) this user's backend container. Returns its container name, which is
    also its resolvable hostname on NETWORK_NAME — Docker's embedded DNS resolves container
    names for containers sharing a user-defined network."""
    name = container_name(user_id)
    c = client()
    just_started = False
    try:
        try:
            container = c.containers.get(name)
            if container.status != "running":
                container.start()
                just_started = True
        except NotFound:
            c.containers.run(
                BACKEND_IMAGE,
                name=name,
                detach=True,
                network=NETWORK_NAME,
                volumes={volume_name(user_id): {"bind": "/app/backend/data", "mode": "rw"}},
                environment={"PROMPT_STUDIO_PUBLIC_BASE_URL": PUBLIC_BASE_URL} if PUBLIC_BASE_URL else {},
                mem_limit="512m",
                nano_cpus=1_000_000_000,  # 1 CPU — cheap hardening against a runaway Process-node script.
                restart_policy={"Name": "unless-stopped"},
            )
            just_started = True
    except DockerException as e:
        raise BackendUnavailable(f"Could not start your workspace container: {e}") from e
    if just_started:
        _wait_until_ready(name)
    db.upsert_container(user_id, name, "running")
    return name


def reap_idle() -> None:
    """Stops (never removes) containers idle past IDLE_TIMEOUT_SEC. Call on an interval, e.g.
    from a background task in main.py."""
    try:
        c = client()
    except BackendUnavailable:
        return
    now = time.time()
    for row in db.list_running_containers():
        if not row["last_active_at"] or now - row["last_active_at"] <= IDLE_TIMEOUT_SEC:
            continue
        try:
            c.containers.get(row["container_name"]).stop()
        except (NotFound, DockerException):
            pass
        db.upsert_container(row["user_id"], row["container_name"], "stopped")
