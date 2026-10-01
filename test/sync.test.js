'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'residency-sync-'));
process.env.DB_PATH = path.join(tmp, 'residency.db');
process.env.MAX_SESSION_HOURS = '10';
process.env.TZ = 'Asia/Manila';

const store = require('../db');
const { createSync } = require('../lib/sync');

test.after(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignored */ }
});

const BOOT = 'boot-today';

/*
 * A stand-in for the spreadsheet: tabs of cells, written by exact range the
 * way lib/sheets.js writes them. `fail` makes the next write go wrong the two
 * ways a network can:
 *
 *   'before'  the request never arrived — nothing is written.
 *   'after'   the request arrived and was applied, but the reply was lost.
 *             The sender can't tell this from 'before', and this is the case
 *             that duplicates rows in anything that appends.
 */
let sheetCount = 0;
function fakeSheet() {
  const tabs = new Map(); // title -> Map('I2' -> value)
  const sheet = {
    spreadsheetId: 'sheet-' + ++sheetCount,
    fail: null,
    writes: [], // every range sent, applied or not
    clears: [],
    async clearRanges(ranges) {
      for (const range of ranges) {
        sheet.clears.push(range);
        const [, title] = /^'(.+)'!A2:G$/.exec(range);
        const cells = tabs.get(title);
        for (const k of [...cells.keys()]) if (Number(k.slice(1)) >= 2) cells.delete(k);
      }
    },
    tabs,
    async listTabs() { return [...tabs.keys()]; },
    async addTabs(titles) { for (const t of titles) tabs.set(t, new Map()); },
    async writeRanges(data) {
      const mode = sheet.fail;
      sheet.fail = null;
      const lost = () => Object.assign(new Error('Could not reach Google (ETIMEDOUT).'), { offline: true });
      if (mode === 'before') throw lost();
      if (mode === 'refused') throw Object.assign(new Error('Google refused (403): no permission'), { offline: false });
      for (const { range, values } of data) {
        sheet.writes.push(range);
        const [, title, c1, r1, c2, r2] = /^'(.+)'!([A-Z])(\d+):([A-Z])(\d+)$/.exec(range);
        assert.ok(tabs.has(title), `wrote to a tab that doesn't exist: ${title}`);
        assert.strictEqual(values.length, r2 - r1 + 1, `${range} has the wrong number of rows`);
        values.forEach((row, i) => {
          assert.strictEqual(row.length, c2.charCodeAt(0) - c1.charCodeAt(0) + 1, `${range} has the wrong width`);
          row.forEach((v, j) => {
            const cell = String.fromCharCode(c1.charCodeAt(0) + j) + (Number(r1) + i);
            if (v === '') tabs.get(title).delete(cell); else tabs.get(title).set(cell, v);
          });
        });
      }
      if (mode === 'after') throw lost();
    },
    cell: (title, at) => tabs.get(title).get(at),
    // A column from row 2 down, including any gaps, as far as the tab goes.
    column(title, letter) {
      const cells = tabs.get(title);
      const rows = [...cells.keys()].filter((k) => k[0] === letter).map((k) => Number(k.slice(1)));
      const out = [];
      for (let r = 2; r <= Math.max(1, ...rows); r++) out.push(cells.get(letter + r));
      return out;
    },
    hours(title) {
      const out = {};
      sheet.column(title, 'A').forEach((name, i) => { out[name] = sheet.cell(title, 'C' + (i + 2)); });
      return out;
    },
  };
  return sheet;
}

// Each test works in a month of its own and a spreadsheet of its own, so the
// one shared database can't make them depend on each other.
let cards = 0;
function person(name) {
  const rfid = String(5000 + ++cards);
  store.createUser(name, 'S' + cards, 'staffer', rfid);
  return store.getUserByRfid(rfid);
}
// Manila is UTC+8: 09:00 there is 01:00Z.
const at = (y, m, d, h = 9, min = 0) => new Date(Date.UTC(y, m - 1, d, h - 8, min)).toISOString();
const tapAt = (user, type, iso, boot = BOOT) => Number(store.insertEvent(user.id, type, iso, boot).lastInsertRowid);

function syncer(sheet, nowISO, extra = {}) {
  return createSync({ store, client: sheet, bootId: BOOT, now: () => Date.parse(nowISO), ...extra });
}

