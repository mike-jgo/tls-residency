# Plan: one native Rust attendance app

The office computer will run one Rust + Slint package for the tap screen,
registration, administration, SQLite, Google Sheets sync, backups and shutdown.
It will need neither Node nor Chromium for office workflows. There will be no
network Admin site, as requested on 2026-11-10.

The office Pi switched to the native app on 2026-11-11 (see *Rollout status*).
web/ stays as the behavioural reference and as the Pi's rollback until the open
hardware checks below are done. Production data and the live spreadsheet are
not test fixtures.

## Package and architecture

- rust/ includes its logos, fonts and sheet-layout data, independent of web/.
- Native screens call Rust services directly, with no HTTP server or browser.
- SQLite keeps the existing users/events/meta schema and request IDs. Native
  pending receipts survive process restarts in a separate table.
- One app owns the database. Sync releases the database mutex while waiting on
  Google, allowing offline taps to continue.
- Attendance, roster and Sheets rules retain their existing behavior.
- Credentials, runtime data, backups and configuration stay outside the binary.
  Import uses a verified copy while the old service is stopped. Both apps must
  never write the same database concurrently.

## Native workflow checklist

- [ ] Tap screen: existing result/refusal/replay states, attendance, leaderboards,
      sync badge and appearance, now backed by Rust services.
- [ ] Reader: form input stays separate from station scans; digits plus Enter,
      overflow protection, Linux reader-speed filtering and keyboard navigation.
- [ ] Durable unconfirmed receipts and explicit timezone handling.
- [ ] Register: validation, duplicate checks, unknown-card and cardless-row
      choices, draft preservation and a clear return to the tap screen.
- [ ] Admin: sign-in/out, session expiry and lock on returning to the tap screen.
- [ ] People: search/filter, edit, deactivate and reactivate without losing history.
- [ ] Attendance, sync errors, roster warnings and unlinked staffers.
- [ ] Hours: inclusive date filters, month shortcuts, uncounted sessions and CSV.
- [ ] Appearance: native image selection/removal, opacity, theme, hidden rankings.
- [ ] Native file selection/export without a browser or desktop file dialog.
- [ ] Backup and validated restore with a recoverable pre-restore copy.
- [ ] Shutdown: current attendance, Cancel focused by default, Escape and errors.

## Rust services

- [x] SQLite schema compatibility, transactions, prepared queries and receipts.
- [x] Person validation, sessions/hours, CSV and timezone helpers.
- [x] Scanner policy and reader tests, including interrupted receipts.
- [x] Standalone service integration: login, edits, appearance, backup and restore.
- [x] Sheets: service-account login, authoritative startup reconciliation,
      pending-tap preservation, deterministic writes, roster conflicts, styles
      and Search formulas, verified against a stand-in.
- [x] Background Google calls outside the UI thread/database critical section.
- [ ] Startup/shutdown backups, clock/RTC readiness and Linux shutdown behavior.

## Verification and rollout

Windows automated parity checks and the fixes from the web comparison are
recorded in [rust/NATIVE-VALIDATION.md](rust/NATIVE-VALIDATION.md). These establish
service and selected native interaction behavior; the complete manual workflow,
footprint and Pi hardware checks below remain separate rollout requirements.

1. Compare domain edge cases against the Node reference.
2. Test Sheets failures, retries, hand-edited tabs, restore and pending taps.
3. Run the standalone app with sync disabled against a disposable database copy.
   Check every native workflow using screenshots and direct app control.
4. Verify it runs with Node stopped and never launches a browser. Build the Rust
   package without assets from web/.
5. Measure idle and twenty-reader-input memory/CPU again for the complete app.
6. Document installation, import, backup/restore and rollback. Keep web/ until the
   replacement is signed off.
7. Cross-build arm64 and test the actual Pi display, reader, fonts and Linux
   backend at a quiet time. Arrange boot/service switchover together afterward.

## Rollout status

Switched over on the office Pi on 2026-11-11 at about 20:20, at the owner's
request, with 16 people checked in. Done at the switch:

- Merged to master as `4e43350`; the Pi runs that commit's CI desktop build
  (checksum-verified against the artifact).
- Node had no unsynced taps. Its database was copied with SQLite's backup API
  (integrity ok, 119 people, 878 taps) into a separate native installation.
- First run with sync off showed the same 16 people, leaderboard and appearance.
  With sync on, the badge showed Synced. Same kernel boot ID, so open sessions
  carried over.
- Starts at login, restarts on exit. Poweroff rule present.
- Idle footprint: 93 MB and 0.15% CPU, against ~375 MB and 8.9% for Node + Chromium.
- Real use from 20:30: taps through the reader and a registration on the Pi work.
- Backend: `winit-femtovg` made the Register screen pin a core in labwc (the Pi's
  compositor renders with pixman, so each GPU frame was a ~1.3 s readback).
  Switched to `winit-software` at 20:49: 10–30 ms per redraw, app at 63 MB. See
  [rust/README.md](rust/README.md#on-the-office-pi).

Still open on the Pi: Admin/Hours/backup-restore on the real screen, pressing
Shut down, a cold boot and RTC/NTP readiness, Linux startup/shutdown backups, the
twenty-input load measurement, and trying the KMS build (no compositor at all). Rollback
steps are in [rust/README.md](rust/README.md#on-the-office-pi).

## UI basis

Use Ruled's app-shell and form patterns, The LaSallian's #054805 brand, Schibsted
Grotesk, keyboard-capable controls and clear status text. No decorative motion.
File selection works in Slint without a browser, GTK dialog or compositor.

## Historical validation

The earlier tap-only Rust client used about 39 MiB during twenty inputs, versus
Chrome's 421 MiB on the same PC. That comparison is in rust/VALIDATION.md. Those
figures do not establish the footprint of the complete standalone replacement;
it must be measured after integration.
