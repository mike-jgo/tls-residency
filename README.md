# TLS Residency

One native Rust + Slint app for RFID attendance, registration and local administration.
SQLite, Google Sheets sync, backups, images, fonts and the complete office interface
are handled by Rust. The native app does not start Node, open Chromium or expose
an HTTP/Admin service on the office network.

- `rust/`: the standalone app. It has run the office Pi since 2026-11-11.
- `legacy/`: the previous Node implementation and its reference tests. It stays
  installed on the Pi, switched off, as the rollback. Its documentation is
  preserved in [legacy/README.md](legacy/README.md).
- [PLAN.md](PLAN.md): migration scope and verification checklist.
- [rust/README.md](rust/README.md): build, configuration, import and recovery.

The office Pi (a Raspberry Pi 3) runs the CI-built arm64 package from
`~/tls-residency-native`, started at login. Installing, updating and rolling back
are in [rust/README.md § On the office Pi](rust/README.md#on-the-office-pi).
Some Pi hardware checks are still open; see [PLAN.md](PLAN.md#rollout-status).

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

The reference suite remains available with `npm test` in `legacy/`. Native service
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
