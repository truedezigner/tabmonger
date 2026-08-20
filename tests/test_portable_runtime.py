from __future__ import annotations

import base64
import http.client
import importlib.util
import json
import os
import stat
import tempfile
import threading
import unittest
import zipfile
from pathlib import Path
from unittest import mock


PROJECT = Path(__file__).resolve().parents[1]

server_spec = importlib.util.spec_from_file_location("tabmonger_server", PROJECT / "server.py")
assert server_spec and server_spec.loader
server = importlib.util.module_from_spec(server_spec)
server_spec.loader.exec_module(server)

release_spec = importlib.util.spec_from_file_location("tabmonger_release", PROJECT / "packaging" / "build_release.py")
assert release_spec and release_spec.loader
release = importlib.util.module_from_spec(release_spec)
release_spec.loader.exec_module(release)


class DataDirectoryTests(unittest.TestCase):
    def test_clean_linux_uses_xdg_user_data(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "checkout"
            xdg = Path(temporary) / "private"
            root.mkdir()
            selected = server.default_data_dir(
                environ={"XDG_DATA_HOME": str(xdg)},
                platform_name="linux",
                home=Path(temporary) / "home",
                project_root=root,
            )
            self.assertEqual(selected, (xdg / "tabmonger").resolve())

    def test_clean_macos_and_windows_use_native_user_folders(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            root = base / "checkout"
            root.mkdir()
            mac = server.default_data_dir({}, "darwin", base / "home", root)
            windows = server.default_data_dir(
                {"LOCALAPPDATA": str(base / "LocalAppData")}, "win32", base / "home", root
            )
            self.assertEqual(mac, (base / "home" / "Library" / "Application Support" / "TabMonger").resolve())
            self.assertEqual(windows, (base / "LocalAppData" / "TabMonger").resolve())

    def test_legacy_database_is_preserved_but_explicit_path_wins(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "checkout"
            legacy = root / "data"
            legacy.mkdir(parents=True)
            (legacy / "tabmonger.db").touch()
            self.assertEqual(
                server.default_data_dir({}, "linux", Path(temporary) / "home", root), legacy.resolve()
            )
            explicit = Path(temporary) / "chosen"
            self.assertEqual(
                server.default_data_dir(
                    {"TABMONGER_DATA_DIR": str(explicit)}, "linux", Path(temporary) / "home", root
                ),
                explicit.resolve(),
            )

    def test_new_database_defaults_are_private_and_opt_in(self) -> None:
        original_data, original_uploads = server.DATA, server.UPLOADS
        try:
            with tempfile.TemporaryDirectory() as temporary:
                data = Path(temporary) / "state"
                server.configure_runtime(data)
                server.init_db()
                self.assertEqual(server.UPLOADS, data / "uploads")
                with server.connect() as database:
                    settings = {row["key"]: row["value"] for row in database.execute("SELECT * FROM settings")}
                self.assertEqual(settings["search_provider"], "tiles")
                self.assertEqual(settings["monitor_services"], "false")
                self.assertEqual(settings["weather_enabled"], "false")
                self.assertEqual(settings["background_color"], "#0c131d")
        finally:
            server.configure_runtime(original_data, original_uploads)

    @unittest.skipUnless(os.name == "posix", "POSIX permissions only")
    def test_runtime_enforces_owner_only_state_permissions(self) -> None:
        original_data, original_uploads = server.DATA, server.UPLOADS
        try:
            with tempfile.TemporaryDirectory() as temporary:
                data = Path(temporary) / "state"
                server.configure_runtime(data)
                server.init_db()
                upload_path = server.save_data_url(
                    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB", "icon"
                )
                server.ensure_daily_backup()

                for directory in (server.DATA, server.UPLOADS, server.BACKUPS):
                    self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o700)
                private_files = [
                    server.DB_PATH,
                    server.uploaded_file(upload_path),
                    *server.BACKUPS.glob("tabmonger-*.json"),
                ]
                for private_file in private_files:
                    self.assertIsNotNone(private_file)
                    self.assertEqual(stat.S_IMODE(private_file.stat().st_mode), 0o600)
        finally:
            server.configure_runtime(original_data, original_uploads)


class QuietHandler(server.Handler):
    def log_message(self, fmt: str, *args: object) -> None:
        pass


class BrowserRequestGuardTests(unittest.TestCase):
    def setUp(self) -> None:
        self.original_data, self.original_uploads = server.DATA, server.UPLOADS
        self.temporary = tempfile.TemporaryDirectory()
        server.configure_runtime(Path(self.temporary.name) / "state")
        server.init_db()
        self.httpd = server.TabMongerHTTPServer(("127.0.0.1", 0), QuietHandler)
        self.port = int(self.httpd.server_address[1])
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.env_patch = mock.patch.dict(os.environ, {"TABMONGER_ALLOWED_HOSTS": ""})
        self.env_patch.start()

    def tearDown(self) -> None:
        self.env_patch.stop()
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=2)
        server.configure_runtime(self.original_data, self.original_uploads)
        self.temporary.cleanup()

    def request(self, method: str, path: str, payload: dict | None = None, headers: dict | None = None):
        status, _, raw = self.request_raw(method, path, payload, headers)
        return status, json.loads(raw) if raw else None

    def request_raw(self, method: str, path: str, payload: dict | None = None, headers: dict | None = None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        body = json.dumps(payload).encode() if payload is not None else None
        all_headers = {"Content-Type": "application/json"}
        all_headers.update(headers or {})
        connection.request(method, path, body=body, headers=all_headers)
        response = connection.getresponse()
        raw = response.read()
        response_headers = dict(response.getheaders())
        connection.close()
        return response.status, response_headers, raw

    def new_item(self, title: str) -> dict:
        return {"title": title, "url": "https://example.com"}

    def test_matching_same_origin_browser_mutation_is_allowed(self) -> None:
        origin = f"http://127.0.0.1:{self.port}"
        status, payload = self.request(
            "POST", "/api/items", self.new_item("Allowed"), {"Origin": origin, "Sec-Fetch-Site": "same-origin"}
        )
        self.assertEqual(status, 201)
        self.assertEqual(payload["title"], "Allowed")

    def test_dashboard_cannot_be_framed(self) -> None:
        status, headers, _ = self.request_raw("GET", "/")
        self.assertEqual(status, 200)
        self.assertEqual(headers["X-Frame-Options"], "DENY")
        self.assertIn("frame-ancestors 'none'", headers["Content-Security-Policy"])

    def test_head_only_exposes_public_routes_not_project_files(self) -> None:
        status, headers, raw = self.request_raw("HEAD", "/")
        self.assertEqual(status, 200)
        self.assertEqual(raw, b"")
        self.assertEqual(headers["X-Frame-Options"], "DENY")

        status, _, raw = self.request_raw("HEAD", "/api/health")
        self.assertEqual(status, 200)
        self.assertEqual(raw, b"")

        status, _, raw = self.request_raw("HEAD", "/server.py")
        self.assertEqual(status, 404)
        self.assertEqual(raw, b"")

    def test_mismatched_origin_and_cross_site_requests_are_rejected(self) -> None:
        status, _ = self.request(
            "POST",
            "/api/items",
            self.new_item("Rejected origin"),
            {"Origin": "https://public.example", "Sec-Fetch-Site": "same-site"},
        )
        self.assertEqual(status, 403)
        status, _ = self.request(
            "POST", "/api/items", self.new_item("Rejected cross-site"), {"Sec-Fetch-Site": "cross-site"}
        )
        self.assertEqual(status, 403)

    def test_rebinding_style_browser_host_is_rejected_for_read_and_write(self) -> None:
        browser_headers = {
            "Host": f"public.example:{self.port}",
            "Origin": f"http://public.example:{self.port}",
            "Sec-Fetch-Site": "same-origin",
        }
        status, _ = self.request("GET", "/api/state", headers=browser_headers)
        self.assertEqual(status, 403)
        status, _ = self.request("POST", "/api/items", self.new_item("Rejected host"), browser_headers)
        self.assertEqual(status, 403)

    def test_originless_cli_client_remains_supported(self) -> None:
        status, payload = self.request(
            "POST",
            "/api/items",
            self.new_item("CLI import"),
            {"Host": f"127.0.0.1:{self.port}"},
        )
        self.assertEqual(status, 201)
        self.assertEqual(payload["title"], "CLI import")

        status, _ = self.request(
            "GET", "/api/state", headers={"Host": f"automation.example:{self.port}"}
        )
        self.assertEqual(status, 403)

    def test_external_upload_is_served_and_included_in_portable_export(self) -> None:
        image_data = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
        web_path = server.save_data_url(image_data, "icon")
        server.upsert_item({"title": "External upload", "url": "https://example.com", "icon": web_path})
        self.assertEqual(server.uploaded_file(web_path).parent, server.UPLOADS)

        status, headers, raw = self.request_raw("GET", web_path)
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "image/png")
        self.assertEqual(raw, server.UPLOADS.joinpath(Path(web_path).name).read_bytes())

        status, exported = self.request("GET", "/api/export")
        self.assertEqual(status, 200)
        self.assertEqual(exported["assets"][web_path], image_data)

        status, _, _ = self.request_raw("GET", "/assets/uploads/../tabmonger.db")
        self.assertEqual(status, 404)
        status, _, _ = self.request_raw("GET", "/assets/uploads/%2e%2e%2ftabmonger.db")
        self.assertEqual(status, 404)

        outside = Path(self.temporary.name) / "outside.txt"
        outside.write_text("must-not-be-exported", encoding="utf-8")
        malicious_path = "/assets/uploads/../../outside.txt"
        server.upsert_item(
            {"title": "Traversal export", "url": "https://example.org", "icon": malicious_path}
        )
        exported = server.snapshot(True)
        self.assertNotIn(malicious_path, exported["assets"])
        self.assertNotIn("must-not-be-exported", json.dumps(exported))

    def test_uploaded_svg_is_sandboxed_as_inert_content(self) -> None:
        svg = b'<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/api/export")</script></svg>'
        data_url = "data:image/svg+xml;base64," + base64.b64encode(svg).decode()
        web_path = server.save_data_url(data_url, "icon")
        status, headers, raw = self.request_raw("GET", web_path)
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "image/svg+xml")
        self.assertEqual(raw, svg)
        self.assertIn("sandbox", headers["Content-Security-Policy"])
        self.assertIn("default-src 'none'", headers["Content-Security-Policy"])


