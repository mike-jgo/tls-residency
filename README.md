# TLS Residency

One native Rust + Slint app for RFID attendance, registration and local administration.
SQLite, Google Sheets sync, backups, images, fonts and the complete office interface
are handled by Rust. The native app does not start Node, open Chromium or expose
an HTTP/Admin service on the office network.

- `rust/`: the standalone replacement, currently being verified on Windows.
- `web/`: the existing deployed Node implementation and its reference tests.
  Its previous documentation is preserved in [web/README.md](web/README.md).
- [PLAN.md](PLAN.md): migration scope and verification checklist.
- [rust/README.md](rust/README.md): build, configuration, import and recovery.

The deployed Pi service has not been replaced. A Windows preview has been run
with live Google Sheets sync using a separate local database. Keep the deployed
service until the native package is tested with the Pi's display, reader and Linux session.

## Build and run

```powershell
cd rust
cargo build --release --locked
Copy-Item .env.example .env
# Edit .env, including ADMIN_PASSWORD and the data paths.
.\target\release\tls-residency.exe
```

The release executable embeds its UI, font and logos. Copy it to an installation
folder outside this checkout and launch it from there with its own `.env` and
writable data folder. Rust is needed to build; Node and a browser are unnecessary
at runtime. See the native guide before importing an existing database.

## Checks

```powershell
cd rust
cargo test --locked
cargo build --release --locked
```

The reference suite remains available with `npm test` in `web/`. Native service
tests use temporary databases and a Google Sheets stand-in, never the live sheet.

## Office workflows

Cards are read only on the tap screen. Registration does not check a person in;
return to the tap screen and tap afterward. Admin manages People, Hours,
Appearance, sync diagnostics and backup/restore locally. Returning to the tap
screen signs out; two minutes of inactivity also returns there.

Attendance keeps the existing policies: five-second repeat suppression,
leading-zero card numbers, abandoned sessions after a reboot, a configurable
maximum session length, inclusive report dates and exclusion of Dummy staffers.
Taps work offline. With Sheets configured, roster changes wait for confirmation
from Google; an uncertain response tells the admin to sync and check before retrying.
