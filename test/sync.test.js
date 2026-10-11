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
        const [, title] = /^'(.+)'!A2:H$/.exec(range);
        const cells = tabs.get(title);
        for (const k of [...cells.keys()]) if (Number(k.slice(1)) >= 2) cells.delete(k);
      }
    },
    tabs,
    shaped: [],
    async shapeTab(title, shape) { sheet.shaped.push({ title, ...shape }); },
    // Like Google: no empty rows at the bottom, no empty cells at the end of a row.
    async readRange(range) {
      const [, title, c1, r1, c2, r2] = /^'(.+)'!([A-Z])(\d+):([A-Z])(\d*)$/.exec(range);
      const cells = tabs.get(title);
      const last = Number(r2) || Math.max(0, ...[...cells.keys()].map((k) => Number(k.slice(1))));
      const rows = [];
      for (let r = Number(r1); r <= last; r++) {
        const row = [];
        for (let c = c1.charCodeAt(0); c <= c2.charCodeAt(0); c++) row.push(cells.get(String.fromCharCode(c) + r) ?? '');
        while (row.length && row[row.length - 1] === '') row.pop();
        rows.push(row);
      }
      while (rows.length && !rows[rows.length - 1].length) rows.pop();
      return rows;
    },
    deleted: [], // every deleteColumns call
    async deleteColumns(title, [first, past]) {
      sheet.deleted.push([title, first, past]);
      const moved = new Map();
      for (const [k, v] of tabs.get(title)) {
        const c = k.charCodeAt(0) - 65;
        if (c < first) moved.set(k, v);
        else if (c >= past) moved.set(String.fromCharCode(65 + c - (past - first)) + k.slice(1), v);
      }
      tabs.set(title, moved);
    },
    async readRanges(ranges) { return Promise.all(ranges.map((range) => sheet.readRange(range))); },
    async listTabs() { return [...tabs.keys()]; },
    // Like Google, a tab made again is a different tab: it gets a new id.
    made: new Map(),
    async addTabs(titles) {
      for (const t of titles) {
        tabs.set(t, new Map());
        sheet.made.set(t, (sheet.made.get(t) || 0) + 1);
      }
    },
    idOf: (title) => (sheet.made.get(title) > 1 ? `${title}#${sheet.made.get(title)}` : title),
    views: new Map(), // title -> the filter views it has, by title
    frozen: new Map(),
    async describeTabs() {
      return [...tabs.keys()].map((title) => ({ title, sheetId: sheet.idOf(title), views: (sheet.views.get(title) || []).map((v) => v.title) }));
    },
    async dressTabs(list) {
      for (const { sheetId: id, frozen, views } of list) {
        const sheetId = id.replace(/#\d+$/, '');
        sheet.frozen.set(sheetId, frozen);
        sheet.views.set(sheetId, [...(sheet.views.get(sheetId) || []), ...views]);
      }
    },
    styled: [], // every tab formatTabs was given, by title
    async formatTabs(list) { for (const t of list) sheet.styled.push(t.title); },
    fitted: [], // every fitColumns call
    async fitColumns(sheetIds) { sheet.fitted.push(sheetIds); },
    formulas: [], // every writeFormulas call
    async writeFormulas(data) {
      sheet.formulas.push(data);
      for (const { range, values } of data) {
        const [, title, cell] = /^'(.+)'!([A-Z]\d+):/.exec(range);
        values[0].forEach((v, j) => tabs.get(title).set(String.fromCharCode(cell.charCodeAt(0) + j) + cell.slice(1), v));
      }
    },
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
  store.createUser({ name, student_id: 'S' + cards }, rfid);
  return store.getUserByRfid(rfid);
}
// Manila is UTC+8: 09:00 there is 01:00Z.
const at = (y, m, d, h = 9, min = 0) => new Date(Date.UTC(y, m - 1, d, h - 8, min)).toISOString();
const tapAt = (user, type, iso, boot = BOOT) => Number(store.insertEvent(user.id, type, iso, boot).lastInsertRowid);

// What restoreBackup leaves (backup.test.js): the database is owed to the
// sheet whole, people included.
function restored() {
  store.setMeta('sync_full', '1');
  store.setMeta('sync_seed', '1');
  store.setMeta('sync_event_id', '0');
}

