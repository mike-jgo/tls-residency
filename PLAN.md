# Plan: a native tap screen for the Pi 3

## Why

The office Pi is a Raspberry Pi 3 Model B with 1 GB of RAM. Its graphics chip only
does OpenGL ES 2.0, and Chromium needs ES 3.0, so Chromium draws the tap screen in
software. Two things follow:

- **Memory is tight.** Chromium takes about 430 MB of the Pi's 905 MB. On
  2026-11-10 the Pi had about 30 MB free and 180 MB in swap.
- **Any motion is expensive.** Every animation redraws the whole screen on the
  CPU. The Christmas snow kept the Pi at 69% CPU and 67 °C, and the Pi died
  without a clean shutdown at about 17:25 that day. The snow has since been
  removed; the Pi now idles at about 3%.

Measured on a PC with software drawing, against the same server and data:

| Client | Memory (working set) | Private memory |
|---|---|---|
| Slint prototype | 35 MB | 9 MB |
| Chrome, blank page | 333 MB | 116 MB |
| Chrome, page matching the prototype | 388 MB | 141 MB |
| Chrome, full tap screen | 371 MB | 138 MB |

The gap is the browser itself, not the page.

The full native app was measured again on 2026-11-10 with software rendering,
a background picture and the local data copy selected for testing:

| Client | Idle working set | Working set during 20 reader inputs | CPU idle / 20 inputs (one core) |
|---|---|---|---|
| Native, release | 37.4 MiB | 38.6 MiB | 3.12% / 6.58% |
| Chrome, all 7 processes | 394.5 MiB | 421.0 MiB | 16.77% / 25.51% |

These are sample means on the PC. The setup, private memory, test coverage and
remaining gaps are recorded in `rust/VALIDATION.md`.

## Goal

Replace Chromium on the Pi with a native tap screen in Rust + Slint (`rust/`)
that does everything the web tap screen (`/station` in `web/views.js`) does.
The Node server stays as it is: it still runs Admin, Register, Sheets sync and
the database.

**It goes on the Pi only once it is complete.** Until then the web tap screen
stays deployed.

## How it talks to the server

The same way the web tap screen does:

- `GET /station/events` (server-sent events)
  - `appearance`: background picture, panel opacity, theme. Sent on connect
    (new: `web/server.js` now sends it, the web page already has it in its HTML)
    and whenever it changes in Admin.
  - `status`: clock readiness, sync badge, who's in, leaderboards.
- `POST /station/tap` with `{ rfid, requestId }` and header `X-Station: 1`.
  A tap that wasn't confirmed keeps its `requestId`, so tapping again is safe.
- `POST /station/sync` (the cloud in the header) and `POST /station/shutdown`.
- `GET /background?v=<version>` for the picture.

## Feature checklist

Everything the web tap screen does, in its order on screen.

Checked items have been exercised on Windows against the web screen. This does
not sign off the Pi: Linux reader timing, direct keyboard ownership and the browser
handoff still need their hardware checks. See `rust/VALIDATION.md` for the setup,
measurements and remaining gaps.

**Header**
- [x] The LaSallian logo and the system's name
- [x] Clock, ticking once a second (Asia/Manila)
- [x] Sync cloud: synced / syncing · n / offline · n saved / sync error; tapping it syncs now
- [ ] Register and Admin: open the web page in a browser launched on demand
- [x] Shut down button

**Main panel (tap result)**
- [x] Idle: "Tap your ID", and the note when an earlier tap still needs confirming
- [x] Connecting (no server yet) and "Setting the clock…" (clock not ready)
- [x] IN, with a note when the last check-in was never tapped out
- [x] OUT
- [x] Tap confirmed (a replayed tap), with when the original was recorded
- [x] Not registered (with the card number), ID deactivated, Not recorded (clock)
- [x] Repeat ignored (and no change if a result is already showing)
- [x] Not confirmed yet (network error), which stays until the next tap
- [x] Results clear after 6 seconds

**Side panels**
- [x] In the office (n): name, section pill in its section's colour, status pill, "since" time
- [x] Leaderboard · month: section bars and top 10 staffers, bars against the leader
- [x] Rankings hidden: "Results coming soon"
- [x] Waiting for the office computer, when disconnected

**Appearance**
- [x] Background picture, cover-fit, with panel opacity
- [x] Christmas theme: colours, candy-cane stripe, still lights (nothing moves)

**Shut down**
- [ ] Confirmation listing who's still in, with the warning; Cancel focused by default
- [x] "Checking attendance…" while disconnected
- [x] "Shutting down…" and the error if it fails
- [x] Escape closes it

**Reader and connection**
- [ ] Card reader: digits then Enter; on Linux only digits at reader speed (≤ 100 ms apart)
- [x] Reconnecting toast and automatic reconnect after the server restarts
- [ ] No "Click to resume": with no desktop, the app gets the keyboard directly

## Steps

1. **Build it on the PC** against a local server with sync off and a copy of the
   Pi's data:
   ```bash
   cd web
   SHEETS_SPREADSHEET_ID= DB_PATH=<scratch>/residency.db BACKUP_DIR=<scratch>/backups PORT=3107 node server.js
   ```
   Split the UI into `rust/ui/*.slint`, logic in `rust/src/`. Work through the
   checklist above.
2. **Check it side by side** with the web tap screen on the PC: every state in the
   checklist, both themes, a background picture, and the shutdown flow (which only
   logs off Linux).
3. **Measure again on the PC** (memory and CPU, idle and during 20 taps) to confirm
   the full version is still far below Chrome.
4. **Move the Pi to the new layout**, together, at a quiet time. The repo now keeps
   the server in `web/`, but the Pi still runs from `~/tls-residency`:
   - stop `attendance.service`;
   - `git pull`, then move `.env`, `residency.db*`, `backups/`, `background.img`
     and the service-account key into `web/`;
   - set `WorkingDirectory=/home/tlsadmin/tls-residency/web`, `daemon-reload`, start;
   - check the tap screen and a test tap.
5. **Build for the Pi** (arm64, cross-compiled on the PC) with Slint's
   `linuxkms` backend so it draws straight to the screen with OpenGL ES 2.0 and
   needs no desktop.
6. **Try it on the Pi** at a quiet time, with Chromium closed: taps, all the
   checks in step 2, then memory, CPU and temperature for a while.
7. **Switch over**: start the Slint app at boot instead of the desktop and
   Chromium, and keep Chromium installed for Register and Admin.

## Open questions

- **Register and Admin on the Pi.** They are web pages. Opening them would start a
  browser on demand, which brings Chromium's memory back while it's open. Fine for
  occasional use; worth checking it closes cleanly and hands the screen back.
- **Without a desktop**, how a browser is shown for Register: under a small kiosk
  compositor such as `cage`, or by keeping the desktop and running Slint under it.
- **Fonts.** The Pi's default fonts differ from the PC's; check text fits on the
  real monitor.
