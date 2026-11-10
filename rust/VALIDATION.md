# PC validation, 2026-11-10

The native screen remains in development. The checked items in `../PLAN.md`
describe Windows checks, not permission to deploy it to the Pi.

## Setup

- Release build: `cargo build --release --locked --offline`, Slint 1.18.1.
  The final build completed without warnings.
- Native renderer: `SLINT_BACKEND=winit-software`.
- Chrome: an isolated profile, `--disable-gpu`, extensions and sync disabled.
  Both clients used windows of approximately 1280 × 800 content pixels.
- The real Node server ran on port 3107 with `SHEETS_SPREADSHEET_ID` explicitly
  empty, a scratch database and a separate backup directory.
- At the user's direction, the source was `web/residency.db`: two users and one
  event. SQLite's backup API made the copy. Twenty disposable QA staffers and one
  inactive QA card were added only to the copy. This is a small local dataset,
  not a validation of the full current Pi dataset.
- A local proxy on port 3108 supplied clock-not-ready, sync badges, positive
  leaderboards, dropped replies and shutdown failures. It forwarded ordinary
  requests to the real server. No production data or Google Sheet was changed.
- Screenshots and direct mouse/keyboard input were used for the visual comparison.

## Results

The following were compared with the web tap screen:

| Area | Result |
|---|---|
| Logo, name and clock | Visible; clock advanced from 19:39 to 19:40 and agreed with the Manila host clock. |
| Sync badge | Synced, syncing with a count, offline with a saved count, and error. Both cloud clicks reached `/station/sync`. |
| Idle and connection | Idle, connecting, setting the clock, attendance unavailable and reconnecting toast. Native recovered after a real local server restart. |
| Successful taps | IN, OUT, stale check-in warning and replay confirmation with the original date/time. |
| Refused taps | Unknown card with its number, inactive card and clock refusal. |
| Repeats | Repeat ignored when idle; an ignored repeat preserved the visible IN result. |
| Uncertain taps | A dropped reply left the warning visible beyond six seconds. Retrying reused the receipt ID. |
| Clearing and reminders | Ordinary results cleared after six seconds; an unconfirmed card still produced the idle reminder after another card's result cleared. |
| Attendance | Empty and populated lists, section/status colors, since times and scrolling with 20 arrivals. |
| Rankings | Month title, section totals, ten staffers, proportional positive bars, no hours and hidden rankings. |
| Appearance | Background cover-fit, panel opacity, removal, Christmas colors, diagonal stripe and still lights. |
| Shutdown | Names/warning, disconnected guard, Escape, failure feedback and successful shutdown display. The real Windows route created a backup and logged that it did not power off. |
| Browser pages | Register and Admin sign-in rendered in Chrome. A native Register launch was observed by its browser window title; the full native browser round trip is still pending. |
| Reader input | Twenty digit-plus-Enter inputs recorded exactly twenty arrivals for each client, against reset copies of the same QA event baseline. |

The comparison also found and corrected three visual problems: the header's
width-dependent layout loop, text inheriting an unreadable light color under the
Windows dark theme, and long result messages squeezing the side panels. Panel
columns now retain equal widths. The Christmas stripe is diagonal.

`cd web && npm test`: **242 passed, 0 failed**. Tests were run outside the
sandbox because its temporary-file and localhost restrictions interfered with
the backup and restore tests.

## Resource measurements

Both clients connected directly to the same real local server with the same
background and 85% panel opacity, theme off, and sync disabled. The disposable
QA events were removed and the server restarted between clients. These figures
are for the final native build.

Idle samples lasted about 30 seconds. Input samples lasted about 40 seconds and
included twenty simulated reader inputs, with a one-second pause after each
card; input itself took about 30 seconds. The final screens showed 20 people in,
and the scratch database contained exactly 20 QA events after each run.

Memory figures are sample means in MiB. Chrome includes all seven processes in
its isolated profile; native had one process. Working sets are summed, so shared
pages may be counted in more than one Chrome process. Private memory is also
reported. CPU is the change in summed process CPU time divided by elapsed time,
as a percentage of **one core**. The Node server and test tools are excluded.

| Client | Workload | Working set | Private memory | CPU, one core |
|---|---|---:|---:|---:|
| Native | Idle | 37.4 MiB | 17.8 MiB | 3.12% |
| Chrome | Idle | 394.5 MiB | 127.6 MiB | 16.77% |
| Native | 20 reader inputs | 38.6 MiB | 18.8 MiB | 6.58% |
| Chrome | 20 reader inputs | 421.0 MiB | 145.9 MiB | 25.51% |

Peak working set during the input runs was 39.3 MiB native and 433.3 MiB Chrome.
The native mean working set was about 91% lower during this workload. These are
PC measurements; Pi memory, CPU, temperature and ES 2.0 rendering still need
their own checks.

## Remaining before Pi deployment

- Shutdown's Cancel button has no default keyboard focus. Buttons and header
  links are mouse controls; keyboard navigation is incomplete.
- Register/Admin still use the OS browser launcher. Closing the browser and
  returning keyboard ownership to the native app, including under a compositor,
  are not implemented or verified end to end.
- Timestamps use the host timezone. They agree with Manila on this PC, but the
  native app does not independently pin or read the server's configured timezone.
- Pending receipt IDs survive connection loss while the app remains open, but
  they are kept only in memory and are lost when the native app restarts.
- The Linux reader-speed filter, real USB reader, arm64 build, `linuxkms`, boot
  integration, fonts on the office monitor and operation without a desktop have
  not been tested on the Pi.
- Native state handling has been exercised interactively but has no automated
  Rust regression suite yet.
