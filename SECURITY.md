# Security

TabMonger is a personal dashboard for a trusted LAN, private VPN, or an authenticated private proxy. It intentionally has no user-account system.

## Deployment boundary

Do not expose a personal TabMonger instance directly to the public internet. Anyone who can reach an unprotected instance can view and change its links and settings. Saved URLs, the SQLite database, exports, and backups may contain private service addresses or sensitive URL fragments.

Bind only to the network interfaces you need, allow the port through a firewall on trusted private networks only, and use a private VPN for remote access whenever possible.

## Browser-request safeguards

The server rejects cross-site browser API requests, untrusted browser Host headers, and framing. These controls reduce DNS-rebinding, cross-site mutation, export, and clickjacking risks, but they are defense in depth—not authentication.

Command-line clients without browser Origin or Fetch Metadata headers remain supported for local automation.

## Authenticated reverse proxies

An HTTPS reverse proxy must authenticate every route, preserve the browser-facing `Host` header, and set that hostname in `TABMONGER_ALLOWED_HOSTS`. The value is a comma-separated hostname list without schemes or ports, for example:

```text
TABMONGER_ALLOWED_HOSTS=dashboard.example.net
```

If the proxy rewrites `Host` to `localhost`, same-origin browser API calls will be rejected. Do not rely on a hidden URL as authentication, and do not place credentials or tokens in the TabMonger address.

## Service monitoring and outbound requests

Monitoring and weather are off on a clean installation. When enabled, monitoring opens short TCP connections only to saved loopback/private-network HTTP or HTTPS targets. Weather is fetched by the server from wttr.in and cached; browser tabs do not contact the weather provider.

## Vulnerability reports

Use the repository’s GitHub Security area for a private report when that option is available. If it is not, open a minimal issue asking for a private contact path—do not post exploit details, credentials, private URLs, databases, exports, backups, or payment receipts publicly.
