# TabMonger

**Your links. No ceremony.**

TabMonger is a tiny, self-hosted new-tab dashboard for links, private services, local search, weather, and quiet reachability checks. The dashboard runtime is one Python standard-library process with SQLite and plain HTML/CSS/JavaScript—no account, telemetry, runtime package installation, framework, container, build step, or external CDN.

**Website:** [tabmonger.com](https://tabmonger.com) · **License:** [MIT](LICENSE)

## Quick start

### Portable download

1. Download [TabMonger-portable.zip](https://github.com/truedezigner/tabmonger/releases/latest/download/TabMonger-portable.zip).
2. Extract the ZIP.
3. Double-click the launcher for your system:
   - Windows: `Start TabMonger.bat`
   - macOS: `Start TabMonger.command`
   - Linux: `Start TabMonger.sh`
4. Keep the launcher window open. TabMonger prefers opening and printing a LAN address such as `http://192.168.1.20:8787/` for trusted computers on the same network, with localhost available as a fallback.

Python 3.10 or newer is the only runtime requirement. Windows may ask whether Python and TabMonger can use the network; allow private networks only. See the [complete installation guide](docs/INSTALL.md) for platform notes, firewall help, automatic startup, updates, and a stable-address recommendation.

TabMonger prefers port `8787`. If another program owns it, the portable launcher finds a nearby free port and clearly prints the address it selected.

### Run from source

```bash
git clone https://github.com/truedezigner/tabmonger.git && cd tabmonger && python3 server.py --open
```

Or download the repository ZIP and use the same platform launchers. Linux users can install an automatic per-user service with `./install.sh`; it requires no root access.

## Make TabMonger your new tab

The repository includes build-free companions for Chrome, Edge, and Firefox under [`extensions/`](extensions/). Each extension remembers one TabMonger address and opens it as the browser’s new-tab destination.

Direct packages from the latest release:

- [Chrome, Brave, and Edge companion ZIP](https://github.com/truedezigner/tabmonger/releases/latest/download/TabMonger-Chromium-extension.zip)
- [Firefox companion ZIP](https://github.com/truedezigner/tabmonger/releases/latest/download/TabMonger-Firefox-extension.zip)

Extract the browser ZIP before loading it. The package contains one ready-to-load extension folder; its matching source and complete setup instructions remain in [`extensions/`](extensions/).

1. Start TabMonger on one trusted computer.
2. Confirm its printed LAN address opens from the other computer.
3. Load the matching extension and save that address once.

Chrome and Edge can load the Chromium folder persistently in Developer mode. Standard Firefox currently loads the repository build temporarily for development; a permanent consumer install requires a Mozilla-signed package. The [extension guide](extensions/README.md) gives exact steps and explains the minimal permissions, offline behavior, and privacy model.

Using one stable port and a DHCP reservation or local hostname keeps the saved extension address working after router restarts.

## First run and private data

A clean install begins empty, with outbound weather and service checks off. The first-run screen offers three paths: add a link, import bookmarks or an older dashboard backup, or connect a new-tab extension.

Private state is stored outside the downloaded application by default:

- Linux: `~/.local/share/tabmonger/`
- macOS: `~/Library/Application Support/TabMonger/`
- Windows: `%LOCALAPPDATA%\TabMonger\`

The folder contains the SQLite database, uploaded icons/backgrounds, and seven rotating daily backups. Existing pre-portable installations with `data/tabmonger.db` are detected and continue using their original ignored data and upload folders. Use `--data-dir` or `TABMONGER_DATA_DIR` to choose another location.

## Features

### Links and organization

- Add, edit, auto-discover, pin, drag-reorder, trash, restore, and permanently delete links
- Custom icon URL or upload with an initials fallback
- Per-tile darkening and icon inversion with automatic text contrast
- Tags, filtering, tag management, and three tile densities
- Same-tab or new-tab launching
- Context-aware first-run and empty states

### Search and glance information

- Ranked local-link search and suggestions
- Optional private SearXNG web search
- `/` to focus, arrow-key navigation, and Enter to open
- Local weekday/date and optional server-cached weather
- Optional centralized reachability indicators for private LAN services

### Lightweight service monitoring

- One shared TCP connect-and-close per unique private endpoint; browser tabs never probe services
- Healthy endpoints checked every five minutes
- First failure confirmed after 15 seconds
- Confirmed-down endpoints backed off to fifteen-minute checks
- Per-link and global monitoring switches
- Monitoring is off until a new user opts in

### Appearance, portability, and extension

- Background URL/upload, color, and overlay controls
- Dark, light, and system themes
- Full JSON import/export with order, tags, settings, local icons, and background
- Legacy-dashboard JSON and browser-bookmark HTML import
- Automatic seven-day portable backup rotation
- Trusted local custom CSS and JavaScript
- Chrome/Edge and Firefox new-tab companion source

## Network and security model

TabMonger intentionally has no user-account system. Keep it on a trusted LAN, private VPN, or behind a properly authenticated reverse proxy; do not expose a personal dashboard directly to the public internet.

The server rejects cross-site browser API requests and browser requests using an untrusted Host, but those guards are defense in depth—not authentication. Saved links and exports may contain private addresses or sensitive URL fragments. Treat the database and every backup as private.

See [SECURITY.md](SECURITY.md) before changing network exposure.

## Build around it

TabMonger favors inspectable extensions over a remote plugin marketplace:

- [`extensions/`](extensions/) — browser new-tab companions
- [Extending TabMonger](docs/EXTENDING.md) — trusted local CSS/JavaScript and source layout
- [CONTRIBUTING.md](CONTRIBUTING.md) — project principles, bug reports, and pull requests
- [`community/`](community/) — a home for small, reviewable customization recipes

Clear issues, platform testing, documentation fixes, accessibility work, and focused code contributions are welcome. Financial support is optional and never required to use or help build TabMonger.

## Development checks

```bash
python3 -m unittest discover -s tests -v
python3 scripts/check_public_release.py
node --check public/app.js
node extensions/scripts/validate.mjs
node extensions/scripts/runtime-tests.mjs
```

The public Astro website lives under `site/` and has its own build and checkout smoke test documented in [`site/README.md`](site/README.md).

The downloaded dashboard and browser companions contain no analytics. The public marketing site's narrow aggregate counters, per-platform download-click mapping, browser opt-out, and private metrics boundary are documented in [`ANALYTICS.md`](ANALYTICS.md).

## Additional documentation

- [Installation and LAN setup](docs/INSTALL.md)
- [Extending TabMonger](docs/EXTENDING.md)
- [Growth plan](GROWTH-PLAN.md)
- [Website analytics](ANALYTICS.md)
- [Project architecture and decisions](PROJECT-NOTES.md)
- [Changelog](CHANGELOG.md)
