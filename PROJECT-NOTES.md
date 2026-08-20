# Project Notes

## Current status

TabMonger is a working, persistent, dependency-free personal dashboard running as `tabmonger.service` on port `8787`. The current product name is intentionally treated as provisional while the final brand is selected.

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

### Recommended final name: Tabmancer

**Why it works**

- Keeps the memorable oddness and existing `TabMonger` recognition
- Replaces the harsher “monger” association with a playful idea of summoning links and services
- Describes the product without sounding like a generic enterprise dashboard
- Supports a strong verbal identity: **“Summon your services.”**
- Allows a graceful transition because both names can use a `TM` shorthand during migration

### Logo direction after approval

The logo should be a simple geometric mark, not a wizard hat or fantasy illustration. The recommended concept combines:

- a browser-tab notch;
- a portal or doorway shape;
- three small dashboard tiles being drawn inward;
- the established blue-gray palette with one restrained periwinkle highlight.

It must remain recognizable at favicon size, work as a single-color mark, and pair cleanly with the `Tabmancer` wordmark. Logo generation and live renaming should happen only after the name is explicitly approved.

### Other viable names

- **Portmancer** — technically clever, but sounds more like a port-scanning utility
- **Docklight** — calm and relevant to status, but less distinctive
- **Linkloom** — friendly and visual, but softer and less aligned with self-hosted infrastructure

Tabmancer is the strongest balance of memorable, relevant, ownable-feeling, and logo-ready.

## Rename checklist

Once the final name is approved:

1. Create and approve the final logo and favicon set.
2. Update the visible title, subtitle, document title, default settings, and README heading.
3. Rename service/project identifiers only if desired; they can remain `tabmonger` internally for a low-risk migration.
4. Preserve database and backup compatibility.
5. Create a rollback snapshot before changing the live brand.
6. Validate desktop, mobile, light, dark, empty, settings, and down-only views.

