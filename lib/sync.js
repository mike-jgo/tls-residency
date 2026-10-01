'use strict';

/*
 * One-way sync to a Google spreadsheet: the database is the record, the sheet
 * is a copy people can read without the Pi being on. Nothing is ever read
 * back from the sheet.
 *
 * What gets published:
 *
 *   - Two tabs per calendar month: "October 2026" holds that month's hours
 *     per person, "October 2026 Logs" holds that month's taps, one per row.
 *   - A "Totals" tab: when the sheet was last synced, and all-time hours.
 *
 * ---- Why a retry can never duplicate a tap ----------------------------
 *
 * Taps are never appended. Each one has a fixed place: the Logs tab for the
 * month it happened in, on the row given by how many taps came before it that
 * month. Taps are never deleted and ids only grow, so that row never changes.
 * Uploading a tap means writing those exact cells — and writing them twice
 * leaves the sheet as it was. So when an upload times out and we can't tell
 * whether Google applied it, we simply send it again.
 *
 * ---- Why pending uploads survive a restart ----------------------------
 *
 * The database remembers the id of the last tap known to be in the sheet.
 * Everything after it is pending — there is no separate queue to lose. That
 * mark only moves after Google confirms a write, so a crash or a shutdown
 * mid-upload just means those taps are sent again next time.
 *
 * The hours tables are rewritten whole on each sync, and a sync always runs
 * at startup, so they need no bookkeeping of their own.
 */

const dates = require('./dates');
const { buildReport } = require('./report');
const { MAX_SESSION_MS } = require('./hours');

const TOTALS_TAB = 'Totals';
const HOURS_HEADER = ['Name', 'Student ID', 'Hours', 'Sessions', 'Still in', 'Not counted', 'Deactivated'];
const TAPS_HEADER = ['Tap #', 'Date', 'Time', 'Name', 'Student ID', 'Direction'];

// Taps uploaded per request. Only the first sync of an old database, or a
// long stretch offline, ever has more than a handful waiting.
const BATCH = 2000;

// Where things go in the spreadsheet. Stored with the spreadsheet's ID; when
// either changes, the sheet in front of us doesn't hold our taps where we
// would now put them, so the whole history is uploaded again.
const LAYOUT = 3;

const logsTitle = (title) => `${title} Logs`;

const tab = (title) => `'${title.replace(/'/g, "''")}'`;

const hoursRow = (r) => [
  r.name, r.student_id || '', r.hours, r.sessions,
  r.open ? 'yes' : '', r.invalid ? 'yes' : '', r.active ? '' : 'yes',
];

// The table can get shorter (someone with no hours is deactivated), and a
// write only touches the cells it names — so always write the same number of
// rows, blank past the end, or old rows would be left behind.
function padded(rows, length) {
  const out = rows.slice();
  while (out.length < length) out.push(HOURS_HEADER.map(() => ''));
  return out;
}

