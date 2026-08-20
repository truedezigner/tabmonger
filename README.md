# TabMonger

An extremely lightweight personal launch dashboard and Heimdall replacement. It is one Python standard-library process, SQLite, and plain HTML/CSS/JavaScript: no package installation, framework, container, build step, telemetry, or external CDN.

**Website:** [tabmonger.com](https://tabmonger.com) · **License:** [MIT](LICENSE)

The interface uses one consistent cool blue-gray visual system across search, dialogs, settings, forms, tabs, controls, and status elements. Individual service tiles retain their own brand colors.

## Run

### Quick start

```bash
git clone https://github.com/truedezigner/tabmonger.git
cd tabmonger
python3 server.py --host 0.0.0.0 --port 8787
```

Open `http://127.0.0.1:8787` locally or `http://192.168.29.44:8787` on the LAN.

For an automatic per-user systemd service:

```bash
./install.sh
```

The installer uses the current checkout path, starts TabMonger immediately, enables it at login, and does not require root.

> [!IMPORTANT]
> Keep personal TabMonger instances on a trusted LAN, VPN, or behind authentication. The app intentionally has no user-account system and should not be exposed directly to the public internet.

## Features

### Links and organization

- Add, edit, auto-discover, pin, unpin, drag-reorder, trash, restore, and permanently delete links
- Custom icon URL or upload with an initials fallback
- Tags, filtering, tag renaming, and tag deletion
- Pinned and all-links views with three tile densities
- Same-tab or new-tab launching

### Search

- SearXNG-first search using the configured private instance
- Ranked local-link suggestions before the final web-search action
- Dedicated local-only search mode
- `/` to focus, arrow-key navigation, and Enter to open
- High-contrast custom provider menu with exactly two choices

### At-a-glance information

- Compact local weekday and date
- Server-cached weather with built-in symbols, configurable location, and Fahrenheit/Celsius
- Tiny per-tile reachability indicators for private LAN services
- One-click down-only view with outage confirmation times

### Lightweight service monitoring

- One centralized TCP connect-and-close per unique endpoint; browser tabs never probe services
- Healthy endpoints checked every five minutes
- First failure retried after 15 seconds before an outage is published
- Confirmed-down endpoints back off to fifteen-minute checks
- Per-link monitoring switches
- Global **Settings → Behavior → Live service status checks** switch
- Turning checks Off immediately clears cached service states and stops service connections

### Appearance and portability

- Background URL/upload, color, and overlay controls
- Dark, light, and system themes
- Unified cool blue-gray interface palette
- Full JSON import/export including order, tags, settings, local icons, and background
- Heimdall JSON import and browser-bookmark HTML import/export
- Automatic daily portable backups with seven-day rotation
- Optional custom CSS and JavaScript
- Responsive desktop and mobile layouts

## Monitoring traffic

Monitoring is deliberately conservative. Multiple tiles sharing the same host and port are deduplicated. An online endpoint sees at most one tiny TCP connection every five minutes. A confirmed-down endpoint receives two attempts every fifteen minutes. No HTTP page is loaded and opening more dashboard tabs does not increase service traffic.

## Data and backups

- Database: `data/tabmonger.db`
- Uploaded assets: `assets/uploads/`
- Rotating daily backups: `data/backups/tabmonger-YYYY-MM-DD.json`
- Health endpoint: `/api/health`
- Cached glance endpoint: `/api/glance`
- Complete portable export: `/api/export`

Portable exports and automatic backups contain full saved URLs. Treat them as private because a URL may itself contain a session fragment or other sensitive value.

The original Heimdall migration copied links, descriptions, icons, pin state, order, tags, background, and trash entries. App-integration credentials were not added to project source.

## Documentation

- [PROJECT-NOTES.md](PROJECT-NOTES.md) — architecture, operation, design decisions, backups, and brand direction
- [CHANGELOG.md](CHANGELOG.md) — completed product milestones