test('a month\'s hours and its taps land on that month\'s two tabs', async () => {
  const ana = person('Ana Jan');
  const ben = person('Ben Jan');
  const ids = [
    tapAt(ana, 'in', at(2026, 1, 5, 9)), tapAt(ben, 'in', at(2026, 1, 5, 10)),
    tapAt(ana, 'out', at(2026, 1, 5, 13)), tapAt(ben, 'out', at(2026, 1, 5, 12, 30)),
  ];
  const sheet = fakeSheet();
  await syncer(sheet, at(2026, 1, 5, 18)).syncOnce();

  assert.deepStrictEqual(sheet.column('January 2026 Logs', 'A'), ids);
  assert.deepStrictEqual(sheet.column('January 2026 Logs', 'D'), ['Ana Jan', 'Ben Jan', 'Ana Jan', 'Ben Jan']);
  assert.deepStrictEqual(sheet.column('January 2026 Logs', 'F'), ['IN', 'IN', 'OUT', 'OUT']);
  assert.strictEqual(sheet.cell('January 2026 Logs', 'B2'), '2026-01-05');
  assert.strictEqual(sheet.cell('January 2026 Logs', 'C2'), '09:00:00');
  assert.strictEqual(sheet.cell('January 2026', 'A1'), 'Name');
  assert.strictEqual(sheet.cell('January 2026 Logs', 'A1'), 'Tap #');

  const hours = sheet.hours('January 2026');
  assert.strictEqual(hours['Ana Jan'], 4);
  assert.strictEqual(hours['Ben Jan'], 2.5);

  assert.strictEqual(sheet.cell('Totals', 'A1'), 'Last synced');
  assert.strictEqual(sheet.cell('Totals', 'B1'), '2026-01-05 18:00:00');
  assert.strictEqual(sheet.cell('Totals', 'A3'), 'Name');
  assert.strictEqual(sheet.hours('Totals')['Ana Jan'], 4);
  assert.strictEqual(sheet.hours('Totals')['Ben Jan'], 2.5);
});

// The requirement that matters most: a retry must never duplicate a record.
test('an upload whose reply was lost is sent again without duplicating a tap', async () => {
  const cy = person('Cy Feb');
  const ids = [tapAt(cy, 'in', at(2026, 2, 3, 9)), tapAt(cy, 'out', at(2026, 2, 3, 11))];
  const sheet = fakeSheet();
  const sync = syncer(sheet, at(2026, 2, 3, 18));

  sheet.fail = 'after'; // Google applied it; we never heard back
  await assert.rejects(sync.syncOnce(), /Could not reach Google/);
  assert.deepStrictEqual(sheet.column('February 2026 Logs', 'A'), ids, 'the taps are in the sheet');
  assert.ok(sync.status().pending >= 2, 'but as far as we know they are still pending');

  await sync.syncOnce(); // the retry
  assert.deepStrictEqual(sheet.column('February 2026 Logs', 'A'), ids, 'each tap exactly once');
  assert.strictEqual(sheet.hours('February 2026')['Cy Feb'], 2);
  assert.strictEqual(sync.status().pending, 0);
});

