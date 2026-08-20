from __future__ import annotations

import hashlib
import importlib.util
import json
import stat
import tempfile
import unittest
import zipfile
from pathlib import Path


PROJECT = Path(__file__).resolve().parents[1]
builder_spec = importlib.util.spec_from_file_location(
    "tabmonger_extension_packages", PROJECT / "packaging" / "build_extensions.py"
)
assert builder_spec and builder_spec.loader
builder = importlib.util.module_from_spec(builder_spec)
builder_spec.loader.exec_module(builder)


class ExtensionPackageTests(unittest.TestCase):
    def _assert_package(self, archive: Path, checksum: Path, spec) -> None:
        self.assertEqual(archive.name, spec.archive_name)
        self.assertEqual(checksum.name, f"{spec.archive_name}.sha256")

        expected_digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        self.assertEqual(
            checksum.read_text(encoding="utf-8"),
            f"{expected_digest}  {spec.archive_name}\n",
        )

        with zipfile.ZipFile(archive) as package:
            names = package.namelist()
            expected_names = [
                f"{spec.folder_name}/{relative}" for relative in builder.PACKAGE_FILES
            ]
            self.assertEqual(names, expected_names)
            self.assertEqual({name.split("/", 1)[0] for name in names}, {spec.folder_name})

            for info in package.infolist():
                self.assertEqual(info.date_time, builder.FIXED_TIMESTAMP)
                self.assertEqual(stat.S_IFMT(info.external_attr >> 16), stat.S_IFREG)
                self.assertEqual(stat.S_IMODE(info.external_attr >> 16), 0o644)

            manifest = json.loads(
                package.read(f"{spec.folder_name}/manifest.json").decode("utf-8")
            )

        self.assertEqual(manifest["manifest_version"], 3)
        self.assertEqual(manifest["name"], "TabMonger New Tab")
        if spec.browser == "firefox":
            self.assertEqual(
                manifest["browser_specific_settings"]["gecko"]["id"],
                "newtab@tabmonger.com",
            )
        else:
            self.assertNotIn("browser_specific_settings", manifest)

        joined_names = "\n".join(names).lower()
        for forbidden in (
            "extensions/source",
            "extensions/scripts",
            "firefox" if spec.browser == "chromium" else "chromium",
            "/data/",
            "/uploads/",
            "/.git/",
            "tabmonger.db",
        ):
            self.assertNotIn(forbidden, joined_names)

    def test_builds_exact_private_state_free_packages_and_checksums(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "first"
            built = builder.build_all(PROJECT, output)
            self.assertEqual([pair[0].name for pair in built], [
                "TabMonger-Chromium-extension.zip",
                "TabMonger-Firefox-extension.zip",
            ])
            for (archive, checksum), spec in zip(built, builder.PACKAGES, strict=True):
                self._assert_package(archive, checksum, spec)

    def test_archives_are_byte_for_byte_reproducible(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            first = builder.build_all(PROJECT, root / "first")
            second = builder.build_all(PROJECT, root / "second")
            for (first_archive, first_checksum), (second_archive, second_checksum) in zip(
                first, second, strict=True
            ):
                self.assertEqual(first_archive.read_bytes(), second_archive.read_bytes())
                self.assertEqual(first_checksum.read_bytes(), second_checksum.read_bytes())


if __name__ == "__main__":
    unittest.main()
