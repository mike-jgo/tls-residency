'use strict';

/*
 * Where the database lives when DB_PATH doesn't say.
 *
 * The file used to be called attendance.db. An install from then still has
 * its records under that name, and opening a new empty residency.db beside
 * them would look exactly like losing everything — so the old file, with its
 * WAL, is renamed the first time through.
 */

const fs = require('fs');
const path = require('path');

function defaultDbPath(dir = path.join(__dirname, '..')) {
  const current = path.join(dir, 'residency.db');
  const old = path.join(dir, 'attendance.db');
  if (!fs.existsSync(current) && fs.existsSync(old)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(old + suffix)) fs.renameSync(old + suffix, current + suffix);
    }
  }
  return current;
}

module.exports = { defaultDbPath };
