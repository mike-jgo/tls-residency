'use strict';

/*
 * Database layer.
 * One SQLite file holds everything. Tables are created on first run,
 * so there is no separate migration step — just start the server.
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'attendance.db');

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
    role        TEXT,
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
`);

// Databases created before boot ids were recorded lack the column. Their
// events keep a NULL boot id, which reads as "some earlier boot" — correct,
// since every one of them was written before this machine last started.
if (!db.pragma('table_info(events)').some((c) => c.name === 'boot_id')) {
  db.exec('ALTER TABLE events ADD COLUMN boot_id TEXT');
}

// People are deactivated, never deleted: deleting a person would take their
// attendance history with them. Databases from before that lack the column;
// everyone in them is active.
if (!db.pragma('table_info(users)').some((c) => c.name === 'active')) {
  db.exec('ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
}

// ---- Prepared statements (compiled once, reused) -------------------------

const stmt = {
  userByRfid:   db.prepare('SELECT * FROM users WHERE rfid = ?'),
  createUser:   db.prepare(
    `INSERT INTO users (name, student_id, role, rfid, created_at)
     VALUES (@name, @student_id, @role, @rfid, @created_at)`
  ),
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
    'INSERT INTO events (user_id, type, ts, boot_id) VALUES (?, ?, ?, ?)'
  ),
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

// ---- Public helpers ------------------------------------------------------

module.exports = {
  getUserByRfid: (rfid) => stmt.userByRfid.get(rfid),
  listUsers:     ()     => stmt.listUsers.all(),

  createUser(name, studentId, role, rfid) {
    return stmt.createUser.run({
      name,
      student_id: studentId || null,
      role: role || null,
      rfid,
      created_at: new Date().toISOString(),
    });
  },

  setUserActive: (id, active) => stmt.setActive.run(active ? 1 : 0, id),

  getLastEvent:   (userId) => stmt.lastEvent.get(userId),
  insertEvent:    (userId, type, ts, bootId = null) => stmt.insertEvent.run(userId, type, ts, bootId),
  getEventsForUser: (userId) => stmt.eventsForUser.all(userId),
  getCurrentlyIn: (bootId) => stmt.currentlyIn.all(bootId),

  // SQLite's online backup: a consistent copy even while taps are being
  // written. Resolves when the copy is complete. See lib/backup.js.
  backup: (dest) => db.backup(dest),
};
