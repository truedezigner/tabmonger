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
PUBLIC_STRIPE_SUPPORT_URL=https://buy.stripe.com/example
PUBLIC_STRIPE_SUPPORT_READY=true
```

Until then, support controls render as a non-clickable “activating soon” state. No Stripe JavaScript, payment iframe, API key, bank detail, or other financial credential is stored in the site.

## Deployment

The CT app path is `/opt/apps/tabmonger-site`, the container is `tabmonger-site`, and boot persistence is provided by `podman-managed-app@tabmonger-site.service`.
