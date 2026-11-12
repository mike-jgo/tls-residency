# Standalone native app

## Build and package

From `rust/`, run `cargo test --locked` and `cargo build --release --locked`.
Windows output is `target/release/tls-residency.exe`; Linux output is
`target/release/tls-residency`. The UI, logos, Schibsted Grotesk font and Sheets
layout are embedded. `web/` is not a build or runtime dependency.

An installation contains the executable, `.env`, a writable data directory and,
when sync is enabled, the service-account key. Include this guide, the font's
`assets/OFL.txt` and the dependency/license information when distributing a build.
The default Slint desktop backend needs an OS desktop session. The actual arm64
Pi build, graphics backend and reader still require hardware validation.

Set the launcher's working directory to the installation folder. Relative paths
in `.env` are resolved from that folder. Configuration is loaded on startup;
restart after changing it. No TCP port or network Admin is opened.

## Configuration

Copy `.env.example` to `.env` and set `ADMIN_PASSWORD` before office use.

| Variable | Default | Purpose |
|---|---|---|
| `DATA_DIR` | `data` | Default location for the database, log and background |
| `DB_PATH` | `data/residency.db` | SQLite database; only one application may own it |
| `BACKUP_DIR` | `data/backups` | Startup, manual, restore-undo and shutdown backups |
| `BACKUP_KEEP` | `60` | Number of recognized dated database backups retained |
| `ADMIN_USER` | `admin` | Local Admin username |
| `ADMIN_PASSWORD` | `changeme` | Local Admin password |
| `TZ` | `Asia/Manila` | Display, report and Sheets timezone, independent of host zone |
| `SHEETS_SPREADSHEET_ID` | empty | Sheet ID or URL; empty explicitly disables all sync |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | `data/service-account.json` | Service-account JSON key |
| `STATION_FULLSCREEN` | `0` | `1` fills the screen |
| `STATION_TYPING` | unset | `1` permits ordinary typing on Linux for testing |
| `SLINT_BACKEND` | Slint default | PC checks use `winit-software` |

