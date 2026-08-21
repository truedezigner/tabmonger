# TabMonger Hosted — deferred launch plan

Status: **planning document only**. TabMonger Hosted has not been built or launched. No recurring Stripe product, customer account, public signup, hosted database, or `app.tabmonger.com` service may be created from this plan without the project owner's explicit approval.

## Product promise

- Keep the existing TabMonger repository free, open source, self-hosted, account-free, and telemetry-free.
- Offer hosting only as an optional convenience for people who do not want to operate the free edition themselves.
- Build the hosted edition as a separate private service so hosted account and billing code never complicates the self-hosted app.
- Never place existing self-hosted features behind a hosted subscription.

## Proposed offer

- Public name: **TabMonger Hosted**.
- Address: `app.tabmonger.com`.
- Recommended price: **$24 per year**, presented as **$2/month billed yearly**. Annual billing avoids twelve sets of transaction fees.
- Proposed beta limits: one owner, one dashboard, 500 links, 25 MB of uploads, unlimited personal devices, no teams, and no uptime SLA during beta.
- Hosted dashboards can save and open private LAN links because navigation happens in the user's browser.
- The cloud service cannot discover or monitor private LAN services. A future opt-in outbound local bridge could add that capability, but it is outside the initial hosted release.

Pricing, taxes, payment-provider costs, retention, quotas, beta language, and recovery rules must be reviewed again immediately before any activation.

## Proposed customer experience

1. Sign in with a verified email code and a documented recovery path.
2. Start a Stripe subscription through hosted Checkout.
3. Import an existing TabMonger export or begin with an empty dashboard.
4. Manage billing, payment methods, and cancellation through the Stripe Customer Portal.
5. Export the complete dashboard and leave at any time.

Normal signup, renewals, failed-payment handling, cancellation, receipts, and account status changes should be automated. Subscription webhooks must be signature-verified, replay-safe, idempotent, and reconciled nightly.

## Proposed architecture

- One shared application service rather than one container per customer.
- PostgreSQL with tenant IDs, composite tenant-scoped relationships, and row-level security.
- Derive tenant identity only from a verified authenticated membership; never trust a tenant ID sent in request data.
- Store uploads in private tenant-namespaced paths and require authenticated delivery.
- Validate MIME types, re-encode supported raster images, reject executable formats, reject SVG/GIF uploads, and enforce strict quotas.
- Disable hosted custom JavaScript. Restrict or disable custom CSS.
- Block server-side requests to loopback, private, link-local, metadata, and other internal network ranges.
- Keep private SearXNG and other LAN navigation client-side.

## Hands-off operations target

- Candidate-first immutable deploys with migration validation, synthetic tenant tests, readiness checks, and automatic rollback.
- A pre-migration database snapshot before every schema change.
- Nightly encrypted PostgreSQL dumps and tenant-portable JSON exports copied off-host with daily, weekly, and monthly retention.
- Automated disposable restore drills, not merely backup-file creation.
- Monitoring for liveness, readiness, database health, disk space, backup age, restore results, webhook lag, and a synthetic dashboard journey.
- Restart a failed service once, then alert the operator instead of silently looping.
- Use request IDs and pseudonymous tenant hashes in logs. Never log email addresses, saved URLs/titles, exports, tokens, Stripe payloads, or uploaded contents.

Routine operation can be highly automated, but no honest hosted service can promise zero human involvement. Security incidents, disputes, tax obligations, provider-account failures, and catastrophic recovery still require an accountable operator.

## Guarded launch sequence

1. The project owner explicitly approves the current price, annual billing, account recovery, quotas, retention, beta language, and payment/tax route.
2. Build the separate service using staging authentication and Stripe test mode only.
3. Pass tenant-isolation, authorization, SSRF, upload, webhook-replay, billing-state, backup/restore, migration, and rollback tests.
4. Invite 5–10 approved beta users on existing infrastructure.
5. Observe support needs, storage, abuse patterns, failures, and resource use for at least one month.
6. Review the beta with the project owner.
7. Only after a second explicit approval, create live recurring billing and public self-service signup.
8. Move to a managed VPS or add a standby instance when usage or revenue justifies redundancy.

## Decisions required before work begins

- Approve or change the proposed `$24/year` price.
- Approve email-code login and the recovery method.
- Approve the beta limits and retention policy.
- Choose direct Stripe billing or a merchant-of-record service for tax handling.
- Approve the initial 5–10 person beta.
- Approve the point at which the service moves away from existing infrastructure.

Until those decisions are explicitly approved, this file is a ready-to-use plan—not authorization to implement it.