function createSync({
  store, client, bootId, now = Date.now, ready = () => true,
  debounceMs = 2000, retryMs = 60000, log = () => {}, onChange = () => {},
}) {
  let running = false;
  let again = false;
  let timer = null;
  let lastError = null; // { message, offline, at }

  const watermark = () => Number(store.getMeta('sync_event_id') || 0);

  function monthHours(y, m, height) {
    const { startISO, endISO } = dates.monthBounds(y, m);
    const { report } = buildReport(store, bootId, startISO, endISO);
    // Everyone whose card works, so a month with no hours shows as zero, plus
    // anyone since deactivated who tapped that month.
    return padded(report.filter((r) => r.active || r.any).map(hoursRow), height);
  }

  async function uploadBatch() {
    const pending = store.getEventsAfter(watermark(), BATCH);
    const at = new Date(now()).toISOString();
    const data = [];

    // Tabs whose hours table is rewritten this time: title -> { y, m }.
    const months = new Map();
    const logTabs = [];
    const touch = (y, m) => months.set(dates.monthTitle(y, m), { y, m });
    const current = dates.monthOf(at);
    touch(current.y, current.m);

    const byMonth = new Map();
    for (const e of pending) {
      const { y, m } = dates.monthOf(e.ts);
      const title = dates.monthTitle(y, m);
      if (!byMonth.has(title)) byMonth.set(title, { y, m, events: [] });
      byMonth.get(title).events.push(e);
    }

    for (const [title, { y, m, events }] of byMonth) {
      touch(y, m);
      const { startISO, endISO } = dates.monthBounds(y, m);
      // A session belongs to the month it was checked in. A check-out in the
      // first hours of a month may close one from the month before.
      if (events.some((e) => e.type === 'out' && Date.parse(e.ts) - Date.parse(startISO) <= MAX_SESSION_MS)) {
        const before = dates.monthOf(new Date(Date.parse(startISO) - 1).toISOString());
        touch(before.y, before.m);
      }
      // Row 1 is the header. Pending taps are every tap after the mark, so
      // within a month they sit on consecutive rows.
      const first = 2 + store.countEventsBefore(startISO, endISO, events[0].id);
      logTabs.push(logsTitle(title));
      data.push({ range: `${tab(logsTitle(title))}!A1:F1`, values: [TAPS_HEADER] });
      data.push({
        range: `${tab(logsTitle(title))}!A${first}:F${first + events.length - 1}`,
        values: events.map((e) => {
          const [date, time] = dates.localStamp(e.ts).split(' ');
          return [e.id, date, time, e.name, e.student_id || '', e.type.toUpperCase()];
        }),
      });
    }

    const height = Math.max(store.listUsers().length, 1);
    for (const [title, { y, m }] of months) {
      data.push({ range: `${tab(title)}!A1:G1`, values: [HOURS_HEADER] });
      data.push({ range: `${tab(title)}!A2:G${1 + height}`, values: monthHours(y, m, height) });
    }

    const totals = buildReport(store, bootId, null, null).report.map(hoursRow);
    data.push({
      range: `${tab(TOTALS_TAB)}!A1:G${3 + height}`,
      values: [
        ['Last synced', dates.localStamp(at), '', '', '', '', ''],
        ['All-time hours', '', '', '', '', '', ''],
        HOURS_HEADER,
        ...padded(totals, height),
      ],
    });

    const have = new Set(await client.listTabs());
    const missing = [...months.keys(), ...logTabs, TOTALS_TAB].filter((title) => !have.has(title));
    if (missing.length) await client.addTabs(missing);
    await client.writeRanges(data);

    // Only now are they known to be in the sheet.
    if (pending.length) store.setMeta('sync_event_id', String(pending[pending.length - 1].id));
    store.setMeta('sync_last_at', at);
    return pending.length === BATCH;
  }

  // Bring the sheet up to date. Rejects if Google can't be reached or
  // refuses; whatever wasn't confirmed stays pending.
  async function syncOnce() {
    // A different spreadsheet has none of our taps in it: start it from the top.
    const target = `${LAYOUT}:${client.spreadsheetId}`;
    if (store.getMeta('sync_spreadsheet') !== target) {
      store.setMeta('sync_event_id', '0');
      store.setMeta('sync_spreadsheet', target);
    }
    while (await uploadBatch()) { /* more waiting */ }
  }

  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(run, ms);
    if (timer.unref) timer.unref();
  }

  // One sync at a time. Before the clock is set nothing is sent: the "last
  // synced" time would be wrong, and Google rejects a login signed with the
  // wrong time anyway. The server kicks again when the clock is ready.
  async function run() {
    clearTimeout(timer);
    if (!ready()) return;
    if (running) { again = true; return; }
    running = true;
    try {
      await syncOnce();
      if (lastError) log('sheet sync: working again');
      lastError = null;
    } catch (e) {
      const offline = Boolean(e.offline);
      // Said once, not every retry: a day without wifi shouldn't fill the log.
      if (!lastError || lastError.message !== e.message) log(`sheet sync failed: ${e.message}`);
      lastError = { message: e.message, offline, at: new Date(now()).toISOString() };
      schedule(retryMs);
    } finally {
      running = false;
    }
    onChange();
    if (again) { again = false; schedule(0); }
  }

  return {
    syncOnce,
    run,
    // Something changed (a tap, the roster): sync shortly. The short wait lets
    // a rush of taps at the door go up together.
    kick: () => schedule(debounceMs),
    stop: () => clearTimeout(timer),
    status: () => ({
      pending: store.countEventsAfter(watermark()),
      lastSyncedAt: store.getMeta('sync_last_at') || null,
      error: lastError,
      running,
    }),
  };
}

module.exports = { createSync, TOTALS_TAB };
