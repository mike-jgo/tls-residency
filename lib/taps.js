'use strict';

/*
 * The Logs tabs, read back. The spreadsheet is the record of the taps as well
 * as of the staffers: when the server starts, this device's taps are replaced
 * by what the tabs hold, so whichever device is switched on carries on from
 * the same history. read() only works out what the tabs say; lib/sync.js
 * acts on it.
 *
 * A tap's place in the sheet is fixed by its number (lib/sync.js), so the tabs
 * are `tidy` when they are exactly what an upload would have written: each
 * month's taps in its own tab, from row 2 down with no gaps, numbers rising.
 * Tabs someone has edited by hand — a row deleted, a forgotten check-out
 * typed in — are read all the same: the taps are put in time order and
 * numbered again, and lib/sync.js then writes the tabs out afresh.
 *
 * A row that can't be read at all is an error, and nothing is taken from the
 * sheet until someone fixes it: guessing would lose a tap.
 */

const dates = require('./dates');

// tabs: [{ title: 'October 2026 Logs', values }], oldest month first, `values`
// being the tab's cells from row 2 down.
function read(tabs) {
  const rows = [];
  const errors = [];
  const numbers = new Set();
  let tidy = true;

  for (const { title, values } of tabs) {
    let last = 0;
    (values || []).forEach((cells, i) => {
      const [tap, date, time, name, studentId, direction] =
        [0, 1, 2, 3, 4, 5].map((c) => String(cells[c] == null ? '' : cells[c]).trim());
      // Google leaves empty rows off the bottom, so an empty one is a gap.
      if (![tap, date, time, name, studentId, direction].some(Boolean)) { tidy = false; return; }

      const where = `${title}, row ${i + 2}`;
      const ts = dates.instantOf(date, time);
      const type = direction.toLowerCase();
      if (!ts) {
        errors.push(`${where}: "${`${date} ${time}`.trim()}" is not a date and time like 2026-10-01 18:30:44.`);
      } else if (type !== 'in' && type !== 'out') {
        errors.push(`${where}: the direction must be IN or OUT.`);
      } else if (!name && !studentId) {
        errors.push(`${where}: no name or student ID.`);
      } else {
        const number = tap.replace(/,/g, '');
        const id = /^[1-9]\d*$/.test(number) ? Number(number) : null;
        const { y, m } = dates.monthOf(ts);
        if (id === null || id <= last || numbers.has(id) || `${dates.monthTitle(y, m)} Logs` !== title) tidy = false;
        else { last = id; numbers.add(id); }
        rows.push({ id, ts, type, name, student_id: studentId });
      }
    });
  }

  if (!tidy) {
    // Array.prototype.sort is stable: taps in the same second keep their order.
    rows.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    rows.forEach((row, i) => { row.id = i + 1; });
  }
  return { rows, tidy, errors };
}

module.exports = { read };
