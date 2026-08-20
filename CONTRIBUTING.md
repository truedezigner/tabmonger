# Contributing to TabMonger

TabMonger grows through small, understandable improvements. Bug reports, documentation fixes, accessibility work, platform testing, browser-extension improvements, and focused feature pull requests are all welcome.

Financial support is never required to participate. Code, testing, ideas, and clear bug reports are valuable contributions.

## Before you start

- Search the [issue tracker](https://github.com/truedezigner/tabmonger/issues) for related work.
- Open a feature request before building a large change so the approach can be discussed early.
- Keep real dashboard data private. Never attach a database, backup, private URL, access token, or personal icon collection to an issue.

## Project principles

Changes should preserve the qualities that make TabMonger useful:

- local-first and self-hosted;
- no telemetry, advertising, or required account;
- Python standard-library-only at runtime;
- plain browser-native HTML, CSS, and JavaScript;
- portable data and understandable backups;
- safe defaults for trusted LAN or private-VPN use;
- accessible controls and restrained resource use.

An optional development or packaging dependency is acceptable only when the shipped dashboard does not require it.

## Ways to contribute

### Report a bug

Include your operating system, Python version, browser, the smallest set of reproduction steps, expected behavior, and actual behavior. Replace private hostnames and addresses with examples such as `192.168.1.20`.

### Improve the dashboard

The runtime lives in `server.py` and `public/`. Keep changes dependency-free and test with a temporary data directory rather than a personal installation.

### Improve browser support

The unpacked new-tab companion source lives in `extensions/`. Changes should request the fewest permissions possible and must not add analytics or remote code.

### Share a customization

TabMonger supports trusted local CSS and JavaScript under **Settings → Advanced**. See [Extending TabMonger](docs/EXTENDING.md) before proposing a reusable recipe.

## Pull-request checklist

- Use fictional links and clean first-run data.
- Do not add secrets, `.env` files, databases, uploads, or generated backups.
- Run the relevant automated checks documented in the README.
- Test keyboard navigation and a narrow mobile layout for interface changes.
- Update documentation when behavior or setup changes.
- Keep the pull request focused enough to review.

By contributing code, you agree that your contribution can be distributed under the project’s [MIT license](LICENSE).
