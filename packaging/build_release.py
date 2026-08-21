#!/usr/bin/env python3
"""Build a private-state-free TabMonger portable source release."""

from __future__ import annotations

import argparse
import hashlib
import json
import stat
import zipfile
from pathlib import Path


REQUIRED_FILES = (
    "server.py",
    "Start TabMonger.bat",
    "Start TabMonger.command",
    "Start TabMonger.sh",
    "install.sh",
    "tabmonger.service",
    "LICENSE",
    "SECURITY.md",
)
OPTIONAL_FILES = ("README.md", "CHANGELOG.md", "CONTRIBUTING.md")
RUNTIME_TREES = ("public", "docs", "extensions", "community")
EXECUTABLE_FILES = {"server.py", "install.sh", "Start TabMonger.command", "Start TabMonger.sh"}
START_HERE = """TabMonger portable
===================

1. Extract this ZIP before running it.
2. Windows: double-click "Start TabMonger.bat".
   macOS: double-click "Start TabMonger.command".
   Linux: double-click "Start TabMonger.sh" and choose Run if prompted.
3. Keep the launcher window open. TabMonger prefers the private LAN address
   usable by trusted devices, with a localhost address available as a fallback.
4. To make that address your new-tab page, follow extensions/README.md and
   load the included Chromium or Firefox companion folder.

Python 3.10 or newer is the only runtime requirement. Your links, settings,
uploads, and backups are stored in your private user-data folder, not inside this package.
Closing the launcher window stops TabMonger. Linux users who want it to start
automatically can run ./install.sh from a terminal.
"""


def release_files(source: Path) -> list[Path]:
    paths: list[Path] = []
    for relative in REQUIRED_FILES:
        path = source / relative
        if not path.is_file():
            raise FileNotFoundError(f"required release file is missing: {relative}")
        paths.append(path)
    for relative in OPTIONAL_FILES:
        path = source / relative
        if path.is_file():
            paths.append(path)
    for tree in RUNTIME_TREES:
        root = source / tree
        if not root.is_dir():
            raise FileNotFoundError(f"required release directory is missing: {tree}")
        paths.extend(
            path for path in root.rglob("*")
            if path.is_file() and "__pycache__" not in path.parts and path.name != ".DS_Store"
        )
    return sorted(set(paths), key=lambda path: path.relative_to(source).as_posix())


def _zip_info(name: str, executable: bool = False) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_DEFLATED
    mode = stat.S_IFREG | (0o755 if executable else 0o644)
    info.external_attr = mode << 16
    info.create_system = 3
    return info


def build_archive(source: Path, output: Path, prefix: str = "TabMonger") -> dict[str, str]:
    source = source.resolve()
    files = release_files(source)
    manifest: dict[str, str] = {}
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        archive.writestr(_zip_info(f"{prefix}/START-HERE.txt"), START_HERE.encode("utf-8"))
        for path in files:
            relative = path.relative_to(source).as_posix()
            raw = path.read_bytes()
            manifest[relative] = hashlib.sha256(raw).hexdigest()
            executable = relative in EXECUTABLE_FILES or bool(path.stat().st_mode & stat.S_IXUSR)
            archive.writestr(_zip_info(f"{prefix}/{relative}", executable), raw)
        archive.writestr(
            _zip_info(f"{prefix}/release-manifest.json"),
            (json.dumps({"sha256": manifest}, indent=2, sort_keys=True) + "\n").encode("utf-8"),
        )
    return manifest


def main() -> int:
    project = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=project)
    parser.add_argument("--output", type=Path, default=project / "dist" / "TabMonger-portable.zip")
    parser.add_argument("--prefix", default="TabMonger")
    args = parser.parse_args()
    manifest = build_archive(args.source, args.output, args.prefix)
    digest = hashlib.sha256(args.output.read_bytes()).hexdigest()
    checksum_path = args.output.with_suffix(args.output.suffix + ".sha256")
    checksum_path.write_text(f"{digest}  {args.output.name}\n", encoding="utf-8")
    print(f"Built {args.output} with {len(manifest)} runtime files")
    print(f"SHA-256: {digest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
