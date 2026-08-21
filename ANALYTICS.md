# TabMonger Website Analytics

TabMonger uses a small first-party aggregate counter for the public marketing website. It is intentionally narrower than a conventional analytics product.

## Scope

Analytics applies only to `tabmonger.com`. The downloaded self-hosted dashboard and Chrome, Brave, Edge, and Firefox companions remain telemetry-free.

The website records these allowlisted events:

- `page_view`
- `download_portable`
- `download_macos`
- `download_windows`
- `download_linux`
- `download_chromium`
- `download_firefox`
- `github_open`
- `support_open`
- `feedback_open`
- `feedback_submit`
- `poll_vote`

Traffic sources are reduced in the browser to one of these categories before transmission:

- `direct`
- `search`
- `github`
- `reddit`
- `hackernews`
- `producthunt`
- `social`
- `newsletter`
- `other`

No raw referral URL is sent.

The macOS, Windows, and Linux counters represent the platform button someone chose. They do not inspect or infer the visitor's operating system. The general download buttons continue to use `download_portable`.

## Data stored

Each accepted event contains only:

- UTC calendar date
- event name from the allowlist
- source category from the allowlist

The analytics store does not save IP addresses, source hashes, cookies, browser identifiers, user agents, full URLs, query strings, or raw referrers. The service may briefly use an in-memory one-way source hash to rate-limit abuse, but that value is not written with analytics events.

Records expire after 180 days. The server compacts old records during routine cleanup.

## Browser-local opt-out

Opening `https://tabmonger.com/?analytics=off` once disables website analytics in that browser profile. The preference is stored in that browser's first-party local storage and a first-party opt-out preference cookie; the query parameter is removed only after one of those safeguards succeeds. No page-view or click events are sent while it remains disabled. Opening `https://tabmonger.com/?analytics=on` turns the counters back on.

Ordinary page views are counted at most once per tab session. Reloading the same tab does not increase the counter.

The opt-out is deliberately available to anyone and is not tied to an account, IP address, advertising identifier, or secret owner token. It must be enabled once in each browser profile or device that should be excluded.

## Private dashboard

The metrics dashboard is served only on the app host’s LAN metrics port:

```text
http://<tabmonger-server-lan-address>:4343/metrics/
```

The public website origin does not expose the dashboard or report API. The dashboard shows page views, downloads, meaningful actions, source categories, and a daily trend. It refreshes automatically without running a process on a workstation.

## Operations

Production data is stored beneath the protected TabMonger deployment data directory. Candidate deployments use disposable copies and cannot contaminate production totals. Deployment backups include the analytics store and follow the same protected 30-day rollback retention used for community data.

A weekly server-side report is generated under:

```text
/opt/apps/data/tabmonger-site/analytics-reports/latest.md
```

The report process runs on the server, not on a user workstation. Public GitHub stars, forks, and release-download totals may be included without authentication. GitHub clone traffic requires a private owner token and is deliberately omitted from the initial version.

## Privacy promise

The counters are for product decisions, not advertising profiles. They are not sold, shared with an advertising network, or used to identify a person. The public privacy page is the user-facing source of truth; this document records the implementation and operating boundaries.
