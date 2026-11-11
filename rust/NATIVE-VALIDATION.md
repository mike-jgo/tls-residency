# Standalone parity validation, 2026-11-11

The native Rust + Slint replacement was checked against the web implementation
on Windows. The automated tests and isolated smoke checks used disposable data
and Sheets stand-ins. A later user-authorized Windows preview used live Sheets
sync with a separate local database. The deployed Pi service was not replaced.

## Automated checks

- `cargo test --locked`: 252 library tests and one native event-loop test pass.
- The unchanged web reference suite passes all 242 tests.
- `cargo build --release --locked` succeeds on Windows.
- Sheets client tests use a localhost HTTP stand-in and a throwaway RSA key.
  Local socket access is required; sandbox socket refusals are not Google errors.
- Test temporary directories were placed under `target/parity-fixes/temp` to avoid
  Windows sandbox rename restrictions in the host's temporary directory.

## Parity fixes and regressions

- Restore preserves its selected source while creating the undo backup, even
  with full retention and `BACKUP_KEEP=1`. Both restored contents and the undo
  contents are checked; ordinary retention resumes on the next backup.
- An aborted SQLite event insert rolls back its receipt and permits an immediate
  retry without elapsed time, a restart or an extra attendance toggle.
- The actual scheduler cycle is tested for automatic retry, no Google calls
  before clock readiness, and an immediate follow-up when a tap arrives during
  upload. Production poll/retry intervals remain five minutes/one minute.
- An unconfirmed roster save schedules immediate reconciliation. A stale edit is
  refused, remote details are pulled and the proposed local edit is not written.
- Dashboard status includes uploaded/waiting counts and the last successful sync.
- Navigation and Hours rows support keyboard and accessibility activation.
  Pointer-click assertions ensure focus targets do not cover the click areas.
  Station input is hidden during management, so it cannot consume form input.
- Registration and per-person edit drafts survive idle return in the current
  process. Restored forms show a review/discard action; save and explicit Cancel
  clear edit drafts. Failed asynchronous saves preserve every form field.
- The compiled native UI is tested for keyboard navigation and Hours selection,
  registration success/failure, draft restore/discard, session locking, edit
  save/cancel, dashboard diagnostics, and shutdown's initial Cancel focus, focus
  containment and Escape.
  Scanner input in forms stays in the form; scanner Enter inside the shutdown
  dialog confirms the card rather than activating a dialog action.
- Search formula tests cover all-time/month labels, month order, exact ID
  matching, details without cards, untouched input cells, balanced formulas and
  header widths. Log import tests cover comma-formatted tap numbers, deleted or
  unnumbered rows, reordered IDs, wrong-month entries, malformed time/direction/
  identity, and empty logs. Roster rename tests check earlier hours and log tabs.

## Windows release smoke check

The release executable was copied into a separate QA folder with its own `.env`,
synthetic SQLite data and Sheets explicitly disabled. It launched without Node
or a browser. Screenshots and direct input checked the tap screen, keyboard and
pointer navigation to Register, restored-draft notice/layout, and shutdown's
centered dialog, initial Cancel focus, Tab/Shift+Tab containment and Escape.
The final QA process was closed after verification.

## Remaining hardware checks

These Windows checks do not validate an arm64 executable, the Pi's graphics
backend/display, physical reader timing, real RTC/NTP behavior or Linux poweroff.
Those still require the hardware checks in [../PLAN.md](../PLAN.md) before service
switchover. Remote browser administration and HTTP/cookie protections are outside
the standalone design intentionally.

The earlier tap-only client's memory figures in [VALIDATION.md](VALIDATION.md)
are historical and are not measurements of this standalone build.

## Performance and usability follow-up

- `cargo test --locked -- --test-threads=1`: 255 library tests and the native
  event-loop test pass. Local HTTP test sockets require sandbox escalation;
  test temporary files were kept under `target/parity-fixes/temp`.
- New regressions check receipt delivery before status publication, range-query
  equivalence to full-history session pairing, month-end checkouts, abandoned
  arrivals, reversed clocks, inactive people, and sync counts with gaps in IDs.
- The native event-loop test covers 117-person pagination, sorted row identity,
  inactive filtering, debounced Search, December/January navigation, and model
  identity across a sync-only status update. It passes again after the final
  leaderboard layout adjustment.
- A synthetic SQLite query check used 117 people and 85,410 taps across 365
  days. The former history fetch needed 117 queries and returned 85,410 events;
  the November query needed one statement and returned 3,510 paired sessions.
  On this Windows host, fetch-only timings were 101.0 ms and 15.1 ms respectively.
  These are a single Python/SQLite query comparison, excluding Rust session
  processing and UI rendering, not end-to-end or Pi performance measurements.
  `EXPLAIN QUERY PLAN` confirms a bounded `(user_id,ts)` index search and a
  covering `(user_id,id)` search for each check-in's immediate successor.
- Release optimization is now level 3. A `pi-kms` feature exposes Slint's
  LinuxKMS backend for testing OpenGL ES 2.0; the desktop GPU candidate is
  `winit-femtovg`. Neither validates the Pi without an arm64 build and the
  actual display, GPU driver, input device and service environment.
- `cargo build --release --locked` succeeds with the final layout. An isolated
  release preview with 117 synthetic people and Sheets disabled launched using
  both `winit-software` and `winit-femtovg` on Windows. The Christmas strips,
  full leaderboard names, touch targets, and fixed registration error banner
  were inspected. Both preview processes were closed after verification.
- Office monitor fit remains a hardware check: the minimum is still 1000×660
  logical pixels. Check display scaling as well as the physical resolution.
- The leaderboard now has no scroll container. A wider right column and
  compact rows keep nine sections and ten staffers visible together. The
  native regression test uses the real software renderer to check every
  label against the panel bounds at 1000×660 and 1280×800, in both themes,
  including long-name fixtures. All checks pass. Rendered QA
  images are written to `target/leaderboard-layout/` by the test.
- The chart rows follow the web implementation: 18px ranks, 112px labels
  with ellipsis, 14px text, 12px bars, and hours immediately after each bar.
  Sections and staffers use equal-width columns. The native layout and
  interaction regression passes at both sizes and in both themes.
- The leaderboard card hugs its chart rows, leaving only its normal bottom
  padding. The office panel fills the remaining height above it. Regression
  checks cover the bottom gap and bottom alignment at both window sizes.