// A new process. Most tests begin with the taps on this device and a
// spreadsheet with nothing in it — which is what a restored backup is, the one
// time the database is uploaded instead of giving way to the sheet. From then
// on, each new process takes the sheet's taps over its own, as a real one does.
function syncer(sheet, nowISO, extra = {}) {
  if (!sheet.begun) {
    sheet.begun = true;
    restored();
  }
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

test('a restored backup is uploaded whole, to whichever spreadsheet is set', async () => {
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
// restore marks the database as owed to the sheet (see backup.test.js); the
// next sync must then leave nothing behind that isn't in the database.
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

  restored();
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
  restored();

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
  assert.strictEqual(sheet.cell('June 2027', 'F' + row()), 1, 'one session not counted');
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

  restored();
  await syncer(sheet, at(2027, 10, 1, 10)).syncOnce();

  assert.ok(!sheet.column('Totals', 'A').includes('Obsolete Person'));
  assert.strictEqual(sheet.cell('Totals', 'C' + below), undefined, 'their hours went with them');
  assert.strictEqual(sheet.cell('Totals', 'A1'), 'Last synced');
  assert.strictEqual(sheet.cell('Totals', 'A3'), 'Name');
  assert.strictEqual(sheet.column('Totals', 'A').length, 2 + store.listUsers().length, 'the table is whole again');
});

// ---- The Staffers tab: the record of who the staffers are (lib/roster.js) --

const details = (name, id, changes = {}) => ({
  name, student_id: id, section: 'A&G', status: 'Probie', telegram: '@' + id.replace('-', '_'), ...changes,
});
const { rowOf } = require('../lib/roster');
const staffRow = (sheet, id) => sheet.column('Staffers', 'B').indexOf(id) + 2;
const staffCells = (sheet, id) => 'ABCDEFG'.split('').map((c) => sheet.cell('Staffers', c + staffRow(sheet, id)));
const setCells = (sheet, row, cells) => cells.forEach((v, i) => {
  if (v === '') sheet.tabs.get('Staffers').delete('ABCDEFG'[i] + row); else sheet.tabs.get('Staffers').set('ABCDEFG'[i] + row, v);
});

test('the people in a restored backup are put in the Staffers tab, once', async () => {
  const uma = person('Uma Dir');
  store.updateUser(uma.id, details('Uma Dir', 'D-uma'));
  const sheet = fakeSheet();
  const sync = syncer(sheet, at(2028, 1, 3, 9));
  await sync.syncOnce();

  assert.strictEqual(sheet.cell('Staffers', 'G1'), 'Card number');
  assert.deepStrictEqual(staffCells(sheet, 'D-uma'), ['Uma Dir', 'D-uma', 'A&G', 'Probie', '@D_uma', undefined, uma.rfid]);
  assert.deepStrictEqual(sheet.shaped.map((t) => [t.title, t.columns, Object.keys(t.dropdowns)]), [['Staffers', 7, ['C', 'D']]]);

  await sync.syncOnce();
  assert.strictEqual(sheet.column('Staffers', 'B').filter((id) => id === 'D-uma').length, 1);
  assert.strictEqual(sheet.shaped.length, 1);
});

test('an edit made in the sheet is taken up here, and reaches the hours tables', async () => {
  const vic = person('Vic Dir');
  store.updateUser(vic.id, details('Vic Dir', 'D-vic'));
  tapAt(vic, 'in', at(2028, 2, 1, 9));
  tapAt(vic, 'out', at(2028, 2, 1, 11));
  const sheet = fakeSheet();
  const sync = syncer(sheet, at(2028, 2, 1, 12));
  await sync.syncOnce();

  const staffers = sheet.tabs.get('Staffers');
  const row = staffRow(sheet, 'D-vic');
  staffers.set('A' + row, 'Victor Dir').set('D' + row, 'Regular').set('E' + row, 'victor').set('F' + row, 'Yes');
  await sync.syncOnce();

  const now = store.getUser(vic.id);
  assert.strictEqual(now.name, 'Victor Dir');
  assert.strictEqual(now.status, 'Regular');
  assert.strictEqual(now.telegram, '@victor', 'the @ is added to what was typed in the sheet');
  assert.strictEqual(now.active, 0, 'deactivated from the sheet');
  assert.strictEqual(now.rfid, vic.rfid);
  assert.strictEqual(sheet.hours('February 2028')['Victor Dir'], 2);
  assert.strictEqual(sheet.hours('February 2028')['Vic Dir'], undefined);
  // And the rows of their taps, which another device would read them from.
  assert.deepStrictEqual(sheet.column('February 2028 Logs', 'D'), ['Victor Dir', 'Victor Dir']);
});

test('a row deleted from the sheet deactivates the person and keeps their taps', async () => {
  const wes = person('Wes Dir');
  store.updateUser(wes.id, details('Wes Dir', 'D-wes'));
  tapAt(wes, 'in', at(2028, 3, 1, 9));
  tapAt(wes, 'out', at(2028, 3, 1, 10));
  const sheet = fakeSheet();
  const sync = syncer(sheet, at(2028, 3, 1, 12));
  await sync.syncOnce();

  setCells(sheet, staffRow(sheet, 'D-wes'), ['', '', '', '', '', '', '']);
  await sync.syncOnce();
  assert.strictEqual(store.getUser(wes.id).active, 0);
  assert.strictEqual(store.getEventsForUser(wes.id).length, 2);
  assert.ok(!sheet.column('Staffers', 'B').includes('D-wes'), 'the row is not put back');
  assert.strictEqual(sheet.hours('Totals')['Wes Dir'], 1);
});

test('a bad row in the sheet is skipped with a warning and changes nothing here', async () => {
  const xia = person('Xia Dir');
  store.updateUser(xia.id, details('Xia Dir', 'D-xia'));
  const sheet = fakeSheet();
  const sync = syncer(sheet, at(2028, 4, 1, 9));
  await sync.run();
  assert.ok(!sync.status().roster.warnings.some((w) => w.includes('Xia Dir')));

  sheet.tabs.get('Staffers').set('C' + staffRow(sheet, 'D-xia'), 'Gossip');
  await sync.run();
  sync.stop();
  assert.strictEqual(store.getUser(xia.id).section, 'A&G');
  assert.strictEqual(store.getUser(xia.id).active, 1);
  assert.ok(sync.status().roster.warnings.some((w) => /Xia Dir.*section/.test(w)));
});

test('a row with a card for someone not here creates them, card and all', async () => {
  const sheet = fakeSheet();
  const sync = syncer(sheet, at(2028, 5, 1, 9));
  await sync.syncOnce();
  setCells(sheet, sheet.column('Staffers', 'B').length + 2, ['Yan Dir', 'D-yan', 'Web', 'Newbie', 'yan_d', '', '880001']);
  await sync.syncOnce();

  const yan = store.getUserByRfid('880001');
  assert.deepStrictEqual(
    [yan.name, yan.student_id, yan.section, yan.status, yan.telegram, yan.active],
    ['Yan Dir', 'D-yan', 'Web', 'Newbie', '@yan_d', 1],
  );
});

// ---- Saving from the People page: the sheet first, then here ------------

test('a save reaches the sheet before it is kept here', async () => {
  const sheet = fakeSheet();
  const sync = syncer(sheet, at(2028, 6, 1, 9));
  await sync.syncOnce();
  const zoe = { ...details('Zoe Dir', 'D-zoe'), active: 1, rfid: '880002' };

  let applied = 0;
  await sync.saveStaffer(rowOf(zoe), null, () => { applied++; store.createUser(details('Zoe Dir', 'D-zoe'), '880002'); });
  assert.strictEqual(applied, 1);
  assert.strictEqual(staffCells(sheet, 'D-zoe')[6], '880002');

  // An edit, then a deactivation, land on the same row.
  const saved = store.getUserByRfid('880002');
  const edited = { ...zoe, status: 'Regular', active: 0 };
  await sync.saveStaffer(rowOf(edited), saved, () => {});
  assert.deepStrictEqual(staffCells(sheet, 'D-zoe').slice(3, 7), ['Regular', '@D_zoe', 'yes', '880002']);
  assert.strictEqual(sheet.column('Staffers', 'B').filter((id) => id === 'D-zoe').length, 1);
});

test('with no internet a save changes nothing, here or in the sheet', async () => {
  const sheet = fakeSheet();
  const sync = syncer(sheet, at(2028, 7, 1, 9));
  await sync.syncOnce();
  const before = sheet.column('Staffers', 'B').length;

  sheet.fail = 'before';
  let applied = 0;
  await assert.rejects(
    sync.saveStaffer(rowOf({ ...details('Abe Dir', 'D-abe'), active: 1, rfid: '880003' }), null, () => { applied++; }),
    (e) => e.offline === true,
  );
  assert.strictEqual(applied, 0);
  assert.strictEqual(sheet.column('Staffers', 'B').length, before);
});

test('a save whose reply was lost is picked up from the sheet by the next sync', async () => {
  const sheet = fakeSheet();
  const sync = syncer(sheet, at(2028, 8, 1, 9));
  await sync.syncOnce();

  sheet.fail = 'after';
  await assert.rejects(sync.saveStaffer(rowOf({ ...details('Bea Dir', 'D-bea'), active: 1, rfid: '880004' }), null, () => {}));
  assert.strictEqual(store.getUserByRfid('880004'), undefined);
  await sync.syncOnce();
  assert.strictEqual(store.getUserByRfid('880004').name, 'Bea Dir');
  assert.strictEqual(sheet.column('Staffers', 'B').filter((id) => id === 'D-bea').length, 1);
});

test('a save is refused when the sheet already has that ID number or card', async () => {
  const cal = person('Cal Dir');
  store.updateUser(cal.id, details('Cal Dir', 'D-cal'));
  const sheet = fakeSheet();
  const sync = syncer(sheet, at(2028, 9, 1, 9));
  await sync.syncOnce();

  const twin = { ...details('Twin Dir', 'D-cal'), active: 1, rfid: '880005' };
  await assert.rejects(sync.saveStaffer(rowOf(twin), null, () => assert.fail('saved')), /D-cal already belongs to Cal Dir/);
  const thief = { ...details('Thief Dir', 'D-thief'), active: 1, rfid: cal.rfid };
  await assert.rejects(sync.saveStaffer(rowOf(thief), null, () => assert.fail('saved')), /card number already belongs to Cal Dir/);
});

test('a save from a device that is behind the sheet is refused, and the device catches up', async () => {
  const eli = person('Eli Dir');
  store.updateUser(eli.id, details('Eli Dir', 'D-eli'));
  const sheet = fakeSheet();
  const sync = syncer(sheet, at(2028, 10, 1, 9));
  await sync.syncOnce();

  // Someone changes their status in the sheet — by hand, or from another device.
  const row = staffRow(sheet, 'D-eli');
  sheet.tabs.get('Staffers').set('D' + row, 'Regular');
  const before = sheet.writes.length;

  // Deactivating them here, before this device has read that, would write the
  // whole row from this device's copy — Probie and all.
  const own = store.getUser(eli.id);
  await assert.rejects(
    sync.saveStaffer(rowOf({ ...own, active: 0 }), own, () => assert.fail('saved')),
    (e) => e.offline === false && /Eli Dir \(row \d+\) are not the ones this device has/.test(e.message),
  );
  assert.strictEqual(sheet.writes.length, before, 'nothing was written');
  assert.strictEqual(sheet.cell('Staffers', 'D' + row), 'Regular');

  // Caught up, the same change goes through on top of the sheet's.
  await sync.run();
  const now = store.getUser(eli.id);
  assert.strictEqual(now.status, 'Regular');
  await sync.saveStaffer(rowOf({ ...now, active: 0 }), now, () => store.setUserActive(eli.id, false));
  assert.deepStrictEqual(staffCells(sheet, 'D-eli').slice(3, 6), ['Regular', '@D_eli', 'yes']);
  sync.stop();
});

test('the Staffers tab is never emptied, and its word is taken when a device comes back to it', async () => {
  const dee = person('Dee Dir');
  store.updateUser(dee.id, details('Dee Dir', 'D-dee'));
  const one = fakeSheet();
  await syncer(one, at(2028, 10, 2, 9)).syncOnce();
  const two = fakeSheet();
  await syncer(two, at(2028, 10, 2, 10)).syncOnce();
  assert.strictEqual(staffCells(two, 'D-dee')[0], 'Dee Dir');
  assert.strictEqual(store.getUser(dee.id).active, 1);

  // Back on the first, which was edited meanwhile: its word is taken.
  one.tabs.get('Staffers').set('D' + staffRow(one, 'D-dee'), 'Regular');
  await syncer(one, at(2028, 10, 2, 11)).syncOnce();
  assert.ok(![...one.clears, ...two.clears].some((range) => range.includes('Staffers')));
  assert.strictEqual(store.getUser(dee.id).status, 'Regular');
});

test('a sheet that still has Year and Course columns loses them, and nobody with them', async () => {
  const fox = person('Fox Dir');
  store.updateUser(fox.id, details('Fox Dir', 'D-fox'));
  const sheet = fakeSheet();
  await sheet.addTabs(['Staffers', 'Search']);
  const put = (title, at, cells) => cells.forEach((v, i) => {
    if (v !== '') sheet.tabs.get(title).set(String.fromCharCode(at.charCodeAt(0) + i) + at.slice(1), v);
  });
  put('Staffers', 'A1', ['Name', 'ID number', 'Section', 'Status', 'Telegram', 'Year', 'Course', 'Deactivated', 'Card number']);
  put('Staffers', 'A2', ['Fox Dir', 'D-fox', 'A&G', 'Regular', '@D_fox', '2', 'AB CAM', '', fox.rfid]);
  put('Search', 'N4', ['Telegram', 'Year', 'Course', 'Deactivated']);
  const sync = syncer(sheet, at(2029, 8, 1, 9));
  await sync.syncOnce();

  assert.deepStrictEqual(sheet.deleted, [['Staffers', 5, 7], ['Search', 14, 16]]);
  assert.deepStrictEqual(staffCells(sheet, 'D-fox'), ['Fox Dir', 'D-fox', 'A&G', 'Regular', '@D_fox', undefined, fox.rfid]);
  assert.strictEqual(sheet.cell('Staffers', 'G1'), 'Card number');
  const now = store.getUser(fox.id);
  assert.deepStrictEqual([now.status, now.active, now.rfid], ['Regular', 1, fox.rfid]);

  await sync.syncOnce();
  assert.strictEqual(sheet.deleted.length, 2, 'once');
});

// ---- Finding things in the sheet ----------------------------------------

test('hours and log tabs get their filter views once, and the views move no cells', async () => {
  const eve = person('Eve Find');
  tapAt(eve, 'in', at(2029, 1, 8, 9));
  tapAt(eve, 'out', at(2029, 1, 8, 12));
  const sheet = fakeSheet();
  const sync = syncer(sheet, at(2029, 1, 8, 13));
  await sync.syncOnce();

  const titles = (tab) => sheet.views.get(tab).map((v) => v.title);
  assert.deepStrictEqual(titles('January 2029'), ['Search', 'Most hours', 'Least hours']);
  assert.deepStrictEqual(titles('January 2029 Logs'), ['Search', 'Newest first']);
  assert.deepStrictEqual(titles('Totals'), ['Search', 'Most hours', 'Least hours']);
  assert.ok(!sheet.views.has('Staffers') && !sheet.views.has('Search'));

  const most = sheet.views.get('Totals').find((v) => v.title === 'Most hours');
  assert.deepStrictEqual([most.headerRow, most.columns, most.sort], [2, 7, [2, 'DESCENDING']], 'Totals\' table starts on row 3');
  assert.strictEqual(sheet.frozen.get('Totals'), 3);
  assert.strictEqual(sheet.frozen.get('January 2029'), 1);

  await sync.syncOnce();
  assert.strictEqual(sheet.views.get('January 2029').length, 3, 'not added twice');

  // A month that appears later gets its own.
  tapAt(eve, 'in', at(2029, 2, 1, 9));
  await syncer(sheet, at(2029, 2, 1, 10)).syncOnce();
  assert.deepStrictEqual(titles('February 2029'), ['Search', 'Most hours', 'Least hours']);
});

test('the Search tab is written when a month is added, and its search box is left alone', async () => {
  const fay = person('Fay Find');
  tapAt(fay, 'in', at(2029, 3, 5, 9));
  const sheet = fakeSheet();
  const sync = syncer(sheet, at(2029, 3, 5, 10));
  await sync.syncOnce();
  assert.strictEqual(sheet.formulas.length, 1);
  assert.match(sheet.cell('Search', 'A5'), /^=.*'March 2029'!A2:G/);
  assert.match(sheet.cell('Search', 'Q5'), /'March 2029 Logs'!A2:F/);

  sheet.tabs.get('Search').set('B1', 'fay');
  await sync.syncOnce();
  assert.strictEqual(sheet.formulas.length, 1, 'nothing new, nothing rewritten');

  tapAt(fay, 'out', at(2029, 4, 2, 9));
  await syncer(sheet, at(2029, 4, 2, 10)).syncOnce();
  assert.strictEqual(sheet.formulas.length, 2);
  const hours = sheet.cell('Search', 'A5');
  assert.ok(hours.indexOf("'April 2029'") < hours.indexOf("'March 2029'"), 'newest month first');
  assert.strictEqual(sheet.cell('Search', 'B1'), 'fay');
});

test('the columns of what a sync wrote are fitted to it, and only those', async () => {
  const gus = person('Gus Find');
  tapAt(gus, 'in', at(2029, 5, 7, 9));
  const sheet = fakeSheet();
  await syncer(sheet, at(2029, 5, 7, 10)).syncOnce();
  for (const title of ['May 2029', 'May 2029 Logs', 'Totals']) assert.ok(sheet.fitted[0].includes(title), title);
  assert.ok(!sheet.fitted.flat().includes('Staffers') && !sheet.fitted.flat().includes('Search'));
});

test('each tab is styled once, and a new or re-made tab gets its turn', async () => {
  const hal = person('Hal Style');
  tapAt(hal, 'in', at(2029, 6, 4, 9));
  const sheet = fakeSheet();
  await syncer(sheet, at(2029, 6, 4, 10)).syncOnce();
  for (const title of ['June 2029', 'June 2029 Logs', 'Totals', 'Staffers', 'Search']) {
    assert.strictEqual(sheet.styled.filter((t) => t === title).length, 1, title);
  }

  await syncer(sheet, at(2029, 6, 4, 11)).syncOnce();
  assert.strictEqual(sheet.styled.filter((t) => t === 'Search').length, 1, 'restyling by hand is left alone');

  tapAt(hal, 'out', at(2029, 7, 2, 9));
  sheet.tabs.delete('Search'); // someone deletes it; the Pi makes it again
  await syncer(sheet, at(2029, 7, 2, 10)).syncOnce();
  assert.strictEqual(sheet.styled.filter((t) => t === 'July 2029').length, 1);
  assert.strictEqual(sheet.styled.filter((t) => t === 'Search').length, 2);
  assert.strictEqual(sheet.styled.filter((t) => t === 'Totals').length, 1);
});

// ---- The sheet is the record: what a device has when it starts -----------

// A spreadsheet as another device left it. `sheet.begun` keeps syncer() from
// treating this device as a restored backup.
const put = (sheet, title, rows) => {
  if (!sheet.tabs.has(title)) sheet.tabs.set(title, new Map());
  rows.forEach((cells, i) => cells.forEach((v, j) => {
    if (v !== '') sheet.tabs.get(title).set('ABCDEFG'[j] + (i + 1), v);
  }));
};
const TAPS = ['Tap #', 'Date', 'Time', 'Name', 'Student ID', 'Direction'];
const STAFF = ['Name', 'ID number', 'Section', 'Status', 'Telegram', 'Deactivated', 'Card number'];
function leftBy(staffers, logs = {}) {
  const sheet = fakeSheet();
  sheet.begun = true;
  put(sheet, 'Staffers', [STAFF, ...staffers]);
  for (const [title, rows] of Object.entries(logs)) put(sheet, title, [TAPS, ...rows]);
  return sheet;
}
const PIA = ['Pia Pull', 'P-pia', 'Web', 'Regular', '@pia', '', '990001'];
const taps = () => store.listEvents().map((e) => [e.id, store.getUser(e.user_id).name, e.type, e.ts]);

test('a device switched on takes the sheet\'s people and taps over its own', async () => {
  const stray = person('Stray Local');
  tapAt(stray, 'in', at(2030, 3, 1, 9));
  const sheet = leftBy([PIA], {
    'March 2030 Logs': [[1, '2030-03-04', '09:00:00', 'Pia Pull', 'P-pia', 'IN'], [2, '2030-03-04', '12:00:00', 'Pia Pull', 'P-pia', 'OUT']],
  });
  const logged = [];
  const sync = syncer(sheet, at(2030, 3, 4, 13), { log: (m) => logged.push(m) });
  await sync.syncOnce();

  assert.deepStrictEqual(taps(), [
    [1, 'Pia Pull', 'in', at(2030, 3, 4, 9)], [2, 'Pia Pull', 'out', at(2030, 3, 4, 12)],
  ]);
  assert.strictEqual(store.getUserByRfid('990001').section, 'Web');
  assert.strictEqual(store.getUser(stray.id), undefined, 'nobody the sheet does not know is left');
  assert.deepStrictEqual(store.listUsers().map((u) => u.name), ['Pia Pull']);
  assert.ok(logged.some((m) => /now has the sheet's 2 taps/.test(m)));

  // Nothing of the sheet's was emptied or moved, and the hours follow from it.
  assert.deepStrictEqual(sheet.clears, []);
  assert.deepStrictEqual(sheet.column('March 2030 Logs', 'A'), [1, 2]);
  assert.strictEqual(sheet.hours('March 2030')['Pia Pull'], 3);
  assert.deepStrictEqual(sheet.column('Staffers', 'A'), ['Pia Pull']);
  assert.strictEqual(sync.status().pending, 0);
});

test('taps still waiting when a device starts are kept, after whatever the sheet has gained', async () => {
  const sheet = leftBy([PIA], {
    'April 2030 Logs': [[1, '2030-04-01', '09:00:00', 'Pia Pull', 'P-pia', 'IN'], [2, '2030-04-01', '12:00:00', 'Pia Pull', 'P-pia', 'OUT']],
  });
  await syncer(sheet, at(2030, 4, 1, 13)).syncOnce();
  // Tapped with no internet, then switched off. It got the next number...
  const pia = store.getUserByRfid('990001');
  assert.strictEqual(tapAt(pia, 'in', at(2030, 4, 2, 9)), 3);
  // ...which another device, switched on meanwhile, has used as well.
  put(sheet, 'April 2030 Logs', [TAPS, [], [], [3, '2030-04-03', '09:00:00', 'Pia Pull', 'P-pia', 'IN'], [4, '2030-04-03', '10:00:00', 'Pia Pull', 'P-pia', 'OUT']]);

  const sync = syncer(sheet, at(2030, 4, 4, 9));
  assert.strictEqual(sync.status().pending, 1);
  await sync.syncOnce();
  assert.deepStrictEqual(sheet.column('April 2030 Logs', 'A'), [1, 2, 3, 4, 5]);
  assert.deepStrictEqual(sheet.column('April 2030 Logs', 'B'), ['2030-04-01', '2030-04-01', '2030-04-03', '2030-04-03', '2030-04-02']);
  assert.deepStrictEqual(taps().map((t) => t[0]), [1, 2, 3, 4, 5]);
  assert.strictEqual(sync.status().pending, 0);
  assert.deepStrictEqual(sheet.clears, []);
});

test('a server restarted mid-day still knows who is in', async () => {
  const sheet = leftBy([PIA]);
  const morning = syncer(sheet, at(2030, 5, 6, 8));
  await morning.syncOnce();
  const pia = store.getUserByRfid('990001');
  tapAt(pia, 'in', '2030-05-06T01:00:00.417Z');
  await morning.syncOnce();

  await syncer(sheet, at(2030, 5, 6, 10)).syncOnce(); // same boot, new process
  assert.deepStrictEqual(store.getCurrentlyIn(BOOT).map((u) => u.name), ['Pia Pull']);
  assert.strictEqual(store.listEvents()[0].ts, '2030-05-06T01:00:00.417Z', 'its own tap, to the millisecond');

  await syncer(sheet, at(2030, 5, 7, 8), { bootId: 'boot-tomorrow' }).syncOnce();
  assert.deepStrictEqual(store.getCurrentlyIn('boot-tomorrow'), [], 'switched off overnight: nobody is');
});

test('Logs tabs edited by hand are taken as they are, then written out afresh', async () => {
  const sheet = leftBy([PIA], {
    'June 2030 Logs': [
      [1, '2030-06-03', '09:00:00', 'Pia Pull', 'P-pia', 'IN'],
      [],                                                         // a mistaken tap, deleted
      [3, '2030-06-04', '09:00:00', 'Pia Pull', 'P-pia', 'IN'],
      ['', '2030-06-03', '11:30', 'Pia Pull', 'P-pia', 'out'],    // the check-out she forgot, typed in
      [5, '2030-06-04', '10:00:00', 'Pia Pull', 'P-pia', 'OUT'],
    ],
  });
  const sync = syncer(sheet, at(2030, 6, 5, 9));
  await sync.syncOnce();

  assert.deepStrictEqual(sheet.column('June 2030 Logs', 'A'), [1, 2, 3, 4]);
  assert.deepStrictEqual(sheet.column('June 2030 Logs', 'C'), ['09:00:00', '11:30:00', '09:00:00', '10:00:00']);
  assert.deepStrictEqual(sheet.column('June 2030 Logs', 'F'), ['IN', 'OUT', 'IN', 'OUT']);
  assert.strictEqual(sheet.hours('June 2030')['Pia Pull'], 3.5);
  assert.deepStrictEqual(taps().map((t) => t[0]), [1, 2, 3, 4]);
  assert.strictEqual(sync.status().pending, 0);

  // Tidy now: the next start reads it and rewrites nothing.
  sheet.clears.length = 0;
  await syncer(sheet, at(2030, 6, 5, 10)).syncOnce();
  assert.deepStrictEqual(sheet.clears, []);
});

test('a tap in the sheet that cannot be read stops the sync and changes nothing', async () => {
  const sheet = leftBy([PIA], { 'July 2030 Logs': [[1, '2030-07-01', '09:00:00', 'Pia Pull', 'P-pia', 'IN']] });
  await syncer(sheet, at(2030, 7, 1, 10)).syncOnce();
  const before = JSON.stringify(store.listEvents());

  put(sheet, 'July 2030 Logs', [TAPS, [], [2, 'July 1', '12:00:00', 'Pia Pull', 'P-pia', 'OUT']]);
  const sync = syncer(sheet, at(2030, 7, 2, 9), { retryMs: 60000 });
  await sync.run();
  sync.stop();
  assert.strictEqual(sync.status().state, 'error');
  assert.match(sync.status().error.message, /July 2030 Logs, row 3: "July 1 12:00:00" is not a date and time/);
  assert.strictEqual(JSON.stringify(store.listEvents()), before);
  assert.strictEqual(sheet.cell('July 2030 Logs', 'B3'), 'July 1', 'nor the sheet');

  sheet.tabs.get('July 2030 Logs').set('B3', '2030-07-01');
  await sync.syncOnce();
  assert.strictEqual(store.listEvents().length, 2);
});

test('taps of someone the Staffers tab does not list are kept, under a deactivated person', async () => {
  const sheet = leftBy([PIA], {
    'August 2030 Logs': [[1, '2030-08-01', '09:00:00', 'Gone Staffer', 'P-gone', 'IN'], [2, '2030-08-01', '11:00:00', 'Gone Staffer', 'P-gone', 'OUT']],
  });
  await syncer(sheet, at(2030, 8, 1, 12)).syncOnce();
  const gone = store.listUsers().find((u) => u.student_id === 'P-gone');
  assert.deepStrictEqual([gone.name, gone.active], ['Gone Staffer', 0]);
  assert.strictEqual(sheet.hours('Totals')['Gone Staffer'], 2);
  assert.ok(!sheet.column('Staffers', 'B').includes('P-gone'), 'and not put in the Staffers tab');

  await syncer(sheet, at(2030, 8, 2, 9)).syncOnce();
  assert.strictEqual(store.listUsers().filter((u) => u.student_id === 'P-gone').length, 1, 'the same person each start');
});

test('an ID number corrected in the Staffers tab while switched off keeps the taps with their person', async () => {
  const sheet = leftBy([PIA], { 'September 2030 Logs': [[1, '2030-09-02', '09:00:00', 'Pia Pull', 'P-pia', 'IN']] });
  await syncer(sheet, at(2030, 9, 2, 10)).syncOnce();
  const pia = store.getUserByRfid('990001');

  sheet.tabs.get('Staffers').set('A2', 'Pia Pulled').set('B2', 'P-pia-2');
  await syncer(sheet, at(2030, 9, 3, 9)).syncOnce();
  assert.deepStrictEqual(store.listUsers().map((u) => [u.id, u.name, u.student_id]), [[pia.id, 'Pia Pulled', 'P-pia-2']]);
  assert.strictEqual(store.getEventsForUser(pia.id).length, 1);
  assert.deepStrictEqual(sheet.column('September 2030 Logs', 'E'), ['P-pia-2'], 'the tap\'s row follows');
});

test('a spreadsheet with nothing in it leaves a device with nothing', async () => {
  const eve = person('Eve Empty');
  tapAt(eve, 'in', at(2030, 10, 1, 9));
  const sheet = fakeSheet();
  sheet.begun = true;
  const sync = syncer(sheet, at(2030, 10, 1, 10));
  await sync.syncOnce();
  assert.deepStrictEqual(store.listEvents(), []);
  assert.deepStrictEqual(store.listUsers(), []);
  assert.deepStrictEqual(sheet.column('Staffers', 'A'), []);
  assert.deepStrictEqual([sync.status().pending, sync.status().state], [0, 'synced']);
});

test('a tap made before a new spreadsheet could be reached is still owed to it', async () => {
  store.createUser(details('Pia Pull', 'P-pia'), '990001');
  const pia = store.getUserByRfid('990001');
  tapAt(pia, 'in', at(2030, 11, 1, 9)); // from whatever this device synced with before
  const sheet = leftBy([PIA]);
  const sync = syncer(sheet, at(2030, 11, 4, 9));

  const reach = sheet.readRange;
  sheet.readRange = async () => { throw Object.assign(new Error('Could not reach Google (ENOTFOUND).'), { offline: true }); };
  await assert.rejects(sync.syncOnce());
  const waiting = tapAt(pia, 'in', at(2030, 11, 4, 9));
  assert.strictEqual(sync.status().pending, 1);

  sheet.readRange = reach;
  await sync.syncOnce();
  assert.deepStrictEqual(taps(), [[waiting, 'Pia Pull', 'in', at(2030, 11, 4, 9)]]);
  assert.deepStrictEqual(sheet.column('November 2030 Logs', 'A'), [waiting]);
  assert.strictEqual(sync.status().pending, 0);
});

// Deleted by hand while the device was off. The startup sync makes it again
// before it reads it, and that must not pass for the tab that was styled.
test('a Staffers tab deleted and made again is styled and given its dropdowns again', async () => {
  const sheet = leftBy([PIA]);
  await syncer(sheet, at(2031, 1, 6, 9)).syncOnce();
  const count = () => [sheet.styled.filter((t) => t === 'Staffers').length, sheet.shaped.length];
  assert.deepStrictEqual(count(), [1, 1]);

  sheet.made.set('Staffers', 1); // the one being deleted was the first
  sheet.tabs.delete('Staffers');
  await syncer(sheet, at(2031, 1, 7, 9)).syncOnce();
  assert.deepStrictEqual(count(), [2, 2]);
  assert.strictEqual(sheet.cell('Staffers', 'G1'), 'Card number');

  await syncer(sheet, at(2031, 1, 8, 9)).syncOnce();
  assert.deepStrictEqual(count(), [2, 2], 'once');
});