class LauncherAndReleaseTests(unittest.TestCase):
    def test_shared_vpn_address_is_trusted(self) -> None:
        self.assertTrue(server.trusted_browser_host("100.100.10.10:8787"))
        self.assertEqual(server.private_endpoint("http://100.100.10.10:8787/"), ("100.100.10.10", 8787))

    def test_lan_urls_are_advertised(self) -> None:
        self.assertEqual(
            server.advertised_urls("0.0.0.0", 8787, ["192.168.1.24", "10.0.0.7"]),
            [
                ("This computer", "http://127.0.0.1:8787/"),
                ("Your network", "http://192.168.1.24:8787/"),
                ("Your network", "http://10.0.0.7:8787/"),
            ],
        )

    def test_release_zip_contains_runtime_and_no_private_or_operator_state(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "TabMonger.zip"
            manifest = release.build_archive(PROJECT, output)
            self.assertIn("server.py", manifest)
            with zipfile.ZipFile(output) as archive:
                names = archive.namelist()
                command = archive.getinfo("TabMonger/Start TabMonger.command")
            self.assertIn("TabMonger/START-HERE.txt", names)
            self.assertIn("TabMonger/public/index.html", names)
            self.assertIn("TabMonger/docs/INSTALL.md", names)
            self.assertIn("TabMonger/extensions/chromium/manifest.json", names)
            self.assertIn("TabMonger/extensions/firefox/manifest.json", names)
            self.assertTrue((command.external_attr >> 16) & 0o100)
            forbidden = ("/data/", "/assets/uploads/", "/site/", "/.git/")
            self.assertFalse(any(any(marker in name for marker in forbidden) for name in names))


if __name__ == "__main__":
    unittest.main()
