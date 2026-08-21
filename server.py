#!/usr/bin/env python3
"""TabMonger: a dependency-free personal launch dashboard."""

from __future__ import annotations

import argparse
import base64
import errno
import html
import ipaddress
import json
import mimetypes
import os
import re
import socket
import sqlite3
import sys
import threading
import time
import uuid
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urljoin, urlparse
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / "public"
APP_VERSION = "1.2.1"
LEGACY_DATA = ROOT / "data"
LEGACY_UPLOADS = ROOT / "assets" / "uploads"
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
    "background_color": "#0c131d",
    "background_image": "",
    "background_overlay": "0.46",
    "homepage_search": "true",
    "search_provider": "tiles",
    "searxng_url": "",
    "open_target": "same",
    "show_mode": "pinned",
    "tile_size": "medium",
    "show_glance": "true",
    "monitor_services": "false",
    "weather_enabled": "false",
    "weather_location": "",
    "weather_units": "f",
    "custom_css": "",
    "custom_js": "",
}

SHARED_VPN_IPV4 = ipaddress.ip_network("100.64.0.0/10")


def trusted_network_address(address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    """Recognize loopback, RFC-private, and the shared range commonly used by private VPNs."""
    return address.is_private or address.is_loopback or (
        address.version == 4 and address in SHARED_VPN_IPV4
    )


def default_data_dir(
    environ: dict[str, str] | None = None,
    platform_name: str | None = None,
    home: Path | None = None,
    project_root: Path | None = None,
) -> Path:
    """Choose a private per-user state directory without breaking legacy installs."""
    env = os.environ if environ is None else environ
    explicit = env.get("TABMONGER_DATA_DIR", "").strip()
    if explicit:
        return Path(explicit).expanduser().resolve()

    root = ROOT if project_root is None else Path(project_root)
    legacy = root / "data"
    # Releases never contain this ignored database. Existing users who already
    # run from a checkout keep their state automatically after an upgrade.
    if (legacy / "tabmonger.db").is_file():
        return legacy.resolve()

    user_home = Path.home() if home is None else Path(home)
    platform_value = sys.platform if platform_name is None else platform_name
    if platform_value == "win32":
        base = Path(env.get("LOCALAPPDATA") or env.get("APPDATA") or user_home / "AppData" / "Local")
        return (base / "TabMonger").expanduser().resolve()
    if platform_value == "darwin":
        return (user_home / "Library" / "Application Support" / "TabMonger").resolve()
    base = Path(env.get("XDG_DATA_HOME") or user_home / ".local" / "share")
    return (base / "tabmonger").expanduser().resolve()


def configure_runtime(data_dir: str | os.PathLike[str] | None = None, uploads_dir: str | os.PathLike[str] | None = None) -> None:
    """Set runtime paths. Primarily used by the CLI and isolated tests."""
    global DATA, BACKUPS, UPLOADS, DB_PATH
    selected = Path(data_dir).expanduser().resolve() if data_dir else default_data_dir()
    explicit_uploads = uploads_dir or os.getenv("TABMONGER_UPLOADS_DIR", "").strip()
    if explicit_uploads:
        selected_uploads = Path(explicit_uploads).expanduser().resolve()
    elif selected == LEGACY_DATA.resolve():
        selected_uploads = LEGACY_UPLOADS.resolve()
    else:
        selected_uploads = selected / "uploads"
    DATA = selected
    BACKUPS = DATA / "backups"
    UPLOADS = selected_uploads
    DB_PATH = DATA / "tabmonger.db"


configure_runtime()


def ensure_private_directory(path: Path) -> None:
    """Create a state directory and keep it owner-only on POSIX hosts."""
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if os.name == "posix":
        path.chmod(0o700)


def ensure_private_file(path: Path) -> None:
    """Keep an existing state file readable and writable only by its owner."""
    if os.name == "posix" and path.is_file() and not path.is_symlink():
        path.chmod(0o600)


def write_private_file(path: Path, raw: bytes, *, exclusive: bool = False) -> None:
    """Write a private state file without a world-readable creation window."""
    flags = os.O_WRONLY | os.O_CREAT | (os.O_EXCL if exclusive else os.O_TRUNC)
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as destination:
            destination.write(raw)
    except Exception:
        try:
            os.close(descriptor)
        except OSError:
            pass
        raise
    ensure_private_file(path)


def uploaded_file(web_path: str) -> Path | None:
    """Map a public upload URL to configured private storage without traversal."""
    prefix = "/assets/uploads/"
    if not isinstance(web_path, str) or not web_path.startswith(prefix):
        return None
    name = web_path[len(prefix):]
    if not name or "/" in name or "\\" in name or name in {".", ".."}:
        return None
    upload_root = UPLOADS.resolve()
    candidate = (upload_root / name).resolve()
    if candidate.parent != upload_root:
        return None
    return candidate


def connect() -> sqlite3.Connection:
    db = sqlite3.connect(DB_PATH, timeout=10)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    db.execute("PRAGMA journal_mode=WAL")
    ensure_private_file(DB_PATH)
    ensure_private_file(DB_PATH.with_name(DB_PATH.name + "-wal"))
    ensure_private_file(DB_PATH.with_name(DB_PATH.name + "-shm"))
    return db


def init_db() -> None:
    ensure_private_directory(DATA)
    ensure_private_directory(UPLOADS)
    ensure_private_directory(BACKUPS)
    if not DB_PATH.exists():
        descriptor = os.open(DB_PATH, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.close(descriptor)
    ensure_private_file(DB_PATH)
    for private_file in (*UPLOADS.iterdir(), *BACKUPS.iterdir()):
        ensure_private_file(private_file)
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
              tile_dim INTEGER NOT NULL DEFAULT 0,
              icon_invert INTEGER NOT NULL DEFAULT 0,
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
        if "tile_dim" not in columns:
            db.execute("ALTER TABLE items ADD COLUMN tile_dim INTEGER NOT NULL DEFAULT 0")
        if "icon_invert" not in columns:
            db.execute("ALTER TABLE items ADD COLUMN icon_invert INTEGER NOT NULL DEFAULT 0")
        normalize_internal_ids(db)


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
            private = trusted_network_address(ipaddress.ip_address(host))
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
    ensure_private_directory(BACKUPS)
    day = time.strftime("%Y-%m-%d", time.localtime())
    destination = BACKUPS / f"tabmonger-{day}.json"
    try:
        if not destination.exists():
            temporary = BACKUPS / f".{destination.name}.tmp"
            write_private_file(
                temporary,
                json.dumps(snapshot(True), ensure_ascii=False).encode("utf-8"),
            )
            os.replace(temporary, destination)
        ensure_private_file(destination)
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
            file_path = uploaded_file(web_path)
            if file_path and file_path.is_file():
                mime = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
                assets[web_path] = f"data:{mime};base64," + base64.b64encode(file_path.read_bytes()).decode()
        result["assets"] = assets
    return result


def safe_id(value: object = None, prefix: str = "tm") -> str:
    text = str(value or "").strip()
    if re.fullmatch(rf"(?:{re.escape(prefix)}-)?[0-9a-f]{{12}}", text):
        return text
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


def unique_id(db: sqlite3.Connection, table: str, prefix: str) -> str:
    while True:
        candidate = safe_id(prefix=prefix)
        if not db.execute(f"SELECT 1 FROM {table} WHERE id=?", (candidate,)).fetchone():
            return candidate


def normalize_internal_ids(db: sqlite3.Connection) -> None:
    """Replace importer-era internal keys with neutral TabMonger identifiers."""
    original_item_count = db.execute("SELECT COUNT(*) FROM items").fetchone()[0]
    item_columns = [row["name"] for row in db.execute("PRAGMA table_info(items)")]
    quoted_item_columns = ",".join(f'"{name}"' for name in item_columns)
    item_placeholders = ",".join("?" for _ in item_columns)
    for row in list(db.execute("SELECT * FROM items ORDER BY position,id")):
        if safe_id(row["id"]) == row["id"]:
            continue
        replacement = unique_id(db, "items", "tm")
        values = [replacement if name == "id" else row[name] for name in item_columns]
        db.execute(
            f"INSERT INTO items({quoted_item_columns}) VALUES({item_placeholders})",
            values,
        )
        db.execute("UPDATE item_tags SET item_id=? WHERE item_id=?", (replacement, row["id"]))
        db.execute("DELETE FROM items WHERE id=?", (row["id"],))

    for row in list(db.execute("SELECT * FROM tags ORDER BY position,id")):
        if safe_id(row["id"], "tag") == row["id"]:
            continue
        replacement = unique_id(db, "tags", "tag")
        temporary_name = f"__tabmonger_tag_migration_{uuid.uuid4().hex}"
        db.execute(
            "INSERT INTO tags(id,name,color,position) VALUES(?,?,?,?)",
            (replacement, temporary_name, row["color"], row["position"]),
        )
        db.execute("UPDATE item_tags SET tag_id=? WHERE tag_id=?", (replacement, row["id"]))
        db.execute("DELETE FROM tags WHERE id=?", (row["id"],))
        db.execute("UPDATE tags SET name=? WHERE id=?", (row["name"], replacement))

    db.execute(
        """UPDATE items SET url=?,description=?
           WHERE deleted_at IS NOT NULL AND url LIKE 'http://invalid.local/%'""",
        (
            "http://invalid.local/unavailable-from-legacy-trash",
            "Imported from a legacy dashboard trash; the deleted URL was unavailable.",
        ),
    )
    if db.execute("SELECT COUNT(*) FROM items").fetchone()[0] != original_item_count:
        raise RuntimeError("Internal ID migration changed the item count")
    violations = list(db.execute("PRAGMA foreign_key_check"))
    if violations:
        raise RuntimeError("Internal ID migration failed its relationship check")


def normalize_url(value: object) -> str:
    url = str(value or "").strip()
    if not url:
        raise ValueError("URL is required")
    parsed = urlparse(url if "://" in url else "https://" + url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("Use a valid http:// or https:// URL")
    return parsed.geturl()


def appearance_level(value: object, default: int, maximum: int = 100) -> int:
    """Return a safe whole-number percentage for a per-link visual setting."""
    if value is None:
        return default
    try:
        level = round(float(value))
    except (TypeError, ValueError, OverflowError):
        raise ValueError("Tile appearance values must be percentages") from None
    return max(0, min(maximum, level))


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
    ensure_private_directory(UPLOADS)
    write_private_file(UPLOADS / name, raw, exclusive=True)
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
            exists = db.execute("SELECT * FROM items WHERE id=?", (item_id,)).fetchone()
            if not exists:
                raise KeyError("Item not found")
            tile_dim = appearance_level(payload.get("tile_dim"), exists["tile_dim"], 90)
            icon_invert = appearance_level(payload.get("icon_invert"), exists["icon_invert"])
            db.execute(
                """UPDATE items SET title=?,url=?,description=?,color=?,icon=?,tile_dim=?,icon_invert=?,
                   pinned=?,monitor=?,updated_at=? WHERE id=?""",
                (title, url, str(payload.get("description") or payload.get("appdescription") or ""), color, icon,
                 tile_dim, icon_invert, 1 if payload.get("pinned", True) else 0,
                 1 if payload.get("monitor", True) else 0, stamp, item_id),
            )
        else:
            item_id = safe_id(payload.get("id"))
            while db.execute("SELECT 1 FROM items WHERE id=?", (item_id,)).fetchone():
                item_id = safe_id()
            position = db.execute("SELECT COALESCE(MAX(position),-1)+1 FROM items").fetchone()[0]
            tile_dim = appearance_level(payload.get("tile_dim"), 0, 90)
            icon_invert = appearance_level(payload.get("icon_invert"), 0)
            db.execute(
                """INSERT INTO items(id,title,url,description,color,icon,tile_dim,icon_invert,pinned,
                   monitor,position,deleted_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (item_id, title, url, str(payload.get("description") or payload.get("appdescription") or ""), color, icon,
                 tile_dim, icon_invert, 1 if payload.get("pinned", True) else 0,
                 1 if payload.get("monitor", True) else 0, position, payload.get("deleted_at"), stamp, stamp),
            )
        tag_ids = []
        for tag in payload.get("tags", []):
            if isinstance(tag, str):
                name, tag_id, tag_color = tag.strip(), safe_id(prefix="tag"), "#58d6a3"
            else:
                name = str(tag.get("name", "")).strip()
                tag_id, tag_color = safe_id(tag.get("id"), "tag"), str(tag.get("color") or "#58d6a3")[:32]
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
        payload = {"items": payload}
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
            converted["description"] = raw.get("description") or raw.get("appdescription", "")
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


def _authority(value: str, scheme: str) -> tuple[str, int] | None:
    try:
        parsed = urlparse(f"{scheme}://{value}")
        if not parsed.hostname or parsed.username or parsed.password or parsed.path not in {"", "/"}:
            return None
        port = parsed.port or (443 if scheme == "https" else 80)
        return parsed.hostname.rstrip(".").casefold(), port
    except (TypeError, ValueError):
        return None


def trusted_browser_host(host_header: str, allowed_hosts: set[str] | None = None) -> bool:
    authority = _authority(host_header.strip(), "http")
    if not authority:
        return False
    hostname = authority[0]
    configured = {
        value.strip().rstrip(".").casefold()
        for value in os.getenv("TABMONGER_ALLOWED_HOSTS", "").split(",")
        if value.strip()
    }
    if allowed_hosts:
        configured.update(value.rstrip(".").casefold() for value in allowed_hosts)
    if hostname in configured:
        return True
    if hostname == "localhost" or hostname.endswith((".localhost", ".local", ".lan", ".home.arpa")):
        return True
    local_names = {socket.gethostname().rstrip(".").casefold(), socket.getfqdn().rstrip(".").casefold()}
    if hostname in local_names:
        return True
    try:
        return trusted_network_address(ipaddress.ip_address(hostname))
    except ValueError:
        return False


def browser_request_rejection(headers: object) -> str | None:
    """Reject untrusted Host and cross-site API requests, including legacy browsers."""
    get_header = getattr(headers, "get")
    origin = str(get_header("Origin", "") or "").strip()
    fetch_site = str(get_header("Sec-Fetch-Site", "") or "").strip().casefold()
    host_header = str(get_header("Host", "") or "").strip()
    if not trusted_browser_host(host_header):
        return "This Host is not allowed for API requests"
    if not origin and not fetch_site:
        return None
    if fetch_site == "cross-site":
        return "Cross-site browser requests are not allowed"
    if origin:
        parsed = urlparse(origin)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.path not in {"", "/"}:
            return "Invalid browser Origin"
        origin_authority = _authority(parsed.netloc, parsed.scheme)
        host_authority = _authority(host_header, parsed.scheme)
        if not origin_authority or origin_authority != host_authority:
            return "Browser Origin must match the request Host"
    return None


class Handler(SimpleHTTPRequestHandler):
    server_version = f"TabMonger/{APP_VERSION}"

    def log_message(self, fmt: str, *args: object) -> None:
        print(f"[{self.log_date_time_string()}] {fmt % args}")

    def end_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        csp = "frame-ancestors 'none'; base-uri 'self'; object-src 'none'"
        if getattr(self, "_sandbox_upload", False):
            csp += "; sandbox; default-src 'none'; style-src 'unsafe-inline'"
        self.send_header("Content-Security-Policy", csp)
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("Cache-Control", "no-store" if self.path.startswith("/api/") else "no-cache")
        super().end_headers()

    def send_json(self, value: object, status: int = 200, *, head_only: bool = False) -> None:
        raw = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        if not head_only:
            self.wfile.write(raw)

    def read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        if length < 1 or length > MAX_BODY:
            raise ValueError("Invalid request size")
        return json.loads(self.rfile.read(length))

    def reject_unsafe_browser_request(self) -> bool:
        reason = browser_request_rejection(self.headers)
        if not reason:
            return False
        self.send_json({"error": reason}, 403)
        return True

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/") and self.reject_unsafe_browser_request():
            return
        if parsed.path == "/api/state":
            self.send_json(snapshot(False)); return
        if parsed.path == "/api/glance":
            self.send_json(glance_snapshot()); return
        if parsed.path == "/api/export":
            self.send_json(snapshot(True)); return
        if parsed.path == "/api/health":
            state = snapshot(False)
            self.send_json({"ok": True, "items": len(state["items"]), "name": "TabMonger", "version": APP_VERSION}); return
        if parsed.path.startswith("/assets/uploads/"):
            upload = uploaded_file(parsed.path)
            if upload:
                self.serve_path(upload, uploaded=True)
            else:
                self.send_error(404)
            return
        if parsed.path in {"/", "/index.html"}:
            self.serve_path(PUBLIC / "index.html"); return
        requested = (PUBLIC / parsed.path.lstrip("/")).resolve()
        if requested.is_relative_to(PUBLIC.resolve()) and requested.is_file():
            self.serve_path(requested); return
        self.send_error(404)

    def do_HEAD(self) -> None:
        """Mirror safe read routes without exposing project-root file metadata."""
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/"):
            reason = browser_request_rejection(self.headers)
            if reason:
                self.send_json({"error": reason}, 403, head_only=True)
                return
        if parsed.path == "/api/health":
            state = snapshot(False)
            self.send_json(
                {"ok": True, "items": len(state["items"]), "name": "TabMonger", "version": APP_VERSION},
                head_only=True,
            )
            return
        if parsed.path.startswith("/assets/uploads/"):
            upload = uploaded_file(parsed.path)
            if upload:
                self.serve_path(upload, uploaded=True, head_only=True)
            else:
                self.send_error(404)
            return
        if parsed.path in {"/", "/index.html"}:
            self.serve_path(PUBLIC / "index.html", head_only=True)
            return
        requested = (PUBLIC / parsed.path.lstrip("/")).resolve()
        if requested.is_relative_to(PUBLIC.resolve()) and requested.is_file():
            self.serve_path(requested, head_only=True)
            return
        self.send_error(404)

    def serve_path(self, path: Path, *, uploaded: bool = False, head_only: bool = False) -> None:
        if not path.is_file():
            self.send_error(404); return
        raw = b"" if head_only else path.read_bytes()
        self._sandbox_upload = uploaded
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(path.name)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(path.stat().st_size))
        self.end_headers()
        if not head_only:
            self.wfile.write(raw)

    def do_POST(self) -> None:
        if self.reject_unsafe_browser_request():
            return
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
        if self.reject_unsafe_browser_request():
            return
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
        if self.reject_unsafe_browser_request():
            return
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
        if self.reject_unsafe_browser_request():
            return
        if self.path.startswith("/api/items/"):
            try: payload = self.read_json()
            except Exception as exc: self.send_json({"error": str(exc)}, 400); return
            item_id = self.path.rsplit("/", 1)[-1]
            allowed = {"pinned", "deleted_at", "tile_dim", "icon_invert"}
            try:
                with LOCK, connect() as db:
                    exists = db.execute("SELECT id FROM items WHERE id=?", (item_id,)).fetchone()
                    if not exists:
                        self.send_json({"error": "Item not found"}, 404); return
                    if "pinned" in payload:
                        db.execute("UPDATE items SET pinned=?,updated_at=? WHERE id=?", (1 if payload["pinned"] else 0, now(), item_id))
                    if "deleted_at" in payload and payload["deleted_at"] is None:
                        db.execute("UPDATE items SET deleted_at=NULL,updated_at=? WHERE id=?", (now(), item_id))
                    if "tile_dim" in payload:
                        level = appearance_level(payload["tile_dim"], 0, 90)
                        db.execute("UPDATE items SET tile_dim=?,updated_at=? WHERE id=?", (level, now(), item_id))
                    if "icon_invert" in payload:
                        level = appearance_level(payload["icon_invert"], 0)
                        db.execute("UPDATE items SET icon_invert=?,updated_at=? WHERE id=?", (level, now(), item_id))
            except ValueError as exc:
                self.send_json({"error": str(exc)}, 400); return
            self.send_json({"ok": True, "fields": sorted(allowed & payload.keys())}); return
        self.send_error(404)


class TabMongerHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


def lan_ipv4_addresses() -> list[str]:
    candidates: set[str] = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET, socket.SOCK_STREAM):
            candidates.add(info[4][0])
    except OSError:
        pass
    # A UDP connect selects an interface but sends no application data.
    for probe in ("192.0.2.1", "198.51.100.1"):
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
                sock.connect((probe, 9))
                candidates.add(sock.getsockname()[0])
        except OSError:
            pass
    result = []
    for candidate in candidates:
        try:
            address = ipaddress.ip_address(candidate)
        except ValueError:
            continue
        if address.version == 4 and trusted_network_address(address) and not address.is_loopback and not address.is_link_local:
            result.append(candidate)
    return sorted(result, key=lambda value: tuple(int(part) for part in value.split(".")))


def advertised_urls(host: str, port: int, addresses: list[str] | None = None) -> list[tuple[str, str]]:
    urls: list[tuple[str, str]] = []
    normalized = host.strip().casefold()
    if normalized in {"", "0.0.0.0", "::", "[::]"}:
        for address in lan_ipv4_addresses() if addresses is None else addresses:
            urls.append(("Open everywhere", f"http://{address}:{port}/"))
        urls.append(("This computer", f"http://127.0.0.1:{port}/"))
    elif normalized in {"127.0.0.1", "localhost", "::1", "[::1]"}:
        display_host = "[::1]" if ":" in normalized else host
        urls.append(("This computer", f"http://{display_host}:{port}/"))
    else:
        display_host = f"[{host}]" if ":" in host and not host.startswith("[") else host
        urls.append(("Server", f"http://{display_host}:{port}/"))
    return urls


def preferred_open_url(urls: list[tuple[str, str]]) -> str:
    """Prefer the shareable LAN address and fall back to this computer."""
    for label, url in urls:
        if label == "Open everywhere":
            return url
    return urls[0][1]


def existing_tabmonger_url(port: int) -> str | None:
    url = f"http://127.0.0.1:{port}/"
    try:
        with urlopen(url + "api/health", timeout=0.6) as response:
            payload = json.loads(response.read(32 * 1024))
        if payload.get("ok") is True and payload.get("name") == "TabMonger":
            return url
    except (OSError, ValueError, json.JSONDecodeError):
        pass
    return None


def print_startup_banner(host: str, port: int, *, already_running: bool = False) -> list[tuple[str, str]]:
    urls = advertised_urls(host, port)
    heading = "TabMonger is already running." if already_running else "TabMonger is running."
    print(f"\n{heading}")
    for label, url in urls:
        print(f"  {label:<13} {url}")
    if not already_running:
        print(f"  {'Private data':<13} {DATA}")
        print("\nKeep this window open while you use TabMonger. Press Ctrl+C to stop it.")
        print("Only share the network URL with people you trust on your local network.")
    print(flush=True)
    return urls


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run the TabMonger personal launch dashboard")
    parser.add_argument("--host", default=os.getenv("TABMONGER_HOST", "0.0.0.0"), help="listen address (default: 0.0.0.0 for LAN access)")
    parser.add_argument("--port", type=int, default=int(os.getenv("TABMONGER_PORT", "8787")), help="listen port (default: 8787)")
    parser.add_argument("--data-dir", default=None, help="private state directory (or set TABMONGER_DATA_DIR)")
    parser.add_argument("--uploads-dir", default=None, help=argparse.SUPPRESS)
    parser.add_argument("--open", action="store_true", dest="open_browser", help="open TabMonger in the default browser")
    parser.add_argument("--find-port", action="store_true", help="try the next 20 ports if the requested port is busy")
    args = parser.parse_args(argv)
    if not 0 <= args.port <= 65535:
        parser.error("port must be between 0 and 65535")
    configure_runtime(args.data_dir, args.uploads_dir)

    candidates = [args.port]
    if args.find_port and args.port:
        candidates.extend(range(args.port + 1, min(args.port + 21, 65535) + 1))
    httpd: TabMongerHTTPServer | None = None
    last_error: OSError | None = None
    for candidate in candidates:
        try:
            httpd = TabMongerHTTPServer((args.host, candidate), Handler)
            break
        except OSError as exc:
            last_error = exc
            address_in_use = exc.errno == errno.EADDRINUSE or getattr(exc, "winerror", None) == 10048
            if not address_in_use:
                raise
            running_url = existing_tabmonger_url(candidate)
            if running_url:
                urls = print_startup_banner(args.host, candidate, already_running=True)
                if args.open_browser:
                    webbrowser.open(preferred_open_url(urls))
                return 0
            if not args.find_port:
                print(f"TabMonger could not start: port {candidate} is already in use.", file=sys.stderr)
                print(f"Try again with --port {candidate + 1}, or close the other program first.", file=sys.stderr)
                return 2
    if httpd is None:
        detail = f": {last_error}" if last_error else ""
        print(f"TabMonger could not find an available port{detail}", file=sys.stderr)
        return 2

    actual_port = int(httpd.server_address[1])
    try:
        init_db()
    except Exception:
        httpd.server_close()
        raise
    threading.Thread(target=glance_worker, name="tabmonger-glance", daemon=True).start()
    urls = print_startup_banner(args.host, actual_port)
    if actual_port != args.port and args.port:
        print(f"Port {args.port} was busy, so this launch is using port {actual_port}.\n", flush=True)
    if args.open_browser:
        threading.Thread(target=webbrowser.open, args=(preferred_open_url(urls),), name="tabmonger-browser", daemon=True).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nTabMonger stopped.")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
