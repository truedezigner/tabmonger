# Security

TabMonger is a personal dashboard designed for a trusted LAN, VPN, or other protected private network.

## Important deployment rule

Do not expose a personal TabMonger instance directly to the public internet. Saved links may identify private services or contain sensitive URL fragments, and the dashboard intentionally does not include a user-account system. If remote access is required, place it behind authentication or use a private VPN.

## Service monitoring

Only loopback and private-network HTTP/HTTPS targets are eligible for monitoring. Checks open a TCP connection to the saved host and port and immediately close it without requesting a page.

## Reports

Open a GitHub issue for a suspected vulnerability, but do not include credentials, private URLs, database files, exports, or other sensitive data in a public report.
