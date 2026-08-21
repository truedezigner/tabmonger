# TabMonger website

The public Astro site for `tabmonger.com`. Static HTML, CSS, and first-party JavaScript are served by Nginx. A separate dependency-free Node service accepts private feedback and serves the owner-moderated, title-only feature poll.

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

Automated filtering rejects markup, URLs, hidden controls, common abuse, threats, profanity, promotional spam, and repetitive junk. Filtering never publishes anything. Every feature remains private until the owner runs an explicit approval command through the API container's mode-`0600` Unix socket. There is no public moderation endpoint.

```bash
sudo podman exec tabmonger-community-api node moderate.mjs list --status pending
sudo podman exec tabmonger-community-api node moderate.mjs show <submission-id>
sudo podman exec tabmonger-community-api node moderate.mjs approve <submission-id> --title "Reviewed public title"
sudo podman exec tabmonger-community-api node moderate.mjs reject <submission-id>
sudo podman exec tabmonger-community-api node moderate.mjs mark-reviewed <submission-id>
sudo podman exec tabmonger-community-api node moderate.mjs poll
sudo podman exec tabmonger-community-api node moderate.mjs close <poll-item-id>
```

See [`community/README.md`](community/README.md) for the complete API, moderation, filtering, retention, and storage contract.

## Deployment

The CT source path is `/opt/apps/tabmonger-site`. Production uses the `tabmonger-community` Podman pod:

- `tabmonger-site` runs Nginx on the pod's port `8080`.
- `tabmonger-community-api` runs non-root on pod-loopback port `8081`, with a read-only root filesystem and only its data mount writable.
- The pod publishes Nginx as `127.0.0.1:4342`; the API has no host port and Nginx exposes only the three exact public routes above.
- Private state is stored at `/opt/apps/data/tabmonger-site/community`; the runtime salt stays in mode-`0600` `runtime.env` and is never committed.
- Generated Podman pod/container systemd units provide boot persistence.

`deploy-tabmonger-site.sh` builds both images and runs their tests before creating an isolated candidate pod with a disposable copy of persistent data. Candidate checks cover the static site, support/download links, security headers, origin enforcement, automated filtering, pending privacy, private approval, title-only publication, voting, restart persistence, and the absence of public admin/health routes.

Only a passing candidate can replace the loopback origin. The script keeps timestamped rollback images, a checksummed state/configuration backup, and at most 30 days of protected deployment backups. Automatic rollback preserves the current community data rather than restoring an older copy over new submissions or votes.

The optional commercial-hosting concept is intentionally dormant and documented separately in [`../HOSTED-EDITION-PLAN.md`](../HOSTED-EDITION-PLAN.md). That file is not authorization to create accounts, billing, DNS, or a hosted service.
