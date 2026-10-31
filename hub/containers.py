"""Container lifecycle: one backend container per user, named promptstudio-user-<id>, with a
named volume at /app/backend/data so credentials/projects/run-history survive restarts — the
same data/ layout the desktop app uses locally, just one instance per invited researcher
instead of one per desktop install. Lazily started on first request and reused by container
name thereafter; idle ones are `docker stop`ped (not removed) by reap_idle, so a later request
just restarts the same container and volume rather than recreating anything.
"""
import os
import socket
import threading
import time

import docker
from docker.errors import DockerException, NotFound

import db
from hosted_model import account_token

BACKEND_IMAGE = os.environ.get("PROMPT_STUDIO_BACKEND_IMAGE", "prompt-studio-backend:latest")
NETWORK_NAME = os.environ.get("PROMPT_STUDIO_NETWORK", "prompt-studio-net")
IDLE_TIMEOUT_SEC = int(os.environ.get("PROMPT_STUDIO_IDLE_TIMEOUT_SEC", "1800"))
# Passed through to every spawned container so its OpenRouter OAuth callback URL (see
# backend/oauth_openrouter.py) points at the Hub's own public domain instead of the container's
# own unreachable-from-outside address. Unset in local/dev use (OAuth login just won't work
# there; manually pasting an API key still does).
PUBLIC_BASE_URL = os.environ.get("PROMPT_STUDIO_PUBLIC_BASE_URL", "")
BACKEND_PORT = 8000

# Caps how many per-user backend containers (see mem_limit/nano_cpus below) can run at once,
# so a burst of new web sessions can't overwhelm the host the Hub itself is running on. Unset by
# default — this box's capacity depends entirely on its actual RAM/CPU, and there's no default
# that's safe to guess, so an admin opts in with a number sized to their own host (roughly host
# RAM ÷ 1GB, minus a bit of headroom for the Hub/Caddy/OS themselves). Only ever checked when a
# user's container doesn't exist yet (see ensure_running) — a session already running is never
# interrupted just because the host later fills up.
MAX_ACTIVE_CONTAINERS = os.environ.get("PROMPT_STUDIO_MAX_ACTIVE_CONTAINERS")
_CONTAINER_NAME_PREFIX = "promptstudio-user-"

_client = None
_start_locks: dict[int, threading.Lock] = {}
_start_locks_guard = threading.Lock()
_capacity_lock = threading.Lock()


class BackendUnavailable(Exception):
    """Raised when Docker itself, or this user's container, can't be reached/started."""


class CapacityExceeded(BackendUnavailable):
    """Raised by ensure_running instead of starting a brand-new container once
    MAX_ACTIVE_CONTAINERS is already running — see proxy.py, which turns this into a response
    the web app recognizes and points the user at the desktop app instead of a generic error."""


def client():
    global _client
    if _client is None:
        try:
            _client = docker.from_env()
        except DockerException as e:
            raise BackendUnavailable(f"Docker is not reachable: {e}") from e
    return _client


def _count_running_backend_containers() -> int:
    return len(client().containers.list(filters={"status": "running", "name": _CONTAINER_NAME_PREFIX}))


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
    # Several startup API requests can arrive together. Only one may create/start
    # this user's container; followers also wait for it to become ready.
    with _start_locks_guard:
        lock = _start_locks.setdefault(user_id, threading.Lock())
    with lock:
        return _ensure_running(user_id)


def _ensure_running(user_id: int) -> str:
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
            # Reserve capacity and create atomically across different users, now
            # that requests can start containers from multiple worker threads.
            with _capacity_lock:
                if MAX_ACTIVE_CONTAINERS and _count_running_backend_containers() >= int(MAX_ACTIVE_CONTAINERS):
                    raise CapacityExceeded(
                        "The server is at capacity right now. Please try again in a few minutes, "
                        "or use the desktop app instead."
                    )
                c.containers.run(
                    BACKEND_IMAGE,
                    name=name,
                    detach=True,
                    network=NETWORK_NAME,
                    volumes={volume_name(user_id): {"bind": "/app/backend/data", "mode": "rw"}},
                    environment={
                        "PROMPT_STUDIO_PUBLIC_BASE_URL": PUBLIC_BASE_URL,
                        "ANNOBIO_HOSTED_MODE": "1",
                        "ANNOBIO_HOSTED_GATEWAY_URL": "http://hub:8080/internal/hosted-model",
                        "ANNOBIO_HOSTED_TOKEN": account_token(user_id),
                    },
                    # 512m was too tight even at rest: uvicorn's baseline RSS was
                    # already ~510MB. The PDF worker has its own RLIMIT_AS cap.
                    mem_limit="1024m",
                    nano_cpus=1_000_000_000,  # 1 CPU, bounds runaway Process scripts.
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
