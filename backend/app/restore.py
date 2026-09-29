"""Restore a database backup: ``python -m app.restore <file> [--yes]``.

Run it inside the backend container. ``<file>`` is a path, or the name of a dump
in ``BACKUP_DIR`` (``settl-YYYYMMDD-HHMMSS-<kind>.dump``). Everything in the
database is replaced by the dump (``pg_restore --clean --if-exists --no-owner``);
restart the backend afterwards so ``schema.sql`` brings the schema up to date.
``.env`` and ``config.yaml`` are not in a dump and are left alone.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

from app.config import Settings
from app.services.backups import pg_connection, pg_env

CONFIRM_WORD = "RESTORE"


def find_dump(settings: Settings, given: str) -> Path | None:
    path = Path(given)
    if path.is_file():
        return path
    candidate = Path(settings.backup_dir) / path.name
    return candidate if candidate.is_file() else None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.restore", description=__doc__.splitlines()[0])
    parser.add_argument("file", help="a .dump file, or the name of one in BACKUP_DIR")
    parser.add_argument("--yes", action="store_true", help="do not ask for confirmation")
    args = parser.parse_args(argv)

    settings = Settings()
    dump = find_dump(settings, args.file)
    if dump is None:
        print(f"No such file: {args.file} (looked in the current folder and {settings.backup_dir})", file=sys.stderr)
        return 2
    conn, password = pg_connection(settings.database_url)
    target = f"{conn.get('PGDATABASE', '?')} on {conn.get('PGHOST', 'localhost')}"
    print(f"This replaces everything in the database {target} with {dump.name}.")
    if not args.yes:
        try:
            answer = input(f"Type {CONFIRM_WORD} to continue: ")
        except EOFError:
            answer = ""
        if answer.strip() != CONFIRM_WORD:
            print("Nothing restored.")
            return 1

    result = subprocess.run(
        ["pg_restore", "--clean", "--if-exists", "--no-owner", "--dbname", conn.get("PGDATABASE", ""), str(dump)],
        env=pg_env(settings.database_url),
        capture_output=True,
        text=True,
        check=False,
    )
    output = (result.stderr or "").strip()
    if password:
        output = output.replace(password, "***")
    if result.returncode != 0:
        print(output, file=sys.stderr)
        print("pg_restore reported errors (above). Check the app before relying on it.", file=sys.stderr)
        return result.returncode
    print(f"Restored {dump.name}. Now restart the backend (docker compose restart backend).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
