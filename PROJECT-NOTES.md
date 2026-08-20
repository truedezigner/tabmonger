# Project Notes

## Current status

TabMonger is a working, persistent, dependency-free personal dashboard running as `tabmonger.service` on port `8787`. **TabMonger is the finalized product name.**

The public product website is an Astro static build under `site/`, deployed as `tabmonger-site` on the PageFollower CT. `tabmonger.com` is the official domain.

## Architecture

- `server.py` — Python standard-library HTTP server, API, SQLite persistence, cached weather, service checks, and rotating backups
- `public/index.html` — application structure and dialogs
- `public/app.js` — search, rendering, editing, importing, settings, and client interactions
- `public/styles.css` — original layout and component foundation
- `public/search-polish.css` — custom search provider and unified result menu
- `public/glance.css` — date, weather, service-health, toggle, and empty-state presentation
- `public/ui-polish.css` — final blue-gray visual system applied across the application
- `data/tabmonger.db` — authoritative SQLite database using WAL mode
- `assets/uploads/` — copied or uploaded icons and backgrounds

There is no runtime dependency installation, JavaScript package tree, build pipeline, external icon font, or frontend framework.

## Service monitoring model

Only private or loopback HTTP/HTTPS targets are eligible. Monitoring opens a TCP connection to the saved host and port, then immediately closes it without requesting a webpage.

- Healthy: one check every 300 seconds
- First failure: one confirmation retry after 15 seconds
- Confirmed down: two attempts every 900 seconds
- Duplicate host/port combinations: checked once and shared by every matching tile
- Multiple browser tabs: consume only the shared cached `/api/glance` response
- Global Off: clears service and endpoint caches immediately and performs no further service connections

Each link also has its own monitoring switch. External links remain unmonitored even when that switch is On.

## Weather model

Weather is fetched by the server from wttr.in and cached for 30 minutes. Browser tabs never contact the weather provider or download condition artwork. Conditions use tiny built-in text symbols, keeping the page free of weather libraries and image requests.

## Backups and recovery

Once per local day, the server creates a complete portable JSON backup under `data/backups/`. It includes links, ordering, pin state, monitoring preference, tags, settings, local icons, and the background. The seven newest dated JSON files are retained.

The pre-monitoring-schema rollback snapshot is:

`data/backups/pre-reliability-pass-2026-08-19.db`

Backups contain full URLs and should be kept private.

## Visual direction

The accepted interface direction is quiet, cool, and legible:

- Core panel: `#101722`
- Field/background: `#0c131d`
- Selected control: `#334766`
- Primary control: `#5d75a8`
- Main text: `#edf2fb`
- Muted text: `#96a4bd`

Search, settings, management, editing, import/export, toggles, toast, and native option menus share this system. Tile colors remain content-owned and are not forced into the interface palette.

## Name and brand direction

### Final name: TabMonger

**Why it works**

- Odd, memorable, and directly tied to collecting and managing tabs and links
- Distinct from generic names built around “dashboard,” “home,” or “start”
- Short enough for a repository, service, wordmark, and spoken recommendation
- Already matches the live application, internal service name, and `TM` shorthand

### Logo direction

The logo should be a simple geometric mark. The recommended concept combines:

- a browser-tab notch;
- a portal or doorway shape;
- three small dashboard tiles being drawn inward;
- the established blue-gray palette with one restrained periwinkle highlight.

It must remain recognizable at favicon size, work as a single-color mark, and pair cleanly with the `TabMonger` wordmark. The existing `TM` text mark remains the temporary fallback until the final logo and favicon set are approved.
