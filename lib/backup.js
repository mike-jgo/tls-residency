'use strict';

/*
 * Backups of the residency database, and putting one back.
 *
 * residency.db is the only copy of the records, on an SD card in a machine
 * that gets unplugged every night. The server takes a backup when it starts
 * and again when Shut down is pressed (see server.js), so there is always one
 * from the end of each day — and one from the next morning, in case the
 * machine was unplugged without shutting down.
 *
 * Restoring is done with the server stopped: scripts/restore.js.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { TZ } = require('./dates');

// Backups made before the rename are still backups: list and prune them too.
const BACKUP_RE = /^(?:residency|attendance)-\d{4}-\d{2}-\d{2}_\d{6}\.db$/;

// 2026-10-01_183044 — local time, and sorts by name in date order.
function stamp(at) {
  return new Date(at).toLocaleString('sv-SE', { timeZone: TZ }).replace(' ', '_').replace(/:/g, '');
}

// Backups in `dir`, oldest first.
function listBackups(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => BACKUP_RE.test(f)).sort();
}

/*
 * Copy the database into `dir` and delete all but the newest `keep` backups.
 * `source` is anything with SQLite's online backup — db.js, or a raw handle.
 *
 * The copy is written under a temporary name and renamed when complete, so a
 * power cut mid-backup can't leave a half-written file that looks like a
 * backup.
 */
async function createBackup({ source, dir, keep = 60, now = Date.now }) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `residency-${stamp(now())}.db`);
  const partial = file + '.partial';
  try {
    await source.backup(partial);
  } catch (e) {
    fs.rmSync(partial, { force: true });
    throw e;
  }
  fs.renameSync(partial, file);

  const all = listBackups(dir);
  for (const old of all.slice(0, Math.max(0, all.length - keep))) {
    fs.unlinkSync(path.join(dir, old));
  }
  return file;
}

// Throws unless `file` is an intact residency database.
function verifyBackup(file) {
  let db;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    const check = db.pragma('integrity_check', { simple: true });
    if (check !== 'ok') throw new Error(`integrity check failed: ${check}`);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").pluck().all();
    for (const t of ['users', 'events']) {
      if (!tables.includes(t)) throw new Error(`it has no ${t} table`);
    }
    return {
      users: db.prepare('SELECT COUNT(*) FROM users').pluck().get(),
      events: db.prepare('SELECT COUNT(*) FROM events').pluck().get(),
    };
  } catch (e) {
    throw new Error(`${file} is not a usable backup — ${e.message}`);
  } finally {
    if (db) db.close();
  }
}

/*
 * Replace the database at `dbPath` with `backupPath`. The server must not be
 * running. The backup is verified first, so a bad file never displaces a good
 * database; and the current database is renamed aside rather than deleted, so
 * a restore of the wrong backup can itself be undone.
 *
 * Returns { users, events, setAside } — setAside is null if there was no
 * database to replace.
 */
function restoreBackup({ backupPath, dbPath, now = Date.now }) {
  const counts = verifyBackup(backupPath);

  // The WAL holds recent writes, so it moves with the file it belongs to.
  // SQLite pairs "<name>-wal" with "<name>", which the renamed set still is.
  let setAside = null;
  if (fs.existsSync(dbPath)) {
    setAside = `${dbPath}.before-restore-${stamp(now())}`;
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(dbPath + suffix)) fs.renameSync(dbPath + suffix, setAside + suffix);
    }
  }
  fs.copyFileSync(backupPath, dbPath);
  return { ...counts, setAside };
}

module.exports = { createBackup, listBackups, verifyBackup, restoreBackup };