Release builds optimize for drawing speed (`opt-level = 3`). For a Pi desktop
session, test `SLINT_BACKEND=winit-femtovg` first, with `winit-software` as the
fallback. For a kiosk running directly on DRM/KMS without a desktop, build with
`cargo build --release --locked --features pi-kms` and test
`SLINT_BACKEND=linuxkms-femtovg`. Slint documents OpenGL ES 2.0 for this backend;
it requires the Pi's working KMS/EGL driver and input/seat permissions. See
[Slint's LinuxKMS backend](https://docs.slint.dev/latest/docs/slint/guide/backends-and-renderers/backend_linuxkms/).
Select the production backend only after comparing tap latency, scrolling,
idle CPU and drawing correctness on the actual Pi. Windows validation does
not verify its graphics stack.

A key is read only when sync is configured. Share the intended sheet with the
service account as Editor. The app uses outbound HTTPS to Google for OAuth and
Sheets; no remote control interface is provided. Keep the `.env` and key private.

## Import from the existing app

1. Stop the old service and browser kiosk. Back up its database with SQLite's
   backup API or the old backup command. Do not copy a live `.db` without its WAL.
2. Keep the old installation intact. Put the verified backup at a new native
   `DB_PATH`; do not point both applications at the same file. If retaining the
   appearance, also copy `background.img` to the new database's parent folder.
3. Start with `SHEETS_SPREADSHEET_ID=` explicitly empty and check People and Hours.
   The native app migrates missing optional columns and preserves users, event
   IDs, timestamps, boot IDs and tap receipts.
4. Close the app, configure the intended spreadsheet/key, then restart when ready.
   As in the old app, a new sync target treats the Sheet's roster and logs as
   authoritative. A startup backup is attempted before reconciliation. Check the
   System screen and log for backup or sync errors before proceeding.

The office Pi was imported this way on 2026-11-11; see *On the office Pi* below.

## On the office Pi

Since 2026-11-11 the office Pi (Raspberry Pi 3, 905 MB RAM, Raspberry Pi OS
with the labwc desktop) runs this app instead of the Node service and Chromium.

**Layout.** Everything is in `~/tls-residency-native/`:

| Path | What it is |
|---|---|
| `tls-residency` | The arm64 desktop build from CI (the *Pi build* workflow) |
| `.env` | Settings (mode 600). `STATION_FULLSCREEN=1`; data paths under `data/` |
| `run.sh` | Launcher: restarts the app if it exits, refuses to start a second copy |
| `data/residency.db` | The database. Only this app may open it |
| `data/service-account.json` | Sheets key (mode 600) |
| `data/background.img` | Tap screen background |
| `data/backups/` | Startup, manual and shutdown backups |
| `data/residency.log`, `data/run.log` | App log; launcher log with exit codes |

`~/.config/autostart/residency-native.desktop` runs `run.sh` at login, in the
desktop session. `run.sh` sets `SLINT_BACKEND=winit-software`.

Keep the software renderer on this Pi. Raspberry Pi OS runs labwc with
`WLR_RENDERER=pixman` on a Pi 3, so the compositor itself draws in software.
With `winit-femtovg` every app frame arrived as a full-screen GPU buffer that
labwc had to read back: one 1920×1080 redraw cost labwc 1.1–1.5 s of CPU, and
the blinking text cursor on Register pinned a core at ~98%. With
`winit-software` the app sends ordinary memory with only the changed area, and
the same redraw costs labwc 10–30 ms (measured 2026-11-11 across the clock's
minute change). The app also uses less memory (63 MB instead of 94 MB).
The Shut down button uses the existing `tlsadmin` sudoers rule for
`/usr/bin/systemctl poweroff`.

Measured at the switch, both idle on the tap screen with the same data:

| | Node + Chromium | Native (`winit-software`) |
|---|---|---|
| Memory (PSS) | ~375 MB | 63 MB |
| CPU, idle tap screen | 8.9% of one core | ~0% (labwc ~0%) |
| Pi memory available | 367 MB | 524 MB |

**Updating.** Build on CI rather than on the Pi. Swap the binary when nobody is
checked in or at a quiet time; the database and settings stay as they are.
The *Pi build* workflow runs on pushes that change `rust/` (or by hand with
`gh workflow run "Pi build"`); `gh run list --workflow "Pi build"` gives the run
ID for the commit you want.

```bash
gh run download <run-id> -n tls-residency-linux-arm64-desktop -D pi-build
tar -xzf pi-build/tls-residency-linux-arm64-desktop.tar.gz -C pi-build
scp pi-build/tls-residency-linux-arm64-desktop/tls-residency tlsadmin@tls-pi:tls-residency-native/tls-residency.new
```

Then on the Pi:

```bash
cd ~/tls-residency-native && kill "$(cat data/run.pid)"; pkill -x tls-residency; mv tls-residency.new tls-residency
```

```bash
cd ~/tls-residency-native && XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-0 setsid nohup ./run.sh >/dev/null 2>&1 < /dev/null &
```

(Logging out and back in, or rebooting, also starts it. A reboot ends everyone's
open session, so only reboot when nobody is checked in.)

**Sessions have no length limit.** A check-in stays open until the person taps
again or the Pi shuts down, however long that takes; restarting just the app
keeps it open. A check-in from before a shutdown or reboot counts as zero, and
the person's next tap is an arrival, logged with `(previous check-in was never
closed — it counts as zero)`. So shut the Pi down at the end of each day: if it
stays on overnight, a check-in nobody closed becomes a session that lasts until
the next morning's tap. `MAX_SESSION_HOURS` is no longer read.

**Rolling back to Node.** The old installation is untouched in `~/tls-residency`
at commit `d95e968`. Do not `git pull` there: master keeps Node in `web/`, and
the old service runs `node server.js` from the folder's top level.

```bash
kill "$(cat ~/tls-residency-native/data/run.pid)"; pkill -x tls-residency; mv ~/.config/autostart/residency-native.desktop ~/.config/autostart/residency-native.desktop.disabled
```

```bash
mv ~/.config/autostart/residency-station.desktop.node-disabled ~/.config/autostart/residency-station.desktop && sudo systemctl enable --now attendance.service
```

Log out and in (or reboot) to open the Chromium kiosk. The old database stops at
the switch: taps recorded since then are in the native database and the Sheet,
not in Node's. Check People and Hours after rolling back.

## Native controls

- **Register:** tap into the Card number field, or pick a recent unknown card.
  Cardless Staffers rows can prefill the form. Registering does not record a tap.
  Unsaved registration input is retained when leaving the screen in this process.
  Restored forms show a review notice and a Discard them button.
- **Admin:** sign in locally. People supports search, filters, editing and
  confirmed deactivation/reactivation. Sort by name, ID number, section or
  status; use the People filter to include deactivated staffers. People and
  Hours display 20 rows per page, and Search waits briefly for typing to pause.
  Existing history is kept.
  Unsaved edits survive idle return; sign in and reopen that person's Edit to
  resume. Cancel or Discard them clears the draft; drafts last for this process.
- **Hours:** use inclusive From/To dates or a month shortcut; select a person to
  see uncounted sessions directly below their row. Previous month, This month
  and Next month fill the date range; the dropdown includes Totals and recorded
  months. Export writes a new CSV file and refuses to overwrite
  an existing file. The CSV includes all people in the applied date range.
- **Appearance:** choose an image using the app's folder list, adjust opacity,
  choose Christmas decorations or hide rankings. PNG/JPEG/WebP/GIF, at most 8 MB.
- **System:** see sync errors, roster warnings and Staffers awaiting cards. Backup
  and restore use the same native file interface; no browser/file-dialog helper.
- **Sync:** Dashboard shows uploaded and waiting tap counts and the last successful
  sync time. An unconfirmed roster save requests reconciliation automatically;
  check People before retrying. Taps arriving during an upload queue another pass.
- **Files:** enter a folder path and Open folder, select a folder and Open selected
  folder, or enter an absolute file path in the filename field. Up goes to its
  parent. Exports require a new filename. Escape/Cancel returns to the prior page.
  Backups opens the configured backup directory. USB drives lists mounted drive
  locations (including other mounted volumes); mounting itself remains an OS
  action. Files show their modification time in UTC and exact size in bytes.
- Returning to the tap screen signs out. Inactivity returns there after two
  minutes; the backend additionally expires Admin authorization after 30 minutes.

The reader is treated as a keyboard: digits plus Enter. Linux accepts only gaps
of at most 100 ms between keys. Overflow is consumed safely. A scan on the tap
screen takes precedence over focused buttons, including shutdown controls.
Typing into management forms never records attendance.

Tab reaches navigation links and Hours rows; Enter or Space activates them.
Shutdown keeps focus on its two actions, starting on Cancel, and Escape closes it.
Success and error notices stay above the scrolling page. Register and Admin
have 44px-high touch targets. The station's background hides the pointer while
action controls keep their pointer cursor. The minimum window remains
1000×660 logical pixels; confirm the office monitor's resolution and scaling
before installation.

Taps return their durable receipt before refreshing status. The UI presents
that receipt, then acknowledges it and publishes status off the UI thread.
Reports fetch check-ins in the requested range and their immediate successors
in one query, including checkouts after the range's end. Sync counts stay in
SQLite. Unchanged presence and leaderboard models are retained across status
updates. Backgrounds are cropped/scaled to the window's physical pixel size
on load or resize, and Christmas strips use cached repeating image assets.

## Backups and restore

Backups are consistent SQLite snapshots, written to a temporary filename and
renamed only when complete. The native log is beside the database. A configured
USB backup directory is preferable to keeping every copy on one SD card.

Admin → System → Back up now saves a snapshot. Choose backup to restore, inspect
the person/tap counts and confirm. The app verifies SQLite integrity and the
attendance schema, saves the current database first, and restores through the
live SQLite connection. It resets sync for a complete republish. If needed,
restore the pre-restore backup displayed in the success message.

The selected backup is protected from retention while the pre-restore copy is
created. This may temporarily keep one extra backup; the next ordinary backup
applies the configured retention limit again.

Do not run the old service on the native database to roll back. Stop the native
app and restore its pre-migration backup into a separate old-service database,
then start that service. Keep the key, background and configuration alongside
that installation.

## Clock and shutdown

Windows/macOS trust the host clock and treat each app run as a fresh boot.
Linux uses the kernel boot ID, NTP readiness or a plausible RTC agreeing with the
system clock. Without `timedatectl`, it trusts the host as the old service does.

Shut down shows everyone still in, initially focuses Cancel and accepts Escape.
Linux attempts a final backup and runs `sudo -n /usr/bin/systemctl poweroff`.
Configure the same narrow shutdown authorization as the existing Pi service.
Errors remain visible. Windows/macOS only log the request and save a backup;
they do not power off the development computer.

## Validation

See [NATIVE-VALIDATION.md](NATIVE-VALIDATION.md) for standalone parity checks and
remaining Pi validation. [VALIDATION.md](VALIDATION.md) describes the earlier
tap-only HTTP client; its measurements do not describe this standalone build.
