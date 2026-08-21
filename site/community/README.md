# TabMonger community service

This directory contains the dependency-free Node 22 service behind TabMonger's
feedback form and owner-moderated feature poll. It uses Node built-ins only. It
does not contain a third-party analytics SDK, public administration route, account system,
or third-party runtime package.

The production shape is deliberately split:

- The existing nginx container remains the public static server and reverse
  proxies only the exact public community routes plus the aggregate analytics event route.
- The community service runs as UID/GID `10001`, listens on port `8081`, and is
  reachable only through the trusted local/private proxy path. Do not publish a
  direct public API port.
- The supplied `Containerfile` does not copy `dist/`; `STATIC_ROOT` is disabled
  there. The server retains tested static-file support for a future direct-host
  deployment, but it is dormant in the API-only image.
- Run one service process and one replica against a local filesystem. The JSON
  store is not safe for multiple writers, multiple replicas, or NFS.

## Public API contract

Every API response is JSON, has `Cache-Control: no-store`, and has no CORS
allowlist headers. Mutation requests require `Content-Type: application/json`,
an exact allowed `Origin`, and (when the browser supplies it)
`Sec-Fetch-Site: same-origin`. The API hard ceiling is 16 KiB; production Nginx
uses smaller 4 KiB submission and 2 KiB vote limits.

### Health

`GET /api/community/health`

```json
{"ok":true,"service":"tabmonger-community","schemaVersion":1}
```

### Submit feedback or a feature request

`POST /api/community/submissions`

```json
{
  "kind": "feature",
  "title": "Add keyboard shortcuts",
  "details": "A focused shortcut menu would make navigation faster.",
  "website": ""
}
```

- `kind` is exactly `feature` or `feedback`.
- `title` is 3–80 normalized Unicode characters.
- `details` is 3–1200 normalized Unicode characters.
- `website` is the honeypot and must remain empty. A filled honeypot receives
  the same generic response but is not stored.
- Unknown fields are rejected.

A syntactically accepted request returns `202 {"ok":true}`. Every real
submission enters `pending`; acceptance never means publication or approval.
The response intentionally includes no submission ID or moderation detail.

### Read the poll

`GET /api/community/poll`

```json
{
  "updatedAt": "2026-08-20T20:00:00.000Z",
  "includesStarterVotes": true,
  "items": [
    {"id":"85b37968-7874-47bb-a36d-3b25d6485d38","title":"Add keyboard shortcuts","votes":12,"starterVotes":5}
  ]
}
```

Each item has `id`, `title`, `votes`, and `starterVotes`; the envelope also says whether starter votes are present. Project-owner starter votes are disclosed in the public UI and remain separate from browser-vote hashes. The envelope timestamp is the
latest poll activity. Pending/rejected submissions, raw feature details,
general feedback, moderation states, source hashes, and private timestamps are
never selected for this response. Public reads come only from the independent
`pollItems` collection.

### Vote or change a vote

`POST /api/community/vote`

```json
{
  "voterId": "663487a7-21d7-478a-a486-a8f8c7f090f8",
  "featureId": "85b37968-7874-47bb-a36d-3b25d6485d38"
}
```

`voterId` must be a lowercase-or-uppercase UUID v4 generated from at least 128
random bits, normally `crypto.randomUUID()` and retained in browser-local
storage. It belongs only in the JSON body—never a query string or log. The
server stores only its HMAC. A browser ID has one active selection; voting for a
different approved feature replaces the prior selection. Success returns
`200 {"ok":true}`.

This is an intentionally lightweight anonymous poll, not a fraud-proof
election. Clearing browser storage or using another private profile produces a
new voter ID and can permit another vote. Source-based rate limits reduce casual
abuse without pretending to establish identity.

## Moderation

There is no HTTP admin route. The running process owns every read/modify/write,
including moderation, so votes cannot be lost to a second CLI writer. The CLI
talks to a Unix-domain socket inside `COMMUNITY_DATA_DIR`; the directory is mode
`0700` and the socket is mode `0600`.

Run these inside the service container (replace the container name as needed):

```text
sudo podman exec tabmonger-community-api node moderate.mjs list --status pending
sudo podman exec tabmonger-community-api node moderate.mjs list --kind feedback
sudo podman exec tabmonger-community-api node moderate.mjs show <submission-id>
sudo podman exec tabmonger-community-api node moderate.mjs approve <submission-id>
sudo podman exec tabmonger-community-api node moderate.mjs approve <submission-id> --title "Owner-edited public title"
sudo podman exec tabmonger-community-api node moderate.mjs reject <submission-id>
sudo podman exec tabmonger-community-api node moderate.mjs mark-reviewed <submission-id>
sudo podman exec tabmonger-community-api node moderate.mjs poll
sudo podman exec tabmonger-community-api node moderate.mjs poll --all
sudo podman exec tabmonger-community-api node moderate.mjs close <poll-item-id>
sudo podman exec tabmonger-community-api node moderate.mjs set-starter-votes <poll-item-id> <count>
```

Approval is allowed only for a pending feature request. It revalidates and
copies only the chosen title into a new independent poll record; it never flips
the raw row into a public object. General feedback cannot be approved. Rejection
and `mark-reviewed` apply only to pending rows. `close` archives an active poll
item and removes its anonymous votes in the same serialized mutation. Archived
poll records remain private, never appear in the public poll, and expire after
30 days. At most 50 items may be active and 500 active-plus-archived poll
records may exist.

