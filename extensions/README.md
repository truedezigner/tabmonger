# TabMonger browser extensions

These build-free Manifest V3 extensions make a self-hosted TabMonger dashboard the new-tab destination in Chrome, Brave, Edge, and Firefox. They contain no analytics, remote scripts, accounts, or payment code.

## Download a browser companion

- [Download for Chrome, Brave, or Edge](https://github.com/truedezigner/tabmonger/releases/latest/download/TabMonger-Chromium-extension.zip)
- [Chromium package SHA-256](https://github.com/truedezigner/tabmonger/releases/latest/download/TabMonger-Chromium-extension.zip.sha256)
- [Download for Firefox](https://github.com/truedezigner/tabmonger/releases/latest/download/TabMonger-Firefox-extension.zip)
- [Firefox package SHA-256](https://github.com/truedezigner/tabmonger/releases/latest/download/TabMonger-Firefox-extension.zip.sha256)

Download and extract the ZIP before loading it. Each archive contains one clearly named folder with the ready-to-load browser package. These are transparent, build-free companion packages from the [TabMonger repository](https://github.com/truedezigner/tabmonger); they are not browser-store installations.

When working from a source checkout or the full TabMonger portable download instead, use `extensions/chromium/` for Chrome, Brave, or Edge and `extensions/firefox/` for Firefox. Shared development source lives in `extensions/source/`; `node extensions/scripts/sync.mjs` copies it into both packages.

## Local installation

### Chrome or Brave

1. Download and extract the Chromium package above.
2. Open `chrome://extensions/` in Chrome or `brave://extensions/` in Brave.
3. Turn on **Developer mode**.
4. Choose **Load unpacked** and select the extracted `TabMonger-Chromium-extension/` folder.
5. Open the TabMonger extension's options and paste the address shown by the TabMonger launcher.

Keep the extracted folder in place while the extension is installed. Chrome and Brave may show a normal Developer mode notice because this transparent package is loaded directly rather than through their stores.

### Edge

1. Download and extract the Chromium package above.
2. Open `edge://extensions/`.
3. Turn on **Developer mode**.
4. Choose **Load unpacked** and select the extracted `TabMonger-Chromium-extension/` folder.
5. Open the TabMonger extension's options and paste the address shown by the TabMonger launcher.

### Firefox development install

1. Download and extract the Firefox package above.
2. Open `about:debugging#/runtime/this-firefox`.
3. Choose **Load Temporary Add-on**.
4. Select `TabMonger-Firefox-extension/manifest.json` from the extracted folder.
5. Open the extension's preferences and paste the address shown by the TabMonger launcher.

Firefox removes this temporary add-on after a restart. The download is source for a temporary developer installation, not a permanently installable `.xpi`. Permanent consumer installation requires Mozilla signing; the source is already separated so it can be submitted without changing the runtime design.

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
python3 packaging/build_extensions.py
```

The validator checks both manifests, permissions, CSP-safe local assets, shared-file parity, URL safety behavior, and PNG icon dimensions. Runtime tests exercise the shared code against Chromium's callback APIs and Firefox's promise APIs. The package builder creates deterministic ZIPs and SHA-256 sidecars in `dist/` while including only the ready-to-load browser files. The validators require only Node.js; icon rendering additionally uses Pillow, which is a development convenience and is not needed to run either extension.
