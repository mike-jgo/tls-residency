'use strict';

require('dotenv').config();

const express = require('express');
const store = require('./db');
const hours = require('./lib/hours');
const dates = require('./lib/dates');
const scan = require('./lib/scan');
const reader = require('./lib/reader');
const views = require('./views');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const TZ = dates.TZ; // one zone for logs, pages and report ranges alike
const READER_DEVICE = process.env.READER_DEVICE || '';

app.use(express.urlencoded({ extended: false }));

// ---- Scan handling -------------------------------------------------------
// Repeat-tap suppression, the stale check-in rule and the in/out toggle all
// live in lib/scan.js, where they can be tested without starting a server.
const scanner = scan.createScanner({ store });

// There is no display at the reader, so this log is the only live feedback
// anyone gets. Under systemd, `journalctl -u attendance -f` is the day's record.
function logTime(iso) {
  return new Date(iso).toLocaleTimeString('en-PH', {
    timeZone: TZ, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function logScan(result) {
  const stamp = logTime(result.time || new Date().toISOString());
  if (result.status === 'unknown') {
    console.log(`${stamp}  ???   unknown card ${result.rfid}`);
  } else if (result.status === 'ignored') {
    console.log(`${stamp}  ...   repeat tap ignored (${result.rfid})`);
  } else {
    // A stale check-in means they went home without tapping out. Say so —
    // the log is the only place anyone would ever find out.
    const note = result.stale ? '   (previous check-in was never closed — it counts as zero)' : '';
    console.log(`${stamp}  ${result.direction.toUpperCase().padEnd(3)}   ${result.name}${note}`);
  }
}

// ---- Card reader ---------------------------------------------------------
// The reader is a USB keyboard. We read its raw input device rather than
// stdin so scanning doesn't depend on a monitor, a desktop session, or a
// logged-in tty — see lib/reader.js.
function startReader() {
  // Off Linux (a Mac used for development) there is no /dev/input; the reader
  // reads keystrokes from stdin instead, so it starts without READER_DEVICE.
  if (process.platform === 'linux' && !READER_DEVICE) {
    console.log('  No READER_DEVICE set — admin is up, but nothing is reading cards.');
    console.log('  Find the reader with:  ls -l /dev/input/by-id/');
    return;
  }
  reader.startReader({
    devicePath: READER_DEVICE,
    onCard: (rfid) => logScan(scanner.handle(rfid)),
    log: (message) => console.log(`  ${message}`),
  });
}

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
  res.set('WWW-Authenticate', 'Basic realm="Attendance admin"');
  return res.status(401).send('Authentication required.');
}

app.use('/admin', requireAdmin);

// Dashboard: who is currently in.
app.get('/admin', (req, res) => {
  res.send(views.dashboardPage({ currentlyIn: store.getCurrentlyIn() }));
});

// People / roster.
app.get('/admin/users', (req, res) => {
  const flash = req.query.ok
    ? { type: 'ok', text: req.query.ok }
    : req.query.err ? { type: 'err', text: req.query.err } : null;
  res.send(views.usersPage({ users: store.listUsers(), flash, unknownScans: scanner.unknownScans }));
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
    return res.redirect('/admin/users?err=' + encodeURIComponent(`That card is already registered to ${existing.name}.`));
  }
  try {
    store.createUser(name, studentId, role, rfid);
    scanner.forgetUnknown(rfid);
    res.redirect('/admin/users?ok=' + encodeURIComponent(`${name} registered.`));
  } catch (e) {
    res.redirect('/admin/users?err=' + encodeURIComponent('Could not save — ' + e.message));
  }
});

// Remove a person (and their history).
app.post('/admin/users/:id/delete', (req, res) => {
  store.deleteUser(Number(req.params.id));
  res.redirect('/admin/users?ok=' + encodeURIComponent('Person removed.'));
});

// ---- Hours report --------------------------------------------------------
// Build each person's sessions, optionally filter to a date range, total up.
function buildReport(startISO, endISO) {
  const users = store.listUsers();
  let anyInvalid = false;
  const report = users.map((u) => {
    const events = store.getEventsForUser(u.id);
    const all = hours.buildSessions(events);
    const inRange = hours.filterByRange(all, startISO, endISO);
    const invalid = inRange.some((s) => s.invalid);
    if (invalid) anyInvalid = true;
    return {
      name: u.name,
      student_id: u.student_id,
      hours: hours.msToHours(hours.sumMs(inRange)),
      // Discarded sessions earned nothing, so they are not sessions worked.
      sessions: inRange.filter((s) => !s.open && !s.invalid).length,
      // Only the live session means "still in". An abandoned check-in is also
      // open, but that person went home — saying they are in would be a lie
      // that never expires.
      open: inRange.some((s) => s.open && !s.invalid),
      invalid,
    };
  });
  return { report, anyInvalid };
}

// Both report routes take the same two date boxes. Bounds are resolved in the
// configured timezone and validated — see lib/dates.js.
function readRange(req) {
  const start = String(req.query.start || '').trim();
  const end = String(req.query.end || '').trim();
  return { start, end, ...dates.dayBounds(start, end) };
}

app.get('/admin/hours', (req, res) => {
  const { start, end, startISO, endISO, error } = readRange(req);
  const { report, anyInvalid } = buildReport(startISO, endISO);
  res.send(views.hoursPage({ report, start, end, invalid: anyInvalid, error }));
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
  const lines = [['Name', 'Student ID', 'Hours', 'Sessions', 'Still in', 'Not counted'].join(',')];
  for (const r of report) {
    lines.push([
      r.name, r.student_id, r.hours.toFixed(2), r.sessions,
      r.open ? 'yes' : '', r.invalid ? 'yes' : '',
    ].map(escCsv).join(','));
  }
  const label = (start || 'all') + '_to_' + (end || 'now');
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="hours_${label}.csv"`);
  res.send(lines.join('\n'));
});

// ---- Health --------------------------------------------------------------
app.get('/', (req, res) => res.redirect('/admin'));
app.get('/healthz', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Attendance server running on http://localhost:${PORT}`);
  console.log(`  Admin:  http://localhost:${PORT}/admin  (user: ${ADMIN_USER})`);
  if (ADMIN_PASSWORD === 'changeme') {
    console.log('  WARNING: using default admin password — set ADMIN_PASSWORD before deploying.');
  }
  startReader();
  console.log('');
});