## Filtering and abuse controls

Input is NFKC-normalized and then checked with conservative limits. The service
rejects Unicode controls/private-use/unassigned/bidirectional formatting,
terminal escapes, HTML/Markdown/BBCode or active-content forms, URLs, common
profanity/slurs/threats, obvious promotional spam, extreme repetition, and
unknown fields. Titles are revalidated again at approval and when the store is
loaded.

Filtering is defense in depth, not an automatic publishing decision. Every
feature remains private until the owner explicitly approves its title. Frontend
code must render returned titles with `textContent`, never `innerHTML`.

Default in-memory fixed-window limits are:

- analytics events: 240/source/minute and 20,000 total/minute;
- submissions: 5/source/hour and 200 total/hour;
- votes: 60/source/minute and 5,000 total/minute;
- poll reads: 180/source/minute and 20,000 total/minute.

Rate-limit state intentionally resets on process restart. Limits are keyed by a
salted source HMAC held only in memory, never a stored raw address or a source
identifier saved with the submission.

## Persistence and retention

`COMMUNITY_DATA_DIR/community.json` has `schemaVersion: 1` and mode `0600`.
Aggregate website events are stored separately in `analytics.ndjson` as date,
allowlisted event name, and coarse source category only; they expire after 180 days.
Every mutation is serialized through one process-wide queue, applied to a copy,
schema-validated, written to a same-directory mode-`0600` temporary file,
flushed with `fsync`, atomically renamed, and followed by a parent-directory
`fsync`. Failed temporary files are removed best-effort and storage failures
return `503` without exposing filesystem details. The process fail-stops after
a persistence failure so it cannot overwrite a renamed file from stale memory;
the production service exits for systemd to restart it. Startup removes safe
abandoned store temporaries and fails closed on malformed, oversized, symlinked,
or schema-invalid state.

Cleanup runs at startup, hourly, and before mutations:

- pending raw submissions expire after 180 days;
- rejected and reviewed raw submissions expire 30 days after the decision;
- approved raw feature title/details expire 30 days after approval;
- the independently copied approved poll title and its votes remain public only
  while the poll item is active;
- closing a poll item removes its votes immediately; the now-private archived title
  record expires after 30 days.

The bounded store permits 5,000 raw submissions, 500 total poll records, 50
active poll items, and 100,000 browser-vote hashes. Back up the persistent local
volume with the normal host snapshot/backup system. Because the sole data file
is replaced atomically, a reader sees a complete old or complete new version;
restore testing should still be part of operations. Protect backups to the same
standard and apply a finite backup-retention policy, since backups can outlive
application cleanup.

## Runtime configuration

| Variable | Default | Contract |
| --- | --- | --- |
| `COMMUNITY_HASH_SALT` | none | **Required.** Stable secret of 32–4096 UTF-8 bytes. Production fails closed without it. |
| `COMMUNITY_ALLOWED_ORIGINS` | `https://tabmonger.com,https://www.tabmonger.com` | Comma-separated exact origins accepted for mutations. |
| `COMMUNITY_DATA_DIR` | `/data/community` | Persistent local directory, owned by service UID 10001 in the image. |
| `COMMUNITY_ADMIN_SOCKET` | `$COMMUNITY_DATA_DIR/admin.sock` | Private local moderation socket. |
| `COMMUNITY_TRUST_PROXY` | unset/off | Set to `1` only when direct origin access is blocked and forwarding headers come exclusively from the trusted proxy/tunnel. |
| `HOST` | `0.0.0.0` in source; `127.0.0.1` in the API image | Listener address. Keep production on a private/loopback path. |
| `PORT` | `8081` | HTTP listener. |
| `STATIC_ROOT` | `/app/dist` in source; disabled in the API image | Optional static root for direct-host mode. |

Generate the salt once with a password manager or a command such as
`openssl rand -hex 32`, store it in the protected runtime environment, and keep
it stable. Rotating it changes both source and voter hashes, so a browser that
already voted could be counted again unless votes are intentionally reset.

When `COMMUNITY_TRUST_PROXY=1`, a valid `CF-Connecting-IP` is preferred, then the
first valid `X-Forwarded-For` address. Otherwise only the TCP peer address is
used. Raw addresses are neither persisted nor request-logged by this service.

## Container and tests

Build from the `site/` directory so the `community/` copy path is correct:

```text
podman build -f community/Containerfile -t localhost/tabmonger-community .
```

Provide the required salt at runtime, mount a persistent local directory at
`/data/community`, and keep the listener behind the existing nginx/private
deployment path. The image has no install step and no package lock because it
has zero third-party dependencies.

Run the complete disposable test suite with Node 22:

```text
cd site/community && npm test
```

Tests cover normalization/filtering, pending and feedback isolation, explicit
approval/public-title copying, exact public fields, vote changes, concurrent
write serialization, persistence/restart, raw-address and voter-ID absence,
retention, active-item limits and closing, atomic-write failure cleanup, strict
origin/body/rate/honeypot rules, no public admin route, static traversal/symlink
blocking, cache/security headers, corrupt-store failure, and required-salt
failure.
