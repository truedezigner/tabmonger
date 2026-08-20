# TabMonger website

The public Astro site for `tabmonger.com`. It is built as static HTML/CSS, served by a small Nginx container, and deployed to the PageFollower CT on port `4342`.

## Local development

```bash
npm ci
npm run dev
```

## Production build

```bash
npm run build
```

## One-time support link

The public site uses a Stripe-hosted “customer chooses what to pay” Payment Link. Set both values in `/opt/apps/data/tabmonger-site/runtime.env` after Stripe has activated live payments:

```bash
PUBLIC_SUPPORT_URL=https://buy.stripe.com/example
PUBLIC_STRIPE_SUPPORT_READY=true
```

`PUBLIC_STRIPE_SUPPORT_URL` remains supported for existing deployments. When a checkout URL is present and `PUBLIC_STRIPE_SUPPORT_READY` is exactly `true`, the header, support card, and footer link directly to Stripe. Until then, the page renders an “opening soon” state. No Stripe JavaScript, payment iframe, API key, bank detail, or other financial credential is stored in the site.

Run `npm test` to verify both preferred and legacy environment names, all three active support entry points, the pending state, and rejection of non-Stripe schemes and hosts. The smoke test uses synthetic Stripe-domain markers and never prints a checkout URL.

## Deployment

The CT app path is `/opt/apps/tabmonger-site`, the container is `tabmonger-site`, and boot persistence is provided by `podman-managed-app@tabmonger-site.service`.

`deploy-tabmonger-site.sh` builds and checks a separately named candidate while the current container remains online. It only switches the origin after the candidate passes HTTP, security-header, headline, and support-link checks. The previous image is retained under a timestamped rollback tag and is restored automatically if cutover fails.
