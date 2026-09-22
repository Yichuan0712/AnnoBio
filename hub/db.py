"""SQLite-backed user/container state for the Hub.

Plain stdlib sqlite3, not SQLAlchemy: the schema is two small tables, and this keeps the Hub's
own dependency footprint minimal to match the deploy target (an admin-invited handful of
researchers, not public self-serve scale — see the plan's Phase 3+ note for what that would need
to grow into).
"""
import hashlib
import secrets
import sqlite3
import time
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent / "data"
DB_FILE = DATA_DIR / "hub.db"


def _connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with _connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                is_admin INTEGER NOT NULL DEFAULT 0,
                created_at REAL NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS containers (
                user_id INTEGER PRIMARY KEY REFERENCES users(id),
                container_name TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'stopped',
                last_active_at REAL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS archive_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_user_id INTEGER NOT NULL REFERENCES users(id),
                title TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                created_at REAL NOT NULL,
                bundle_path TEXT NOT NULL,
                thumbnail_path TEXT
            )
            """
        )


def _hash_password(password: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 200_000)
    return f"{salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        salt_hex, _ = stored.split("$", 1)
    except ValueError:
        return False
    return secrets.compare_digest(_hash_password(password, bytes.fromhex(salt_hex)), stored)


def create_user(email: str, password: str, is_admin: bool = False) -> int:
    with _connect() as conn:
        cur = conn.execute(
            "INSERT INTO users (email, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?)",
            (email.strip().lower(), _hash_password(password), int(is_admin), time.time()),
        )
        return cur.lastrowid


def list_users() -> list[dict]:
    with _connect() as conn:
        rows = conn.execute("SELECT email, is_admin, created_at FROM users ORDER BY created_at").fetchall()
        return [dict(row) for row in rows]


def get_user_by_email(email: str) -> dict | None:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM users WHERE email = ?", (email.strip().lower(),)).fetchone()
        return dict(row) if row else None


def get_user_by_id(user_id: int) -> dict | None:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        return dict(row) if row else None


def get_container(user_id: int) -> dict | None:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM containers WHERE user_id = ?", (user_id,)).fetchone()
        return dict(row) if row else None


def list_running_containers() -> list[dict]:
    with _connect() as conn:
        rows = conn.execute("SELECT * FROM containers WHERE status = 'running'").fetchall()
        return [dict(row) for row in rows]


def upsert_container(user_id: int, container_name: str, status: str) -> None:
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO containers (user_id, container_name, status, last_active_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
                container_name = excluded.container_name,
                status = excluded.status,
                last_active_at = excluded.last_active_at
            """,
            (user_id, container_name, status, time.time()),
        )


def touch_container(user_id: int) -> None:
    with _connect() as conn:
        conn.execute("UPDATE containers SET last_active_at = ? WHERE user_id = ?", (time.time(), user_id))


def create_archive_item(owner_user_id: int, title: str, description: str, bundle_path: str, thumbnail_path: str | None) -> int:
    with _connect() as conn:
        cur = conn.execute(
            "INSERT INTO archive_items (owner_user_id, title, description, created_at, bundle_path, thumbnail_path) VALUES (?, ?, ?, ?, ?, ?)",
            (owner_user_id, title, description, time.time(), bundle_path, thumbnail_path),
        )
        return cur.lastrowid


def list_archive_items() -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT archive_items.*, users.email AS owner_email
            FROM archive_items JOIN users ON users.id = archive_items.owner_user_id
            ORDER BY archive_items.created_at DESC
            """
        ).fetchall()
        return [dict(row) for row in rows]


def get_archive_item(item_id: int) -> dict | None:
    with _connect() as conn:
        row = conn.execute(
            """
            SELECT archive_items.*, users.email AS owner_email
            FROM archive_items JOIN users ON users.id = archive_items.owner_user_id
            WHERE archive_items.id = ?
            """,
            (item_id,),
        ).fetchone()
        return dict(row) if row else None