test('taps that could not be uploaded survive a restart and go up afterwards', async () => {
  const di = person('Di Mar');
  const first = [tapAt(di, 'in', at(2026, 3, 2, 9)), tapAt(di, 'out', at(2026, 3, 2, 12))];
  const sheet = fakeSheet();
  await syncer(sheet, at(2026, 3, 2, 13)).syncOnce();

  // The wifi drops, two more taps happen, the upload fails, the Pi is shut down.
  const later = [tapAt(di, 'in', at(2026, 3, 2, 14)), tapAt(di, 'out', at(2026, 3, 2, 17))];
  const offline = syncer(sheet, at(2026, 3, 2, 18));
  sheet.fail = 'before';
  await assert.rejects(offline.syncOnce());
  assert.strictEqual(offline.status().pending, 2);
  assert.deepStrictEqual(sheet.column('March 2026 Logs', 'A'), first);

  // Next morning: a new process, with nothing in memory. Only the database
  // knows what is still owed.
  const nextDay = syncer(sheet, at(2026, 3, 3, 9));
  assert.strictEqual(nextDay.status().pending, 2);
  sheet.writes.length = 0;
  await nextDay.syncOnce();

  assert.deepStrictEqual(sheet.column('March 2026 Logs', 'A'), [...first, ...later]);
  assert.strictEqual(nextDay.status().pending, 0);
  // And it sent only what was owed, to the rows after what was already there.
  assert.deepStrictEqual(sheet.writes.filter((r) => /Logs'!A[2-9]/.test(r)), ["'March 2026 Logs'!A4:F5"]);
});

test('syncing again with nothing new changes nothing but the time', async () => {
  const ed = person('Ed Apr');
  tapAt(ed, 'in', at(2026, 4, 6, 9));
  tapAt(ed, 'out', at(2026, 4, 6, 10));
  const sheet = fakeSheet();
  await syncer(sheet, at(2026, 4, 6, 11)).syncOnce();
  const before = JSON.stringify([...sheet.tabs.get('April 2026')]);

  sheet.writes.length = 0;
  await syncer(sheet, at(2026, 4, 6, 15)).syncOnce();
  assert.strictEqual(JSON.stringify([...sheet.tabs.get('April 2026')]), before);
  assert.deepStrictEqual(sheet.writes.filter((r) => r.includes('Logs')), [], 'no taps re-sent');
  assert.strictEqual(sheet.cell('Totals', 'B1'), '2026-04-06 15:00:00');
});

test('each month gets its own tabs, and taps start at the top of its log', async () => {
  const fe = person('Fe MayJun');
  const may = [tapAt(fe, 'in', at(2026, 5, 29, 9)), tapAt(fe, 'out', at(2026, 5, 29, 12))];
  const june = [tapAt(fe, 'in', at(2026, 6, 1, 9)), tapAt(fe, 'out', at(2026, 6, 1, 14))];
  const sheet = fakeSheet();
  await syncer(sheet, at(2026, 6, 1, 18)).syncOnce();

  assert.deepStrictEqual(sheet.column('May 2026 Logs', 'A'), may);
  assert.deepStrictEqual(sheet.column('June 2026 Logs', 'A'), june);
  assert.strictEqual(sheet.hours('May 2026')['Fe MayJun'], 3);
  assert.strictEqual(sheet.hours('June 2026')['Fe MayJun'], 5);
});

// Midnight in Manila is 16:00Z the day before — the month is the local one.
test('a tap just after local midnight belongs to the new month', async () => {
  const gil = person('Gil Jul');
  const id = tapAt(gil, 'in', at(2026, 8, 1, 0, 30)); // 31 Jul 16:30Z
  const sheet = fakeSheet();
  await syncer(sheet, at(2026, 8, 1, 1)).syncOnce();
  assert.ok(sheet.column('August 2026 Logs', 'A').includes(id));
  assert.ok(!sheet.tabs.has('July 2026 Logs'));
});

test('a session that runs past midnight on the last day updates the month it began in', async () => {
  const hal = person('Hal SepOct');
  tapAt(hal, 'in', at(2026, 9, 30, 22));
  const sheet = fakeSheet();
  await syncer(sheet, at(2026, 9, 30, 23)).syncOnce();
  assert.strictEqual(sheet.hours('September 2026')['Hal SepOct'], 0);

  tapAt(hal, 'out', at(2026, 10, 1, 1));
  await syncer(sheet, at(2026, 10, 1, 2)).syncOnce();
  assert.strictEqual(sheet.hours('September 2026')['Hal SepOct'], 3);
});

test('someone who drops out of a month\'s table leaves no stale row behind', async () => {
  const zed = person('Zed Nov'); // sorts last, so their row is the one that goes
  const sheet = fakeSheet();
  await syncer(sheet, at(2026, 11, 2, 9)).syncOnce();
  assert.ok(sheet.column('November 2026', 'A').includes('Zed Nov'), 'active people are listed with zero hours');

  store.setUserActive(zed.id, false);
  await syncer(sheet, at(2026, 11, 2, 10)).syncOnce();
  assert.ok(!sheet.column('November 2026', 'A').includes('Zed Nov'));
  // Still in the all-time totals, marked deactivated.
  const row = sheet.column('Totals', 'A').indexOf('Zed Nov') + 2;
  assert.strictEqual(sheet.cell('Totals', 'G' + row), 'yes');
});

test('pointing at a different spreadsheet uploads the whole history to it', async () => {
  const ivy = person('Ivy Dec');
  const ids = [tapAt(ivy, 'in', at(2026, 12, 1, 9)), tapAt(ivy, 'out', at(2026, 12, 1, 10))];
  const one = fakeSheet();
  await syncer(one, at(2026, 12, 1, 11)).syncOnce();
  const two = fakeSheet();
  const sync = syncer(two, at(2026, 12, 1, 12));
  await sync.syncOnce();
  assert.deepStrictEqual(two.column('December 2026 Logs', 'A'), ids);
  assert.ok(two.tabs.has('January 2026'), 'earlier months too');
});

// ---- The retry loop ------------------------------------------------------

const until = async (cond) => { while (!cond()) await new Promise((r) => setTimeout(r, 2)); };

test('a failed sync is retried by itself until it works', async () => {
  const jo = person('Jo 27');
  const ids = [tapAt(jo, 'in', at(2027, 1, 4, 9))];
  const sheet = fakeSheet();
  const logged = [];
  const sync = syncer(sheet, at(2027, 1, 4, 10), { retryMs: 5, log: (m) => logged.push(m) });

  assert.strictEqual(sync.status().state, 'pending', 'nothing uploaded yet, nothing wrong yet');
  sheet.fail = 'before';
  await sync.run();
  assert.strictEqual(sync.status().error.offline, true);
  assert.strictEqual(sync.status().state, 'offline');
  assert.ok(sync.status().pending > 0);

  await until(() => sync.status().error === null && !sync.status().running);
  sync.stop();
  assert.deepStrictEqual(sheet.column('January 2027 Logs', 'A'), ids);
  assert.strictEqual(sync.status().pending, 0);
  assert.strictEqual(sync.status().lastSyncedAt, at(2027, 1, 4, 10));
  assert.strictEqual(sync.status().state, 'synced');
  assert.strictEqual(sync.status().uploaded, store.countEventsAfter(0), 'every tap is accounted for');
  assert.ok(logged.some((m) => m.includes('sheet sync failed')));
  assert.ok(logged.some((m) => m.includes('working again')));
});

test('being refused is told apart from being offline', async () => {
  const sheet = fakeSheet();
  const sync = syncer(sheet, at(2027, 2, 1, 10), { retryMs: 60000 });
  sheet.fail = 'refused';
  await sync.run();
  sync.stop();
  assert.strictEqual(sync.status().error.offline, false);
  assert.strictEqual(sync.status().state, 'error');
  assert.match(sync.status().error.message, /403/);
});

test('nothing is sent until the clock is set', async () => {
  const sheet = fakeSheet();
  let clockSet = false;
  const sync = syncer(sheet, at(2027, 3, 1, 10), { ready: () => clockSet });
  await sync.run();
  assert.strictEqual(sheet.tabs.size, 0);
  clockSet = true;
  await sync.run();
  assert.ok(sheet.tabs.has('Totals'));
});

test('a tap that arrives during an upload goes up straight after it', async () => {
  const kim = person('Kim 27');
  const sheet = fakeSheet();
  const sync = syncer(sheet, at(2027, 4, 5, 10), { debounceMs: 0 });
  const first = tapAt(kim, 'in', at(2027, 4, 5, 9));
  const running = sync.run();
  const second = tapAt(kim, 'out', at(2027, 4, 5, 9, 30));
  sync.run(); // asked again while the first is still in flight
  await running;
  await until(() => sync.status().pending === 0 && !sync.status().running);
  sync.stop();
  assert.deepStrictEqual(sheet.column('April 2027 Logs', 'A'), [first, second]);
});

// ---- Review fixes --------------------------------------------------------

// After a restore the sheet holds taps the database no longer has. The
// restore clears the mark (see backup.test.js); the next sync must then leave
// nothing behind that isn't in the database.
test('starting from the top removes rows the database no longer has', async () => {
  const lea = person('Lea 27');
  const id = tapAt(lea, 'in', at(2027, 5, 3, 9));
  const sheet = fakeSheet();
  const sync = syncer(sheet, at(2027, 5, 3, 10));
  await sync.syncOnce();

  // What a later, now-lost stretch of the database had put in the sheet.
  sheet.tabs.get('May 2027 Logs').set('A3', 999).set('D3', 'Ghost');
  sheet.tabs.set('June 2027 Logs', new Map([['A1', 'Tap #'], ['A2', 1000], ['D2', 'Ghost']]));
  sheet.tabs.set('June 2027', new Map([['A1', 'Name'], ['A2', 'Ghost'], ['C2', 5]]));
  sheet.tabs.set('Notes', new Map([['A2', 'someone\'s own tab']]));

  store.setMeta('sync_spreadsheet', ''); // what restoreBackup leaves
  await syncer(sheet, at(2027, 5, 3, 11)).syncOnce();

  assert.deepStrictEqual(sheet.column('May 2027 Logs', 'A'), [id]);
  assert.deepStrictEqual(sheet.column('June 2027 Logs', 'A'), []);
  assert.deepStrictEqual(sheet.column('June 2027', 'A'), []);
  assert.strictEqual(sheet.cell('Notes', 'A2'), 'someone\'s own tab', 'only the sync\'s own tabs are emptied');
  assert.strictEqual(sync.status().pending, 0);
});

test('a failed start from the top is finished by the retry', async () => {
  const sheet = fakeSheet();
  const sync = syncer(sheet, at(2027, 5, 4, 10));
  await sync.syncOnce();
  sheet.tabs.get('May 2027 Logs').set('A9', 999);
  store.setMeta('sync_spreadsheet', '');

  sheet.fail = 'before';
  await assert.rejects(sync.syncOnce());
  await sync.syncOnce();
  assert.ok(!sheet.column('May 2027 Logs', 'A').includes(999));
});

// A check-in left open at shutdown is "still in" until the next boot, when it
// becomes abandoned. No new tap happens in that month, so the old month has
// to be rewritten anyway.
test('last month\'s open check-in stops showing as still in after the next boot', async () => {
  const mo = person('Mo 27');
  tapAt(mo, 'in', at(2027, 6, 30, 17), 'boot-june');
  const sheet = fakeSheet();
  await syncer(sheet, at(2027, 6, 30, 18), { bootId: 'boot-june' }).syncOnce();
  const row = () => sheet.column('June 2027', 'A').indexOf('Mo 27') + 2;
  assert.strictEqual(sheet.cell('June 2027', 'E' + row()), 'yes', 'still in, that evening');

  // Next morning is a new month and a new boot. Nobody has tapped yet.
  await syncer(sheet, at(2027, 7, 1, 8), { bootId: 'boot-july' }).syncOnce();
  assert.strictEqual(sheet.cell('June 2027', 'E' + row()), undefined, 'no longer still in');
  assert.strictEqual(sheet.cell('June 2027', 'F' + row()), 'yes', 'not counted');
});

test('a roster change reaches earlier months too', async () => {
  const ned = person('Ned 27');
  tapAt(ned, 'in', at(2027, 8, 2, 9));
  tapAt(ned, 'out', at(2027, 8, 2, 10));
  const sheet = fakeSheet();
  const sync = syncer(sheet, at(2027, 9, 1, 9), { debounceMs: 0 });
  await sync.run();
  const row = sheet.column('August 2027', 'A').indexOf('Ned 27') + 2;
  assert.strictEqual(sheet.cell('August 2027', 'G' + row), undefined);

  store.setUserActive(ned.id, false);
  sync.kick(true);
  await until(() => sheet.cell('August 2027', 'G' + row) === 'yes');
  sync.stop();
});

// A backup from before someone was registered has a shorter roster. The
// rewritten Totals table only reaches as far as the restored roster, so
// whoever was below that must be cleared, not left with their hours.
test('starting from the top removes people the database no longer has from Totals', async () => {
  const sheet = fakeSheet();
  await syncer(sheet, at(2027, 10, 1, 9)).syncOnce();
  const totals = sheet.tabs.get('Totals');
  const below = sheet.column('Totals', 'A').length + 2; // first row past the table
  totals.set('A' + below, 'Obsolete Person').set('C' + below, 12).set('D' + below, 3);

  store.setMeta('sync_spreadsheet', ''); // what restoreBackup leaves
  await syncer(sheet, at(2027, 10, 1, 10)).syncOnce();

  assert.ok(!sheet.column('Totals', 'A').includes('Obsolete Person'));
  assert.strictEqual(sheet.cell('Totals', 'C' + below), undefined, 'their hours went with them');
  assert.strictEqual(sheet.cell('Totals', 'A1'), 'Last synced');
  assert.strictEqual(sheet.cell('Totals', 'A3'), 'Name');
  assert.strictEqual(sheet.column('Totals', 'A').length, 2 + store.listUsers().length, 'the table is whole again');
});
