'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createBackup, listBackups, verifyBackup, restoreBackup } = require('../lib/backup');

const ROOT = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'attendance-backup-'));

test.after(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignored */ }
});

// The database is driven from separate processes, as in real life: a restore
// happens with the server stopped, and what the next server sees is whatever
// is really in the file.
function inServer(dbPath, body) {
  const script = [
    'process.env.DB_PATH=' + JSON.stringify(dbPath),
    'const s=require(' + JSON.stringify(path.join(ROOT, 'db.js')) + ')',
    'const b=require(' + JSON.stringify(path.join(ROOT, 'lib', 'backup.js')) + ')',
    `(async()=>{${body}})()`,
  ].join(';');
  return execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }).trim();
}

const snapshot = (dbPath) => JSON.parse(inServer(dbPath,
  'console.log(JSON.stringify(s.listUsers().map(u=>({name:u.name,active:u.active,' +
  'events:s.getEventsForUser(u.id).map(e=>[e.type,e.ts])}))))'));

const seed = `
  s.createUser('Ana','S1','staffer','111');
  const u=s.getUserByRfid('111');
  s.insertEvent(u.id,'in','2026-01-05T01:00:00.000Z','boot-a');
  s.insertEvent(u.id,'out','2026-01-05T05:00:00.000Z','boot-a');`;

const freePort = () => new Promise((resolve) => {
  const srv = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});

test('a backup restores the database to exactly what it was', () => {
  const dbPath = path.join(tmp, 'a', 'attendance.db');
  const dir = path.join(tmp, 'a', 'backups');
  fs.mkdirSync(path.dirname(dbPath));

  const backup = inServer(dbPath,
    seed + `console.log(await b.createBackup({source:s,dir:${JSON.stringify(dir)}}))`);
  const before = snapshot(dbPath);
  assert.strictEqual(before[0].events.length, 2);

  // The day goes on, then goes wrong.
  inServer(dbPath, `
    const u=s.getUserByRfid('111');
    s.insertEvent(u.id,'in','2026-01-06T01:00:00.000Z','boot-b');
    s.setUserActive(u.id,false);
    s.createUser('Mistake','S2','','222');`);
  assert.notDeepStrictEqual(snapshot(dbPath), before);

  const done = restoreBackup({ backupPath: backup, dbPath });
  assert.deepStrictEqual({ users: done.users, events: done.events }, { users: 1, events: 2 });
  assert.deepStrictEqual(snapshot(dbPath), before);
});

test('the database being replaced is set aside, not deleted', () => {
  const dbPath = path.join(tmp, 'b', 'attendance.db');
  const dir = path.join(tmp, 'b', 'backups');
  fs.mkdirSync(path.dirname(dbPath));

  const backup = inServer(dbPath,
    seed + `console.log(await b.createBackup({source:s,dir:${JSON.stringify(dir)}}))`);
  inServer(dbPath, "s.createUser('Later','S3','','333')");
  const replaced = snapshot(dbPath);

  const { setAside } = restoreBackup({ backupPath: backup, dbPath });
  assert.strictEqual(snapshot(dbPath).length, 1);
  // Restoring the wrong backup can be undone: the old database still opens.
  assert.deepStrictEqual(snapshot(setAside), replaced);
});

test('a damaged backup is refused and the database is left alone', () => {
  const dbPath = path.join(tmp, 'c', 'attendance.db');
  fs.mkdirSync(path.dirname(dbPath));
  inServer(dbPath, seed);
  const before = snapshot(dbPath);

  const bad = path.join(tmp, 'c', 'bad.db');
  fs.writeFileSync(bad, 'this is not a database, it only has the right name');
  assert.throws(() => restoreBackup({ backupPath: bad, dbPath }), /not a usable backup/);
  assert.throws(() => restoreBackup({ backupPath: path.join(tmp, 'c', 'missing.db'), dbPath }),
    /not a usable backup/);

  assert.deepStrictEqual(snapshot(dbPath), before);
  assert.deepStrictEqual(fs.readdirSync(path.dirname(dbPath)).filter((f) => f.includes('before-restore')), []);
});

test('a backup is a complete database while the server still has it open', () => {
  const dbPath = path.join(tmp, 'd', 'attendance.db');
  const dir = path.join(tmp, 'd', 'backups');
  fs.mkdirSync(path.dirname(dbPath));
  const backup = inServer(dbPath,
    seed + `console.log(await b.createBackup({source:s,dir:${JSON.stringify(dir)}}))`);
  assert.deepStrictEqual(verifyBackup(backup), { users: 1, events: 2 });
});

test('only the newest backups are kept', async () => {
  const dir = path.join(tmp, 'e');
  const source = { backup: async (dest) => fs.writeFileSync(dest, 'x') };
  let at = Date.UTC(2026, 0, 5, 1, 0, 0);
  for (let day = 0; day < 5; day++) {
    await createBackup({ source, dir, keep: 3, now: () => at });
    at += 24 * 3_600_000;
  }
  assert.deepStrictEqual(listBackups(dir), [
    'attendance-2026-01-07_090000.db',
    'attendance-2026-01-08_090000.db',
    'attendance-2026-01-09_090000.db',
  ]);
});

test('a backup that fails part-way leaves nothing that looks like a backup', async () => {
  const dir = path.join(tmp, 'f');
  const source = {
    backup: async (dest) => { fs.writeFileSync(dest, 'half'); throw new Error('disk full'); },
  };
  await assert.rejects(createBackup({ source, dir }), /disk full/);
  assert.deepStrictEqual(listBackups(dir), []);
});

// The procedure in the README, run the way an admin would run it.
test('npm run restore puts a backup back, and refuses a bad file', async () => {
  const dbPath = path.join(tmp, 'g', 'attendance.db');
  const dir = path.join(tmp, 'g', 'backups');
  fs.mkdirSync(path.dirname(dbPath));
  const backup = inServer(dbPath,
    seed + `console.log(await b.createBackup({source:s,dir:${JSON.stringify(dir)}}))`);
  const before = snapshot(dbPath);
  inServer(dbPath, "s.createUser('Mistake','S2','','222')");

  const env = { ...process.env, DB_PATH: dbPath, PORT: String(await freePort()) };
  const script = path.join(ROOT, 'scripts', 'restore.js');
  const out = execFileSync(process.execPath, [script, backup], { env, encoding: 'utf8' });
  assert.match(out, /1 people, 2 taps/);
  assert.deepStrictEqual(snapshot(dbPath), before);

  const bad = path.join(tmp, 'g', 'bad.db');
  fs.writeFileSync(bad, 'nope');
  assert.throws(() => execFileSync(process.execPath, [script, bad], { env, stdio: 'pipe' }));
  assert.deepStrictEqual(snapshot(dbPath), before);
});

test('npm run restore refuses while the server is running', async () => {
  const srv = require('node:http').createServer((req, res) => res.end('{"ok":true}'));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const dbPath = path.join(tmp, 'h', 'attendance.db');
  const env = { ...process.env, DB_PATH: dbPath, PORT: String(srv.address().port) };
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'restore.js'), 'any.db'], { env });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  const code = await new Promise((r) => child.on('close', r));
  srv.close();
  assert.strictEqual(code, 1);
  assert.match(err, /Stop it first/);
  assert.ok(!fs.existsSync(dbPath));
});
