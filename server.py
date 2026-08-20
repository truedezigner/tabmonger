#!/usr/bin/env python3
"""TabMonger: a dependency-free personal launch dashboard."""

from __future__ import annotations

import argparse
import base64
import html
import ipaddress
import json
import mimetypes
import os
import re
import socket
import sqlite3
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urljoin, urlparse
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / "public"
DATA = ROOT / "data"
BACKUPS = DATA / "backups"
UPLOADS = ROOT / "assets" / "uploads"
DB_PATH = DATA / "tabmonger.db"
MAX_BODY = 24 * 1024 * 1024
LOCK = threading.RLock()
CACHE_LOCK = threading.RLock()
GLANCE_WAKE = threading.Event()
GLANCE_CACHE = {
    "services": {}, "weather": None, "backup": None, "updated_at": None,
    "interval_seconds": 300, "down_interval_seconds": 900,
}
ENDPOINT_CACHE: dict[tuple[str, int], dict] = {}

DEFAULT_SETTINGS = {
    "title": "TabMonger",
    "subtitle": "Your links. No ceremony.",
    "theme": "dark",
    "background_color": "#07110f",
    "background_image": "",
    "background_overlay": "0.46",
    "homepage_search": "true",
    "search_provider": "searxng",
    "searxng_url": "",
    "open_target": "same",
    "show_mode": "pinned",
    "tile_size": "medium",
    "show_glance": "true",
    "monitor_services": "true",
    "weather_enabled": "true",
    "weather_location": "",
    "weather_units": "f",
    "custom_css": "",
    "custom_js": "",
}


def connect() -> sqlite3.Connection:
    db = sqlite3.connect(DB_PATH, timeout=10)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    db.execute("PRAGMA journal_mode=WAL")
    return db


