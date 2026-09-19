"""Admin CLI for the Hub. Accounts are also created via self-serve registration at /register now
(see hub/main.py) — this remains for an admin to hand someone an account directly, or to grant
--admin, without them going through the public form. There is no password reset flow yet.

Usage:
    python hub/manage_users.py invite alice@example.edu [--admin]
    python hub/manage_users.py list
"""
import argparse
import secrets
import sys

import db

if sys.platform == "win32":
    # Deployment target is the Linux container in hub/Dockerfile; this only matters for an
    # admin running this CLI directly on Windows, where the default console codepage mangles
    # the em dash below.
    try:
        import ctypes

        ctypes.windll.kernel32.SetConsoleOutputCP(65001)
    except Exception:
        pass


def invite(email: str, is_admin: bool) -> None:
    db.init_db()
    if db.get_user_by_email(email):
        print(f"{email} already has an account.", file=sys.stderr)
        sys.exit(1)
    password = secrets.token_urlsafe(12)
    db.create_user(email, password, is_admin=is_admin)
    print(f"Created account for {email}")
    print(f"Temporary password: {password}")
    print("Send this to them directly — there is no self-serve signup or password reset yet.")


def list_users() -> None:
    db.init_db()
    for user in db.list_users():
        print(f"{user['email']}{' (admin)' if user['is_admin'] else ''}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    invite_p = sub.add_parser("invite", help="Create an account and print its temporary password.")
    invite_p.add_argument("email")
    invite_p.add_argument("--admin", action="store_true", help="Grant admin (currently unused by the Hub itself, reserved for later).")

    sub.add_parser("list", help="List existing accounts.")

    args = parser.parse_args()
    if args.command == "invite":
        invite(args.email, args.admin)
    elif args.command == "list":
        list_users()


if __name__ == "__main__":
    main()
