'use strict';

/*
 * Sync to a Google spreadsheet. For taps and hours it is one-way: the database
 * is the record, the sheet is a copy people can read without the Pi being on.
 * The Staffers tab is the exception — for who the staffers are the sheet is
 * the record, and this device's people are the copy. See lib/roster.js.
 *
 * What gets published:
 *
 *   - Two tabs per calendar month: "October 2026" holds that month's hours
 *     per person, "October 2026 Logs" holds that month's taps, one per row.
 *   - A "Totals" tab: when the sheet was last synced, and all-time hours.
 *   - A "Staffers" tab: the directory — everyone's section, status and so on.
 *     Read back on every sync; never rewritten whole.
 *   - A "Search" tab of formulas: one person's hours, details and taps.
 *
 * The hours and log tabs also get filter views (Data > Filter views) to sort
 * by hours or pick out a person without moving any cell.
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
 * The hours tables are rewritten whole, and need no bookkeeping: the months
 * a tap touches are rewritten with it, and every month is rewritten at
 * startup and when the roster changes — the two things that alter an old
 * month without a new tap in it (yesterday's open check-in becomes abandoned
 * at boot; a deactivation changes a person's row everywhere).
 *
 * ---- Starting from the top --------------------------------------------
 *
 * A new spreadsheet, or a database restored from a backup, means the sheet
 * and the mark no longer describe each other. Then the sync's own tabs are
 * emptied and the whole history uploaded again, so nothing the database no
 * longer holds is left behind in the sheet.
 */

const dates = require('./dates');
const { buildReport } = require('./report');
const { MAX_SESSION_MS } = require('./hours');
const roster = require('./roster');
const search = require('./search');
const style = require('./style');
const { SECTIONS, STATUSES } = require('./people');

const TOTALS_TAB = 'Totals';
const STAFFERS_TAB = roster.TAB;
const HOURS_HEADER = ['Name', 'Student ID', 'Hours', 'Sessions', 'Still in', 'Uncounted sessions', 'Deactivated'];
const TAPS_HEADER = ['Tap #', 'Date', 'Time', 'Name', 'Student ID', 'Direction'];

// Taps uploaded per request. Only the first sync of an old database, or a
// long stretch offline, ever has more than a handful waiting.
const BATCH = 2000;

// Where things go in the spreadsheet. Stored with the spreadsheet's ID; when
// either changes, the sheet in front of us doesn't hold our taps where we
// would now put them, so the whole history is uploaded again.
const LAYOUT = 3;

const logsTitle = (title) => `${title} Logs`;
const isLogs = (title) => title.endsWith(' Logs');

// The filter views each of our tabs should have, and its frozen header rows.
// A view with no sort is for the search boxes on its column headers.
const hoursViews = (headerRow) => [
  { title: 'Search', headerRow, columns: HOURS_HEADER.length, sort: null },
  { title: 'Most hours', headerRow, columns: HOURS_HEADER.length, sort: [2, 'DESCENDING'] },
  { title: 'Least hours', headerRow, columns: HOURS_HEADER.length, sort: [2, 'ASCENDING'] },
];
const LOGS_VIEWS = [
  { title: 'Search', headerRow: 0, columns: TAPS_HEADER.length, sort: null },
  { title: 'Newest first', headerRow: 0, columns: TAPS_HEADER.length, sort: [0, 'DESCENDING'] },
];
function dressFor(title) {
  if (title === TOTALS_TAB) return { frozen: 3, views: hoursViews(2) }; // its table starts on row 3
  if (!dates.MONTH_TAB_RE.test(title)) return null;
  return { frozen: 1, views: isLogs(title) ? LOGS_VIEWS : hoursViews(0) };
}

// "October 2026" and "October 2026 Logs" -> when that month began.
const monthStart = (title) => Date.parse(`1 ${title.replace(/ Logs$/, '')}`);

const tab = (title) => `'${title.replace(/'/g, "''")}'`;

