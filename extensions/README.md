# TabMonger browser extensions

These build-free Manifest V3 extensions make a self-hosted TabMonger dashboard the new-tab destination in Chrome, Edge, and Firefox. They contain no analytics, remote scripts, accounts, or payment code.

## Which folder to load

- Chrome or Edge: `extensions/chromium/`
- Firefox: `extensions/firefox/`

The browser-specific folders are ready to load as-is. Shared source lives in `extensions/source/`; `node extensions/scripts/sync.mjs` copies it into both packages.

## Local installation

### Chrome

1. Open `chrome://extensions/`.
2. Turn on **Developer mode**.
3. Choose **Load unpacked** and select the `extensions/chromium/` folder.
4. Open the TabMonger extension's options and paste the address shown by the TabMonger launcher.

### Edge

1. Open `edge://extensions/`.
2. Turn on **Developer mode**.
3. Choose **Load unpacked** and select the `extensions/chromium/` folder.
4. Open the TabMonger extension's options and paste the address shown by the TabMonger launcher.

### Firefox development install

1. Open `about:debugging#/runtime/this-firefox`.
2. Choose **Load Temporary Add-on**.
3. Select `extensions/firefox/manifest.json`.
4. Open the extension's preferences and paste the address shown by the TabMonger launcher.

Firefox removes temporary add-ons after a restart. A permanent consumer install needs a Mozilla-signed package; the source is already separated so it can be submitted without changing the runtime design.

An address such as `http://192.168.1.20:8787/`, `http://tabmonger.local:8787/`, or an HTTPS reverse-proxy address is supported. Every device must be able to reach the TabMonger host, and the host firewall must allow the selected port on the trusted LAN.

## New-tab behavior

The browser first opens a tiny local extension page. If a target is configured and enabled, it navigates the top-level tab to that address. Top-level navigation is more reliable than framing the app: it preserves authentication, links, downloads, address-bar behavior, and deployments that use `X-Frame-Options` or `frame-ancestors`.

The optional friendly-offline check requests access only to the configured scheme and hostname. Browser match patterns cannot be limited to one port, so the permission applies to that hostname's HTTP or HTTPS ports; it is not requested until the user enables the check. The extension calls TabMonger's read-only `/api/health` route with credentials omitted, then either opens the dashboard or leaves a local retry page. If access is declined, new tabs simply open the saved address directly.

The toolbar popup provides a quick open/pause control. Disabling or removing the extension restores the browser's normal new-tab page.

## Privacy and security

- Required permission: `storage`, used only for the base URL, two local choices, and the derived host-permission pattern needed to remove old access cleanly after an address change.
- Optional permission: the configured HTTP or HTTPS hostname, used only for the health check.
- URL usernames and passwords are rejected. Queries and fragments are removed before storage.
- No browsing history, dashboard content, secrets, telemetry, analytics, external API, or remote code is collected or used.
- Private LAN HTTP is supported because that is the normal self-hosted setup. Use HTTPS before exposing TabMonger beyond a trusted LAN.

## Validate changes

From the repository root:

```sh
python3 extensions/scripts/render_icons.py
node extensions/scripts/sync.mjs
node extensions/scripts/validate.mjs
node extensions/scripts/runtime-tests.mjs
```

The validator checks both manifests, permissions, CSP-safe local assets, shared-file parity, URL safety behavior, and PNG icon dimensions. Runtime tests exercise the shared code against Chromium's callback APIs and Firefox's promise APIs. They require only Node.js; icon rendering additionally uses Pillow, which is a development convenience and is not needed to run either extension.
