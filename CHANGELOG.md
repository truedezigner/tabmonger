# Changelog

## 1.2.1 — Community pulse and LAN-first startup

### Added

- Privacy-minimized aggregate metrics for the public marketing website, with no cookies, visitor identifiers, raw referrers, or app telemetry
- A LAN-only metrics dashboard and server-generated weekly Markdown report
- A documented twelve-week open-source growth plan and measurement contract
- Clearly disclosed project-owner starter votes for the community feature poll
- Browser-local website analytics opt-out for the project owner or any visitor
- Separate macOS, Windows, Linux, Chrome/Brave/Edge, and Firefox download-interest counters

### Changed

- Portable launchers now prefer opening the shareable private-LAN address, with localhost kept as a fallback

## 1.2.0 — Per-tile dark mode

### Added

- A quick settings control on every tile with independent background-darkening and icon-inversion sliders
- Automatic text contrast so bright tiles can become comfortable dark variants without losing readability
- Portable backup/import support for each tile's visual settings

### Changed

- Internal item and tag keys now use TabMonger-native identifiers, with an automatic relationship-safe migration for existing installations
- Import and migration wording is vendor-neutral throughout the current source tree

## 1.1.1 — Direct browser downloads

### Added

- Direct, checksummed Chrome/Brave/Edge and Firefox companion ZIP downloads
- A dedicated public-site download section with clear macOS, Chromium-family, and Firefox setup choices
- Source and setup links beside every browser download so the packages stay inspectable

### Fixed

- Rounded the dashboard search action's right edge while hovered so its highlight follows the search bar shape

## 1.1.0 — Portable community release

### Added

- One portable ZIP with Windows, macOS, and Linux launchers, the dashboard, complete setup docs, and ready-to-load new-tab companion source
- Chrome/Edge Manifest V3 companion with persistent unpacked Developer-mode setup
- Firefox Manifest V3 companion source with temporary development installation instructions and a stable Gecko ID for future signing
- Extension setup/options, toolbar pause control, optional host-scoped health checks, offline retry, and unset states
- OS-native per-user data directories for clean installs and automatic legacy checkout-state preservation
- Owner-only POSIX permissions for databases, backups, uploaded assets, and private state directories
- Friendly first-run actions for adding, importing, and connecting a browser
- Community contribution guide, extension model, issue templates, and public-release privacy gate
- Cross-site, Host, DNS-rebinding, clickjacking, upload-traversal, and active-SVG response safeguards
- Reproducible portable archive builder with a SHA-256 checksum

### Changed

- New installations default to local-link search with weather and service monitoring off until the user opts in
- Linux user-service installs copy stable app files under `~/.local/lib` while keeping state under `~/.local/share`
- The launcher prints both local and trusted-LAN addresses, opens the browser, detects an existing TabMonger process, and explains port fallback
- The public site now uses restrained community support language, a stable SVG coffee icon, transparent contribution limits, a LAN/new-tab explanation, and contributor paths
- Public examples use neutral network addresses; real operator state and environment details remain excluded

### Fixed

- Portable uploaded icons and backgrounds are served and included in exports from the configured data directory
- Update installs restart an already-running user service instead of leaving old code in memory
- Nginx cache locations retain the public site’s security headers
- Support builds fail closed unless the configured destination is an HTTPS `buy.stripe.com` Payment Link

## 2026-08-20 — Public project foundation

### Added

- Final vector logo, favicon, wordmark, and responsive Astro product website
- One-command user-service installer
- MIT license and public deployment security guidance
- Stripe-hosted, supporter-chosen one-time contribution flow with no payment code in the site
- Privacy and voluntary-support policy pages
- Podman, Nginx, systemd, and Cloudflare deployment configuration for `tabmonger.com`

### Changed

- Generalized the example systemd service to avoid a machine-specific home path
- Documented the official website and safe private-network deployment model

## 2026-08-19 — Complete lightweight dashboard foundation

### Added

- Dependency-free Python/SQLite/vanilla-JavaScript dashboard
- Complete legacy-dashboard migration with local assets, ordering, pin states, and trash
- Link management, tags, drag ordering, custom icons, backgrounds, themes, and density controls
- Complete JSON and browser-bookmark import/export
- Automatic seven-day portable backup rotation
- SearXNG-first, local-first unified search with keyboard navigation
- Compact date and cached lightweight weather
- Centralized private-service monitoring with per-link and global controls
- Two-attempt outage confirmation and adaptive down-service backoff
- One-click down-only view with confirmation timestamps
- Context-aware empty states
- Responsive light and dark layouts

### Changed

- Replaced the original always-visible green diamond with a hover-only pushpin and solid pinned state
- Replaced native search-provider presentation with a readable two-option custom picker
- Replaced the original dark-green application chrome with the accepted cool blue-gray visual system
- Reduced confirmed-down service traffic from 24 attempts per hour to 8

### Fixed

- Prevented hidden empty-state content from appearing beneath populated grids
- Prevented custom provider and suggestion menus from slipping behind tiles
- Removed duplicate local-search no-match messages

### Brand status

- `TabMonger` is the finalized product name
- GitHub repository reserved as `truedezigner/tabmonger`
- Final logo and favicon creation is the remaining brand task
