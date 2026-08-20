# Changelog

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
- Complete Heimdall migration with local assets, ordering, pin states, and trash
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
- Private GitHub repository reserved as `truedezigner/tabmonger`
- Final logo and favicon creation is the remaining brand task
