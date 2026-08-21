# Installation and LAN setup

TabMonger runs on Windows, macOS, or Linux with Python 3.10 or newer. The dashboard itself installs no Python packages.

## Recommended portable setup

1. Download `TabMonger-portable.zip` from the [latest GitHub release](https://github.com/truedezigner/tabmonger/releases/latest).
2. Extract the complete ZIP to a normal folder. Do not run a launcher from inside the ZIP preview.
3. Start the launcher for your system.
4. Keep its window open while using TabMonger.

The launcher prefers opening a private LAN address such as `http://192.168.1.20:8787/`, so that same address can be saved in browser companions on trusted computers. It also prints a localhost fallback. If port 8787 belongs to another program, it chooses a nearby free port and prints the actual address.

## Windows

Install Python 3.10 or newer from python.org if neither `py` nor `python` is available, and enable the installer’s PATH option. Then double-click `Start TabMonger.bat`.

Windows Firewall may ask whether Python can accept connections. Allow **Private networks** only. Do not allow public networks for an ordinary home installation.

## macOS

Confirm `python3 --version` reports 3.10 or newer, then double-click `Start TabMonger.command`. If macOS blocks a downloaded script, inspect the file and use Finder’s **Open** confirmation; do not disable Gatekeeper.

Recent macOS versions do not always include Python. Install a current Python 3.10+ release from python.org if needed.

## Linux

Most current distributions provide Python 3.10 or newer. Double-click `Start TabMonger.sh` and choose **Run** if the file manager asks. From a terminal, the equivalent one-liner is:

```bash
./Start\ TabMonger.sh
```

For automatic startup under a per-user systemd service, run `./install.sh`. It copies application files to `~/.local/lib/tabmonger/`, stores private state under `~/.local/share/tabmonger/`, and enables `tabmonger.service` without root access.

## Connect other computers

1. Keep the TabMonger host running.
2. Open the printed LAN URL from another computer on the same trusted network.
3. If it does not load, allow the selected TCP port through the host firewall for the private LAN only.
4. Load the matching new-tab companion from [`extensions/`](../extensions/) and save the working address.

Use a router DHCP reservation for the host, or a working local hostname such as `tabmonger.local`, so the saved address does not change. Keeping the default port 8787 also avoids reconfiguring each browser extension. Private VPN addresses in `100.64.0.0/10` are supported; add public-looking VPN DNS names to `TABMONGER_ALLOWED_HOSTS`.

Chrome and Edge can keep an unpacked extension loaded in Developer mode. Standard Firefox treats the repository version as a temporary development add-on and removes it after restart; permanent consumer installation requires a Mozilla-signed package.

## Private data and updates

Clean portable launches use the operating system’s user-data folder:

- Linux: `~/.local/share/tabmonger/`
- macOS: `~/Library/Application Support/TabMonger/`
- Windows: `%LOCALAPPDATA%\TabMonger\`

This state is separate from the downloaded application, so replacing the extracted app files does not replace links, settings, uploads, or backups. Stop the old launcher, extract the new release, and start the new launcher. Linux service users should run the new release’s `install.sh` again to update the installed application files.

Existing older checkouts containing `data/tabmonger.db` continue using that ignored database and `assets/uploads/` automatically.

## Advanced paths and network exposure

Use `--data-dir` or `TABMONGER_DATA_DIR` to choose another state directory. `TABMONGER_HOST` and `TABMONGER_PORT` override the launcher defaults.

TabMonger has no login screen. Keep ordinary installations on a trusted LAN or private VPN. An authenticated HTTPS reverse proxy must preserve `Host` and include its public hostname in the comma-separated `TABMONGER_ALLOWED_HOSTS` environment variable; see [SECURITY.md](../SECURITY.md).

## Troubleshooting

- **The launcher closes immediately:** start it from a terminal to read the error, and confirm Python 3.10+ is available.
- **Another computer cannot connect:** verify the printed LAN URL on the host first, then check private-network firewall rules and Wi-Fi client isolation.
- **The extension opens an offline page:** start TabMonger, confirm the saved address in a normal tab, and update the extension if the host address or port changed.
- **The address changes after a router reboot:** reserve the host address in DHCP or use a reliable local hostname.
