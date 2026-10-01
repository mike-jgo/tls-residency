'use strict';

require('dotenv').config();

const { execFile } = require('child_process');
const path = require('path');
const express = require('express');
const store = require('./db');
const report = require('./lib/report');
const dates = require('./lib/dates');
const scan = require('./lib/scan');
const machine = require('./lib/machine');
const backup = require('./lib/backup');
const sheets = require('./lib/sheets');
const { createSync } = require('./lib/sync');
const views = require('./views');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const TZ = dates.TZ; // one zone for logs, pages and report ranges alike
const BOOT_ID = machine.BOOT_ID;
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, 'backups');
const BACKUP_KEEP = Number(process.env.BACKUP_KEEP || 60);

app.use(express.urlencoded({ extended: false }));

// ---- Scan handling -------------------------------------------------------
// The clock check, repeat-tap suppression, the stale check-in rule and the
// in/out toggle all live in lib/scan.js, where they can be tested without
// starting a server. The clock watcher starts with the server, below.
let clock = null;
const scanner = scan.createScanner({
  store,
  bootId: BOOT_ID,
  clockReady: () => clock !== null && clock.isReady(),
});

// The tap screen is what people at the reader see; this log is the record of
// it. Under systemd, `journalctl -u residency -f` shows the day's taps.
function logTime(iso) {
  return new Date(iso).toLocaleTimeString('en-PH', {
    timeZone: TZ, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function logScan(result) {
  const stamp = logTime(result.time || new Date().toISOString());
  if (result.status === 'unknown') {
    console.log(`${stamp}  ???   unknown card ${result.rfid}`);
  } else if (result.status === 'clock') {
    console.log(`${stamp}  WAIT  clock not set yet — tap not recorded (${result.rfid})`);
  } else if (result.status === 'inactive') {
    console.log(`${stamp}  ---   deactivated card — tap not recorded (${result.name})`);
  } else if (result.status === 'ignored') {
    console.log(`${stamp}  ...   repeat tap ignored (${result.rfid})`);
  } else {
    // A stale check-in means they went home without tapping out. Say so —
    // the log is the only place anyone would ever find out.
    const note = result.stale ? '   (previous check-in was never closed — it counts as zero)' : '';
    console.log(`${stamp}  ${result.direction.toUpperCase().padEnd(3)}   ${result.name}${note}`);
  }
}

// ---- Backups -------------------------------------------------------------
// Taken when the server starts and when Shut down is pressed — see
// lib/backup.js. A failed backup (the USB stick isn't in) is logged and must
// never stop the server starting or the machine shutting down.
function backUp(when) {
  return backup.createBackup({ source: store, dir: BACKUP_DIR, keep: BACKUP_KEEP })
    .then((file) => console.log(`  backup (${when}): ${file}`))
    .catch((e) => console.log(`  BACKUP FAILED (${when}): ${e.message}`));
}

// ---- Google Sheets sync --------------------------------------------------
// Off unless a spreadsheet is configured. Kicked at startup, when the clock is
// set, and whenever a tap or the roster changes — see lib/sync.js.
const SHEETS_SPREADSHEET_ID = sheets.spreadsheetIdFrom(process.env.SHEETS_SPREADSHEET_ID);
const sync = SHEETS_SPREADSHEET_ID
  ? createSync({
    store,
    bootId: BOOT_ID,
    client: sheets.createSheetsClient({
      spreadsheetId: SHEETS_SPREADSHEET_ID,
      keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY || path.join(__dirname, 'service-account.json'),
    }),
    ready: () => clock !== null && clock.isReady(),
    log: (message) => console.log(`  ${message}`),
    onChange: () => showStatus(), // the tap screen says when it is offline
  })
  : null;
const kickSync = (rosterChanged) => { if (sync) sync.kick(rosterChanged); };

// ---- Admin auth (HTTP Basic) --------------------------------------------
// The credentials ride in a header, so they are only as private as the
// transport. Over Tailscale that's inside the WireGuard tunnel; over the plain
// office LAN it is clear text — hence the README's warning not to reuse a
// password that matters elsewhere.
function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const [user, pass] = Buffer.from(encoded, 'base64').toString().split(':');
    if (user === ADMIN_USER && pass === ADMIN_PASSWORD) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Residency admin"');
  return res.status(401).send('Authentication required.');
}

app.use('/admin', requireAdmin);

// Every admin page carries the sheet sync's state in its header; null when no
// spreadsheet is configured.
const syncStatus = () => (sync ? sync.status() : null);

// Requests from the office computer's own browser. The tap screen and the
// shutdown button only make sense there — nobody on the network should be
// able to switch the machine off.
const LOCAL_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const isLocal = (req) => LOCAL_ADDRESSES.has(req.socket.remoteAddress);

// Clicking the cloud in the header: sync now, then show the page they were on
// with the result.
const ADMIN_PAGES = new Set(['/admin', '/admin/users', '/admin/hours']);
app.post('/admin/sync', async (req, res) => {
  if (sync) await sync.run();
  res.redirect(ADMIN_PAGES.has(req.body.back) ? req.body.back : '/admin');
});

// Dashboard: who is currently in.
app.get('/admin', (req, res) => {
  res.send(views.dashboardPage({
    currentlyIn: store.getCurrentlyIn(BOOT_ID), sync: syncStatus(), local: isLocal(req),
  }));
});

// People / roster.
app.get('/admin/users', (req, res) => {
  const flash = req.query.ok
    ? { type: 'ok', text: req.query.ok }
    : req.query.err ? { type: 'err', text: req.query.err } : null;
  res.send(views.usersPage({
    users: store.listUsers(), flash, unknownScans: scanner.unknownScans,
    sync: syncStatus(), local: isLocal(req),
  }));
});

// Register a person. RFID must be unique.
app.post('/admin/users', (req, res) => {
  const name = String(req.body.name || '').trim();
  const rfid = String(req.body.rfid || '').trim();
  const studentId = String(req.body.student_id || '').trim();
  const role = String(req.body.role || '').trim();

  if (!name || !rfid) {
    return res.redirect('/admin/users?err=' + encodeURIComponent('Name and a tapped RFID are both required.'));
  }
  const existing = store.getUserByRfid(rfid);
  if (existing) {
    const hint = existing.active ? '' : ' They are deactivated — reactivate them instead.';
    return res.redirect('/admin/users?err=' + encodeURIComponent(`That card is already registered to ${existing.name}.${hint}`));
  }
  try {
    store.createUser(name, studentId, role, rfid);
    scanner.forgetUnknown(rfid);
    kickSync(true);
    res.redirect('/admin/users?ok=' + encodeURIComponent(`${name} registered.`));
  } catch (e) {
    res.redirect('/admin/users?err=' + encodeURIComponent('Could not save — ' + e.message));
  }
});

// Deactivate rather than delete: the person's card stops working, but their
// residency history stays in the database and in the hours report.
app.post('/admin/users/:id/deactivate', (req, res) => {
  store.setUserActive(Number(req.params.id), false);
  showStatus(); // they may have been checked in
  kickSync(true);
  res.redirect('/admin/users?ok=' + encodeURIComponent('Person deactivated. Their history is kept.'));
});

app.post('/admin/users/:id/reactivate', (req, res) => {
  store.setUserActive(Number(req.params.id), true);
  showStatus();
  kickSync(true);
  res.redirect('/admin/users?ok=' + encodeURIComponent('Person reactivated.'));
});

// ---- Hours report --------------------------------------------------------
// Built in lib/report.js, which the sheet sync shares.
const buildReport = (startISO, endISO) => report.buildReport(store, BOOT_ID, startISO, endISO);

// Both report routes take the same two date boxes. Bounds are resolved in the
// configured timezone and validated — see lib/dates.js.
function readRange(req) {
  const start = String(req.query.start || '').trim();
  const end = String(req.query.end || '').trim();
  return { start, end, ...dates.dayBounds(start, end) };
}

// The hours page is laid out like the spreadsheet: a tab for all time, then
// one per month that could hold taps, newest first. A tab is
// just a link to that month's date range.
function monthTabs() {
  const tabs = [{ label: 'Totals', start: '', end: '' }];
  // Always includes the current month, even if the clock is wrong and "now"
  // is before the first tap or after the last.
  const now = new Date().toISOString();
  const stamps = [now, store.getFirstEventTs() || now, store.getLastEventTs() || now].sort();
  for (const { y, m } of dates.monthsBetween(stamps[0], stamps[2]).reverse()) {
    const { first, last } = dates.monthDays(y, m);
    tabs.push({ label: dates.monthTitle(y, m), start: first, end: last });
  }
  return tabs;
}

// Residency is graded by the month, so the page opens on the current one.
app.get('/admin/hours', (req, res) => {
  if (req.query.start === undefined && req.query.end === undefined) {
    const { y, m } = dates.monthOf(new Date().toISOString());
    const { first, last } = dates.monthDays(y, m);
    return res.redirect(`/admin/hours?start=${first}&end=${last}`);
  }
  const tabs = monthTabs();
  const { start, end, startISO, endISO, error } = readRange(req);
  const { report } = buildReport(startISO, endISO);
  res.send(views.hoursPage({
    report, tabs, start, end, error, sync: syncStatus(), local: isLocal(req),
  }));
});

app.get('/admin/hours.csv', (req, res) => {
  const { start, end, startISO, endISO, error } = readRange(req);
  // A spreadsheet can't show a warning banner, so refuse rather than hand back
  // a file whose date range silently isn't the one that was asked for.
  if (error) return res.status(400).type('text/plain').send(error);
  const { report } = buildReport(startISO, endISO);

  const escCsv = (v) => {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  // "Not counted" travels with the numbers: a discarded session shows up as a
  // silent zero otherwise, and this is the file someone signs off residency on.
  const lines = [['Name', 'Student ID', 'Hours', 'Sessions', 'Still in', 'Not counted', 'Deactivated'].join(',')];
  for (const r of report) {
    lines.push([
      r.name, r.student_id, r.hours.toFixed(2), r.sessions,
      r.open ? 'yes' : '', r.invalid ? 'yes' : '', r.active ? '' : 'yes',
    ].map(escCsv).join(','));
  }
  const label = (start || 'all') + '_to_' + (end || 'now');
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="hours_${label}.csv"`);
  res.send(lines.join('\n'));
});

// ---- Tap screen ----------------------------------------------------------
// The monitor at the reader shows /station full-screen, and the tap screen
// *is* the reader's input: the reader is a USB keyboard, so a tap arrives in
// that page as a burst of digits and Enter, and the page posts the number to
// /station/tap. Who's in the office is pushed back to it over /station/events.
app.use('/station', (req, res, next) => {
  if (isLocal(req)) return next();
  res.status(403).type('text/plain').send('The tap screen only opens on the office computer itself.');
});

const stationClients = new Set();

function sendEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function stationStatus() {
  return {
    clockReady: clock !== null && clock.isReady(),
    // Shown as a small cloud in the header. Offline, taps are still recorded
    // here and uploaded later.
    sync: sync ? views.syncBadge(sync.status()) : null,
    currentlyIn: store.getCurrentlyIn(BOOT_ID).map((u) => ({ name: u.name, since: u.since })),
  };
}

function showStatus() {
  if (!stationClients.size) return;
  const status = stationStatus();
  for (const res of stationClients) sendEvent(res, 'status', status);
}

// The page's own POSTs. The custom header is a cheap CSRF guard: a form or
// link on some other page can't set it, and a cross-origin script can't
// without a preflight we never answer.
function fromTapScreen(req, res, next) {
  if (req.get('X-Station') === '1') return next();
  res.status(403).json({ ok: false, error: 'not from the tap screen' });
}

// Only on the Pi does the page insist that digits arrive at reader speed — see
// stationPage. On a Mac with no reader, typing a number is how you test.
app.get('/station', (req, res) => res.send(views.stationPage({ readerOnly: process.platform === 'linux' })));

app.post('/station/tap', fromTapScreen, express.json(), (req, res) => {
  const rfid = String((req.body && req.body.rfid) || '').trim();
  if (!/^\d{1,64}$/.test(rfid)) return res.status(400).json({ ok: false, error: 'not a card number' });

  const result = scanner.handle(rfid);
  logScan(result);
  if (result.status === 'ok') { showStatus(); kickSync(); }
  res.json({
    ok: true,
    status: result.status,
    direction: result.direction,
    name: result.name,
    stale: result.stale,
    time: result.time,
    rfid: result.status === 'unknown' ? result.rfid : undefined,
  });
});

// The cloud on the tap screen. The outcome reaches the page over
// /station/events, like every other change.
app.post('/station/sync', fromTapScreen, (req, res) => {
  if (sync) sync.run();
  res.json({ ok: true });
});

app.get('/station/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  stationClients.add(res);
  sendEvent(res, 'status', stationStatus());
  req.on('close', () => stationClients.delete(res));
});

// End of the day. The page has already shown who is still checked in and had
// someone confirm; this just records who that was and powers off.
app.post('/station/shutdown', fromTapScreen, (req, res) => {
  const stillIn = store.getCurrentlyIn(BOOT_ID).map((u) => u.name);
  const note = stillIn.length ? ` — still checked in, won't count: ${stillIn.join(', ')}` : '';
  console.log(`${logTime(new Date().toISOString())}  OFF   shutting down${note}`);

  // The day's taps are all in; copy them before the power goes.
  backUp('shutdown').then(() => {
    if (process.platform !== 'linux') {
      console.log('  (not on Linux — not actually shutting down)');
      return res.json({ ok: true });
    }
    // Needs a sudoers rule letting the service user run exactly this — see README.
    execFile('sudo', ['-n', '/usr/bin/systemctl', 'poweroff'], (err, stdout, stderr) => {
      if (err) {
        const why = String(stderr || err.message).trim();
        console.log(`  shutdown failed: ${why}`);
        return res.status(500).json({ ok: false, error: why });
      }
      res.json({ ok: true });
    });
  });
});

// ---- Health --------------------------------------------------------------
// On the office computer the front page is the tap screen; elsewhere, admin.
app.get('/', (req, res) => res.redirect(isLocal(req) ? '/station' : '/admin'));
app.get('/healthz', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Residency server running on http://localhost:${PORT}`);
  console.log(`  Tap screen:  http://localhost:${PORT}/station  (the reader types into this page)`);
  console.log(`  Admin:       http://localhost:${PORT}/admin  (user: ${ADMIN_USER})`);
  if (ADMIN_PASSWORD === 'changeme') {
    console.log('  WARNING: using default admin password — set ADMIN_PASSWORD before deploying.');
  }
  clock = machine.watchClock({
    onChange: () => { showStatus(); kickSync(); },
    log: (message) => console.log(`  ${message}`),
    // A hardware clock claiming to be earlier than a tap we already recorded
    // has lost power — see rtcVerdict.
    floor: () => Date.parse(store.getLastEventTs() || '') || 0,
  });
  console.log('');
  backUp('startup');
  console.log(sync
    ? `  Sheet sync:  spreadsheet ${SHEETS_SPREADSHEET_ID}`
    : '  Sheet sync:  off (SHEETS_SPREADSHEET_ID is not set)');
  kickSync();
});
