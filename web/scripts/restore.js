'use strict';

/*
 * Put a backup back:   npm run restore -- backups/residency-2026-10-01_183044.db
 *
 * Stop the server first (sudo systemctl stop residency). A running server
 * keeps the old file open and would carry on writing to it, so this refuses
 * if one answers on PORT.
 */

require('dotenv').config();

const http = require('http');
const { defaultDbPath } = require('../lib/dbpath');
const { restoreBackup } = require('../lib/backup');

const DB_PATH = process.env.DB_PATH || defaultDbPath();
const PORT = Number(process.env.PORT || 3000);

const backupPath = process.argv[2];
if (!backupPath) {
  console.error('Usage: npm run restore -- <backup file>');
  process.exit(1);
}

function serverRunning(callback) {
  const req = http.get({ host: '127.0.0.1', port: PORT, path: '/healthz', timeout: 2000 },
    (res) => { res.resume(); callback(true); });
  req.on('timeout', () => req.destroy());
  req.on('error', () => callback(false));
}

serverRunning((running) => {
  if (running) {
    console.error(`The residency server is running on port ${PORT}. Stop it first:`);
    console.error('  sudo systemctl stop residency');
    process.exit(1);
  }
  try {
    const done = restoreBackup({ backupPath, dbPath: DB_PATH });
    console.log(`Restored ${backupPath} to ${DB_PATH}`);
    console.log(`  ${done.users} people, ${done.events} taps`);
    if (done.setAside) console.log(`  The previous database was kept as ${done.setAside}`);
    console.log('Start the server again:  sudo systemctl start residency');
  } catch (e) {
    console.error(e.message);
    console.error('Nothing was changed.');
    process.exit(1);
  }
});
