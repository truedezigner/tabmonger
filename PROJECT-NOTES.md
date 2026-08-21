# Project notes

## Product boundary

TabMonger is a lightweight, self-hosted personal launch dashboard. The public repository contains reusable application code, clean defaults, launchers, documentation, browser companion source, and the static product website. Databases, uploaded assets, generated backups, environment files, checkout configuration, and operator-specific addresses are excluded.

The official public site is `tabmonger.com`; its Astro source and deployment files live under `site/` and are not part of the dashboard runtime.

## Runtime architecture

- `server.py` — Python standard-library HTTP server, API, SQLite persistence, cached weather, service checks, security guards, and rotating backups
- `public/index.html` — dashboard structure and dialogs
- `public/app.js` — search, rendering, editing, importing, settings, first-run guidance, and client interactions
- `public/styles.css` — layout and component foundation
- `public/search-polish.css` — custom search provider and unified result menu
- `public/glance.css` — date, weather, service-health, toggle, and empty-state presentation
- `public/ui-polish.css` — final cool blue-gray visual system and first-run panel
- `extensions/` — build-free Chrome/Edge and Firefox Manifest V3 new-tab companions
- `packaging/build_release.py` — private-state-free portable archive and checksum builder

The shipped dashboard uses no third-party Python runtime package, JavaScript framework, external icon font, frontend build, or CDN. Python 3.10 or newer is required. One-time importer-specific tooling is not included in the portable runtime package.

## Storage and upgrade model

Clean installations store private state outside the application:

- Linux: `~/.local/share/tabmonger/`
- macOS: `~/Library/Application Support/TabMonger/`
- Windows: `%LOCALAPPDATA%\TabMonger\`

Older checkouts containing an ignored `data/tabmonger.db` continue using that database and their existing `assets/uploads/` automatically. `TABMONGER_DATA_DIR` and `TABMONGER_UPLOADS_DIR` provide explicit overrides.

On POSIX hosts, TabMonger enforces owner-only `0700` permissions on private state directories and `0600` on databases, backups, and uploads. This also tightens permissions when an older installation starts under the portable runtime.

Once per local day, the server creates a complete portable JSON backup under the selected data directory and retains the seven newest dated backups.

## Network and browser model

The default listener is `0.0.0.0:8787` so trusted LAN devices can share one dashboard. The launcher prefers opening a private IPv4 LAN address that can be reused in browser companions, while retaining loopback as a fallback. It also advertises shared-space private-VPN addresses. A stable DHCP reservation, local hostname, or fixed private-VPN address is recommended for browser companions.

The server has no account system. Host validation, Fetch Metadata/Origin checks, framing denial, safe upload resolution, and sandboxed upload responses reduce browser attack surface, but deployment still belongs on a trusted LAN, private VPN, or authenticated proxy. Public-looking proxy/VPN hostnames must be listed in `TABMONGER_ALLOWED_HOSTS`.

The browser companions override the new-tab page with a small local extension page and then perform top-level navigation to the saved TabMonger address. This avoids iframe, authentication, download, and frame-policy problems. Only `storage` is required; a host permission is requested only if the user enables the friendly health check.

## Public website, community, and metrics

The website is operationally separate from the downloaded dashboard. Its Astro/Nginx frontend and dependency-free Node community service live under `site/`; neither component is included in the telemetry-free dashboard runtime.

- Feedback remains private unless the owner approves a short feature title for the public poll.
- Poll responses expose only approved IDs, reviewed titles, vote totals, starter-vote totals, and update time.
- Website analytics accept only an allowlisted event and a coarse source category.
- Download interest is recorded by the button selected: general app, macOS, Windows, Linux, Chrome/Brave/Edge, or Firefox. It does not inspect a visitor's operating system.
- Page views are counted at most once per tab session, so reloading one tab does not inflate traffic.
- `?analytics=off` disables website events for one browser profile using a response-set, non-identifying first-party preference cookie plus local-storage redundancy. The API itself refuses opted-out events, including attempts from stale cached scripts. `?analytics=on` reverses it.
- Production can privately exclude an operator connection by salted source HMAC. The API drops a match before recording; raw addresses and configured hashes stay out of the repository and analytics dataset.
- The analytics store contains only UTC date, allowlisted event, and coarse source. It contains no IP address, cookie, visitor ID, user agent, full URL, query string, fingerprint, or raw referrer.
- The metrics dashboard and report API are LAN-only; the public origin returns `404` for both. A server-side timer writes a protected weekly report.

Candidate deployments build and test the site and community service against a disposable copy of persistent state. Only a passing candidate may replace production, and the deployment retains rollback images and protected backups.

The complete data contract is in [`ANALYTICS.md`](ANALYTICS.md); the distribution plan is in [`GROWTH-PLAN.md`](GROWTH-PLAN.md).

## Service monitoring model

Monitoring is off for a clean install. When enabled, only loopback, RFC-private, or `100.64.0.0/10` HTTP/HTTPS targets are eligible. The server opens a TCP connection and immediately closes it without requesting a page.

- Healthy: one check every 300 seconds
- First failure: one confirmation retry after 15 seconds
- Confirmed down: two attempts every 900 seconds
- Duplicate host/port combinations: checked once and shared
- Multiple browser tabs: consume the same cached `/api/glance` response
- Global Off: clears service and endpoint caches immediately

## Weather model

Weather is off for a clean install. When enabled, the server fetches wttr.in and caches the result for 30 minutes. Browser tabs never contact the provider or download condition artwork.

## Visual and brand direction

TabMonger is the final product name and “Your links. No ceremony.” is the compact tagline. The accepted interface is quiet, cool, and legible:

- Core panel: `#101722`
- Field/background: `#0c131d`
- Selected control: `#334766`
- Primary control: `#5d75a8`
- Main text: `#edf2fb`
- Muted text: `#96a4bd`

The public site uses the final geometric browser/dashboard mark and a stable inline vector support icon. The dashboard retains a compact `TM` mark so the runtime stays asset-light. Tile colors remain content-owned.

## Contribution philosophy

The extension surface is deliberately inspectable: built-in configuration, trusted local CSS/JavaScript, source contributions, and small reviewed recipes. TabMonger does not auto-install remote plugins because the dashboard contains private addresses and saved URLs.

## Current release checkpoint

Version `1.2.1` is the current portable release. It includes per-tile darkening/inversion, macOS/Windows/Linux launchers, Chromium and Firefox companion packages, and LAN-first startup. The later website hotfix at commit `0eafd63` made the browser-local analytics opt-out durable and stopped same-tab reloads from increasing page views; it did not change the downloaded app or extension packages.