const hoursRow = (r) => [
  r.name, r.student_id || '', r.hours, r.sessions,
  r.open ? 'yes' : '', r.uncounted.length || '', r.active ? '' : 'yes',
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
  debounceMs = 2000, retryMs = 60000, pollMs = 5 * 60000, log = () => {}, onChange = () => {},
}) {
  let running = false;
  let again = false;
  let timer = null;
  let lastError = null; // { message, offline, at }
  // Rewrite every month's hours, not just the touched ones. True for the
  // first sync after startup; set again by kick(true).
  let refreshAll = true;
  // What the last look at the Staffers tab found — for the People page.
  let rosterNotes = { warnings: [], unlinked: [] };
  const target = `${LAYOUT}:${client.spreadsheetId}`;
  // Raise the number to get every spreadsheet's Staffers tab ready once more.
  const staffersKey = `${target}:2`;

  // A sync and a save from the People page each read the Staffers tab and
  // then act on what they read, so they take turns.
  let turn = Promise.resolve();
  const inTurn = (fn) => {
    const mine = turn.then(fn);
    turn = mine.catch(() => {});
    return mine;
  };

  const watermark = () => Number(store.getMeta('sync_event_id') || 0);

  function monthHours(y, m, height) {
    const { startISO, endISO } = dates.monthBounds(y, m);
    const { report } = buildReport(store, bootId, startISO, endISO);
    // Everyone whose card works, so a month with no hours shows as zero, plus
    // anyone since deactivated who tapped that month.
    return padded(report.filter((r) => r.active || r.any).map(hoursRow), height);
  }

  async function uploadBatch(all) {
    const pending = store.getEventsAfter(watermark(), BATCH);
    const at = new Date(now()).toISOString();
    const fromTop = store.getMeta('sync_full') === '1';
    const data = [];

    // Tabs whose hours table is rewritten this time: title -> { y, m }.
    const months = new Map();
    const logTabs = [];
    const touch = (y, m) => months.set(dates.monthTitle(y, m), { y, m });
    const current = dates.monthOf(at);
    touch(current.y, current.m);
    if (all || fromTop) {
      const first = store.getFirstEventTs();
      const last = store.getLastEventTs();
      if (first) for (const { y, m } of dates.monthsBetween(first, last)) touch(y, m);
    }

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

    let tabs = await client.describeTabs();
    const have = new Set(tabs.map((t) => t.title));
    if (fromTop) {
      // Whatever is in our tabs may not be in the database any more — taps,
      // and people: a restored roster can be shorter than the one in Totals.
      // Not the Staffers tab: that one is the record, not a copy.
      const ours = [...have].filter((title) => title === TOTALS_TAB || dates.MONTH_TAB_RE.test(title));
      if (ours.length) await client.clearRanges(ours.map((title) => `${tab(title)}!A2:H`));
    }
    const missing = [...months.keys(), ...logTabs, TOTALS_TAB, STAFFERS_TAB].filter((title) => !have.has(title));
    if (missing.length) await client.addTabs(missing);
    if (!have.has(search.TAB)) await client.addTabs([search.TAB], search.COLUMNS);
    const added = have.has(search.TAB) ? missing : [...missing, search.TAB];
    if (added.length) tabs = await client.describeTabs();

    // Whichever of our tabs lack a filter view get theirs — new tabs, and
    // every tab the first time this runs.
    const bare = [];
    for (const t of tabs) {
      const dress = dressFor(t.title);
      const views = dress ? dress.views.filter((v) => !t.views.includes(v.title)) : [];
      if (views.length) bare.push({ sheetId: t.sheetId, frozen: dress.frozen, views });
    }
    if (bare.length) await client.dressTabs(bare);

    // Each of our tabs is styled once — lib/style.js — and then left to
    // whoever wants it to look different. Which ones have been is remembered
    // per spreadsheet.
    const styleKey = `${target}:${style.VERSION}`;
    const memo = JSON.parse(store.getMeta('sync_styled') || '{}');
    const styled = new Set(memo.key === styleKey ? memo.titles : []);
    for (const title of added) styled.delete(title); // a tab made again is plain again
    const plain = [];
    for (const t of tabs) {
      const look = styled.has(t.title) ? null : style.styleFor(t.title, { totalsTab: TOTALS_TAB, staffersTab: STAFFERS_TAB });
      if (look) plain.push({ sheetId: t.sheetId, title: t.title, ...look });
    }
    if (plain.length) {
      await client.formatTabs(plain);
      for (const t of plain) styled.add(t.title);
      store.setMeta('sync_styled', JSON.stringify({ key: styleKey, titles: [...styled] }));
    }

    await client.writeRanges(data);

    // The Search tab's formulas name every month tab, so they are written
    // again when there is a new one (or the tab itself is new).
    const monthTabs = tabs.map((t) => t.title).filter((title) => dates.MONTH_TAB_RE.test(title))
      .sort((a, b) => monthStart(b) - monthStart(a));
    const wanted = JSON.stringify([target, search.VERSION, monthTabs]);
    if (!have.has(search.TAB) || store.getMeta('sync_search') !== wanted) {
      await client.writeFormulas(search.searchTab({
        hoursTabs: monthTabs.filter((title) => !isLogs(title)),
        logsTabs: monthTabs.filter(isLogs),
        totalsTab: TOTALS_TAB,
        staffersTab: STAFFERS_TAB,
        hoursHeader: HOURS_HEADER,
        tapsHeader: TAPS_HEADER,
        staffersHeader: roster.HEADER,
      }));
      store.setMeta('sync_search', wanted);
    }

    // Only now are they known to be in the sheet.
    if (fromTop) store.setMeta('sync_full', '0');
    if (pending.length) store.setMeta('sync_event_id', String(pending[pending.length - 1].id));
    store.setMeta('sync_last_at', at);

    // Widen the columns of what was just written to fit it — a long name
    // would otherwise be cut off. Not the Staffers or Search tabs: how those
    // look is up to whoever uses them.
    const written = new Set([...months.keys(), ...logTabs, TOTALS_TAB]);
    await client.fitColumns(tabs.filter((t) => written.has(t.title)).map((t) => t.sheetId));
    return pending.length === BATCH;
  }

  // Once per spreadsheet: the Staffers tab, wide enough and with its dropdowns.
  async function staffersTab() {
    if (store.getMeta('sync_staffers') === staffersKey) return;
    const tabs = await client.listTabs();
    if (!tabs.includes(STAFFERS_TAB)) await client.addTabs([STAFFERS_TAB]);
    // Year and Course used to sit between Telegram and Deactivated, here and
    // in the Search tab's details. A sheet from then loses those two columns,
    // and what was in them, so everything after lines up with where it is now.
    const old = async (title, range) => {
      if (!tabs.includes(title)) return false;
      const [cells = []] = await client.readRange(`${tab(title)}!${range}`);
      return cells[0] === 'Year' && cells[1] === 'Course';
    };
    if (await old(STAFFERS_TAB, 'F1:G1')) await client.deleteColumns(STAFFERS_TAB, [5, 7]);
    if (await old(search.TAB, 'O4:P4')) await client.deleteColumns(search.TAB, [14, 16]);
    await client.shapeTab(STAFFERS_TAB, {
      columns: roster.HEADER.length, dropdowns: { C: SECTIONS, D: STATUSES },
    });
    store.setMeta('sync_staffers', staffersKey);
  }

  // Make this device's people match the Staffers tab — lib/roster.js.
  // Resolves true if anyone here changed.
  async function pullRoster() {
    await staffersTab();
    const values = await client.readRange(roster.RANGE);
    const plan = roster.pull(store.listUsers(), values);
    store.applyRoster(plan);
    if (plan.writes.length) await client.writeRanges(plan.writes);
    // Only now are they known to be in the sheet. If the reply was lost, the
    // next look finds their rows there.
    store.markInSheet(plan.seeded);
    rosterNotes = { warnings: plan.warnings, unlinked: plan.unlinked };
    return plan.create.length + plan.update.length + plan.deactivate.length > 0;
  }

  // A register, edit or deactivation from the People page. `row` is the
  // person as they should be; `own` is them as this device has them, or null
  // if new. It goes to the sheet first, and `apply` — which saves it here —
  // runs only once Google has it. Rejects, with nothing changed anywhere, if
  // Google can't be reached or the tab has that ID number or card already.
  const saveStaffer = (row, own, apply) => inTurn(async () => {
    await staffersTab();
    const spot = roster.place(await client.readRange(roster.RANGE), row, own);
    if (spot.error) throw Object.assign(new Error(spot.error), { offline: false });
    await client.writeRanges(spot.writes);
    apply();
  });

  // Bring the sheet up to date. Rejects if Google can't be reached or
  // refuses; whatever wasn't confirmed stays pending.
  const syncOnce = () => inTurn(async () => {
    // A different spreadsheet has none of our taps in it, and after a restore
    // (which clears this mark — lib/backup.js) the sheet may hold taps the
    // database no longer has: start from the top.
    if (store.getMeta('sync_spreadsheet') !== target) {
      store.setMeta('sync_event_id', '0');
      store.setMeta('sync_full', '1');
      store.setMeta('sync_spreadsheet', target);
      // Nor has its Staffers tab listed anyone yet, as far as we know.
      store.forgetSheet();
    }
    let all = refreshAll;
    refreshAll = false;
    try {
      // First, so the Search tab's formulas are written for the Staffers tab
      // as it will be.
      await staffersTab();
      while (await uploadBatch(all)) all = false; // more waiting
      // A name or a deactivation that came from the sheet is in every month's
      // hours table.
      if (await pullRoster()) await uploadBatch(true);
    } catch (e) {
      refreshAll = true; // still owed
      throw e;
    }
  });

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
      // An edit made in the sheet announces itself to no one: look again later.
      schedule(pollMs);
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
    saveStaffer,
    run,
    // Something changed (a tap, the roster): sync shortly. The short wait lets
    // a rush of taps at the door go up together. Pass true when the roster
    // changed, which touches every month's hours table.
    kick: (all = false) => { if (all) refreshAll = true; schedule(debounceMs); },
    stop: () => clearTimeout(timer),
    /*
     * state, for the tap screen and the admin site:
     *   synced   every tap is in the sheet
     *   pending  taps are waiting and nothing is wrong (uploading, or the
     *            clock isn't set yet)
     *   offline  taps are waiting because Google can't be reached
     *   error    taps are waiting because Google refused — someone has to
     *            fix something
     */
    status() {
      const pending = store.countEventsAfter(watermark());
      const lastSyncedAt = store.getMeta('sync_last_at') || null;
      let state = 'synced';
      if (lastError) state = lastError.offline ? 'offline' : 'error';
      else if (pending > 0 || running || !lastSyncedAt) state = 'pending';
      return {
        state,
        pending,
        uploaded: store.countEventsAfter(0) - pending,
        lastSyncedAt,
        error: lastError,
        running,
        roster: rosterNotes,
      };
    },
  };
}

module.exports = { createSync, TOTALS_TAB, STAFFERS_TAB };
