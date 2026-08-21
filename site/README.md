# TabMonger website

The public Astro site for `tabmonger.com`. Static HTML, CSS, and first-party JavaScript are served by Nginx. A separate dependency-free Node service accepts private feedback, serves the owner-moderated title-only feature poll, and keeps privacy-minimized aggregate website counters.

## Local development

```bash
npm ci
npm run dev
```

## Production build

```bash
npm run build
```

The community service has no third-party runtime packages. Run its disposable tests separately:

```bash
cd community && npm test
```

## One-time support link

The public site uses a Stripe-hosted “customer chooses what to pay” Payment Link. Set both values in `/opt/apps/data/tabmonger-site/runtime.env` after Stripe has activated live payments:

```bash
PUBLIC_SUPPORT_URL=https://buy.stripe.com/example
PUBLIC_STRIPE_SUPPORT_READY=true
```

`PUBLIC_STRIPE_SUPPORT_URL` remains supported for existing deployments. When a checkout URL is present and `PUBLIC_STRIPE_SUPPORT_READY` is exactly `true`, the header, support card, and footer link directly to Stripe. Until then, the page renders an “opening soon” state. No Stripe JavaScript, payment iframe, API key, bank detail, or other financial credential is stored in the site.

Run `npm test` to verify both preferred and legacy environment names, all three active support entry points, the pending state, and rejection of non-Stripe schemes and hosts. The smoke test uses synthetic Stripe-domain markers and never prints a checkout URL.

## Community feedback and poll

The public routes are deliberately narrow:

- `POST /api/community/submissions` accepts either private general feedback or a pending feature request.
- `GET /api/community/poll` returns approved poll IDs, reviewed titles, totals, and an update time—nothing from the private moderation record.
- `POST /api/community/vote` records one current selection per locally stored anonymous browser ID.
- `POST /api/analytics/event` accepts only an allowlisted event and coarse source category; it stores no visitor identifier.

Automated filtering rejects markup, URLs, hidden controls, common abuse, threats, profanity, promotional spam, and repetitive junk. Filtering never publishes anything. Every feature remains private until the owner runs an explicit approval command through the API container's mode-`0600` Unix socket. There is no public moderation endpoint.

```bash
sudo podman exec tabmonger-community-api node moderate.mjs list --status pending
sudo podman exec tabmonger-community-api node moderate.mjs show <submission-id>
sudo podman exec tabmonger-community-api node moderate.mjs approve <submission-id> --title "Reviewed public title"
sudo podman exec tabmonger-community-api node moderate.mjs reject <submission-id>
sudo podman exec tabmonger-community-api node moderate.mjs mark-reviewed <submission-id>
sudo podman exec tabmonger-community-api node moderate.mjs poll
sudo podman exec tabmonger-community-api node moderate.mjs close <poll-item-id>
sudo podman exec tabmonger-community-api node moderate.mjs set-starter-votes <poll-item-id> <count>
```

See [`community/README.md`](community/README.md) for the complete API, moderation, filtering, retention, and storage contract.

## Aggregate website metrics

The marketing site counts only allowlisted aggregate events. App and extension downloads are separated by the exact button selected—general, macOS, Windows, Linux, Chrome/Brave/Edge, or Firefox—without inspecting the visitor's operating system. These are download-click interest signals, not confirmation that a download completed.

Page views are recorded at most once per tab session. Opening `https://tabmonger.com/?analytics=off` disables every website event in that browser profile; Nginx sets a non-identifying first-party preference cookie on the response and local storage provides redundancy. The analytics API independently refuses events carrying that cookie, including attempts from stale cached scripts. `?analytics=on` restores counting. Neither preference value is written into the analytics dataset.

The private metrics dashboard is available only on the LAN metrics listener. The public origin deliberately returns `404` for `/metrics/` and `/api/analytics/report`.

Operators who need exclusion across multiple browsers on one connection may privately set `ANALYTICS_EXCLUDED_SOURCE_HASHES` in `runtime.env`. Values must be lowercase SHA-256 HMACs produced with the deployment salt. Never commit a raw address, deployment salt, or operator hash. The API discards a matching event before it reaches the analytics store.

## Deployment

The CT source path is `/opt/apps/tabmonger-site`. Production uses the `tabmonger-community` Podman pod:

- `tabmonger-site` runs the public Nginx site on pod port `8080` and the private metrics view on pod port `8082`.
- `tabmonger-community-api` runs non-root on pod-loopback port `8081`, with a read-only root filesystem and only its data mount writable.
- The pod publishes the public site as `127.0.0.1:4342`. Production may publish port `8082` as `<LAN-address>:4343` for the private `/metrics/` dashboard. The API has no host port; public Nginx exposes only the four exact public routes above.
- Private state is stored at `/opt/apps/data/tabmonger-site/community`; the runtime salt stays in mode-`0600` `runtime.env` and is never committed.
- Generated Podman pod/container systemd units provide boot persistence.

`deploy-tabmonger-site.sh` builds both images and runs their tests before creating an isolated candidate pod with a disposable copy of persistent data. Candidate checks cover the static site, support/download links, security headers, origin enforcement, automated filtering, pending privacy, private approval, title-only publication, voting, analytics allowlists, the private metrics view, restart persistence, and the absence of public admin/health/report routes.

See [`../ANALYTICS.md`](../ANALYTICS.md) and [`../GROWTH-PLAN.md`](../GROWTH-PLAN.md) for the data contract and measurement plan.

Only a passing candidate can replace the loopback origin. The script keeps timestamped rollback images, a checksummed state/configuration backup, and at most 30 days of protected deployment backups. Automatic rollback preserves the current community data rather than restoring an older copy over new submissions or votes.

The optional commercial-hosting concept is intentionally dormant and documented separately in [`../HOSTED-EDITION-PLAN.md`](../HOSTED-EDITION-PLAN.md). That file is not authorization to create accounts, billing, DNS, or a hosted service.
