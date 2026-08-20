#!/usr/bin/env python3
"""Fail closed if tracked release files contain private runtime state or known local identifiers."""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SELF = Path(__file__).resolve().relative_to(ROOT)

BANNED_PATHS = (
    "data/",
    "assets/uploads/",
    "site/dist/",
)

BANNED_NAMES = {
    ".env",
    "tabmonger.db",
    "tabmonger.db-shm",
    "tabmonger.db-wal",
}

BANNED_TEXT = {
    "Jon's Studio LAN range": re.compile(r"\b192\.168\.29\.\d{1,3}\b"),
    "local home path": re.compile(r"/home/legend(?:/|\b)"),
    "local workstation name": re.compile(r"\b(?:zorin-96|friday-studio|openclaw-44)\b", re.I),
    "live Stripe checkout": re.compile(r"https://buy\.stripe\.com/(?!example\b)[A-Za-z0-9_]+"),
    "Stripe secret": re.compile(r"\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]+"),
    "Stripe webhook secret": re.compile(r"\bwhsec_[A-Za-z0-9]+"),
    "private key": re.compile(r"BEGIN (?:OPENSSH|RSA|EC) PRIVATE KEY"),
}


def tracked_files() -> list[Path]:
    result = subprocess.run(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        cwd=ROOT,
        check=True,
        capture_output=True,
    )
    return [Path(raw.decode()) for raw in result.stdout.split(b"\0") if raw]


def main() -> int:
    problems: list[str] = []
    for relative in tracked_files():
        path_text = relative.as_posix()
        if relative == SELF:
            continue
        if path_text.startswith(BANNED_PATHS) or relative.name in BANNED_NAMES:
            problems.append(f"tracked private/generated path: {path_text}")
            continue
        absolute = ROOT / relative
        try:
            raw = absolute.read_bytes()
        except OSError as exc:
            problems.append(f"could not read {path_text}: {exc}")
            continue
        if raw.startswith(b"SQLite format 3\x00"):
            problems.append(f"tracked SQLite database: {path_text}")
            continue
        if b"\x00" in raw[:8192]:
            continue
        text = raw.decode("utf-8", "replace")
        for label, pattern in BANNED_TEXT.items():
            if pattern.search(text):
                problems.append(f"{label}: {path_text}")

    if problems:
        print("Public release check failed:", file=sys.stderr)
        for problem in problems:
            print(f"- {problem}", file=sys.stderr)
        return 1

    print(f"Public release check passed ({len(tracked_files())} tracked files inspected).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
