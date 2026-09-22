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


def _add_column_if_missing(conn: sqlite3.Connection, table: str, column: str, decl: str) -> None:
    """Idempotent `ALTER TABLE ADD COLUMN` — table/column/decl are always our own fixed literals
    (never request input), so building the statement with an f-string is safe here."""
    existing = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
    if column not in existing:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")


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
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS password_resets (
                token TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id),
                expires_at REAL NOT NULL,
                used INTEGER NOT NULL DEFAULT 0
            )
            """
        )
        # Added after both tables already existed in production — ALTER TABLE rather than baking
        # into the CREATE above, so existing rows survive. Pre-existing archive_items default to
        # 'approved' (they were already public before review existed); create_archive_item below
        # overrides that default to 'pending' for anything published from here on.
        _add_column_if_missing(conn, "users", "name", "TEXT NOT NULL DEFAULT ''")
        _add_column_if_missing(conn, "users", "contact", "TEXT NOT NULL DEFAULT ''")
        _add_column_if_missing(conn, "archive_items", "status", "TEXT NOT NULL DEFAULT 'approved'")


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


def update_password(user_id: int, new_password: str) -> None:
    """Used directly by the logged-in Change Password form on Profile — see
    consume_password_reset below for the logged-out forgot-password flow's equivalent."""
    with _connect() as conn:
        conn.execute("UPDATE users SET password_hash = ? WHERE id = ?", (_hash_password(new_password), user_id))


def create_password_reset(user_id: int, ttl_seconds: int = 3600) -> str:
    """A fresh reset link invalidates any earlier one for the same user — so a leaked or
    forgotten-about old email can't still be redeemed once someone requests a new link."""
    token = secrets.token_urlsafe(32)
    with _connect() as conn:
        conn.execute("DELETE FROM password_resets WHERE user_id = ?", (user_id,))
        conn.execute(
            "INSERT INTO password_resets (token, user_id, expires_at, used) VALUES (?, ?, ?, 0)",
            (token, user_id, time.time() + ttl_seconds),
        )
    return token


def get_valid_password_reset(token: str) -> dict | None:
    """None for a token that doesn't exist, was already used, or expired — main.py treats all
    three the same way ("this link is invalid or has expired"), so it doesn't distinguish here."""
    with _connect() as conn:
        row = conn.execute("SELECT * FROM password_resets WHERE token = ?", (token,)).fetchone()
    if not row or row["used"] or row["expires_at"] < time.time():
        return None
    return dict(row)


def consume_password_reset(token: str, user_id: int, new_password: str) -> None:
    with _connect() as conn:
        conn.execute(
            "UPDATE users SET password_hash = ? WHERE id = ?",
            (_hash_password(new_password), user_id),
        )
        conn.execute("UPDATE password_resets SET used = 1 WHERE token = ?", (token,))


def create_user(email: str, password: str, is_admin: bool = False, name: str = "") -> int:
    with _connect() as conn:
        cur = conn.execute(
            "INSERT INTO users (email, password_hash, is_admin, name, created_at) VALUES (?, ?, ?, ?, ?)",
            (email.strip().lower(), _hash_password(password), int(is_admin), name.strip()[:200], time.time()),
        )
        return cur.lastrowid


def update_user_info(user_id: int, name: str, contact: str) -> None:
    """Name + contact live on the account (filled once via the Profile page) rather than being
    re-asked on every Gallery publish — see archive_publish in main.py, which requires both to be
    set before it'll accept a submission."""
    with _connect() as conn:
        conn.execute(
            "UPDATE users SET name = ?, contact = ? WHERE id = ?",
            (name.strip()[:200], contact.strip()[:200], user_id),
        )


def set_admin(user_id: int, is_admin: bool) -> None:
    with _connect() as conn:
        conn.execute("UPDATE users SET is_admin = ? WHERE id = ?", (int(is_admin), user_id))


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
            "INSERT INTO archive_items (owner_user_id, title, description, created_at, bundle_path, thumbnail_path, status) "
            "VALUES (?, ?, ?, ?, ?, ?, 'pending')",
            (owner_user_id, title, description, time.time(), bundle_path, thumbnail_path),
        )
        return cur.lastrowid


_ARCHIVE_ITEM_SELECT = """
    SELECT archive_items.*, users.email AS owner_email, users.name AS owner_name, users.contact AS owner_contact
    FROM archive_items JOIN users ON users.id = archive_items.owner_user_id
"""


def list_archive_items() -> list[dict]:
    """Public Gallery listing — approved items only; see list_pending_archive_items for the
    admin review queue."""
    with _connect() as conn:
        rows = conn.execute(
            _ARCHIVE_ITEM_SELECT + " WHERE archive_items.status = 'approved' ORDER BY archive_items.created_at DESC"
        ).fetchall()
        return [dict(row) for row in rows]


def list_pending_archive_items() -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            _ARCHIVE_ITEM_SELECT + " WHERE archive_items.status = 'pending' ORDER BY archive_items.created_at ASC"
        ).fetchall()
        return [dict(row) for row in rows]


def get_archive_item(item_id: int) -> dict | None:
    """Unfiltered by status — used both for the public detail page (which checks status ==
    'approved' itself before showing anything) and for the admin review actions below."""
    with _connect() as conn:
        row = conn.execute(_ARCHIVE_ITEM_SELECT + " WHERE archive_items.id = ?", (item_id,)).fetchone()
        return dict(row) if row else None


def update_archive_item(item_id: int, title: str, description: str) -> None:
    with _connect() as conn:
        conn.execute(
            "UPDATE archive_items SET title = ?, description = ? WHERE id = ?",
            (title.strip()[:200], description.strip()[:2000], item_id),
        )


def approve_archive_item(item_id: int) -> None:
    with _connect() as conn:
        conn.execute("UPDATE archive_items SET status = 'approved' WHERE id = ?", (item_id,))


def delete_archive_item(item_id: int) -> dict | None:
    """Returns the deleted row (so the caller can also remove its bundle/thumbnail files —
    see archive.py) or None if it didn't exist."""
    item = get_archive_item(item_id)
    if not item:
        return None
    with _connect() as conn:
        conn.execute("DELETE FROM archive_items WHERE id = ?", (item_id,))
    return item
