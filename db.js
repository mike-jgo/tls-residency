'use strict';

/*
 * Database layer.
 * One SQLite file holds everything. Tables are created on first run,
 * so there is no separate migration step — just start the server.
 */

const Database = require('better-sqlite3');
const { defaultDbPath } = require('./lib/dbpath');

const DB_PATH = process.env.DB_PATH || defaultDbPath();

const db = new Database(DB_PATH);
// WAL mode survives crashes/power cuts more gracefully and allows the
// admin pages to read while a scan is being written.
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    student_id  TEXT,
    section     TEXT,
    status      TEXT,
    telegram    TEXT,
    rfid        TEXT    NOT NULL UNIQUE,
    created_at  TEXT    NOT NULL,
    active      INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS events (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id  INTEGER NOT NULL,
    type     TEXT    NOT NULL CHECK (type IN ('in','out')),
    ts       TEXT    NOT NULL,
    boot_id  TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_events_user_ts ON events(user_id, ts);

  -- Small facts the server must remember across restarts, such as how far
  -- the Google Sheets sync has got (lib/sync.js).
  CREATE TABLE IF NOT EXISTS meta (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
  );
`);

// Databases created before boot ids were recorded lack the column. Their
// events keep a NULL boot id, which reads as "some earlier boot" — correct,
// since every one of them was written before this machine last started.
if (!db.pragma('table_info(events)').some((c) => c.name === 'boot_id')) {
  db.exec('ALTER TABLE events ADD COLUMN boot_id TEXT');
}

// A retry after a lost reply must return the original tap, not toggle again.
if (!db.pragma('table_info(events)').some((c) => c.name === 'request_id')) {
  db.exec('ALTER TABLE events ADD COLUMN request_id TEXT');
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_events_request ON events(request_id) WHERE request_id IS NOT NULL');

// People are deactivated, never deleted: deleting a person would take their
// residency history with them. Databases from before that lack the column;
// everyone in them is active.
if (!db.pragma('table_info(users)').some((c) => c.name === 'active')) {
  db.exec('ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
}

// The staffer directory's fields (lib/people.js) came later still. People
// registered before them have none until someone edits them in. Those
// databases also keep a `role` column, and later ones `year`, `course` and
// `in_sheet`, which nothing reads any more.
for (const column of ['section', 'status', 'telegram']) {
  if (!db.pragma('table_info(users)').some((c) => c.name === column)) {
    db.exec(`ALTER TABLE users ADD COLUMN ${column} TEXT`);
  }
}

// ---- Prepared statements (compiled once, reused) -------------------------

const stmt = {
  userByRfid:   db.prepare('SELECT * FROM users WHERE rfid = ?'),
  userById:     db.prepare('SELECT * FROM users WHERE id = ?'),
  createUser:   db.prepare(
    `INSERT INTO users (name, student_id, section, status, telegram, rfid, created_at)
     VALUES (@name, @student_id, @section, @status, @telegram, @rfid, @created_at)`
  ),
  // The card is not among them: a card stays with the person it was given to.
  updateUser:   db.prepare(
    `UPDATE users SET name = @name, student_id = @student_id, section = @section, status = @status,
       telegram = @telegram
     WHERE id = @id`
  ),
  getMeta:      db.prepare('SELECT value FROM meta WHERE key = ?').pluck(),
  setMeta:      db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ),
  // For the sheet sync: taps after a given one, oldest first, with whose they are.
  eventsAfter:  db.prepare(`
    SELECT e.id, e.type, e.ts, u.name, u.student_id
    FROM events e JOIN users u ON u.id = e.user_id
    WHERE e.id > ? ORDER BY e.id ASC LIMIT ?
  `),
  // For the sync's pull of the taps the sheet holds — lib/sync.js.
  allEvents:    db.prepare('SELECT * FROM events ORDER BY id ASC'),
  lastEventId:  db.prepare('SELECT COALESCE(MAX(id), 0) FROM events').pluck(),
  clearEvents:  db.prepare('DELETE FROM events'),
  restartIds:   db.prepare("DELETE FROM sqlite_sequence WHERE name = 'events'"),
  // An id of null takes the next one.
  putEvent:     db.prepare(
    `INSERT INTO events (id, user_id, type, ts, boot_id, request_id)
     VALUES (@id, @user_id, @type, @ts, @boot_id, @request_id)`
  ),
  firstEventTs: db.prepare('SELECT MIN(ts) FROM events').pluck(),
  lastEventTs:  db.prepare('SELECT MAX(ts) FROM events').pluck(),
  countAfter:   db.prepare('SELECT COUNT(*) FROM events WHERE id > ?').pluck(),
  countBefore:  db.prepare(
    'SELECT COUNT(*) FROM events WHERE ts >= ? AND ts < ? AND id < ?'
  ).pluck(),
  usersByStudentId: db.prepare('SELECT * FROM users WHERE student_id = ?'),
  // For lib/roster.js's pull: the tab's version of a person.
  fromSheet:    db.prepare(
    `UPDATE users SET name = @name, student_id = @student_id, section = @section, status = @status,
       telegram = @telegram, rfid = @rfid, active = @active
     WHERE id = @id`
  ),
  newFromSheet: db.prepare(
    `INSERT INTO users (name, student_id, section, status, telegram, rfid, active, created_at)
     VALUES (@name, @student_id, @section, @status, @telegram, @rfid, @active, @created_at)`
  ),
  setCard:      db.prepare('UPDATE users SET rfid = ? WHERE id = ?'),
  deleteUser:   db.prepare('DELETE FROM users WHERE id = ?'),
  setActive:    db.prepare('UPDATE users SET active = ? WHERE id = ?'),
  listUsers:    db.prepare('SELECT * FROM users ORDER BY name COLLATE NOCASE'),

  // Ordered by id, not ts. The Pi has no battery-backed clock, so after a
  // power cut with no network it boots hours in the past — ordering by ts
  // would then pick a stale row and flip the in/out toggle the wrong way.
  // AUTOINCREMENT ids stay monotonic no matter what the clock does.
  lastEvent:    db.prepare(
    'SELECT * FROM events WHERE user_id = ? ORDER BY id DESC LIMIT 1'
  ),
  insertEvent:  db.prepare(
    'INSERT INTO events (user_id, type, ts, boot_id, request_id) VALUES (?, ?, ?, ?, ?)'
  ),
  eventByRequest: db.prepare('SELECT e.*, u.name, u.rfid FROM events e JOIN users u ON u.id = e.user_id WHERE e.request_id = ?'),
  // Insertion order is the true sequence of taps — see the note above.
  eventsForUser: db.prepare(
    'SELECT * FROM events WHERE user_id = ? ORDER BY id ASC'
  ),
  // Everyone whose most recent event is a check-in made since the machine last
  // started = currently in the office. A check-in from an earlier boot was
  // never closed before shutdown; that person went home.
  currentlyIn: db.prepare(`
    SELECT u.*, e.ts AS since
    FROM users u
    JOIN events e ON e.id = (
      SELECT id FROM events WHERE user_id = u.id ORDER BY id DESC LIMIT 1
    )
    WHERE e.type = 'in' AND e.boot_id = ? AND u.active = 1
    ORDER BY e.ts DESC
  `),
};

// Carry out lib/roster.js's pull(), all of it or none.
const applyRoster = db.transaction((plan) => {
  // Two people's cards may have been swapped in the tab, and no two rows may
  // hold one card even for a moment — so park the cards that are changing.
  for (const u of plan.update) stmt.setCard.run(`moving:${u.id}`, u.id);
  for (const u of plan.update) {
    stmt.fromSheet.run({ ...EMPTY_PERSON, ...u.person, id: u.id, rfid: u.rfid, active: u.active ? 1 : 0 });
  }
  for (const c of plan.create) {
    stmt.newFromSheet.run({
      ...EMPTY_PERSON, ...c.person, rfid: c.rfid, active: c.active ? 1 : 0, created_at: new Date().toISOString(),
    });
  }
  for (const id of plan.deactivate) stmt.setActive.run(0, id);
});

// Make the taps exactly `events`, all of them or none, and drop the people in
// `gone` — for lib/sync.js, when the sheet's taps replace this device's.
const replaceEvents = db.transaction((events, gone = []) => {
  stmt.clearEvents.run();
  stmt.restartIds.run();
  for (const e of events) {
    stmt.putEvent.run({
      id: e.id, user_id: e.user_id, type: e.type, ts: e.ts, boot_id: e.boot_id || null, request_id: e.request_id || null,
    });
  }
  for (const id of gone) stmt.deleteUser.run(id);
});

// ---- Public helpers ------------------------------------------------------

const EMPTY_PERSON = { student_id: null, section: null, status: null, telegram: null };

module.exports = {
  getUserByRfid: (rfid) => stmt.userByRfid.get(rfid),
  getUser:       (id)   => stmt.userById.get(id),
  listUsers:     ()     => stmt.listUsers.all(),

  // `person` holds the directory fields — see readPerson in lib/people.js.
  // Any left out are stored empty.
  createUser(person, rfid) {
    return stmt.createUser.run({ ...EMPTY_PERSON, ...person, rfid, created_at: new Date().toISOString() });
  },
  updateUser: (id, person) => stmt.updateUser.run({ ...EMPTY_PERSON, ...person, id }),

  // Whoever else has this ID number: it is how a person is matched to their
  // row in the sheet, so no two people may share one.
  getOtherWithStudentId: (studentId, id = null) =>
    stmt.usersByStudentId.all(studentId).find((u) => u.id !== id),

  // For the sheet sync — see lib/roster.js.
  applyRoster,
  listEvents: () => stmt.allEvents.all(),
  getLastEventId: () => stmt.lastEventId.get(),
  replaceEvents,
  // Someone the sheet's taps name but its Staffers tab doesn't: kept, so the
  // taps have someone to belong to, deactivated and with a card nothing reads.
  addFormerStaffer(name, studentId) {
    return Number(stmt.newFromSheet.run({
      ...EMPTY_PERSON, name, student_id: studentId, rfid: `none:${studentId || name}`, active: 0,
      created_at: new Date().toISOString(),
    }).lastInsertRowid);
  },

  setUserActive: (id, active) => stmt.setActive.run(active ? 1 : 0, id),

  getLastEvent:   (userId) => stmt.lastEvent.get(userId),
  insertEvent:    (userId, type, ts, bootId = null, requestId = null) => stmt.insertEvent.run(userId, type, ts, bootId, requestId),
  getEventByRequest: (requestId) => stmt.eventByRequest.get(requestId),
  getEventsForUser: (userId) => stmt.eventsForUser.all(userId),
  getCurrentlyIn: (bootId) => stmt.currentlyIn.all(bootId),

  getFirstEventTs: () => stmt.firstEventTs.get(),
  getLastEventTs:  () => stmt.lastEventTs.get(),
  getMeta: (key) => stmt.getMeta.get(key),
  setMeta: (key, value) => stmt.setMeta.run(key, value),
  getEventsAfter:   (id, limit) => stmt.eventsAfter.all(id, limit),
  countEventsAfter: (id) => stmt.countAfter.get(id),
  // How many taps in [startISO, endISO) came before tap `id`.
  countEventsBefore: (startISO, endISO, id) => stmt.countBefore.get(startISO, endISO, id),

  // SQLite's online backup: a consistent copy even while taps are being
  // written. Resolves when the copy is complete. See lib/backup.js.
  backup: (dest) => db.backup(dest),
};
