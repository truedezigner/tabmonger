#!/usr/bin/env python3
"""Build deterministic, private-state-free TabMonger browser companion ZIPs."""

from __future__ import annotations

import argparse
import hashlib
import json
import stat
import zipfile
from pathlib import Path
from typing import NamedTuple


FIXED_TIMESTAMP = (2026, 1, 1, 0, 0, 0)
PACKAGE_FILES = (
    "common.js",
    "extension.css",
    "icons/icon-16.png",
    "icons/icon-32.png",
    "icons/icon-48.png",
    "icons/icon-128.png",
    "icons/icon.svg",
    "manifest.json",
    "newtab.html",
    "newtab.js",
    "options.html",
    "options.js",
    "popup.html",
    "popup.js",
)


class PackageSpec(NamedTuple):
    browser: str
    archive_name: str
    folder_name: str


PACKAGES = (
    PackageSpec(
        browser="chromium",
        archive_name="TabMonger-Chromium-extension.zip",
        folder_name="TabMonger-Chromium-extension",
    ),
    PackageSpec(
        browser="firefox",
        archive_name="TabMonger-Firefox-extension.zip",
        folder_name="TabMonger-Firefox-extension",
    ),
)


def _zip_info(name: str) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, date_time=FIXED_TIMESTAMP)
    info.compress_type = zipfile.ZIP_DEFLATED
    info.create_system = 3
    info.external_attr = (stat.S_IFREG | 0o644) << 16
    return info


def _validated_files(project: Path, spec: PackageSpec) -> list[tuple[str, Path]]:
    package_root = project / "extensions" / spec.browser
    if not package_root.is_dir():
        raise FileNotFoundError(f"extension package is missing: {package_root}")

    files: list[tuple[str, Path]] = []
    for relative in PACKAGE_FILES:
        path = package_root / relative
        if path.is_symlink() or not path.is_file():
            raise FileNotFoundError(f"required extension file is missing or unsafe: {path}")
        files.append((relative, path))

    manifest = json.loads((package_root / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("manifest_version") != 3:
        raise ValueError(f"{spec.browser} manifest must use Manifest V3")
    if manifest.get("name") != "TabMonger New Tab":
        raise ValueError(f"unexpected {spec.browser} extension name")
    if spec.browser == "firefox" and not (
        manifest.get("browser_specific_settings", {}).get("gecko", {}).get("id")
    ):
        raise ValueError("Firefox manifest must include a Gecko extension ID")

    return files


def _write_checksum(archive: Path) -> Path:
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    checksum = archive.with_suffix(archive.suffix + ".sha256")
    checksum.write_text(f"{digest}  {archive.name}\n", encoding="utf-8")
    return checksum


def build_package(project: Path, output_dir: Path, spec: PackageSpec) -> tuple[Path, Path]:
    """Build one browser package and its standard SHA-256 sidecar."""

    project = project.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    archive_path = output_dir / spec.archive_name
    files = _validated_files(project, spec)

    with zipfile.ZipFile(
        archive_path,
        "w",
        compression=zipfile.ZIP_DEFLATED,
        compresslevel=9,
        strict_timestamps=True,
    ) as archive:
        for relative, path in files:
            member = f"{spec.folder_name}/{relative}"
            archive.writestr(_zip_info(member), path.read_bytes())

    return archive_path, _write_checksum(archive_path)


def build_all(project: Path, output_dir: Path) -> list[tuple[Path, Path]]:
    """Build both browser packages in stable order."""

    return [build_package(project, output_dir, spec) for spec in PACKAGES]


def main() -> int:
    project = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=project)
    parser.add_argument("--output-dir", type=Path, default=project / "dist")
    args = parser.parse_args()

    for archive, checksum in build_all(args.source, args.output_dir):
        digest = checksum.read_text(encoding="utf-8").split()[0]
        print(f"Built {archive}")
        print(f"SHA-256: {digest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
