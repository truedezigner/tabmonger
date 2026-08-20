# Extending TabMonger

TabMonger offers three deliberately simple extension paths. None of them sends private dashboard data to a plugin service.

## 1. Configure without code

Most installations only need the built-in controls:

- links, icons, tags, pinning, and ordering;
- browser-bookmark and legacy-dashboard imports;
- background, theme, and tile-density settings;
- a private SearXNG endpoint;
- per-link and global service monitoring controls.

Use **Settings → Import / export** to make a portable backup before experimenting.

## 2. Add trusted local CSS or JavaScript

**Settings → Advanced** accepts custom CSS and JavaScript. This is useful for a personal theme, a keyboard shortcut, or a small local behavior change.

Custom JavaScript has the same access as the dashboard itself. It can read links and change settings, so only paste code you have reviewed and trust. TabMonger intentionally does not download or auto-update remote scripts.

Reusable, narrowly scoped examples can be proposed under `community/`. Every example should explain what it changes, avoid network requests, and be short enough to audit.

## 3. Extend the source

- `server.py` contains the standard-library HTTP API, SQLite storage, backups, weather cache, and service checks.
- `public/` contains the dependency-free dashboard interface.
- `extensions/` contains the browser new-tab companions.
- `site/` contains the public product website; it is not part of the dashboard runtime.

Start with [CONTRIBUTING.md](../CONTRIBUTING.md) and discuss large features in an issue before building them.

## Why there is no remote plugin marketplace

A dashboard contains private service addresses and sometimes sensitive URLs. Automatically installing third-party code would create a much larger trust and update surface. TabMonger favors inspectable source changes, reviewed local recipes, and small browser companions instead.