def init_db() -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    UPLOADS.mkdir(parents=True, exist_ok=True)
    with connect() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS items (
              id TEXT PRIMARY KEY,
              title TEXT NOT NULL,
              url TEXT NOT NULL,
              description TEXT NOT NULL DEFAULT '',
              color TEXT NOT NULL DEFAULT '#17211f',
              icon TEXT NOT NULL DEFAULT '',
              pinned INTEGER NOT NULL DEFAULT 1,
              monitor INTEGER NOT NULL DEFAULT 1,
              position INTEGER NOT NULL DEFAULT 0,
              deleted_at TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS tags (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL UNIQUE COLLATE NOCASE,
              color TEXT NOT NULL DEFAULT '#58d6a3',
              position INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS item_tags (
              item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
              tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
              PRIMARY KEY(item_id, tag_id)
            );
            CREATE TABLE IF NOT EXISTS settings (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL
            );
            """
        )
        db.executemany(
            "INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)",
            DEFAULT_SETTINGS.items(),
        )
        columns = {row["name"] for row in db.execute("PRAGMA table_info(items)")}
        if "monitor" not in columns:
            db.execute("ALTER TABLE items ADD COLUMN monitor INTEGER NOT NULL DEFAULT 1")


def now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def private_endpoint(value: str) -> tuple[str, int] | None:
    """Return a LAN endpoint without making any DNS request."""
    try:
        parsed = urlparse(value)
        host = parsed.hostname or ""
        if host.lower() == "localhost" or host.lower().endswith((".local", ".lan")):
            private = True
        else:
            private = ipaddress.ip_address(host).is_private
        if not private:
            return None
        return host, parsed.port or (443 if parsed.scheme == "https" else 80)
    except (ValueError, TypeError):
        return None


def check_endpoint(endpoint: tuple[str, int]) -> dict:
    started = time.monotonic()
    try:
        with socket.create_connection(endpoint, timeout=1.25):
            pass
        return {"state": "up", "latency_ms": round((time.monotonic() - started) * 1000)}
    except OSError:
        return {"state": "down", "latency_ms": None}


def refresh_services(settings: dict) -> None:
    if settings.get("monitor_services", "true") != "true":
        with CACHE_LOCK:
            GLANCE_CACHE["services"] = {}
            ENDPOINT_CACHE.clear()
        return
    with connect() as db:
        rows = [dict(x) for x in db.execute("SELECT id,title,url FROM items WHERE deleted_at IS NULL AND monitor=1")]
    endpoints = {endpoint for row in rows if (endpoint := private_endpoint(row["url"]))}
    clock = time.monotonic()
    with CACHE_LOCK:
        for stale in set(ENDPOINT_CACHE) - endpoints:
            ENDPOINT_CACHE.pop(stale, None)
        due = {endpoint for endpoint in endpoints if ENDPOINT_CACHE.get(endpoint, {}).get("next_check", 0) <= clock}
    checked_results = {}
    if due:
        with ThreadPoolExecutor(max_workers=min(8, len(due))) as pool:
            futures = {endpoint: pool.submit(check_endpoint, endpoint) for endpoint in due}
            checked_results = {endpoint: future.result() for endpoint, future in futures.items()}
        failed = {endpoint for endpoint, result in checked_results.items() if result["state"] == "down"}
        if failed:
            # Only publish an outage after the same endpoint fails twice.
            time.sleep(15)
            with ThreadPoolExecutor(max_workers=min(8, len(failed))) as pool:
                retries = {endpoint: pool.submit(check_endpoint, endpoint) for endpoint in failed}
                for endpoint, future in retries.items():
                    checked_results[endpoint] = future.result()
    checked = now()
    with CACHE_LOCK:
        for endpoint, result in checked_results.items():
            interval = 900 if result["state"] == "down" else 300
            ENDPOINT_CACHE[endpoint] = {
                **result,
                "checked_at": checked,
                "confirmed": result["state"] == "down",
                "check_interval_seconds": interval,
                "next_check": time.monotonic() + interval,
            }
        services = {}
        for row in rows:
            endpoint = private_endpoint(row["url"])
            endpoint_state = ENDPOINT_CACHE.get(endpoint)
            if endpoint_state:
                services[row["id"]] = {
                    "title": row["title"],
                    **{key: value for key, value in endpoint_state.items() if key != "next_check"},
                }
        GLANCE_CACHE["services"] = services
        GLANCE_CACHE["updated_at"] = checked


def refresh_weather(settings: dict) -> None:
    if settings.get("weather_enabled", "true") != "true":
        with CACHE_LOCK:
            GLANCE_CACHE["weather"] = None
        return
    location = settings.get("weather_location", "").strip()
    target = f"https://wttr.in/{quote(location)}?format=j2"
    try:
        request = Request(target, headers={"User-Agent": "TabMonger/1.0 (cached weather glance)"})
        with urlopen(request, timeout=7) as response:
            payload = json.loads(response.read(160 * 1024))
        current = payload["current_condition"][0]
        area = payload.get("nearest_area", [{}])[0]
        area_name = area.get("areaName", [{}])[0].get("value", "")
        region = area.get("region", [{}])[0].get("value", "")
        weather = {
            "temp_f": current.get("temp_F"),
            "temp_c": current.get("temp_C"),
            "condition": current.get("weatherDesc", [{}])[0].get("value", "Weather"),
            "code": current.get("weatherCode", ""),
            "location": location or ", ".join(x for x in (area_name, region) if x),
            "updated_at": now(),
        }
        with CACHE_LOCK:
            GLANCE_CACHE["weather"] = weather
    except (OSError, ValueError, KeyError, json.JSONDecodeError):
        # A stale reading is more useful than making the dashboard wait or flicker.
        pass


def ensure_daily_backup() -> None:
    BACKUPS.mkdir(parents=True, exist_ok=True)
    day = time.strftime("%Y-%m-%d", time.localtime())
    destination = BACKUPS / f"tabmonger-{day}.json"
    try:
        if not destination.exists():
            temporary = BACKUPS / f".{destination.name}.tmp"
            temporary.write_text(json.dumps(snapshot(True), ensure_ascii=False), encoding="utf-8")
            os.replace(temporary, destination)
        backups = sorted(BACKUPS.glob("tabmonger-????-??-??.json"))
        for expired in backups[:-7]:
            expired.unlink()
        status = {"latest": destination.name, "count": min(len(backups), 7), "kept_days": 7}
    except OSError as exc:
        status = {"error": str(exc), "kept_days": 7}
    with CACHE_LOCK:
        GLANCE_CACHE["backup"] = status


def glance_worker() -> None:
    weather_due = 0.0
    while True:
        with connect() as db:
            settings = {x["key"]: x["value"] for x in db.execute("SELECT * FROM settings")}
        ensure_daily_backup()
        refresh_services(settings)
        if time.monotonic() >= weather_due:
            refresh_weather(settings)
            weather_due = time.monotonic() + 1800
        GLANCE_WAKE.wait(300)
        if GLANCE_WAKE.is_set():
            weather_due = 0.0
            GLANCE_WAKE.clear()


def glance_snapshot() -> dict:
    with CACHE_LOCK:
        return {
            "services": {key: dict(value) for key, value in GLANCE_CACHE["services"].items()},
            "weather": dict(GLANCE_CACHE["weather"]) if GLANCE_CACHE["weather"] else None,
            "backup": dict(GLANCE_CACHE["backup"]) if GLANCE_CACHE["backup"] else None,
            "updated_at": GLANCE_CACHE["updated_at"],
            "interval_seconds": GLANCE_CACHE["interval_seconds"],
            "down_interval_seconds": GLANCE_CACHE["down_interval_seconds"],
        }


def item_dict(db: sqlite3.Connection, row: sqlite3.Row) -> dict:
    out = dict(row)
    out["pinned"] = bool(out["pinned"])
    out["monitor"] = bool(out["monitor"])
    out["tags"] = [
        dict(x)
        for x in db.execute(
            """SELECT t.id,t.name,t.color FROM tags t
               JOIN item_tags it ON it.tag_id=t.id
               WHERE it.item_id=? ORDER BY t.position,t.name""",
            (row["id"],),
        )
    ]
    return out


def snapshot(include_assets: bool = False) -> dict:
    with connect() as db:
        items = [item_dict(db, x) for x in db.execute("SELECT * FROM items ORDER BY position,title")]
        tags = [dict(x) for x in db.execute("SELECT * FROM tags ORDER BY position,name")]
        settings = {x["key"]: x["value"] for x in db.execute("SELECT * FROM settings")}
    result = {"format": "tabmonger-v1", "exportedAt": now(), "settings": settings, "tags": tags, "items": items}
    if include_assets:
        assets = {}
        paths = {x["icon"] for x in items if str(x["icon"]).startswith("/assets/uploads/")}
        bg = settings.get("background_image", "")
        if bg.startswith("/assets/uploads/"):
            paths.add(bg)
        for web_path in paths:
            file_path = ROOT / web_path.lstrip("/")
            if file_path.is_file():
                mime = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
                assets[web_path] = f"data:{mime};base64," + base64.b64encode(file_path.read_bytes()).decode()
        result["assets"] = assets
    return result


def safe_id(value: object = None) -> str:
    text = str(value or "").strip()
    return text if re.fullmatch(r"[A-Za-z0-9_-]{1,80}", text) else uuid.uuid4().hex[:12]


def normalize_url(value: object) -> str:
    url = str(value or "").strip()
    if not url:
        raise ValueError("URL is required")
    parsed = urlparse(url if "://" in url else "https://" + url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("Use a valid http:// or https:// URL")
    return parsed.geturl()


def save_data_url(value: str, prefix: str) -> str:
    match = re.fullmatch(r"data:([\w.+-]+/[\w.+-]+);base64,(.+)", value, re.S)
    if not match:
        raise ValueError("Invalid uploaded image")
    raw = base64.b64decode(match.group(2), validate=True)
    if len(raw) > 12 * 1024 * 1024:
        raise ValueError("Image is larger than 12 MB")
    mime = match.group(1).lower()
    ext = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif", "image/svg+xml": ".svg"}.get(mime)
    if not ext:
        raise ValueError("Unsupported image type")
    name = f"{prefix}-{uuid.uuid4().hex[:12]}{ext}"
    (UPLOADS / name).write_bytes(raw)
    return "/assets/uploads/" + name


def discover_website(value: object) -> dict:
    url = normalize_url(value)
    request = Request(url, headers={"User-Agent": "TabMonger/1.0"})
    with urlopen(request, timeout=8) as response:
        final_url = response.geturl()
        raw = response.read(1024 * 1024)
        charset = response.headers.get_content_charset() or "utf-8"
    page = raw.decode(charset, "replace")
    title_match = re.search(r"<title[^>]*>(.*?)</title>", page, re.I | re.S)
    title = html.unescape(re.sub(r"\s+", " ", title_match.group(1)).strip()) if title_match else ""
    description = ""
    for match in re.finditer(r"<meta\s+[^>]*>", page, re.I):
        tag = match.group(0)
        if re.search(r"(?:name|property)\s*=\s*['\"](?:description|og:description)['\"]", tag, re.I):
            content = re.search(r"content\s*=\s*(['\"])(.*?)\1", tag, re.I | re.S)
            if content:
                description = html.unescape(re.sub(r"\s+", " ", content.group(2)).strip())
                break
    icons = []
    for match in re.finditer(r"<link\s+[^>]*>", page, re.I):
        tag = match.group(0)
        if re.search(r"rel\s*=\s*['\"][^'\"]*icon", tag, re.I):
            href = re.search(r"href\s*=\s*(['\"])(.*?)\1", tag, re.I | re.S)
            if href:
                icons.append(urljoin(final_url, html.unescape(href.group(2))))
    if not icons:
        icons.append(urljoin(final_url, "/favicon.ico"))
    return {"url": final_url, "title": title, "description": description, "icon": icons[-1]}


def upsert_item(payload: dict, item_id: str | None = None) -> dict:
    title = str(payload.get("title", "")).strip()
    if not title:
        raise ValueError("Title is required")
    url = normalize_url(payload.get("url"))
    color = str(payload.get("color") or payload.get("colour") or "#17211f")[:32]
    icon = str(payload.get("icon") or "")
    if icon.startswith("data:"):
        icon = save_data_url(icon, "icon")
    stamp = now()
    with LOCK, connect() as db:
        if item_id:
            exists = db.execute("SELECT id FROM items WHERE id=?", (item_id,)).fetchone()
            if not exists:
                raise KeyError("Item not found")
            db.execute(
                """UPDATE items SET title=?,url=?,description=?,color=?,icon=?,pinned=?,monitor=?,updated_at=? WHERE id=?""",
                (title, url, str(payload.get("description") or payload.get("appdescription") or ""), color, icon,
                 1 if payload.get("pinned", True) else 0, 1 if payload.get("monitor", True) else 0, stamp, item_id),
            )
        else:
            item_id = safe_id(payload.get("id"))
            while db.execute("SELECT 1 FROM items WHERE id=?", (item_id,)).fetchone():
                item_id = safe_id()
            position = db.execute("SELECT COALESCE(MAX(position),-1)+1 FROM items").fetchone()[0]
            db.execute(
                """INSERT INTO items(id,title,url,description,color,icon,pinned,monitor,position,deleted_at,created_at,updated_at)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
                (item_id, title, url, str(payload.get("description") or payload.get("appdescription") or ""), color, icon,
                 1 if payload.get("pinned", True) else 0, 1 if payload.get("monitor", True) else 0,
                 position, payload.get("deleted_at"), stamp, stamp),
            )
        tag_ids = []
        for tag in payload.get("tags", []):
            if isinstance(tag, str):
                name, tag_id, tag_color = tag.strip(), safe_id(), "#58d6a3"
            else:
                name = str(tag.get("name", "")).strip()
                tag_id, tag_color = safe_id(tag.get("id")), str(tag.get("color") or "#58d6a3")[:32]
            if not name:
                continue
            existing = db.execute("SELECT id FROM tags WHERE name=? COLLATE NOCASE", (name,)).fetchone()
            if existing:
                tag_id = existing[0]
            else:
                pos = db.execute("SELECT COALESCE(MAX(position),-1)+1 FROM tags").fetchone()[0]
                db.execute("INSERT INTO tags(id,name,color,position) VALUES(?,?,?,?)", (tag_id, name, tag_color, pos))
            tag_ids.append(tag_id)
        db.execute("DELETE FROM item_tags WHERE item_id=?", (item_id,))
        db.executemany("INSERT OR IGNORE INTO item_tags(item_id,tag_id) VALUES(?,?)", [(item_id, x) for x in tag_ids])
        row = db.execute("SELECT * FROM items WHERE id=?", (item_id,)).fetchone()
        return item_dict(db, row)


def import_snapshot(payload: object, replace: bool = False) -> dict:
    if isinstance(payload, list):
        payload = {"format": "heimdall", "items": payload}
    if not isinstance(payload, dict) or not isinstance(payload.get("items"), list):
        raise ValueError("Import must contain an items array")
    assets = payload.get("assets", {}) if isinstance(payload.get("assets"), dict) else {}
    asset_map = {}
    for old_path, data_url in assets.items():
        if isinstance(data_url, str) and data_url.startswith("data:image/"):
            asset_map[str(old_path)] = save_data_url(data_url, "import")
    if replace:
        with LOCK, connect() as db:
            db.execute("DELETE FROM items")
            db.execute("DELETE FROM tags")
    imported, failed = 0, []
    for raw in payload["items"]:
        try:
            if not isinstance(raw, dict):
                raise ValueError("Item is not an object")
            converted = dict(raw)
            converted["color"] = raw.get("color") or raw.get("colour") or "#17211f"
            converted["description"] = raw.get("description") if payload.get("format") == "tabmonger-v1" else raw.get("appdescription", "")
            converted["icon"] = asset_map.get(str(raw.get("icon", "")), raw.get("icon", ""))
            upsert_item(converted)
            imported += 1
        except Exception as exc:
            failed.append({"title": raw.get("title", "Unknown") if isinstance(raw, dict) else "Unknown", "error": str(exc)})
    settings = payload.get("settings")
    if isinstance(settings, dict):
        with connect() as db:
            for key, value in settings.items():
                if key in DEFAULT_SETTINGS:
                    value = asset_map.get(str(value), value)
                    if key == "background_image" and isinstance(value, str) and value.startswith("data:image/"):
                        value = save_data_url(value, "background")
                    db.execute("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)", (key, str(value)))
    return {"imported": imported, "failed": failed}


class Handler(SimpleHTTPRequestHandler):
    server_version = "TabMonger/1.0"

    def log_message(self, fmt: str, *args: object) -> None:
        print(f"[{self.log_date_time_string()}] {fmt % args}")

    def end_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("Cache-Control", "no-store" if self.path.startswith("/api/") else "no-cache")
        super().end_headers()

    def send_json(self, value: object, status: int = 200) -> None:
        raw = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        if length < 1 or length > MAX_BODY:
            raise ValueError("Invalid request size")
        return json.loads(self.rfile.read(length))

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/state":
            self.send_json(snapshot(False)); return
        if parsed.path == "/api/glance":
            self.send_json(glance_snapshot()); return
        if parsed.path == "/api/export":
            self.send_json(snapshot(True)); return
        if parsed.path == "/api/health":
            state = snapshot(False)
            self.send_json({"ok": True, "items": len(state["items"]), "name": "TabMonger"}); return
        if parsed.path.startswith("/assets/uploads/"):
            self.serve_path(ROOT / parsed.path.lstrip("/")); return
        if parsed.path in {"/", "/index.html"}:
            self.serve_path(PUBLIC / "index.html"); return
        requested = (PUBLIC / parsed.path.lstrip("/")).resolve()
        if requested.is_relative_to(PUBLIC.resolve()) and requested.is_file():
            self.serve_path(requested); return
        self.send_error(404)

    def serve_path(self, path: Path) -> None:
        if not path.is_file():
            self.send_error(404); return
        raw = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(path.name)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_POST(self) -> None:
        try:
            payload = self.read_json()
            if self.path == "/api/items":
                item = upsert_item(payload)
                GLANCE_WAKE.set()
                self.send_json(item, 201); return
            if self.path == "/api/import":
                self.send_json(import_snapshot(payload.get("data", payload), bool(payload.get("replace", False)))); return
            if self.path == "/api/background":
                path = save_data_url(str(payload.get("data", "")), "background")
                with connect() as db: db.execute("INSERT OR REPLACE INTO settings(key,value) VALUES('background_image',?)", (path,))
                self.send_json({"path": path}); return
            if self.path == "/api/discover":
                self.send_json(discover_website(payload.get("url"))); return
            self.send_error(404)
        except (ValueError, json.JSONDecodeError, OSError) as exc:
            self.send_json({"error": str(exc)}, 400)

    def do_PUT(self) -> None:
        try:
            payload = self.read_json()
            if self.path.startswith("/api/items/"):
                item = upsert_item(payload, self.path.rsplit("/", 1)[-1])
                GLANCE_WAKE.set()
                self.send_json(item); return
            if self.path == "/api/order":
                with connect() as db:
                    for pos, item_id in enumerate(payload.get("ids", [])):
                        db.execute("UPDATE items SET position=?,updated_at=? WHERE id=?", (pos, now(), str(item_id)))
                self.send_json({"ok": True}); return
            if self.path == "/api/settings":
                with connect() as db:
                    for key, value in payload.items():
                        if key in DEFAULT_SETTINGS:
                            db.execute("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)", (key, str(value)))
                if "monitor_services" in payload and str(payload["monitor_services"]).lower() == "false":
                    with CACHE_LOCK:
                        GLANCE_CACHE["services"] = {}
                        ENDPOINT_CACHE.clear()
                if any(key in payload for key in ("monitor_services", "weather_enabled", "weather_location", "weather_units")):
                    GLANCE_WAKE.set()
                self.send_json({"ok": True}); return
            if self.path.startswith("/api/tags/"):
                tag_id = self.path.rsplit("/", 1)[-1]
                with connect() as db:
                    db.execute("UPDATE tags SET name=?,color=? WHERE id=?", (str(payload.get("name", "")).strip(), str(payload.get("color", "#58d6a3")), tag_id))
                self.send_json({"ok": True}); return
            self.send_error(404)
        except (ValueError, KeyError, json.JSONDecodeError, sqlite3.IntegrityError) as exc:
            self.send_json({"error": str(exc)}, 400 if not isinstance(exc, KeyError) else 404)

    def do_DELETE(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/items/"):
            item_id = parsed.path.rsplit("/", 1)[-1]
            permanent = parse_qs(parsed.query).get("permanent", ["false"])[0] == "true"
            with connect() as db:
                if permanent: db.execute("DELETE FROM items WHERE id=?", (item_id,))
                else: db.execute("UPDATE items SET deleted_at=?,updated_at=? WHERE id=?", (now(), now(), item_id))
            self.send_json({"ok": True}); return
        if parsed.path.startswith("/api/tags/"):
            with connect() as db: db.execute("DELETE FROM tags WHERE id=?", (parsed.path.rsplit("/", 1)[-1],))
            self.send_json({"ok": True}); return
        self.send_error(404)

    def do_PATCH(self) -> None:
        if self.path.startswith("/api/items/"):
            try: payload = self.read_json()
            except Exception as exc: self.send_json({"error": str(exc)}, 400); return
            item_id = self.path.rsplit("/", 1)[-1]
            allowed = {"pinned", "deleted_at"}
            with connect() as db:
                if "pinned" in payload: db.execute("UPDATE items SET pinned=?,updated_at=? WHERE id=?", (1 if payload["pinned"] else 0, now(), item_id))
                if "deleted_at" in payload and payload["deleted_at"] is None: db.execute("UPDATE items SET deleted_at=NULL,updated_at=? WHERE id=?", (now(), item_id))
            self.send_json({"ok": True, "fields": list(allowed & payload.keys())}); return
        self.send_error(404)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default=os.getenv("TABMONGER_HOST", "0.0.0.0"))
    parser.add_argument("--port", type=int, default=int(os.getenv("TABMONGER_PORT", "8787")))
    args = parser.parse_args()
    init_db()
    threading.Thread(target=glance_worker, name="tabmonger-glance", daemon=True).start()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"TabMonger listening on http://{args.host}:{args.port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
