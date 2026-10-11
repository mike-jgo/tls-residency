'use strict';

require('dotenv').config();

const { execFile } = require('child_process');
const path = require('path');
const express = require('express');
const store = require('./db');
const report = require('./lib/report');
const dates = require('./lib/dates');
const scan = require('./lib/scan');
const people = require('./lib/people');
const roster = require('./lib/roster');
const machine = require('./lib/machine');
const guard = require('./lib/guard');
const { createAuth } = require('./lib/auth');
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

// Nothing here is changed by a form or script on some other website — see
// sameOrigin in lib/guard.js. Every POST goes through this, the tap screen's
// included (which keeps its own X-Station check as well).
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || guard.sameOrigin(req.headers)) return next();
  res.status(403).type('text/plain').send('That request came from another website, so nothing was changed.');
});

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
    console.log(`${stamp}  ???   unknown ID — card number ${result.rfid}`);
  } else if (result.status === 'clock') {
    console.log(`${stamp}  WAIT  clock not set yet — tap not recorded (${result.rfid})`);
  } else if (result.status === 'inactive') {
    console.log(`${stamp}  ---   deactivated ID — tap not recorded (${result.name})`);
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
//
// The spreadsheet is the record: the first sync replaces this device's people
// and taps with the sheet's. So it waits for the startup backup, which is then
// a copy of what this device had.
let backedUp = false;
const SHEETS_SPREADSHEET_ID = sheets.spreadsheetIdFrom(process.env.SHEETS_SPREADSHEET_ID);
const sync = SHEETS_SPREADSHEET_ID
  ? createSync({
    store,
    bootId: BOOT_ID,
    client: sheets.createSheetsClient({
      spreadsheetId: SHEETS_SPREADSHEET_ID,
      keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY || path.join(__dirname, 'service-account.json'),
    }),
    ready: () => backedUp && clock !== null && clock.isReady(),
    log: (message) => console.log(`  ${message}`),
    onChange: () => showStatus(), // the tap screen says when it is offline, and who the sheet says is in
  })
  : null;
const kickSync = (rosterChanged) => { if (sync) sync.kick(rosterChanged); };

// ---- Admin login --------------------------------------------------------
const auth = createAuth({ user: ADMIN_USER, password: ADMIN_PASSWORD });
app.use('/admin', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.get('/admin/login', (req, res) => {
  res.send(views.loginPage({ local: isLocal(req) }));
});
app.post('/admin/login', (req, res) => {
  if (!auth.login(req, res, req.body.username, req.body.password)) {
    return res.status(401).send(views.loginPage({ local: isLocal(req), error: 'Username or password is incorrect. Try again.' }));
  }
  res.redirect('/admin');
});
app.post('/admin/logout', (req, res) => {
  auth.logout(req, res);
  res.redirect(isLocal(req) ? '/station' : '/admin/login');
});
app.use('/admin', (req, res, next) => {
  if (auth.authenticated(req)) return next();
  if (req.method === 'GET') return res.redirect('/admin/login');
  res.status(401).send(views.loginPage({ local: isLocal(req), error: 'Your admin session ended. Sign in again before making changes.' }));
});

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

// Dashboard: who is currently in. An open dashboard is kept up to date over
// /admin/events — showStatus() sends it whatever the tap screen is sent.
const dashboardNow = () => ({ currentlyIn: store.getCurrentlyIn(BOOT_ID), sync: syncStatus() });
app.get('/admin', (req, res) => {
  res.send(views.dashboardPage({ ...dashboardNow(), local: isLocal(req) }));
});

const dashboardClients = new Set();
app.get('/admin/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  dashboardClients.add(res);
  sendEvent(res, 'dashboard', views.dashboardLive(dashboardNow()));
  req.on('close', () => dashboardClients.delete(res));
});

// People / roster.
function usersPage(req, flash, editing, draft = false) {
  return views.usersPage({
    users: store.listUsers(), flash, editing, draft,
    roster: sync ? sync.status().roster : { warnings: [], unlinked: [] },
    online: sheetReachable(),
    sync: syncStatus(), local: isLocal(req),
  });
}

app.get('/admin/users', (req, res) => {
  const flash = req.query.ok
    ? { type: 'ok', text: req.query.ok }
    : req.query.err ? { type: 'err', text: req.query.err } : null;
  // ?edit=<id> opens that person's details.
  const editing = req.query.edit ? store.getUser(Number(req.query.edit)) : null;
  res.send(usersPage(req, flash, editing));
});

// A change to a person goes to the Staffers tab first, and `apply` saves it
// here only once Google has it: the sheet is the record of who the staffers
// are (lib/roster.js). With no spreadsheet configured, this device is all
// there is.
async function saveStaffer(person, own, apply) {
  if (!sync) return apply();
  return sync.saveStaffer(roster.rowOf(person), own, apply);
}
const notSaved = (e) => (e.offline ? 'Offline — not saved.' : `Not saved — ${e.message}`);
// A form that can't be saved is shown again with what was typed still in it —
// sent straight back rather than redirected, so nobody's details ride in a URL.
const typed = (body) => Object.fromEntries(
  ['name', 'student_id', 'section', 'status', 'telegram'].map((key) => [key, String(body[key] || '')])
);
// People are changed in the sheet first, so not without it.
const sheetReachable = () => !sync || sync.status().state !== 'offline';

// ---- Registration --------------------------------------------------------
// Its own page, outside admin: registering means tapping the new card, and the
// reader is at the office computer. So it opens there only, like the tap
// screen, and asks for no password.
app.use('/register', (req, res, next) => {
  if (isLocal(req)) return next();
  res.status(403).type('text/plain').send('Registration only opens on the office computer itself.');
});

app.get('/register', (req, res) => {
  const flash = req.query.ok
    ? { type: 'ok', text: req.query.ok }
    : req.query.err ? { type: 'err', text: req.query.err } : null;
  // ?from=<ID number> fills the form in from a Staffers row that has no card here.
  const unlinked = sync ? sync.status().roster.unlinked : [];
  const from = unlinked.find((r) => r.person && r.person.student_id === req.query.from);
  res.send(views.registerPage({
    flash, unknownScans: scanner.unknownScans, prefill: from ? from.person : null,
    online: sheetReachable(),
  }));
});

// Register a person. Their ID number and their card must each be theirs alone.
app.post('/register', async (req, res) => {
  const rfid = String(req.body.rfid || '').trim();
  const { person, error } = people.readPerson(req.body);
  const refuse = (text, status = 400) => res.status(status).send(views.registerPage({
    flash: { type: 'err', text }, unknownScans: scanner.unknownScans,
    prefill: { ...typed(req.body), rfid }, online: sheetReachable(), draft: true,
  }));

  if (error) return refuse(error);
  if (!/^\d{1,64}$/.test(rfid)) return refuse('Tap their ID, or type its card number — all digits.');
  const { name } = person;
  const namesake = store.getOtherWithStudentId(person.student_id);
  if (namesake) return refuse(`ID number ${person.student_id} already belongs to ${namesake.name}.`);
  const existing = store.getUserByRfid(rfid);
  if (existing) {
    const hint = existing.active ? '' : ' They are deactivated — ask an admin to reactivate them.';
    return refuse(`That card number is already registered to ${existing.name}.${hint}`);
  }
  try {
    await saveStaffer({ ...person, active: 1, rfid }, null, () => store.createUser(person, rfid));
    scanner.forgetUnknown(rfid);
    kickSync(true);
    res.redirect('/register?ok=' + encodeURIComponent(`${name} registered. Registration does not check you in. Return to the tap screen and tap your ID to start your time.`));
  } catch (e) {
    refuse(notSaved(e), 503);
  }
});

// Change a person's details. Their card is not one of them.
app.post('/admin/users/:id', async (req, res) => {
  const id = Number(req.params.id);
  const user = store.getUser(id);
  if (!user) return res.redirect('/admin/users?err=' + encodeURIComponent('No such person.'));
  const { person, error } = people.readPerson(req.body);
  const refuse = (text, status = 400) => res.status(status).send(
    usersPage(req, { type: 'err', text }, { ...user, ...typed(req.body) }, true)
  );
  if (error) return refuse(error);
  const namesake = store.getOtherWithStudentId(person.student_id, id);
  if (namesake) return refuse(`ID number ${person.student_id} already belongs to ${namesake.name}.`);
  try {
    await saveStaffer({ ...person, active: user.active, rfid: user.rfid }, user, () => store.updateUser(id, person));
    showStatus(); // their name may be on the tap screen
    kickSync(true);
    res.redirect('/admin/users?ok=' + encodeURIComponent(`${person.name} saved.`));
  } catch (e) {
    refuse(notSaved(e), 503);
  }
});

// Deactivate rather than delete: the person's card stops working, but their
// residency history stays in the database and in the hours report.
async function setActive(req, res, active, done) {
  const user = store.getUser(Number(req.params.id));
  if (!user) return res.redirect('/admin/users?err=' + encodeURIComponent('No such person.'));
  try {
    await saveStaffer({ ...user, active }, user, () => store.setUserActive(user.id, active));
    showStatus(); // they may have been checked in
    kickSync(true);
    res.redirect('/admin/users?ok=' + encodeURIComponent(done));
  } catch (e) {
    res.redirect('/admin/users?err=' + encodeURIComponent(notSaved(e)));
  }
}

app.post('/admin/users/:id/deactivate', (req, res) => setActive(req, res, false, 'Person deactivated. Their history is kept.'));
app.post('/admin/users/:id/reactivate', (req, res) => setActive(req, res, true, 'Person reactivated.'));

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
  const { report: rows } = buildReport(startISO, endISO);
  const label = (start || 'all') + '_to_' + (end || 'now');
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="hours_${label}.csv"`);
  res.send(report.hoursCsv(rows));
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
  if (stationClients.size) {
    const status = stationStatus();
    for (const res of stationClients) sendEvent(res, 'status', status);
  }
  if (dashboardClients.size) {
    const live = views.dashboardLive(dashboardNow());
    for (const res of dashboardClients) sendEvent(res, 'dashboard', live);
  }
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
app.get('/station', (req, res) => {
  auth.logout(req, res);
  res.set('Cache-Control', 'no-store');
  res.send(views.stationPage({ readerOnly: process.platform === 'linux' }));
});

app.post('/station/tap', fromTapScreen, express.json(), (req, res) => {
  const rfid = String((req.body && req.body.rfid) || '').trim();
  if (!/^\d{1,64}$/.test(rfid)) return res.status(400).json({ ok: false, error: 'not a card number' });
  const requestId = req.body.requestId;
  if (typeof requestId !== 'string' || !/^[a-f0-9-]{36}$/i.test(requestId)) {
    return res.status(400).json({ ok: false, error: 'Missing or invalid tap receipt. Reload the tap screen.' });
  }
  let result;
  try {
    result = scanner.handle(rfid, requestId);
  } catch (e) {
    console.error('Tap failed:', e.message);
    return res.status(500).json({ ok: false, error: 'Could not confirm this tap. Retry the same tap.' });
  }
  logScan(result);
  if (result.status === 'ok') { showStatus(); kickSync(); }
  res.json({
    ok: true,
    status: result.status,
    direction: result.direction,
    name: result.name,
    stale: result.stale,
    replayed: result.replayed,
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
// The browser tab's icon, for every page.
app.get('/icon.png', (req, res) => res.sendFile(path.join(__dirname, 'assets', 'icon.png')));

app.listen(PORT, () => {
  console.log(`Staffer Attendance Monitoring System running on http://localhost:${PORT}`);
  console.log(`  Tap screen:  http://localhost:${PORT}/station  (the reader types into this page)`);
  console.log(`  Register:    http://localhost:${PORT}/register  (this computer only)`);
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
  console.log(sync
    ? `  Sheet sync:  spreadsheet ${SHEETS_SPREADSHEET_ID}`
    : '  Sheet sync:  off (SHEETS_SPREADSHEET_ID is not set)');
  backUp('startup').then(() => { backedUp = true; kickSync(); });
});
