'use strict';

require('dotenv').config();

const { execFile } = require('child_process');
const express = require('express');
const store = require('./db');
const hours = require('./lib/hours');
const dates = require('./lib/dates');
const scan = require('./lib/scan');
const machine = require('./lib/machine');
const views = require('./views');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const TZ = dates.TZ; // one zone for logs, pages and report ranges alike
const BOOT_ID = machine.BOOT_ID;

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
// it. Under systemd, `journalctl -u attendance -f` shows the day's taps.
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
  } else if (result.status === 'ignored') {
    console.log(`${stamp}  ...   repeat tap ignored (${result.rfid})`);
  } else {
    // A stale check-in means they went home without tapping out. Say so —
    // the log is the only place anyone would ever find out.
    const note = result.stale ? '   (previous check-in was never closed — it counts as zero)' : '';
    console.log(`${stamp}  ${result.direction.toUpperCase().padEnd(3)}   ${result.name}${note}`);
  }
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

// Requests from the office computer's own browser. The tap screen and the
// shutdown button only make sense there — nobody on the network should be
// able to switch the machine off.
const LOCAL_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const isLocal = (req) => LOCAL_ADDRESSES.has(req.socket.remoteAddress);

// Dashboard: who is currently in.
app.get('/admin', (req, res) => {
  res.send(views.dashboardPage({ currentlyIn: store.getCurrentlyIn(BOOT_ID), local: isLocal(req) }));
});

// People / roster.
app.get('/admin/users', (req, res) => {
  const flash = req.query.ok
    ? { type: 'ok', text: req.query.ok }
    : req.query.err ? { type: 'err', text: req.query.err } : null;
  res.send(views.usersPage({
    users: store.listUsers(), flash, unknownScans: scanner.unknownScans, local: isLocal(req),
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
  showStatus(); // they may have been checked in
  res.redirect('/admin/users?ok=' + encodeURIComponent('Person removed.'));
});

// ---- Hours report --------------------------------------------------------
// Build each person's sessions, optionally filter to a date range, total up.
function buildReport(startISO, endISO) {
  const users = store.listUsers();
  let anyInvalid = false;
  const report = users.map((u) => {
    const events = store.getEventsForUser(u.id);
    const all = hours.buildSessions(events, { bootId: BOOT_ID });
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
      // that never expires. That includes one left open at last night's
      // shutdown, which buildSessions flags as abandoned given the boot id.
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
  res.send(views.hoursPage({ report, start, end, invalid: anyInvalid, error, local: isLocal(req) }));
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
  if (result.status === 'ok') showStatus();
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

// ---- Health --------------------------------------------------------------
// On the office computer the front page is the tap screen; elsewhere, admin.
app.get('/', (req, res) => res.redirect(isLocal(req) ? '/station' : '/admin'));
app.get('/healthz', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Attendance server running on http://localhost:${PORT}`);
  console.log(`  Tap screen:  http://localhost:${PORT}/station  (the reader types into this page)`);
  console.log(`  Admin:       http://localhost:${PORT}/admin  (user: ${ADMIN_USER})`);
  if (ADMIN_PASSWORD === 'changeme') {
    console.log('  WARNING: using default admin password — set ADMIN_PASSWORD before deploying.');
  }
  clock = machine.watchClock({
    onChange: showStatus,
    log: (message) => console.log(`  ${message}`),
  });
  console.log('');
});
